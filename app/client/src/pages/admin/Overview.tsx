import { Link } from 'react-router-dom';
import { useApi } from '../../api.ts';
import { PageHead, Region, Sev, St, Empty } from '../../components/ui.tsx';
import { when, ago } from '../../format.ts';

type Ov = {
  flags: { severity: string; n: number }[];
  topFlags: { id: number; rule: string; severity: string; title: string; status: string; last_seen: string; customer: string; ticket_key: string | null }[];
  critical: { customer_id: string; customer: string; alerts: number; since: string; ticket_key: string | null; ticket_subject: string | null }[];
  tickets: { key: string; subject: string; status: string; priority: string; updated_at: string; customer: string; last_public_role: string | null; drafts: number }[];
  drafts: number;
  customers: { id: string; name: string; booking_system: string; health: { level: string; criticalFlags: number; otherFlags: number }; calls: number; saved: number; follow_up: number; duplicates: number; lastWrite: string | null }[];
  logRange: { first: string; last: string; n: number };
};

const HEALTH: Record<string, string> = { down: 'Writes failing', degraded: 'Degraded', ok: 'Healthy' };

export function AdminOverview() {
  const q = useApi<Ov>('/overview');
  return (
    <>
      <PageHead title="Overview" lead="What needs a person now, across every client." />
      <Region q={q} rows={8}>{(d) => {
        const n = (s: string) => d.flags.find((f) => f.severity === s)?.n ?? 0;
        const followUp = d.customers.reduce((a, c) => a + (c.follow_up ?? 0), 0);
        const waiting = d.tickets.filter((t) => t.last_public_role !== 'admin');
        return (
          <>
            {d.critical.map((c) => (
              <div className="banner" key={c.customer_id}>
                <div><b>{c.customer}: {c.alerts} critical alert{c.alerts > 1 ? 's' : ''}.</b> <span>{c.ticket_subject ?? 'No ticket yet'}</span><p>Since {when(c.since)}, {ago(c.since)}.</p></div>
                {c.ticket_key
                  ? <Link className="btn btn--primary" to={`/admin/tickets/${c.ticket_key}`}>Open {c.ticket_key}</Link>
                  : <Link className="btn btn--primary" to={`/admin/alerts?customer=${c.customer_id}`}>See alerts</Link>}
              </div>
            ))}
            <div className="tally">
              <div><b className={n('critical') ? 'owed' : ''}>{n('critical')}</b><span>critical alerts open</span></div>
              <div><b className={followUp ? 'owed' : ''}>{followUp}</b><span>callers told a change was made that was not</span></div>
              <div><b>{waiting.length}</b><span>tickets waiting on support</span></div>
              <div><b>{d.drafts}</b><span>draft replies waiting to be sent</span></div>
            </div>
            <div className="grid grid-main">
              <div className="stack">
                <section className="panel" aria-labelledby="cust-h">
                  <div className="panel__head"><h2 id="cust-h">Clients</h2><span className="muted">Log covers {when(d.logRange.first, undefined, { date: true })} to {when(d.logRange.last, undefined, { date: true })}</span></div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th scope="col">Client</th><th scope="col">Booking writes</th><th scope="col">Calls</th><th scope="col">Saved</th><th scope="col">Follow up</th><th scope="col">Last accepted write</th></tr></thead>
                      <tbody>
                        {d.customers.map((c) => (
                          <tr key={c.id}>
                            <td><b>{c.name}</b><small>{c.booking_system}</small></td>
                            <td><St s={c.health.level} label={HEALTH[c.health.level]} /></td>
                            <td>{c.calls}</td>
                            <td>{c.saved}</td>
                            <td>{c.follow_up ? <Link to={`/admin/alerts/calls?customer=${c.id}&followUp=1`} className="wr wr--failed">{c.follow_up} callers</Link> : <span className="muted">none</span>}</td>
                            <td>{c.lastWrite ? `${when(c.lastWrite)}` : 'never'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="panel" aria-labelledby="flags-h">
                  <div className="panel__head"><h2 id="flags-h">Alerts</h2><Link to="/admin/alerts">All alerts</Link></div>
                  {d.topFlags.length ? (
                    <div className="rows">
                      {d.topFlags.map((f) => (
                        <Link key={f.id} className="row" to={`/admin/alerts/flags/${f.id}`}>
                          <div><div className="row__title">{f.title}</div><div className="row__meta">{f.customer}, last seen {when(f.last_seen)}{f.ticket_key ? `, ${f.ticket_key}` : ', no ticket'}</div></div>
                          <div className="row__side"><Sev s={f.severity} /></div>
                        </Link>
                      ))}
                    </div>
                  ) : <Empty title="No open flags.">The detectors found nothing that needs a person.</Empty>}
                </section>
              </div>
              <div className="stack">
                <section className="panel" aria-labelledby="tix-h">
                  <div className="panel__head"><h2 id="tix-h">Tickets</h2><Link to="/admin/tickets">All tickets</Link></div>
                  {d.tickets.length ? (
                    <div className="rows">
                      {d.tickets.map((t) => (
                        <Link key={t.key} className="row" to={`/admin/tickets/${t.key}`}>
                          <div><div className="row__title">{t.subject}</div><div className="row__meta">{t.key}, {t.customer}{t.last_public_role !== 'admin' ? ', waiting on us' : ''}{t.drafts ? `, ${t.drafts} draft to send` : ''}</div></div>
                          <div className="row__side"><St s={t.priority} /></div>
                        </Link>
                      ))}
                    </div>
                  ) : <Empty title="No open tickets." />}
                </section>
                <section className="panel" aria-labelledby="bot-h">
                  <div className="panel__head"><h2 id="bot-h">Ask the debug bot</h2></div>
                  <p className="muted small">It reads every table and log line, links alerts, opens tickets when it has findings, and drafts replies for you to send.</p>
                  <div className="actions"><Link className="btn" to="/admin/bot">Open debug bot</Link></div>
                </section>
              </div>
            </div>
          </>
        );
      }}</Region>
    </>
  );
}
