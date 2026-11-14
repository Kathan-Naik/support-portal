/**
 * Context management for the debug bot, using Pi's own compaction from @mariozechner/pi-coding-agent:
 * token accounting (calculateContextTokens, estimateTokens), the trigger (shouldCompact), the summariser
 * (generateSummary) and the compactionSummary message, which Pi's convertToLlm turns into a user message.
 * We only decide where to cut and what an investigation summary must keep.
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model } from '@mariozechner/pi-ai';
import {
  calculateContextTokens, estimateTokens, shouldCompact, generateSummary, DEFAULT_COMPACTION_SETTINGS, convertToLlm,
} from '@mariozechner/pi-coding-agent';

export { convertToLlm };

export const SETTINGS = {
  ...DEFAULT_COMPACTION_SETTINGS,
  reserveTokens: Number(process.env.BOT_RESERVE_TOKENS ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens),
  keepRecentTokens: Number(process.env.BOT_KEEP_RECENT_TOKENS ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
};

/** The window we budget against: the model's, unless BOT_CONTEXT_WINDOW lowers it (useful to see compaction early). */
export const windowOf = (model: Model<any>) => Math.min(model.contextWindow || 131072, Number(process.env.BOT_CONTEXT_WINDOW ?? Infinity));

const INSTRUCTIONS = `This is a support investigation by a debug bot over calls, integration logs, alerts and tickets.
Keep every identifier exactly: call ids (call_00297), appointment ids, ticket keys (SUP-1001), alert ids, customer ids, log timestamps, HTTP statuses.
Record what was already written: tickets created, alerts linked, internal notes and draft replies saved, and on which ticket.
Record conclusions with their evidence and counts, and what the admin asked for next.`;

type Summary = Extract<AgentMessage, { role: 'compactionSummary' }>;
const isSummary = (m: AgentMessage): m is Summary => (m as { role: string }).role === 'compactionSummary';

/** Tokens in context: the last successful assistant usage (real numbers from the provider) plus estimates for what came after. */
export function contextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantMessage;
    if (m.role === 'assistant' && m.usage && m.stopReason !== 'error' && m.stopReason !== 'aborted') {
      let n = calculateContextTokens(m.usage);
      for (let j = i + 1; j < messages.length; j++) n += estimateTokens(messages[j]);
      return n;
    }
  }
  return messages.reduce((n, m) => n + estimateTokens(m), 0);
}

export type Compacted = { messages: AgentMessage[]; replaced: number; tokensBefore: number; tokensAfter: number };

/**
 * If the context is over budget (or `force`), summarise older turns and keep roughly keepRecentTokens of recent ones.
 * Cuts only at a user message, so a tool call is never separated from its result.
 * `replaced` is how many leading input messages the summary stands in for.
 */
export async function compactIfNeeded(messages: AgentMessage[], model: Model<any>, apiKey: string, signal?: AbortSignal, force = false): Promise<Compacted | null> {
  const tokensBefore = contextTokens(messages);
  if (!force && !shouldCompact(tokensBefore, windowOf(model), SETTINGS)) return null;
  const start = messages.length && isSummary(messages[0]) ? 1 : 0;
  const previous = start ? (messages[0] as Summary).summary : undefined;

  // Walk back from the end until we hold keepRecentTokens, then cut at the nearest user message at or before that point.
  let acc = 0; let cut = -1;
  for (let i = messages.length - 1; i > start; i--) {
    acc += estimateTokens(messages[i]);
    if ((messages[i] as { role: string }).role === 'user' && (acc >= SETTINGS.keepRecentTokens || cut === -1)) { cut = i; if (acc >= SETTINGS.keepRecentTokens) break; }
  }
  // Nothing older than the latest turn: nothing to summarise.
  if (cut <= start) return null;

  const older = messages.slice(start, cut);
  const summary = await generateSummary(older, model, SETTINGS.reserveTokens, apiKey, undefined, signal, INSTRUCTIONS, previous);
  if (!summary.trim()) return null;
  const head: Summary = { role: 'compactionSummary', summary, tokensBefore, timestamp: Date.now() };
  const next = [head as AgentMessage, ...messages.slice(cut)];
  return { messages: next, replaced: cut, tokensBefore, tokensAfter: next.reduce((n, m) => n + estimateTokens(m), 0) };
}
