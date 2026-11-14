import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useApi } from '../../api.ts';
import { PageHead, Region, Sev, St, Empty, Markdown, useToast } from '../../components/ui.tsx';
import { when } from '../../format.ts';

type Flag = { id: number; rule: string; severity: string; customer_id: string; customer: string; title: string; summary: string; count: number; first_seen: string; last_seen: string; status: string; ticket_key: string | null; ticket_subject: string | null; ticket_status: string | null };
type FlagFull = Flag & { analysis: string; recommendation: string; evidence: Record<string, unknown>; timezone: string };

const RULES: Record<string, string> = {
  auth_refresh_failing: 'Token refresh failing', dead_letter_writes: 'Dead-lettered writes', said_not_written: 'Said but not written',
  duplicate_ingest: 'Duplicate call records', webhook_ack_timeout: 'Webhook ack timeouts', upstream_5xx: 'Upstream 5xx', intent_mismatch: 'Intent disagrees with outcome',
};

export function FlagsPage() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const customer = sp.get('customer') ?? '';
  const q = useApi<Flag[]>(`/flags?status=${status}&customer=${customer}`);
  const customers = useApi<{ id: string; name: string }[]>('/customers');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const rescan = async () => {
    setBusy(true);
    try { const r = await api<{ flags: number }>('/flags/rescan', { method: 'POST' }); toast(`Detectors re-run: ${r.flags} findings.`); q.reload(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead title="Alerts" lead="Patterns the detectors found in calls and integration logs, each with its evidence and the ticket handling it.">
        <button type="button" className="btn" onClick={rescan} aria-busy={busy} disabled={busy}>Re-run detectors</button>
      </PageHead>
      <div className="toolbar">
        <div className="field"><label htmlFor="f-status">Status</label>
          <select id="f-status" className="select" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Not resolved</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option>
          </select></div>
        <div className="field"><label htmlFor="f-cust">Client</label>
          <select id="f-cust" className="select" value={customer} onChange={(e) => set('customer', e.target.value)}>
            <option value="">All clients</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
      </div>
      <Region q={q} rows={6} isEmpty={(d) => !d.length} empty={<Empty title="No alerts match.">Change the filters, or re-run the detectors.</Empty>}>{(d) => (
        <div className="panel">
          <div className="table-wrap">
            <table className="calls">
              <thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col">Client</th><th scope="col">Count</th><th scope="col">Last seen</th><th scope="col">Ticket</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {d.map((f) => (
                  <tr key={f.id} className={f.severity === 'critical' && f.status !== 'resolved' ? 'is-mismatch' : ''}>
                    <td data-label="Severity"><Sev s={f.severity} /></td>
                    <td data-label="Finding"><Link to={`/admin/alerts/flags/${f.id}`} className="row__title">{f.title}</Link><small>{RULES[f.rule] ?? f.rule}</small></td>
                    <td data-label="Client">{f.customer}</td>
                    <td data-label="Count">{f.count}</td>
                    <td data-label="Last seen">{when(f.last_seen)}</td>
                    <td data-label="Ticket">{f.ticket_key ? <Link to={`/admin/tickets/${f.ticket_key}`}>{f.ticket_key}</Link> : <span className="muted">none</span>}</td>
                    <td data-label="Status"><St s={f.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}</Region>
    </>
  );
}

export function FlagDetail() {
  const { id } = useParams();
  const q = useApi<FlagFull>(`/flags/${id}`);
  const tickets = useApi<{ key: string; subject: string; customer: string | null; status: string }[]>('/tickets');
  const toast = useToast();
  const nav = useNavigate();
  const patch = async (body: object, msg: string) => {
    try { await api(`/flags/${id}`, { method: 'PATCH', body }); toast(msg); q.reload(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Region q={q} rows={10}>{(f) => (
      <>
        <PageHead crumb={<Link className="crumb" to="/admin/alerts">Alerts</Link>} title={f.title} lead={<>{f.customer}, {RULES[f.rule] ?? f.rule}, seen {when(f.first_seen, f.timezone)} to {when(f.last_seen, f.timezone)}</>}>
          {f.status !== 'acknowledged' && f.status !== 'resolved' ? <button type="button" className="btn" onClick={() => patch({ status: 'acknowledged' }, 'Alert acknowledged.')}>Acknowledge</button> : null}
          {f.status !== 'resolved' ? <button type="button" className="btn" onClick={() => patch({ status: 'resolved' }, 'Alert resolved.')}>Resolve</button> : <button type="button" className="btn" onClick={() => patch({ status: 'open' }, 'Alert reopened.')}>Reopen</button>}
          <button type="button" className="btn btn--primary" onClick={() => nav(`/admin/bot?ask=${encodeURIComponent(`Investigate alert ${f.id} (${f.title}) for ${f.customer}. Verify the evidence against the logs and calls, tell me anything the analysis misses, and propose a ticket if one is needed.`)}`)}>Ask the debug bot</button>
        </PageHead>
        <div className="grid grid-main">
          <div className="stack">
            <section className={`panel${f.severity === 'critical' ? ' panel--owed' : ''}`}>
              <div className="panel__head"><h2>What is happening</h2><Sev s={f.severity} /></div>
              <p>{f.summary}</p>
            </section>
            <section className="panel"><div className="panel__head"><h2>Analysis</h2></div><Markdown text={f.analysis} /></section>
            <section className="panel"><div className="panel__head"><h2>Recommendation</h2></div><Markdown text={f.recommendation} /></section>
            <section className="panel"><div className="panel__head"><h2>Evidence</h2><span className="muted">Computed by the detector</span></div>
              <Evidence ev={f.evidence} />
            </section>
          </div>
          <div className="stack">
            <section className="panel">
              <dl className="kv kv--one">
                <div><dt>Status</dt><dd><St s={f.status} /></dd></div>
                <div><dt>Count</dt><dd>{f.count}</dd></div>
                <div><dt>Rule</dt><dd className="mono">{f.rule}</dd></div>
                <div><dt>Ticket</dt><dd>{f.ticket_key ? <><Link to={`/admin/tickets/${f.ticket_key}`}>{f.ticket_key}</Link>: {f.ticket_subject}</> : 'none'}</dd></div>
              </dl>
              <div className="field mt">
                <label htmlFor="link-tk">Handled by ticket</label>
                <select id="link-tk" className="select" value={f.ticket_key ?? ''} onChange={(e) => patch({ ticket_key: e.target.value || null }, e.target.value ? `Linked to ${e.target.value}.` : 'Unlinked.')}>
                  <option value="">No ticket</option>{tickets.data?.map((t) => <option key={t.key} value={t.key}>{t.key}: {t.subject} ({t.customer ?? 'internal'})</option>)}
                </select>
              </div>
              {!f.ticket_key ? (
                <div className="actions">
                  <Link className="btn" to={`/admin/tickets/new?customer=${f.customer_id}&flag=${f.id}&subject=${encodeURIComponent(f.title)}`}>Open a ticket for this</Link>
                </div>
              ) : null}
            </section>
            {Array.isArray(f.evidence.call_ids) ? (
              <section className="panel"><div className="panel__head"><h2>Calls</h2></div>
                <Link className="btn" to={`/admin/alerts/calls?customer=${f.customer_id}${f.rule === 'said_not_written' ? '&followUp=1' : f.rule === 'intent_mismatch' ? '&mismatch=1' : ''}`}>Open these {(f.evidence.call_ids as unknown[]).length} calls</Link>
              </section>
            ) : null}
            <section className="panel"><div className="panel__head"><h2>Logs</h2></div>
              <Link className="btn" to={`/admin/alerts/logs?customer=${f.customer_id}&problems=1`}>Open problem lines for {f.customer}</Link>
            </section>
          </div>
        </div>
      </>
    )}</Region>
  );
}

function Evidence({ ev }: { ev: Record<string, unknown> }) {
  const lines = (ev.sample_lines ?? ev.lines) as string[] | undefined;
  const groups = ev.groups as { sid: string; records: string[]; retry_gaps_sec: number[]; ack_timeout_logged: boolean; appointment_id: string | null }[] | undefined;
  const confirmations = ev.confirmations as { call_id: string; line: string }[] | undefined;
  const events = ev.events as { ts: string; op: string; status: string; appointment_id: string; recovered: boolean }[] | undefined;
  const scalar = Object.entries(ev).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  const maps = Object.entries(ev).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  return (
    <div className="stack">
      {scalar.length ? <dl className="kv">{scalar.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></div>)}</dl> : null}
      {maps.length ? <dl className="kv">{maps.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{Object.entries(v as object).map(([a, b]) => `${a}: ${b}`).join(', ')}</dd></div>)}</dl> : null}
      {lines ? <pre className="record">{lines.join('\n')}</pre> : null}
      {groups ? (
        <div className="table-wrap"><table><thead><tr><th scope="col">Telephony sid</th><th scope="col">Records</th><th scope="col">Retry gaps</th><th scope="col">Timeout logged</th></tr></thead>
          <tbody>{groups.map((g) => <tr key={g.sid}><td className="mono">{g.sid.slice(0, 14)}</td><td>{g.records.join(', ')}</td><td>{g.retry_gaps_sec.map((s) => `${Math.round(s / 60)} min`).join(', ')}</td><td>{g.ack_timeout_logged ? 'yes' : <b className="wr wr--failed">no</b>}</td></tr>)}</tbody></table></div>
      ) : null}
      {confirmations ? (
        <div className="table-wrap"><table><thead><tr><th scope="col">Call</th><th scope="col">What the agent told the caller</th></tr></thead>
          <tbody>{confirmations.map((c) => <tr key={c.call_id}><td className="nowrap">{c.call_id}</td><td>{c.line.replace(/^Agent:\s*/, '')}</td></tr>)}</tbody></table></div>
      ) : null}
      {events ? (
        <div className="table-wrap"><table><thead><tr><th scope="col">Time</th><th scope="col">Op</th><th scope="col">Status</th><th scope="col">Recovered</th></tr></thead>
          <tbody>{events.map((e) => <tr key={e.ts}><td>{when(e.ts)}</td><td>{e.op}</td><td>{e.status}</td><td>{e.recovered ? <span className="wr wr--written">yes</span> : <span className="wr wr--failed">no</span>}</td></tr>)}</tbody></table></div>
      ) : null}
      {!lines && !groups && !confirmations && !events && Array.isArray(ev.appointment_ids) ? <p className="small muted mono">{(ev.appointment_ids as string[]).join(', ')}</p> : null}
    </div>
  );
}
