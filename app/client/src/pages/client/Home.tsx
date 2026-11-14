import { Link } from 'react-router-dom';
import { useApi } from '../../api.ts';
import { useMe } from '../../App.tsx';
import { Region, St, Empty } from '../../components/ui.tsx';
import { when, ago } from '../../format.ts';

type Ov = {
  customer: { id: string; name: string; booking_system: string; timezone: string; business_hours: string };
  health: { level: string };
  tickets: { key: string; subject: string; status: string; priority: string; updated_at: string; unread: number }[];
  counts: { open: number | null; pending: number | null; done: number | null };
  unread: number;
  latestReply: { key: string; subject: string; created_at: string; preview: string; read_at: string | null } | null;
};

export function ClientHome() {
  const { me } = useMe();
  const q = useApi<Ov>('/overview');
  return (
    <Region q={q} rows={8}>{(d) => (
      <>
        <section className="help-hero" aria-labelledby="help-h">
          <div>
            <h1 id="help-h">How can we help, {d.customer.name}?</h1>
            <p>Tell us what went wrong. A caller's name and when they called help us find it fast.</p>
          </div>
          <Link className="btn btn--primary" to="/portal/tickets/new">New ticket</Link>
        </section>

        {d.health.level === 'down' ? (
          <div className="banner">
            <div><b>Some bookings are not reaching {d.customer.booking_system}.</b>
              <p>We know about it and are working on it. Updates arrive on your ticket.</p></div>
            {d.tickets[0] ? <Link className="btn" to={`/portal/tickets/${d.tickets[0].key}`}>View ticket</Link> : <span />}
          </div>
        ) : (
          <div className="banner banner--ok"><div><b>Your assistant is working normally.</b><p>Bookings are reaching {d.customer.booking_system}.</p></div><span /></div>
        )}

        <div className="grid grid-main">
          <section className="panel" aria-labelledby="open-h">
            <div className="panel__head"><h2 id="open-h">Open tickets</h2><Link to="/portal/tickets">All tickets</Link></div>
            {d.tickets.length ? (
              <div className="rows">{d.tickets.map((t) => (
                <Link key={t.key} className="row" to={`/portal/tickets/${t.key}`}>
                  <div>
                    <div className="row__title">{t.unread ? <span className="unread-dot" aria-label="New reply" /> : null} {t.subject}</div>
                    <div className="row__meta">{t.key}, updated {ago(t.updated_at)}{t.unread ? `, ${t.unread} new repl${t.unread > 1 ? 'ies' : 'y'}` : ''}</div>
                  </div>
                  <div className="row__side"><St s={t.status} label={t.status === 'pending' ? 'waiting on you' : t.status} /></div>
                </Link>
              ))}</div>
            ) : <Empty title="No open tickets." action={<Link className="btn" to="/portal/tickets/new">Open a ticket</Link>}>If something looks wrong with your calls or bookings, tell us.</Empty>}
          </section>
          <div className="stack">
            <section className="panel" aria-labelledby="reply-h">
              <div className="panel__head"><h2 id="reply-h">Latest from support</h2></div>
              {d.latestReply ? (
                <Link className="row" to={`/portal/tickets/${d.latestReply.key}`}>
                  <div><div className="row__title">{!d.latestReply.read_at ? <span className="unread-dot" aria-label="Unread" /> : null} {d.latestReply.subject}</div>
                    <div className="row__meta">{when(d.latestReply.created_at, d.customer.timezone)}</div>
                    <p className="small reply-preview">{d.latestReply.preview}</p></div>
                </Link>
              ) : <p className="muted small">Replies from our team arrive on your tickets.</p>}
            </section>
            <section className="panel">
              <dl className="kv kv--one">
                <div><dt>Open</dt><dd>{d.counts.open ?? 0}</dd></div>
                <div><dt>Waiting on you</dt><dd>{d.counts.pending ?? 0}</dd></div>
                <div><dt>Resolved</dt><dd>{d.counts.done ?? 0}</dd></div>
              </dl>
            </section>
          </div>
        </div>
        <p className="small muted mt">Signed in as {me.email}. Business hours {d.customer.business_hours}, {d.customer.timezone}.</p>
      </>
    )}</Region>
  );
}
