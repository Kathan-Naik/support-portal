import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiForm, useApi } from '../api.ts';
import { useMe } from '../App.tsx';
import { PageHead, Region, Empty, St, Sev, Confirm, Tabs, useToast } from '../components/ui.tsx';
import { when, ago } from '../format.ts';

type T = { id: number; key: string; subject: string; category: string; status: string; priority: string; created_at: string; updated_at: string; customer: string | null; customer_id: string | null; origin?: string; alerts?: number; top_severity?: string | null;
  created_by_name: string; created_by_role: string; assignee: string | null; messages: number; last_public_role: string | null; drafts?: number; unread: number };
type File_ = { id: number; filename: string; mime: string; size: number };
type Msg = { id: number; body: string; internal: number; status: 'draft' | 'sent'; author_kind: string; created_at: string; read_at: string | null; author: string | null; author_role: string | null; author_title: string | null; attachments: File_[] };
type Alert = { id: number; rule: string; severity: string; title: string; status: string; count: number; customer: string | null };
type Example = { caller: string; phone_last4: string; when: string; what: string };
type Evidence = { started_at?: string; examples?: Example[] };
type Full = Omit<T, 'alerts'> & { booking_system: string; timezone: string; assignee_id: number | null; messages: Msg[]; alerts?: Alert[]; evidence: Evidence | null; investigations?: { id: number; title: string; updated_at: string }[] };

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv';

// ---- list ---------------------------------------------------------------------------
export function TicketsPage() {
  const { me } = useMe();
  const admin = me.role === 'admin';
  const base = admin ? '/admin' : '/portal';
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const q = useApi<T[]>(`/tickets?status=${status}`);
  const setStatus = (v: string) => { const n = new URLSearchParams(sp); if (v) n.set('status', v); else n.delete('status'); setSp(n, { replace: true }); };
  return (
    <>
      <PageHead title="Tickets" lead={admin ? 'Every conversation with a client happens on a ticket. Waiting on us first.' : 'Your conversations with our support team.'}>
        <Link className="btn btn--primary" to={`${base}/tickets/new`}>{admin ? 'Message a client' : 'New ticket'}</Link>
      </PageHead>
      <div className="toolbar">
        <Tabs label="Ticket status" value={status as '' | 'open' | 'pending' | 'resolved' | 'closed'} onChange={setStatus}
          tabs={[{ id: '', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'pending', label: admin ? 'Pending' : 'Waiting on you' }, { id: 'resolved', label: 'Resolved' }, { id: 'closed', label: 'Closed' }]} />
      </div>
      <Region q={q} isEmpty={(d) => !d.length} empty={<Empty title={status ? 'Nothing here.' : 'No tickets yet.'} action={<Link className="btn" to={`${base}/tickets/new`}>{admin ? 'Message a client' : 'Open a ticket'}</Link>}>{admin ? 'Clients open tickets from their portal, or you can start one.' : 'If something looks wrong with your calls or bookings, tell us here.'}</Empty>}>{(d) => (
        <div className="panel"><div className="rows">
          {d.map((t) => {
            const waiting = admin ? (t.customer_id ? t.last_public_role !== 'admin' : true) && ['open', 'pending'].includes(t.status) || Boolean(t.drafts) : t.unread > 0;
            const meta = admin
              ? [t.key, t.customer ?? 'Internal', t.origin === 'bot' ? 'opened by debug bot' : t.created_by_role === 'admin' ? 'started by support' : null, `updated ${ago(t.updated_at)}`, t.alerts ? `${t.alerts} alert${t.alerts > 1 ? 's' : ''}` : null, t.drafts ? `${t.drafts} draft${t.drafts > 1 ? 's' : ''} waiting` : null]
              : [t.key, `updated ${ago(t.updated_at)}`, t.unread ? `${t.unread} new repl${t.unread > 1 ? 'ies' : 'y'}` : null];
            return (
              <Link key={t.key} className="row" to={`${base}/tickets/${t.key}`}>
                <div>
                  <div className="row__title">{waiting ? <span className="unread-dot" aria-label={admin ? 'Waiting on support' : 'New reply'} /> : null} {t.subject}</div>
                  <div className="row__meta">{meta.filter(Boolean).join(', ')}</div>
                </div>
                <div className="row__side">{admin && t.top_severity ? <Sev s={t.top_severity} /> : null}{admin ? <St s={t.priority} /> : null}<St s={t.status} label={!admin && t.status === 'pending' ? 'waiting on you' : t.status} /></div>
              </Link>
            );
          })}
        </div></div>
      )}</Region>
    </>
  );
}

