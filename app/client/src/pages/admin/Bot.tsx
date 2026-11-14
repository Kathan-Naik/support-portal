import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, streamBot, useApi, type BotEvent, type Proposal } from '../../api.ts';
import { Markdown, Loading, Confirm, useToast } from '../../components/ui.tsx';
import { ago } from '../../format.ts';

type Status = { configured: boolean; hasKey: boolean; provider: string; model: string; modelName: string | null; models: { id: string; name: string }[] };
type Session = { id: number; title: string; updated_at: string; owner: string; ticket_key: string | null };
type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'toolCall'; id: string; name: string; arguments: unknown };
type Msg =
  | { role: 'compactionSummary'; summary: string; tokensBefore: number; timestamp: number }
  | { role: 'user'; content: string | { type: string; text?: string }[] }
  | { role: 'assistant'; content: Block[]; stopReason?: string; errorMessage?: string }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: { type: string; text?: string }[]; isError: boolean; details?: { ticket_key?: string; proposal?: Proposal; wrote?: 'note' | 'draft' } };
type SessionData = { id: number; title: string; messages: Msg[]; context?: { tokens: number; window: number }; ticket_key?: string | null; ticket_subject?: string | null; ticket_customer?: string | null };
type LiveTool = { id: string; name: string; args: unknown; done: boolean; isError: boolean; preview: string; ticketKey?: string; proposal?: Proposal; wrote?: 'note' | 'draft' };
type Live = { prompt: string; text: string; thinking: boolean; tools: LiveTool[]; error: string | null };

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  panel: 'M4 5h16v14H4zM9 5v14',
  back: 'M15 6l-6 6 6 6',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
};
const SIDE_KEY = 'portal.bot.history';
const phone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 40rem)').matches;
// On a phone the history is an overlay, so it starts closed; elsewhere it remembers the last choice.
const readSide = () => { if (phone()) return false; try { return localStorage.getItem(SIDE_KEY) !== 'closed'; } catch { return true; } };

const SUGGEST = [
  'Why did Sunrise Dental stop booking? Show the evidence.',
  'Which callers need a call back, and what was each one told?',
  'Are duplicate call records causing double bookings anywhere?',
  'Is anything wrong that has no ticket yet? Propose one if so.',
];
const CREATE_FROM_FINDINGS = 'Create a ticket from your findings so far with create_ticket: full findings as the internal note, link the relevant alerts, pick the client (or internal if it spans clients), and add a draft reply if it is for a client.';
const startPrompt = (key: string) => `Investigate ticket ${key}. Read it, check the reporter's evidence against calls, logs and alerts, link the relevant alerts to it, and tell me the cause, who is affected and what to do next.`;
const findingsPrompt = (key: string, client: boolean) => `Add your findings to ${key}: an internal note with the cause, evidence (call ids, log timestamps), impact and next steps${client ? `, then a draft reply on ${key} for the client in plain language` : ''}.`;
const STORE_KEY = 'portal.bot.model';
const readModel = () => { try { return localStorage.getItem(STORE_KEY) ?? ''; } catch { return ''; } };

