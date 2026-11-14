/**
 * The debug bot: a Pi agent (pi-agent-core) on a Fireworks model (pi-ai), with tools over the portal database.
 * Each chat turn rebuilds an Agent from the session's stored messages, streams events to the browser, then persists.
 */
import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { getModel, getModels, isContextOverflow, type AssistantMessage } from '@mariozechner/pi-ai';
import { compactIfNeeded, contextTokens, convertToLlm, windowOf } from './compaction.ts';
import { all, get, run, now, audit } from '../db.ts';
import { buildTools } from './tools.ts';

export const MODEL_ID = process.env.PI_MODEL ?? 'accounts/fireworks/models/kimi-k3';
export const PROVIDER = 'fireworks';

type ModelInfo = { id: string; name: string; reasoning: boolean; contextWindow: number };
const known = () => getModels(PROVIDER) as unknown as (ModelInfo & Record<string, unknown>)[];

/**
 * Fireworks ships models faster than pi-ai's built-in catalog. Any Fireworks id resolves:
 * catalog entries as-is, anything else from a catalog Fireworks entry used as a template
 * (same API, base URL and provider), with a conservative output limit.
 */
export function resolveModel(id: string) {
  const exact = getModel(PROVIDER, id as never);
  if (exact) return exact;
  if (!id.startsWith('accounts/fireworks/')) return undefined;
  const template = known()[0];
  if (!template) return undefined;
  return { ...template, id, name: id.split('/').pop()!, maxTokens: 16384, contextWindow: 131072, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never as ReturnType<typeof getModel>;
}

/** The chat models this key can use, fetched from Fireworks and cached; falls back to the pi-ai catalog. */
let accountModels: { at: number; list: ModelInfo[] } | null = null;
export async function availableModels(): Promise<ModelInfo[]> {
  const key = process.env.FIREWORKS_API_KEY;
  if (accountModels && Date.now() - accountModels.at < 10 * 60_000) return accountModels.list;
  const fallback = known().map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow }));
  if (!key) return fallback;
  try {
    const res = await fetch('https://api.fireworks.ai/inference/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return fallback;
    const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    const chat = ids.filter((id) => id.startsWith('accounts/fireworks/models/') && !/embedding|reranker/.test(id)).sort();
    const list = chat.map((id) => {
      const k = known().find((m) => m.id === id);
      return { id, name: k?.name ?? id.split('/').pop()!, reasoning: k?.reasoning ?? true, contextWindow: k?.contextWindow ?? 131072 };
    });
    accountModels = { at: Date.now(), list: list.length ? list : fallback };
    return accountModels.list;
  } catch { return fallback; }
}

export async function botStatus() {
  const model = resolveModel(MODEL_ID) as { id: string; name: string } | undefined;
  const models = await availableModels();
  return {
    configured: Boolean(process.env.FIREWORKS_API_KEY) && Boolean(model),
    hasKey: Boolean(process.env.FIREWORKS_API_KEY),
    provider: PROVIDER,
    model: model?.id ?? MODEL_ID,
    modelName: model?.name ?? null,
    modelKnown: Boolean(model),
    models: models.some((m) => m.id === MODEL_ID) ? models : [{ id: MODEL_ID, name: MODEL_ID.split('/').pop()!, reasoning: true, contextWindow: 131072 }, ...models],
  };
}

