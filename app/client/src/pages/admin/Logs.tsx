import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../api.ts';
import { PageHead, Region, Empty, Switch } from '../../components/ui.tsx';
import { when } from '../../format.ts';

type Log = { id: number; ts: string; level: string; service: string; customer_id: string | null; op: string | null; event: string | null; appointment_id: string | null; status: string | null; error: string | null; error_description: string | null; attempt: number | null; final: number; action: string | null; raw: string };
type Res = { total: number; page: number; size: number; rows: Log[]; byLevel: { level: string; n: number }[]; byDay: { day: string; errors: number; warns: number; n: number }[] };

const SERVICES = ['booking-sync', 'booking-auth', 'avail-sync', 'call-ingest'];
const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

export function LogsPage() {
  const [sp, setSp] = useSearchParams();
  const customers = useApi<{ id: string; name: string }[]>('/customers');
  const keys = ['service', 'level', 'customer', 'q', 'from', 'to', 'problems', 'page', 'appointment_id', 'status'];
  const qs = keys.filter((k) => sp.get(k)).map((k) => `${k}=${encodeURIComponent(sp.get(k)!)}`).join('&');
  const q = useApi<Res>(`/logs?size=100&${qs}`);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const page = Number(sp.get('page') ?? 1);
  return (
    <>
      <PageHead title="Logs" lead="integration.log, one row per event. Times in UTC.">
        {qs ? <button type="button" className="btn btn--link" onClick={() => setSp(new URLSearchParams(), { replace: true })}>Clear filters</button> : null}
      </PageHead>
      <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field field--wide"><label htmlFor="l-q">Search the raw line</label>
          <input id="l-q" className="input" type="search" defaultValue={sp.get('q') ?? ''} placeholder="invalid_client, apt_baf23ea2a1, dead_letter" onChange={(e) => set('q', e.target.value)} /></div>
        <div className="field"><label htmlFor="l-svc">Service</label>
          <select id="l-svc" className="select" value={sp.get('service') ?? ''} onChange={(e) => set('service', e.target.value)}><option value="">All services</option>{SERVICES.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label htmlFor="l-lvl">Level</label>
          <select id="l-lvl" className="select" value={sp.get('level') ?? ''} onChange={(e) => set('level', e.target.value)}><option value="">All levels</option>{LEVELS.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label htmlFor="l-c">Client</label>
          <select id="l-c" className="select" value={sp.get('customer') ?? ''} onChange={(e) => set('customer', e.target.value)}><option value="">All clients</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label htmlFor="l-from">From</label><input id="l-from" className="input" type="date" value={sp.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="field"><label htmlFor="l-to">To</label><input id="l-to" className="input" type="date" value={sp.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} /></div>
        <Switch checked={sp.get('problems') === '1'} onChange={(v) => set('problems', v ? '1' : '')}>Problems only</Switch>
      </form>
      <Region q={q} rows={10} isEmpty={(d) => !d.total} empty={<Empty title="No log lines match.">Widen the dates or clear a filter.</Empty>}>{(d) => {
        const max = Math.max(...d.byDay.map((x) => x.n), 1);
        return (
          <div className="panel">
            <div className="panel__head"><h2>{d.total.toLocaleString()} lines</h2>
              <span className="muted">{d.byLevel.map((l) => `${l.n} ${l.level}`).join(', ')}</span></div>
            <div className="bars" role="img" aria-label="Lines per day, with warnings and errors in apricot">
              {d.byDay.map((x) => (
                <div key={x.day} title={`${x.day}: ${x.n} lines, ${x.warns} warn, ${x.errors} error`}>
                  <span className="b-all" style={{ height: `${((x.n - x.warns - x.errors) / max) * 100}%` }} />
                  <span className="b-bad" style={{ height: `${((x.warns + x.errors) / max) * 100}%` }} />
                </div>
              ))}
            </div>
            {d.byDay.length ? <div className="bars-legend"><span>{d.byDay[0].day}</span><span>apricot: WARN and ERROR</span><span>{d.byDay.at(-1)!.day}</span></div> : null}
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Level</th><th scope="col">Service</th><th scope="col">Client</th><th scope="col">Event</th></tr></thead>
                <tbody>
                  {d.rows.map((l) => {
                    const bad = l.level === 'ERROR' || l.level === 'WARN';
                    return (
                      <tr key={l.id} className={bad ? 'log--problem' : ''}>
                        <td className="nowrap mono">{l.ts.replace('T', ' ').slice(0, 19)}</td>
                        <td><span className={`loglevel loglevel--${l.level}`}>{l.level}</span></td>
                        <td className="nowrap"><button type="button" className="btn btn--link" style={{ minHeight: 0, padding: 0 }} onClick={() => set('service', l.service)}>{l.service}</button></td>
                        <td className="nowrap">{l.customer_id}</td>
                        <td><div className="logline">{l.raw.replace(/^\S+\s+\S+\s+\S+\s+/, '')}</div>
                          {l.appointment_id ? <button type="button" className="btn btn--link" style={{ minHeight: 0, padding: 0, fontSize: 'var(--text-xs)' }} onClick={() => set('appointment_id', l.appointment_id!)}>All lines for {l.appointment_id}</button> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>Page {d.page} of {Math.max(1, Math.ceil(d.total / d.size))}, newest first</span>
              <div className="inline-actions">
                <button type="button" className="btn" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>Newer</button>
                <button type="button" className="btn" disabled={page * d.size >= d.total} onClick={() => set('page', String(page + 1))}>Older</button>
              </div>
            </div>
            <p className="small muted">Last updated {when(d.rows[0]?.ts)}</p>
          </div>
        );
      }}</Region>
    </>
  );
}