export function BotPage() {
  const { id } = useParams();
  const sid = id ? Number(id) : null;
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const status = useApi<Status>('/bot/status');
  const st = status.data;
  const sessions = useApi<Session[]>('/bot/sessions');
  const openTickets = useApi<{ key: string; subject: string; customer: string | null; status: string; priority: string }[]>('/tickets');
  const tickets = (openTickets.data ?? []).filter((x) => ['open', 'pending'].includes(x.status)).slice(0, 4);
  const [starting, setStarting] = useState<string | null>(null);
  const startFromTicket = async (key: string) => {
    setStarting(key);
    try { const r = await api<{ id: number }>('/bot/sessions', { body: { ticket_key: key } }); sessions.reload(); nav(`/admin/bot/${r.id}?start=1`); }
    catch (x) { toast(x instanceof Error ? x.message : String(x)); }
    finally { setStarting(null); }
  };
  const [session, setSession] = useState<SessionData | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(readModel());
  const [live, setLive] = useState<Live | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [ctx, setCtx] = useState<{ tokens: number; window: number } | null>(null);
  useEffect(() => { setCtx(session?.context ?? null); }, [session]);
  const [sideOpen, setSideOpen] = useState(readSide);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ownNav = useRef(false);          // true while send() itself moves to a new session id
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);            // follow the bottom only while the reader is at the bottom
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A prepared question from elsewhere in the portal (alert, ticket): prefill, never auto-send.
  useEffect(() => {
    const ask = sp.get('ask');
    if (ask) { setInput(ask); const n = new URLSearchParams(sp); n.delete('ask'); setSp(n, { replace: true }); inputRef.current?.focus(); }
  }, [sp, setSp]);

  // Load the transcript when the session changes, unless we navigated there ourselves mid-answer.
  useEffect(() => {
    if (phone()) setSideOpen(false);
    if (ownNav.current) { ownNav.current = false; return; }
    setDismissed(false); setLive(null);
    if (!sid) { setSession(null); return; }
    let gone = false;
    setLoadingSession(true);
    api<SessionData>(`/bot/sessions/${sid}`).then((d) => { if (!gone) setSession(d); }).catch(() => { if (!gone) setSession(null); }).finally(() => { if (!gone) setLoadingSession(false); });
    return () => { gone = true; };
  }, [sid]);

  const started = useRef<number | null>(null);
  useEffect(() => {
    if (sp.get('start') !== '1' || !session || session.id !== sid || !session.ticket_key || session.messages.length || !st?.configured || started.current === sid) return;
    started.current = sid;
    const n = new URLSearchParams(sp); n.delete('start'); setSp(n, { replace: true });
    void send(startPrompt(session.ticket_key));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sp, st]);

  // Keep the view pinned to the newest line while the reader is at the bottom.
  const onScroll = () => { const el = logRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  useLayoutEffect(() => { const el = logRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [live, session]);

  const chosen = model && st?.models.some((m) => m.id === model) ? model : st?.model ?? '';

  const send = useCallback(async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || (live && !live.error) || !st?.configured) return;
    let target = sid;
    if (!target) {
      const r = await api<{ id: number }>('/bot/sessions', { method: 'POST' });
      target = r.id;
      ownNav.current = true;
      nav(`/admin/bot/${r.id}`);
      setSession({ id: r.id, title: prompt.slice(0, 80), messages: [] });
    }
    setInput(''); setDismissed(false); stick.current = true;

    // Stream into a mutable buffer; paint at most once per animation frame.
    const buf: Live = { prompt, text: '', thinking: false, tools: [], error: null };
    let frame = 0;
    const paint = () => { frame = 0; setLive({ ...buf, tools: buf.tools.map((t) => ({ ...t })) }); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    setLive({ ...buf });
    const on = (ev: BotEvent) => {
      if (ev.type === 'text') { buf.text += ev.delta; buf.thinking = false; }
      else if (ev.type === 'thinking') buf.thinking = true;
      else if (ev.type === 'tool_start') { buf.thinking = false; buf.tools.push({ id: ev.id, name: ev.name, args: ev.args, done: false, isError: false, preview: '' }); }
      else if (ev.type === 'tool_end') {
        const t = buf.tools.find((x) => x.id === ev.id);
        if (t) Object.assign(t, { done: true, isError: ev.isError, preview: ev.preview, ticketKey: ev.ticket_key, proposal: ev.proposal, wrote: ev.wrote });
        if (ev.ticket_key) toast(ev.wrote === 'note' ? `Findings added to ${ev.ticket_key}.` : ev.wrote === 'draft' ? `Draft reply saved on ${ev.ticket_key}.` : `${ev.ticket_key} created.`);
      } else if (ev.type === 'compacted') toast(`Context compacted: ${k(ev.tokensBefore)} to ${k(ev.tokensAfter)} tokens. Older turns are summarised.`);
      else if (ev.type === 'context') setCtx({ tokens: ev.tokens, window: ev.window });
      else if (ev.type === 'error') buf.error = ev.message;
      schedule();
    };
    const ctl = new AbortController(); abortRef.current = ctl;
    try { await streamBot(target, prompt, chosen, on, ctl.signal); }
    catch (x) { if (!ctl.signal.aborted) buf.error = x instanceof Error ? x.message : String(x); }
    cancelAnimationFrame(frame);
    abortRef.current = null;
    // Swap the live turn for the saved transcript in one render, so nothing shows twice.
    try {
      const saved = await api<SessionData>(`/bot/sessions/${target}`);
      setSession(saved);
      setLive(buf.error ? { prompt: '', text: '', thinking: false, tools: [], error: buf.error } : null);
    } catch { setLive({ ...buf }); }
    sessions.reload();
  }, [input, live, st, sid, nav, chosen, toast, sessions]);

  const stop = async () => { if (sid) await api(`/bot/sessions/${sid}/abort`, { method: 'POST' }).catch(() => {}); abortRef.current?.abort(); };
  const remove = async (s: Session) => {
    setDeleting(null);
    await api(`/bot/sessions/${s.id}`, { method: 'DELETE' });
    sessions.reload(); toast('Investigation deleted.');
    if (s.id === sid) nav('/admin/bot');
  };
  const toggleSide = () => { const next = !sideOpen; setSideOpen(next); if (phone()) return; try { localStorage.setItem(SIDE_KEY, next ? 'open' : 'closed'); } catch { /* storage blocked */ } };

  // Latest proposal still waiting, and the latest ticket created, across saved and live turns.
  const outcome = useMemo(() => {
    let proposal: Proposal | null = null; let ticket: string | null = null; let wrote: string | null = null;
    const take = (p?: Proposal, k?: string, w?: string) => { if (p) proposal = p; if (k && !w) { ticket = k; proposal = null; } if (k && w) wrote = k; };
    for (const m of session?.messages ?? []) if (m.role === 'toolResult' && !m.isError) take(m.details?.proposal, m.details?.ticket_key, m.details?.wrote);
    for (const t of live?.tools ?? []) take(t.proposal, t.ticketKey, t.wrote);
    return { proposal: proposal as Proposal | null, ticket: (session?.ticket_key ?? ticket) as string | null, wrote: wrote as string | null };
  }, [session, live]);
  const answered = (session?.messages ?? []).some((m) => m.role === 'assistant');
  const busy = Boolean(live && !live.error);
  const createFromProposal = (p: Proposal) => send(`Create the ticket you proposed: "${p.subject}"${p.customer ? ` for ${p.customer}` : ' as an internal ticket'}. Put your full findings in it, link alerts ${p.flag_ids.length ? p.flag_ids.join(', ') : 'that apply'}${p.customer ? ', and add a draft reply for the client' : ''}.`);

  return (
    <div className="bot">
      <aside className={`bot__sessions${sideOpen ? '' : ' is-closed'}`} aria-label="Investigations">
        <div className="bot__side-head">
          <Link className="bot__back" to="/admin" aria-label="Back to the portal"><Icon d={I.back} size={16} /><span>Portal</span></Link>
          <button type="button" className="icon-btn" onClick={toggleSide} aria-label={sideOpen ? 'Hide history' : 'Show history'} aria-expanded={sideOpen}><Icon d={I.panel} /></button>
        </div>
        {sideOpen ? (
          <>
            <button type="button" className="bot__new" onClick={() => nav('/admin/bot')} disabled={busy}><Icon d={I.plus} size={16} />New investigation</button>
            <p className="bot__label">History</p>
            <nav className="bot__list" aria-label="Past investigations">
              {sessions.data?.length ? sessions.data.map((s) => (
                <div key={s.id} className={`bot__item${s.id === sid ? ' is-active' : ''}`}>
                  <Link to={`/admin/bot/${s.id}`} className="bot__item-link" aria-current={s.id === sid ? 'page' : undefined} onClick={(e) => { if (busy) e.preventDefault(); }}>
                    <span className="bot__item-title">{s.title}</span>
                    <span className="bot__item-meta">{s.ticket_key ? `${s.ticket_key}, ` : ''}{ago(s.updated_at)}</span>
                  </Link>
                  <button type="button" className="icon-btn icon-btn--quiet bot__item-del" onClick={() => setDeleting(s)} disabled={busy && s.id === sid} aria-label={`Delete "${s.title}"`}><Icon d={I.trash} size={16} /></button>
                </div>
              )) : <p className="bot__none">Your investigations appear here.</p>}
            </nav>
          </>
        ) : (
          <button type="button" className="icon-btn" onClick={() => nav('/admin/bot')} disabled={busy} aria-label="New investigation"><Icon d={I.plus} /></button>
        )}
      </aside>

      <section className="bot__chat" aria-label="Conversation">
        <header className="bot__head">
          <div className="bot__title">
            <b>{session?.title ?? 'New investigation'}</b>
            {ctx && ctx.tokens ? (
              <span className={`bot__ctx${ctx.tokens / ctx.window > 0.75 ? ' is-high' : ''}`} title="Context the model sees. Pi compacts older turns into a summary when it gets close to the limit.">
                <span className="bot__ctx-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((ctx.tokens / ctx.window) * 100))}%` }} /></span>
                {k(ctx.tokens)} / {k(ctx.window)}
              </span>
            ) : null}
            <span className={`bot__state${busy ? ' is-busy' : ''}`}>{!st ? 'Checking' : st.configured ? (busy ? 'Working' : 'Ready') : 'Needs FIREWORKS_API_KEY'}</span>
          </div>
          <div className="bot__tools">
            {st ? (
              <>
                <label htmlFor="bot-model" className="visually-hidden">Model</label>
                <select id="bot-model" className="select" value={chosen} disabled={busy} onChange={(e) => { setModel(e.target.value); try { localStorage.setItem(STORE_KEY, e.target.value); } catch { /* storage blocked */ } }}>
                  {st.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === st.model ? ' (default)' : ''}</option>)}
                </select>
              </>
            ) : null}
            {session?.ticket_key ? (
              <>
                <Link className="btn" to={`/admin/tickets/${session.ticket_key}`}>{session.ticket_key}</Link>
                <button type="button" className="btn btn--primary" disabled={!answered || busy || !st?.configured} onClick={() => send(findingsPrompt(session.ticket_key!, session.ticket_customer !== 'Internal'))}
                  title={answered ? 'The bot writes an internal note and, for a client, a draft reply' : 'Let the bot investigate first'}>Add findings to {session.ticket_key}</button>
              </>
            ) : outcome.ticket
              ? <Link className="btn btn--primary" to={`/admin/tickets/${outcome.ticket}`}>Open {outcome.ticket}</Link>
              : <button type="button" className="btn" disabled={!answered || busy || !st?.configured} onClick={() => send(CREATE_FROM_FINDINGS)}
                  title={answered ? 'Ask the bot to open a ticket with what it found' : 'Ask a question first'}>Create ticket</button>}
          </div>
        </header>

        <div className="bot__log" ref={logRef} onScroll={onScroll}>
          <div className="bot__col">
          {st && !st.hasKey ? <Setup /> : null}
          {loadingSession && !session ? <Loading /> : null}
          {session ? <Transcript messages={session.messages} /> : null}
          {live ? <LiveTurn live={live} /> : null}
          {!session?.messages.length && !live ? (
            <div className="bot__empty">
              <h2>What should we look into?</h2>
              <p>Start from a ticket, or ask anything about calls, logs and alerts.</p>
              {tickets.length ? (
                <section className="start" aria-labelledby="start-h">
                  <h3 id="start-h">Investigate a ticket</h3>
                  <div className="start__grid">
                    {tickets.map((x) => (
                      <button key={x.key} type="button" className="start-card" disabled={!st?.configured || starting !== null} onClick={() => startFromTicket(x.key)} aria-busy={starting === x.key}>
                        <span className="start-card__top"><b>{x.key}</b><span className={`st st--${x.priority}`}>{x.priority}</span></span>
                        <span className="start-card__subject">{x.subject}</span>
                        <span className="start-card__meta">{starting === x.key ? 'Starting' : x.customer ?? 'Internal'}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="start" aria-labelledby="ask-h">
                <h3 id="ask-h">Or ask</h3>
                <div className="start__grid">
                  {SUGGEST.map((s) => <button key={s} type="button" className="ask-card" onClick={() => send(s)} disabled={!st?.configured}>{s}</button>)}
                </div>
              </section>
            </div>
          ) : null}
          </div>
        </div>

        <footer className="bot__foot">
          <div className="bot__col">
          {outcome.wrote && !busy ? (
            <div className="bot__callout" role="status">
              <span><b>Findings are on {outcome.wrote}.</b> Review the note{session?.ticket_customer !== 'Internal' ? ' and send the draft reply' : ''} from the ticket.</span>
              <Link className="btn btn--primary" to={`/admin/tickets/${outcome.wrote}`}>Open {outcome.wrote}</Link>
            </div>
          ) : null}
          {outcome.proposal && !dismissed && !busy && !outcome.ticket ? (
            <div className="bot__callout bot__callout--proposal" role="region" aria-label="Ticket proposal">
              <div>
                <b>Proposed ticket: {outcome.proposal.subject}</b>
                <p>{outcome.proposal.customer ?? 'Internal'}, {outcome.proposal.priority} priority{outcome.proposal.flag_ids.length ? `, alerts ${outcome.proposal.flag_ids.join(', ')}` : ''}. {outcome.proposal.why}</p>
              </div>
              <div className="inline-actions">
                <button type="button" className="btn btn--link" onClick={() => setDismissed(true)}>Not now</button>
                <button type="button" className="btn btn--primary" onClick={() => createFromProposal(outcome.proposal!)}>Create ticket</button>
              </div>
            </div>
          ) : null}
          <form className="bot__input" onSubmit={(e: FormEvent) => { e.preventDefault(); void send(); }}>
            <label htmlFor="bot-in" className="visually-hidden">Message the debug bot</label>
            <textarea ref={inputRef} id="bot-in" className="input" rows={1} value={input} disabled={!st?.configured}
              placeholder={st?.configured ? 'Ask about a client, a call, a log pattern...' : 'Set FIREWORKS_API_KEY to enable the bot'}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            {busy ? <button type="button" className="send-btn send-btn--stop" onClick={stop} aria-label="Stop"><Icon d={I.stop} size={16} /></button>
              : <button type="submit" className="send-btn" disabled={!input.trim() || !st?.configured} aria-label="Send"><Icon d={I.send} size={18} /></button>}
          </form>
          <p className="bot__fine">Reads all portal data. Opens tickets and drafts replies; never sends to a client.</p>
          </div>
        </footer>
      </section>
      <Confirm open={Boolean(deleting)} title="Delete this investigation?" confirmLabel="Delete" onConfirm={() => deleting && remove(deleting)} onCancel={() => setDeleting(null)}>
        <p>{deleting?.title}</p>
        <p>The conversation is removed. Tickets, notes and drafts it created stay.</p>
      </Confirm>
    </div>
  );
}

function Setup() {
  return (
    <div className="bot__empty">
      <h2>Connect Fireworks to enable the bot</h2>
      <p>Add your key to <code>app/.env</code> and restart the server:</p>
      <pre className="record">{'FIREWORKS_API_KEY=fw_...\n# optional, defaults to accounts/fireworks/models/kimi-k3\nPI_MODEL=accounts/fireworks/models/kimi-k3'}</pre>
    </div>
  );
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const textOf = (c: { type: string; text?: string }[] | string) => (typeof c === 'string' ? c : c.map((x) => x.text ?? '').join('\n'));
const argLine = (a: unknown) => { const s = JSON.stringify(a ?? {}); return s === '{}' ? '' : s.length > 90 ? s.slice(0, 87) + '...' : s; };
const LABEL: Record<string, string> = {
  describe_schema: 'Read the schema', sql_query: 'Ran SQL', search_logs: 'Searched logs', get_call: 'Opened a call', list_flags: 'Listed alerts', get_flag: 'Opened an alert',
  get_ticket: 'Opened a ticket', rerun_detectors: 'Re-ran detectors', update_flag: 'Updated an alert', add_internal_note: 'Added an internal note', draft_reply: 'Drafted a reply',
  propose_ticket: 'Proposed a ticket', create_ticket: 'Created a ticket',
};

const ToolBox = memo(function ToolBox({ name, args, preview, running, isError, ticketKey }: { name: string; args: unknown; preview: string; running?: boolean; isError?: boolean; ticketKey?: string }) {
  if (ticketKey) return (
    <div className="tool tool--ticket"><span>{LABEL[name] ?? name} {name === 'create_ticket' ? '' : 'on '}<b>{ticketKey}</b></span><Link className="btn" to={`/admin/tickets/${ticketKey}`}>Open {ticketKey}</Link></div>
  );
  return (
    <details className={`tool${running ? ' tool--running' : ''}${isError ? ' tool--error' : ''}`}>
      <summary><span>{LABEL[name] ?? name}</span><code>{argLine(args)}</code>{running ? <span className="muted small">running</span> : null}</summary>
      <pre>{`${name} ${JSON.stringify(args ?? {}, null, 1)}\n\n${preview || (running ? '...' : '(no output)')}`}</pre>
    </details>
  );
});

const Transcript = memo(function Transcript({ messages }: { messages: Msg[] }) {
  const results = useMemo(() => {
    const m = new Map<string, Extract<Msg, { role: 'toolResult' }>>();
    for (const x of messages) if (x.role === 'toolResult') m.set(x.toolCallId, x);
    return m;
  }, [messages]);
  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'compactionSummary') return (
          <details key={i} className="compacted">
            <summary>Earlier turns summarised by Pi ({k(m.tokensBefore)} tokens of context before)</summary>
            <Markdown text={m.summary} />
          </details>
        );
        if (m.role === 'user') return <div key={i} className="turn-user">{textOf(m.content)}</div>;
        if (m.role !== 'assistant') return null;
        const tools = m.content.filter((b): b is Extract<Block, { type: 'toolCall' }> => b.type === 'toolCall');
        const text = m.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!tools.length && !text && m.stopReason !== 'error' && m.stopReason !== 'aborted') return null;
        return (
          <div key={i} className="turn-bot">
            {tools.length ? <div className="tool-steps">{tools.map((b) => {
              const r = results.get(b.id);
              return <ToolBox key={b.id} name={b.name} args={b.arguments} preview={r ? textOf(r.content).slice(0, 4000) : ''} isError={r?.isError} ticketKey={r?.details?.ticket_key} />;
            })}</div> : null}
            {text ? <Markdown text={text} /> : null}
            {m.stopReason === 'error' ? <p className="err">{m.errorMessage ?? 'The model returned an error.'}</p> : null}
            {m.stopReason === 'aborted' ? <p className="muted small">Stopped.</p> : null}
          </div>
        );
      })}
    </>
  );
});

function LiveTurn({ live }: { live: Live }) {
  return (
    <>
      {live.prompt ? <div className="turn-user">{live.prompt}</div> : null}
      <div className="turn-bot">
        {live.tools.length ? <div className="tool-steps">{live.tools.map((t) => <ToolBox key={t.id} name={t.name} args={t.args} preview={t.preview} running={!t.done} isError={t.isError} ticketKey={t.ticketKey} />)}</div> : null}
        {live.text ? <Markdown text={live.text} /> : null}
        {!live.error && live.prompt && (live.thinking || !live.text) ? (
          <p className="bot__working" aria-live="polite"><span className="bot__dots keep-motion" aria-hidden="true"><i /><i /><i /></span>{live.tools.some((t) => !t.done) ? 'Running a tool' : live.thinking ? 'Thinking' : 'Investigating'}</p>
        ) : null}
        {live.error ? <p className="err" role="alert">{live.error}</p> : null}
      </div>
    </>
  );
}