function systemPrompt(sessionId: number) {
  const ticket = get<{ key: string; subject: string; customer: string | null; status: string }>(`SELECT t.key, t.subject, cu.name customer, t.status FROM bot_sessions s
    JOIN tickets t ON t.id = s.ticket_id LEFT JOIN customers cu ON cu.id = t.customer_id WHERE s.id = ?`, sessionId);
  const customers = all<{ id: string; name: string; timezone: string; booking_system: string; integration: string }>('SELECT id, name, timezone, booking_system, integration FROM customers');
  const range = get<{ a: string; b: string }>('SELECT MIN(ts) a, MAX(ts) b FROM log_events');
  return `You are the debug bot inside the support portal for an AI phone agent that answers inbound calls for small businesses and books, moves and cancels appointments in each business's own booking system.

You help support staff (deployment engineers and on-call engineers) investigate problems. You have full read access to the portal database and limited write access to internal records.

Customers:
${customers.map((c) => `- ${c.id}: ${c.name}, ${c.booking_system} via ${c.integration}, timezone ${c.timezone}`).join('\n')}

Data:
- calls: one row per ingested call record. outcome is what the agent SAID happened. write_status is what the booking system ACCEPTED (written, failed, none, unknown). said_not_written=1 means the caller was told a change was made that was not saved. is_duplicate=1 marks a repeat ingest of the same telephony_sid.
- log_events: integration.log parsed, ${range?.a} to ${range?.b} (UTC). Services: booking-sync, booking-auth, avail-sync, call-ingest.
- flags (shown to staff as alerts): detector output with analysis and evidence; flags.ticket_id is the ticket handling it.
- tickets: one problem being worked. customer_id NULL means an internal ticket no client sees. ticket_messages: every message to or from a client lives on a ticket; internal=1 is a staff note, status='draft' is an unsent reply.

How to work:
- Investigate with tools before answering. Prefer specific tools; use sql_query for anything else (call describe_schema first if unsure of columns).
- Cite evidence: call ids, log timestamps, counts. Never invent a number; compute it.
- Timestamps in the data are UTC. When talking about a customer's day, convert to their timezone and say so.
- Separate what the data shows from what you infer.
- You may update alerts, add INTERNAL ticket notes, save DRAFT replies, and open tickets. You cannot send anything to a client: drafts wait on the ticket for a human.
- Tickets: when your investigation has found a cause or a clear pattern with evidence, and no open ticket already covers it (check list_flags for ticket_key), call propose_ticket once. The admin sees a card with a Create button. Only call create_ticket when the admin asks (for example "create the ticket"). Put the full findings in create_ticket's findings; add a draft_reply only for a client ticket. Afterwards tell the admin the ticket key.
- Client-facing drafts: plain language, no jargon, say what happened, who is affected, what you need from them, what happens next.
- Be concise. Lead with the answer, then the evidence.${ticket ? `

This investigation was started from ticket ${ticket.key} ("${ticket.subject}", ${ticket.customer ?? 'internal ticket'}, status ${ticket.status}).
- Begin by reading it with get_ticket ${ticket.key}: the reporter's description, their evidence (example calls, when it started) and any attachments.
- Check that evidence against calls, log_events and alerts. Link relevant alerts to ${ticket.key} with update_flag.
- Findings belong on ${ticket.key}: when asked to add findings, call add_internal_note on ${ticket.key} (cause, evidence with call ids and log timestamps, impact, next steps)${ticket.customer ? `, then draft_reply on ${ticket.key} with a plain-language update for the client` : ''}.
- Do not open a new ticket for this problem. propose_ticket is only for an unrelated problem you happen to find.` : ''}`;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; isError: boolean; preview: string; ticket_key?: string; proposal?: unknown; wrote?: string }
  | { type: 'compacted'; tokensBefore: number; tokensAfter: number; when: 'before' | 'during' | 'overflow' }
  | { type: 'context'; tokens: number; window: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

const running = new Map<number, Agent>();

export function abortSession(sessionId: number) {
  running.get(sessionId)?.abort();
}

/** Replace a session's saved history (after compaction the transcript starts with Pi's compactionSummary). */
function saveAll(sessionId: number, msgs: AgentMessage[]) {
  run('DELETE FROM bot_messages WHERE session_id = ?', sessionId);
  msgs.forEach((m, i) => run('INSERT INTO bot_messages (session_id, seq, message_json, created_at) VALUES (?, ?, ?, ?)', sessionId, i, JSON.stringify(m), now()));
}

/** Context in use for a saved session, for the meter on the bot page. */
export function sessionContext(sessionId: number, modelId?: string) {
  const model = resolveModel(modelId || MODEL_ID);
  const msgs = all<{ message_json: string }>('SELECT message_json FROM bot_messages WHERE session_id = ? ORDER BY seq', sessionId).map((r) => JSON.parse(r.message_json) as AgentMessage);
  return { tokens: contextTokens(msgs), window: model ? windowOf(model) : 0 };
}

export async function chat(sessionId: number, userId: number, actor: string, prompt: string, emit: (e: StreamEvent) => Promise<void> | void, modelId?: string) {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) throw new Error('FIREWORKS_API_KEY is not set. Add it to app/.env and restart the server.');
  const id = modelId || MODEL_ID;
  const model = resolveModel(id);
  if (!model) throw new Error(`Unknown Fireworks model "${id}". Pick one from the list or set PI_MODEL.`);
  if (running.has(sessionId)) throw new Error('This session is already answering. Wait or stop it first.');

  let stored = all<{ message_json: string }>('SELECT message_json FROM bot_messages WHERE session_id = ? ORDER BY seq', sessionId).map((r) => JSON.parse(r.message_json) as AgentMessage);
  const firstTurn = stored.length === 0;

  // 1. Before the turn: if the saved history is over budget, compact it with Pi and save the shorter history.
  const pre = await compactIfNeeded(stored, model, apiKey).catch(() => null);
  if (pre) {
    stored = pre.messages;
    saveAll(sessionId, stored);
    await emit({ type: 'compacted', tokensBefore: pre.tokensBefore, tokensAfter: pre.tokensAfter, when: 'before' });
  }

  // 2. During the turn: a long tool loop can outgrow the window. Pi calls transformContext before every model call;
  //    we compact the view the model sees and cache it, so later calls in the same turn reuse the summary.
  let cache: { summary: AgentMessage; prefix: number } | null = null;
  const view = (msgs: AgentMessage[]) => (cache && msgs.length >= cache.prefix ? [cache.summary, ...msgs.slice(cache.prefix)] : msgs);
  const transformContext = async (msgs: AgentMessage[], signal?: AbortSignal) => {
    const v = view(msgs);
    try {
      const r = await compactIfNeeded(v, model, apiKey, signal);
      if (!r) return v;
      // r.replaced counts messages of v; map back to an index in the agent's full message list.
      cache = { summary: r.messages[0], prefix: (cache && v !== msgs ? cache.prefix - 1 : 0) + r.replaced };
      await emit({ type: 'compacted', tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter, when: 'during' });
      return r.messages;
    } catch { return v; } // contract: never throw
  };

  const agent = new Agent({
    initialState: { systemPrompt: systemPrompt(sessionId), model, thinkingLevel: 'low', tools: buildTools(actor, userId), messages: stored },
    convertToLlm,                 // Pi's converter: understands compactionSummary messages
    transformContext,
    toolExecution: 'sequential',
    sessionId: `portal-bot-${sessionId}`,
    beforeToolCall: async ({ toolCall }) => { audit(actor, `bot.tool.${toolCall.name}`, `session:${sessionId}`, JSON.stringify(toolCall.arguments).slice(0, 500)); return undefined; },
  });
  running.set(sessionId, agent);

  const unsub = agent.subscribe(async (e: AgentEvent) => {
    if (e.type === 'message_update') {
      const a = e.assistantMessageEvent;
      if (a.type === 'text_delta') await emit({ type: 'text', delta: a.delta });
      else if (a.type === 'thinking_delta') await emit({ type: 'thinking', delta: a.delta });
    } else if (e.type === 'tool_execution_start') {
      await emit({ type: 'tool_start', id: e.toolCallId, name: e.toolName, args: e.args });
    } else if (e.type === 'tool_execution_end') {
      const r = e.result as { content?: { type: string; text?: string }[]; details?: { ticket_key?: string; proposal?: unknown; wrote?: string } } | undefined;
      const preview = (r?.content ?? []).map((c) => c.text ?? '').join('\n').slice(0, 1500);
      // Structured results the UI acts on: a created ticket to jump to, or a proposal to confirm.
      await emit({ type: 'tool_end', id: e.toolCallId, name: e.toolName, isError: e.isError, preview, ticket_key: r?.details?.ticket_key, proposal: r?.details?.proposal, wrote: r?.details?.wrote });
    } else if (e.type === 'message_end') {
      const m = e.message as AssistantMessage;
      // An overflow is handled below by compacting and retrying; other errors go to the page.
      if (m.role === 'assistant' && m.stopReason === 'error' && !isContextOverflow(m, windowOf(model))) await emit({ type: 'error', message: m.errorMessage ?? 'The model returned an error.' });
    }
  });

  try {
    await agent.prompt(prompt);
    // 3. Overflow anyway (estimates are estimates): compact the whole history once and continue the turn.
    const last = agent.state.messages.at(-1) as AssistantMessage | undefined;
    if (last?.role === 'assistant' && isContextOverflow(last, windowOf(model))) {
      const forced = await compactIfNeeded(view(agent.state.messages.slice(0, -1)), model, apiKey, undefined, true).catch(() => null);
      if (forced) {
        cache = null;
        agent.state.messages = forced.messages;
        await emit({ type: 'compacted', tokensBefore: forced.tokensBefore, tokensAfter: forced.tokensAfter, when: 'overflow' });
        await agent.continue();
      } else {
        await emit({ type: 'error', message: 'This investigation no longer fits the model context. Start a new one from the ticket.' });
      }
    }
  } finally {
    unsub();
    running.delete(sessionId);
    // Save what the model actually works from: the compacted view if this turn compacted, else the full list.
    const msgs = view(agent.state.messages);
    if (msgs !== agent.state.messages || msgs.length < stored.length || (msgs[0] && stored[0] && msgs[0] !== stored[0])) saveAll(sessionId, msgs);
    else for (let i = stored.length; i < msgs.length; i++) run('INSERT INTO bot_messages (session_id, seq, message_json, created_at) VALUES (?, ?, ?, ?)', sessionId, i, JSON.stringify(msgs[i]), now());
    run('UPDATE bot_sessions SET updated_at = ? WHERE id = ?', now(), sessionId);
    if (firstTurn) run('UPDATE bot_sessions SET title = ? WHERE id = ? AND title = ?', prompt.slice(0, 80), sessionId, 'New investigation');
    await emit({ type: 'context', tokens: contextTokens(msgs), window: windowOf(model) });
    await emit({ type: 'done' });
  }
}