// ---- files picker -------------------------------------------------------------------------
function FilePicker({ files, onChange, id }: { files: File[]; onChange: (f: File[]) => void; id: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const add = (list: FileList | null) => { if (list) onChange([...files, ...Array.from(list)].slice(0, 6)); };
  return (
    <div className="files">
      <div className={`drop${over ? ' is-over' : ''}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
        <span>Drop screenshots or exports here, or</span>
        <button type="button" className="btn btn--link" onClick={() => ref.current?.click()}>choose files</button>
        <input ref={ref} id={id} type="file" multiple accept={ACCEPT} className="visually-hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <small>Images, PDF, text or CSV. Up to 6 files, 8 MB each.</small>
      </div>
      {files.length ? (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="file-chip"><span>{f.name}</span><small>{size(f.size)}</small>
              <button type="button" className="file-chip__x" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>Remove</button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const blankExample = (): Example => ({ caller: '', phone_last4: '', when: '', what: '' });

// ---- new ticket ------------------------------------------------------------------------------
export function NewTicket() {
  const { me } = useMe();
  const admin = me.role === 'admin';
  const base = admin ? '/admin' : '/portal';
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useToast();
  const customers = useApi<{ id: string; name: string }[]>(admin ? '/customers' : null);
  const flag = sp.get('flag');
  const [f, setF] = useState({ subject: sp.get('subject') ?? '', body: '', category: admin ? 'general' : 'bookings', priority: flag ? 'high' : 'normal', customer_id: sp.get('customer') ?? '' });
  const [startedAt, setStartedAt] = useState('');
  const [examples, setExamples] = useState<Example[]>(admin ? [] : [blankExample()]);
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setEx = (i: number, k: keyof Example, v: string) => setExamples(examples.map((e, j) => (j === i ? { ...e, [k]: v } : e)));

  const submit = async (draft: boolean) => {
    setErr('');
    if (!f.subject.trim() || !f.body.trim()) { setErr(admin ? 'Add a subject and a message.' : 'Add a short summary and describe what happened.'); return; }
    if (admin && !f.customer_id) { setErr('Pick a client, or choose an internal ticket.'); return; }
    setBusy(true);
    try {
      const evidence = { started_at: startedAt, examples: examples.filter((e) => e.caller || e.phone_last4 || e.when || e.what) };
      const r = await apiForm<{ key: string }>('/tickets', {
        ...f, customer_id: f.customer_id === 'internal' ? '' : f.customer_id, draft: admin ? draft : undefined,
        flag_ids: flag ? [Number(flag)] : undefined, evidence,
      }, files);
      toast(draft ? `${r.key} opened with a draft. The client sees it once you send.` : `${r.key} opened.`);
      nav(`${base}/tickets/${r.key}`);
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead crumb={<Link className="crumb" to={`${base}/tickets`}>Tickets</Link>} title={admin ? 'Message a client' : 'New ticket'}
        lead={admin ? 'Starts a ticket the client sees in their portal, with your message as the first post.' : 'The more specific you are, the faster we can fix it.'} />
      <div className="grid grid-main">
        <form className="ticket-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(false); }} noValidate>
          <section className="form-step">
            <h2><span className="step-n">1</span> What’s wrong</h2>
            {admin ? (
              <div className="field"><label htmlFor="n-c">For</label>
                <select id="n-c" className="select" value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })}>
                  <option value="">Pick a client</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="internal">Internal ticket (no client)</option></select></div>
            ) : null}
            <div className="field"><label htmlFor="n-s">Summary</label>
              <input id="n-s" className="input" required maxLength={160} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder={admin ? 'An update on your bookings' : 'Patients say they booked, but nothing is in our calendar'} /></div>
            <div className="fields">
              <div className="field"><label htmlFor="n-cat">Topic</label>
                <select id="n-cat" className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                  <option value="bookings">Bookings and calendar</option><option value="calls">How the assistant handled a call</option><option value="billing">Billing</option><option value="general">Something else</option>
                </select></div>
              <div className="field"><label htmlFor="n-p">How urgent</label>
                <select id="n-p" className="select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                  <option value="urgent">Urgent: affecting patients or customers now</option><option value="high">High: needs attention today</option><option value="normal">Normal</option><option value="low">Low: a question</option>
                </select></div>
            </div>
            <div className="field"><label htmlFor="n-b">{admin ? 'Message' : 'What happened'}</label>
              <textarea id="n-b" className={`input${admin ? ' input--tall' : ''}`} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })}
                placeholder={admin ? '' : 'What did you expect, and what happened instead? Who noticed?'} /></div>
            {flag ? <p className="small muted">Alert {flag} will be linked to this ticket.</p> : null}
          </section>

          <section className="form-step">
            <h2><span className="step-n">2</span> Evidence <small>optional, but it helps</small></h2>
            <div className="field" style={{ maxWidth: '20rem' }}><label htmlFor="n-start">When did it start?</label>
              <input id="n-start" className="input" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} /></div>
            <div className="field">
              <span className="label">Example calls</span>
              <p className="small muted">A caller this happened to. Last 4 digits of their number are enough.</p>
              <div className="examples">
                {examples.map((ex, i) => (
                  <fieldset key={i} className="example">
                    <legend className="visually-hidden">Example call {i + 1}</legend>
                    <div className="field"><label htmlFor={`ex-c-${i}`}>Caller</label><input id={`ex-c-${i}`} className="input" value={ex.caller} onChange={(e) => setEx(i, 'caller', e.target.value)} placeholder="Tom Chen" /></div>
                    <div className="field"><label htmlFor={`ex-p-${i}`}>Last 4 digits</label><input id={`ex-p-${i}`} className="input" inputMode="numeric" maxLength={4} value={ex.phone_last4} onChange={(e) => setEx(i, 'phone_last4', e.target.value.replace(/\D/g, ''))} placeholder="9745" /></div>
                    <div className="field"><label htmlFor={`ex-w-${i}`}>Roughly when</label><input id={`ex-w-${i}`} className="input" value={ex.when} onChange={(e) => setEx(i, 'when', e.target.value)} placeholder="Sat morning" /></div>
                    <div className="field example__what"><label htmlFor={`ex-t-${i}`}>What they were told</label><input id={`ex-t-${i}`} className="input" value={ex.what} onChange={(e) => setEx(i, 'what', e.target.value)} placeholder="Booked Mon 11:45 with Dr. Alvarez, not in our calendar" /></div>
                    <button type="button" className="btn btn--link example__x" onClick={() => setExamples(examples.filter((_, j) => j !== i))} aria-label={`Remove example call ${i + 1}`}>Remove</button>
                  </fieldset>
                ))}
              </div>
              {examples.length < 10 ? <button type="button" className="btn" onClick={() => setExamples([...examples, blankExample()])}>Add a call</button> : null}
            </div>
            <div className="field"><label htmlFor="n-files">Attachments</label><FilePicker id="n-files" files={files} onChange={setFiles} /></div>
          </section>

          <p className="err" role="alert" aria-live="polite">{err}</p>
          <div className="composer__foot">
            <span className="muted small">{admin ? 'Sending makes it visible in the client’s portal.' : 'We usually reply within a business hour.'}</span>
            <div className="inline-actions">
              {admin ? <button type="button" className="btn" disabled={busy} onClick={() => submit(true)}>Save as draft</button> : null}
              <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>{busy ? 'Sending' : admin ? 'Send to client' : 'Open ticket'}</button>
            </div>
          </div>
        </form>
        {!admin ? (
          <aside className="panel tips">
            <h2>What helps us most</h2>
            <ul>
              <li><b>One caller it happened to.</b> Name and the last 4 digits find the exact call.</li>
              <li><b>Roughly when.</b> “Since last Monday” is enough.</li>
              <li><b>What they were told</b> beside what you see in your calendar.</li>
              <li><b>A screenshot</b> of the calendar day, if you can.</li>
            </ul>
          </aside>
        ) : null}
      </div>
    </>
  );
}

// ---- evidence and files on a ticket ---------------------------------------------------------------
function EvidencePanel({ ev, admin, customerId, timezone }: { ev: Evidence; admin: boolean; customerId: string | null; timezone?: string }) {
  const started = ev.started_at ? (/^\d{4}-\d{2}-\d{2}T/.test(ev.started_at) ? when(new Date(ev.started_at).toISOString(), timezone) : ev.started_at) : null;
  return (
    <section className="panel evidence" aria-labelledby="ev-h">
      <div className="panel__head"><h2 id="ev-h">Evidence</h2>{started ? <span className="muted">Started {started}</span> : null}</div>
      {ev.examples?.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Caller</th><th scope="col">Last 4</th><th scope="col">When</th><th scope="col">What they were told</th>{admin ? <th scope="col"><span className="visually-hidden">Find</span></th> : null}</tr></thead>
          <tbody>{ev.examples.map((e, i) => (
            <tr key={i}><td>{e.caller || '-'}</td><td className="mono">{e.phone_last4 || '-'}</td><td>{e.when || '-'}</td><td>{e.what || '-'}</td>
              {admin ? <td className="nowrap">{(e.phone_last4 || e.caller) && customerId ? <Link to={`/admin/alerts/calls?customer=${customerId}&q=${encodeURIComponent(e.phone_last4 || e.caller)}`}>Find in calls</Link> : null}</td> : null}</tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted small">No example calls given.</p>}
    </section>
  );
}

function Attachments({ files }: { files: File_[] }) {
  if (!files.length) return null;
  return (
    <ul className="file-list">
      {files.map((f) => (
        <li key={f.id}>
          <a className="file-chip file-chip--link" href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">
            {f.mime.startsWith('image/') ? <img src={`/api/attachments/${f.id}`} alt="" width="40" height="40" /> : null}
            <span>{f.filename}</span><small>{size(f.size)}</small>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ---- ticket detail ---------------------------------------------------------------------------------
type Mode = 'reply' | 'note';

export function TicketDetail() {
  const { key } = useParams();
  const { me } = useMe();
  const admin = me.role === 'admin';
  const base = admin ? '/admin' : '/portal';
  const nav = useNavigate();
  const q = useApi<Full>(`/tickets/${key}`);
  const users = useApi<{ id: number; name: string; role: string }[]>(admin ? '/users' : null);
  const toast = useToast();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<Mode>('reply');
  // An internal ticket has no client to reply to: only notes.
  useEffect(() => { if (q.data && !q.data.customer_id) setMode('note'); }, [q.data]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [sending, setSending] = useState<Msg | null>(null);

  const post = async (draft: boolean) => {
    setBusy(true); setErr('');
    try {
      await apiForm(`/tickets/${key}/messages`, { body, internal: mode === 'note', draft }, files);
      setBody(''); setFiles([]); toast(mode === 'note' ? 'Internal note added.' : draft ? 'Draft saved on the ticket.' : 'Reply sent.'); q.reload();
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); }
  };
  const patch = async (b: object, msg: string) => { try { await api(`/tickets/${key}`, { method: 'PATCH', body: b }); toast(msg); q.reload(); } catch (x) { toast(x instanceof Error ? x.message : String(x)); } };
  const draftAction = async (m: Msg, action: 'send' | 'save' | 'discard') => {
    try {
      if (action === 'send') await api(`/tickets/${key}/messages/${m.id}/send`, { method: 'POST' });
      if (action === 'save' && editing) await api(`/tickets/${key}/messages/${m.id}`, { method: 'PATCH', body: { body: editing.body } });
      if (action === 'discard') await api(`/tickets/${key}/messages/${m.id}`, { method: 'DELETE' });
      toast(action === 'send' ? 'Sent. The client sees it now.' : action === 'save' ? 'Draft updated.' : 'Draft discarded.');
      setEditing(null); setSending(null); q.reload();
    } catch (x) { toast(x instanceof Error ? x.message : String(x)); }
  };
  const investigate = async () => {
    try {
      const r = await api<{ id: number }>('/bot/sessions', { body: { ticket_key: key } });
      nav(`/admin/bot/${r.id}?start=1`);
    } catch (x) { toast(x instanceof Error ? x.message : String(x)); }
  };

  return (
    <Region q={q} rows={8}>{(t) => (
      <>
        <PageHead crumb={<Link className="crumb" to={`${base}/tickets`}>Tickets</Link>} title={t.subject}
          lead={<>{t.key}{admin ? `, ${t.customer ?? 'internal'}` : ''}, opened {when(t.created_at, admin ? undefined : t.timezone)} by {t.created_by_role === 'admin' && !admin ? 'Support' : t.created_by_name}</>}>
          {admin ? <button type="button" className="btn btn--primary" onClick={investigate}>Investigate with debug bot</button> : null}
          {!admin ? (t.status === 'resolved' || t.status === 'closed'
            ? <button type="button" className="btn" onClick={() => patch({ status: 'open' }, 'Ticket reopened.')}>Reopen</button>
            : <button type="button" className="btn" onClick={() => patch({ status: 'resolved' }, 'Marked resolved. Thanks.')}>Mark resolved</button>) : null}
        </PageHead>
        <div className="grid grid-main">
          <div className="stack">
            {t.evidence ? <EvidencePanel ev={t.evidence} admin={admin} customerId={t.customer_id} timezone={t.timezone} /> : null}
            <div className="thread">
              {t.messages.map((m) => {
                const draft = m.status === 'draft';
                const fromSupport = m.author_role === 'admin' || m.author_kind === 'bot';
                return (
                  <article key={m.id} className={`msg${m.internal ? ' msg--internal' : ''}${draft ? ' msg--draft' : ''}${!draft && !m.internal && fromSupport === admin ? ' msg--mine' : ''}`}>
                    <div className="msg__head">
                      <b>{m.author_kind === 'bot' ? 'Debug bot' : !admin && fromSupport ? 'Support' : m.author ?? 'Unknown'}</b>
                      {admin ? <span className="muted">{fromSupport ? (m.author_kind === 'bot' ? 'Automated' : 'Support') : t.customer}</span> : null}
                      <span className="muted">{when(m.created_at, admin ? undefined : t.timezone)}</span>
                      {m.internal ? <span className="msg__tag">Internal, client cannot see</span> : null}
                      {draft ? <span className="msg__tag msg__tag--draft">Draft, not sent</span> : null}
                      {admin && !draft && !m.internal && fromSupport ? <span className="msg__read">{m.read_at ? `Read ${ago(m.read_at)}` : 'Not read yet'}</span> : null}
                    </div>
                    {editing?.id === m.id ? (
                      <div className="field"><label htmlFor={`ed-${m.id}`} className="visually-hidden">Edit draft</label>
                        <textarea id={`ed-${m.id}`} className="input input--tall" value={editing.body} onChange={(e) => setEditing({ id: m.id, body: e.target.value })} /></div>
                    ) : <div className="msg__body">{m.body}</div>}
                    <Attachments files={m.attachments ?? []} />
                    {admin && draft ? (
                      <div className="msg__actions">
                        {editing?.id === m.id ? (
                          <>
                            <button type="button" className="btn" onClick={() => draftAction(m, 'save')} disabled={!editing.body.trim()}>Save draft</button>
                            <button type="button" className="btn btn--link" onClick={() => setEditing(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn btn--primary" onClick={() => setSending(m)}>Send to {t.customer}</button>
                            <button type="button" className="btn" onClick={() => setEditing({ id: m.id, body: m.body })}>Edit</button>
                            <button type="button" className="btn btn--link" onClick={() => draftAction(m, 'discard')}>Discard</button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <form className="composer" onSubmit={(e) => { e.preventDefault(); void post(false); }}>
              {admin && t.customer_id ? <Tabs label="Message type" value={mode} onChange={setMode} tabs={[{ id: 'reply', label: `Reply to ${t.customer}` }, { id: 'note', label: 'Internal note' }]} /> : null}
              <div className="field"><label htmlFor="reply" className={admin ? 'visually-hidden' : undefined}>{mode === 'note' ? 'Internal note' : admin ? `Reply to ${t.customer}` : 'Reply'}</label>
                <textarea id="reply" className="input" value={body} onChange={(e) => setBody(e.target.value)}
                  placeholder={mode === 'note' ? 'Only support staff will see this' : admin ? 'The client sees this on their ticket' : 'Add more detail, or answer our question'} /></div>
              <FilePicker id="reply-files" files={files} onChange={setFiles} />
              <p className="err" aria-live="polite">{err}</p>
              <div className="composer__foot">
                <span className="muted small">{!admin ? 'Replying reopens the ticket.' : mode === 'note' ? 'Staff only. Never shown to the client.' : 'Sending sets the ticket to pending.'}</span>
                <div className="inline-actions">
                  {admin && mode === 'reply' ? <button type="button" className="btn" disabled={busy || !body.trim()} onClick={() => post(true)}>Save draft</button> : null}
                  <button type="submit" className={`btn${mode === 'note' ? '' : ' btn--primary'}`} disabled={busy || (!body.trim() && !files.length)} aria-busy={busy}>{mode === 'note' ? 'Add note' : 'Send reply'}</button>
                </div>
              </div>
            </form>
          </div>
          <aside className="stack">
            <section className="panel">
              <dl className="kv kv--one">
                <div><dt>Status</dt><dd><St s={t.status} label={!admin && t.status === 'pending' ? 'waiting on you' : t.status} /></dd></div>
                {admin ? <div><dt>Priority</dt><dd><St s={t.priority} /></dd></div> : null}
                <div><dt>Topic</dt><dd>{t.category}</dd></div>
              </dl>
              {admin ? (
                <div className="stack mt">
                  <div className="field"><label htmlFor="tk-st">Status</label>
                    <select id="tk-st" className="select" value={t.status} onChange={(e) => patch({ status: e.target.value }, `Status set to ${e.target.value}.`)}>{['open', 'pending', 'resolved', 'closed'].map((s) => <option key={s}>{s}</option>)}</select></div>
                  <div className="field"><label htmlFor="tk-p">Priority</label>
                    <select id="tk-p" className="select" value={t.priority} onChange={(e) => patch({ priority: e.target.value }, `Priority set to ${e.target.value}.`)}>{['urgent', 'high', 'normal', 'low'].map((s) => <option key={s}>{s}</option>)}</select></div>
                  <div className="field"><label htmlFor="tk-a">Assignee</label>
                    <select id="tk-a" className="select" value={t.assignee_id ?? ''} onChange={(e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null }, 'Assignee updated.')}>
                      <option value="">Unassigned</option>{users.data?.filter((u) => u.role === 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
                </div>
              ) : null}
            </section>
            {admin ? (
              <section className="panel">
                <div className="panel__head"><h2>Alerts</h2><Link to="/admin/alerts">All alerts</Link></div>
                {t.alerts?.length ? (
                  <div className="rows">{t.alerts.map((a) => (
                    <Link key={a.id} className="row" to={`/admin/alerts/flags/${a.id}`}><div><div className="row__title">{a.title}</div><div className="row__meta">{a.customer ?? 'all clients'}, {a.status}</div></div><div className="row__side"><Sev s={a.severity} /></div></Link>
                  ))}</div>
                ) : <p className="muted small">No alerts linked yet. The debug bot links them when it investigates.</p>}
              </section>
            ) : null}
            {admin ? (
              <section className="panel">
                <div className="panel__head"><h2>Investigations</h2></div>
                {t.investigations?.length ? (
                  <div className="rows">{t.investigations.map((s) => (
                    <Link key={s.id} className="row" to={`/admin/bot/${s.id}`}><div><div className="row__title">{s.title}</div><div className="row__meta">updated {ago(s.updated_at)}</div></div></Link>
                  ))}</div>
                ) : <p className="muted small">None yet.</p>}
                <div className="actions"><button type="button" className="btn" onClick={investigate}>Start an investigation</button></div>
              </section>
            ) : null}
          </aside>
        </div>
        <Confirm open={Boolean(sending)} title={`Send to ${t.customer}?`} confirmLabel="Send now" onConfirm={() => sending && draftAction(sending, 'send')} onCancel={() => setSending(null)}>
          <p>It appears on their ticket immediately and cannot be edited after.</p>
        </Confirm>
      </>
    )}</Region>
  );
}
