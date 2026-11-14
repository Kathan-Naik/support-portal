import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api.ts';
import { useMe } from '../App.tsx';
import { PageHead, Region, Empty, Outcome, Write, Drawer, Tabs, Chips, Switch, Loading } from '../components/ui.tsx';
import { localStamp, OUTCOME_FOR_CLIENT, when } from '../format.ts';

type Row = { call_id: string; customer_id: string; customer: string; started_local: string; duration_sec: number; caller_name: string; caller_phone_last4: string; intent_tag: string; outcome: string; appointment_id: string | null; write_op: string | null; write_status: string; write_http: string | null; write_attempts: number; is_duplicate: number; said_not_written: number; intent_mismatch: number };
type Res = { total: number; page: number; size: number; rows: Row[]; facets: { followUp: number; failed: number } };
type Full = Row & { telephony_sid: string; transcript: string; ingested_at: string; ingest_lag_sec: number; started_at: string; booking_system: string; timezone: string; external_id: string | null;
  writes: { ts: string; level: string; op: string; status: string; error: string | null; attempt: number | null; final: number; action: string | null; external_id: string | null; raw?: string }[];
  duplicates: { call_id: string; ingested_at: string }[] };

const OUTCOMES = ['booked', 'rescheduled', 'cancelled', 'resolved', 'transferred', 'abandoned'];
const INTENTS = ['book_new', 'reschedule', 'cancel', 'confirm', 'billing', 'pricing', 'general_info'];

export function CallsPage() {
  const { me } = useMe();
  const admin = me.role === 'admin';
  const [sp, setSp] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const customers = useApi<{ id: string; name: string }[]>(admin ? '/customers' : null);
  const keys = ['customer', 'from', 'to', 'intent', 'outcome', 'write', 'q', 'dups', 'followUp', 'mismatch', 'page', 'sort'];
  const qs = keys.filter((k) => sp.get(k)).map((k) => `${k}=${encodeURIComponent(sp.get(k)!)}`).join('&');
  const q = useApi<Res>(`/calls?size=50&${qs}`);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const list = (k: string) => (sp.get(k) ? sp.get(k)!.split(',') : []);
  const page = Number(sp.get('page') ?? 1);

  return (
    <>
      <PageHead title="Calls" lead={admin ? 'Every call, with what the agent said beside what the booking system accepted. Times are each client’s local time.' : 'Every call your assistant took, and whether the change reached your calendar.'}>
        <button type="button" className={`btn${sp.get('followUp') === '1' ? ' btn--primary' : ''}`} aria-pressed={sp.get('followUp') === '1'} onClick={() => set('followUp', sp.get('followUp') === '1' ? '' : '1')}>
          {admin ? 'Said but not written' : 'Needs follow-up'}
        </button>
        {qs ? <button type="button" className="btn btn--link" onClick={() => setSp(new URLSearchParams(), { replace: true })}>Reset filters</button> : null}
      </PageHead>
      <details className="filters" open>
        <summary>Filters</summary>
        <form className="filters__body" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="filters__row">
            <div className="field"><label htmlFor="c-q">Search</label><input id="c-q" className="input" type="search" defaultValue={sp.get('q') ?? ''} placeholder="Caller, last 4 digits, call id, words said" onChange={(e) => set('q', e.target.value)} /></div>
            <div className="field"><label htmlFor="c-from">From</label><input id="c-from" className="input" type="date" value={sp.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} /></div>
            <div className="field"><label htmlFor="c-to">To</label><input id="c-to" className="input" type="date" value={sp.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} /></div>
            {admin ? (
              <div className="field"><label htmlFor="c-cust">Client</label>
                <select id="c-cust" className="select" value={sp.get('customer') ?? ''} onChange={(e) => set('customer', e.target.value)}><option value="">All clients</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            ) : (
              <div className="field"><label htmlFor="c-intent">What they wanted</label>
                <select id="c-intent" className="select" value={sp.get('intent') ?? ''} onChange={(e) => set('intent', e.target.value)}><option value="">Anything</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select></div>
            )}
          </div>
          <div className="filters__chips">
            <div><span className="label" id="c-out">Outcome</span><Chips label="Outcome" options={OUTCOMES.map((o) => ({ id: o, label: admin ? o : OUTCOME_FOR_CLIENT[o] }))} value={list('outcome')} onChange={(v) => set('outcome', v.join(','))} /></div>
            <div><span className="label" id="c-wr">{admin ? 'Write' : 'Calendar'}</span><Chips label="Write status" options={[{ id: 'failed', label: admin ? 'failed' : 'not saved' }, { id: 'written', label: admin ? 'written' : 'saved' }, { id: 'none', label: admin ? 'no write' : 'no change' }]} value={list('write')} onChange={(v) => set('write', v.join(','))} /></div>
          </div>
          {admin ? (
            <div className="filters__foot">
              <div className="inline-actions">
                <Switch checked={sp.get('dups') !== '1'} onChange={(v) => set('dups', v ? '' : '1')}>Hide duplicate records</Switch>
                <Switch checked={sp.get('mismatch') === '1'} onChange={(v) => set('mismatch', v ? '1' : '')}>Intent disagrees with outcome</Switch>
              </div>
              <div className="field" style={{ maxWidth: '14rem' }}><label htmlFor="c-intent">Intent tag</label>
                <select id="c-intent" className="select" value={sp.get('intent') ?? ''} onChange={(e) => set('intent', e.target.value)}><option value="">Any intent</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select></div>
            </div>
          ) : null}
        </form>
      </details>
      <div className="mt">
        <Region q={q} rows={10} isEmpty={(d) => !d.total} empty={<Empty title="No calls match these filters." action={<button type="button" className="btn" onClick={() => setSp(new URLSearchParams(), { replace: true })}>Reset filters</button>}>Widen the dates or clear a chip.</Empty>}>{(d) => (
          <>
            <div className="count" style={{ marginBottom: 'var(--space-md)' }}>
              <p aria-live="polite"><b>{d.total}</b> calls{d.facets.followUp ? <>, <span className="wr wr--failed">{d.facets.followUp} {admin ? 'said but not written' : 'need follow-up'}</span></> : null}</p>
              <button type="button" className="btn btn--link" onClick={() => set('sort', sp.get('sort') === 'asc' ? '' : 'asc')}>{sp.get('sort') === 'asc' ? 'Oldest first' : 'Newest first'}</button>
            </div>
            <div className="table-wrap">
              <table className="calls">
                <caption className="visually-hidden">Calls with the agent outcome and the booking write result</caption>
                <thead><tr><th scope="col">Call</th><th scope="col">Local time</th>{admin ? <th scope="col">Client</th> : null}<th scope="col">Caller</th><th scope="col">{admin ? 'Intent' : 'Wanted'}</th><th scope="col">{admin ? 'Outcome' : 'Assistant said'}</th><th scope="col">{admin ? 'Write' : 'Calendar'}</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.call_id} className={`${r.said_not_written ? 'is-mismatch' : ''}${r.is_duplicate ? ' is-dup' : ''}${open === r.call_id ? ' is-open' : ''}`} onClick={() => setOpen(r.call_id)}>
                      <td data-label="Call"><button type="button" className="open" onClick={(e) => { e.stopPropagation(); setOpen(r.call_id); }}>{r.call_id}</button></td>
                      <td data-label="Local time" className="nowrap">{localStamp(r.started_local)}</td>
                      {admin ? <td data-label="Client">{r.customer}</td> : null}
                      <td data-label="Caller" className="caller">{r.caller_name}<small>ends {r.caller_phone_last4}</small></td>
                      <td data-label="Intent">{r.intent_tag}{admin && r.intent_mismatch ? <small>disagrees</small> : null}</td>
                      <td data-label="Outcome"><Outcome o={admin ? r.outcome : OUTCOME_FOR_CLIENT[r.outcome]} quiet={!['booked', 'rescheduled', 'cancelled'].includes(r.outcome)} /></td>
                      <td data-label="Write"><Write status={r.write_status} http={r.write_http} dup={Boolean(r.is_duplicate)} client={!admin} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>Page {d.page} of {Math.max(1, Math.ceil(d.total / d.size))}</span>
              <div className="inline-actions">
                <button type="button" className="btn" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>Previous</button>
                <button type="button" className="btn" disabled={page * d.size >= d.total} onClick={() => set('page', String(page + 1))}>Next</button>
              </div>
            </div>
          </>
        )}</Region>
      </div>
      <CallDrawer id={open} onClose={() => setOpen(null)} admin={admin} />
    </>
  );
}

function CallDrawer({ id, onClose, admin }: { id: string | null; onClose: () => void; admin: boolean }) {
  const q = useApi<Full>(id ? `/calls/${id}` : null);
  const [tab, setTab] = useState<'transcript' | 'write' | 'record'>('transcript');
  const c = q.data && q.data.call_id === id ? q.data : null;
  const said = c && ['booked', 'rescheduled', 'cancelled'].includes(c.outcome);
  return (
    <Drawer open={Boolean(id)} onClose={onClose} title={id ?? ''} sub={c ? `${c.customer}, ${localStamp(c.started_local)} local, ${c.duration_sec}s` : undefined}>
      {!c ? <Loading /> : (
        <>
          {c.write_status === 'failed' ? (
            <div className="verdict verdict--bad"><b>{admin ? `Said ${c.outcome}, not written.` : `Not saved to ${c.booking_system}.`}</b>
              <span>{admin ? `${c.write_attempts} attempts, last HTTP ${c.write_http}, dead-lettered. The caller believes this happened.` : `Your assistant told ${c.caller_name} this was done, but it did not reach your calendar. Please call them back.`}</span></div>
          ) : c.write_status === 'written' ? (
            <div className="verdict"><b>{admin ? `Said ${c.outcome}, written.` : `Saved to ${c.booking_system}.`}</b><span>{admin ? `${c.booking_system} returned ${c.write_http}${c.external_id ? `, ${c.external_id}` : ''}.` : 'The change is in your calendar.'}</span></div>
          ) : (
            <div className="verdict"><b>{said ? 'No write found.' : 'No calendar change needed.'}</b><span>The call ended as {c.outcome}.</span></div>
          )}
          <dl className="facts">
            <div><dt>Caller</dt><dd>{c.caller_name}, ends {c.caller_phone_last4}</dd></div>
            <div><dt>{admin ? 'Intent tag' : 'Wanted'}</dt><dd>{c.intent_tag}</dd></div>
            <div><dt>Outcome</dt><dd>{c.outcome}</dd></div>
            <div><dt>Appointment</dt><dd>{c.appointment_id ?? 'none'}</dd></div>
            {admin ? <>
              <div><dt>Telephony sid</dt><dd className="mono">{c.telephony_sid}</dd></div>
              <div><dt>Ingested</dt><dd>{when(c.ingested_at)}, {c.ingest_lag_sec}s after start</dd></div>
              <div><dt>Duplicates</dt><dd>{c.duplicates.length ? c.duplicates.map((d) => d.call_id).join(', ') : 'none'}</dd></div>
            </> : null}
          </dl>
          <div>
            <Tabs label="Call detail" value={tab} onChange={setTab} tabs={[{ id: 'transcript', label: 'Transcript' }, { id: 'write', label: admin ? 'Booking writes' : 'Calendar' }, ...(admin ? [{ id: 'record' as const, label: 'Raw record' }] : [])]} />
            <div className="tabpanel" role="tabpanel">
              {tab === 'transcript' ? (
                <ol className="transcript">
                  {c.transcript.split('\n').map((l, i) => {
                    const m = l.match(/^(Agent|Caller):\s*(.*)$/);
                    return m ? <li key={i}><span className="who">{m[1] === 'Agent' ? 'Assistant' : 'Caller'}</span><span>{m[2]}</span></li> : <li key={i}><span className="sys">{l}</span></li>;
                  })}
                </ol>
              ) : tab === 'write' ? (
                c.writes.length ? (
                  admin ? <pre className="record">{c.writes.map((w) => w.raw).join('\n')}</pre> : (
                    <div className="rows">{c.writes.map((w, i) => (
                      <div key={i} className="row"><div><div className="row__title">{w.status?.startsWith('2') ? 'Saved' : w.final ? 'Gave up' : 'Attempt failed'}</div><div className="row__meta">{when(w.ts, c.timezone)}</div></div><div className="row__side">{w.op}</div></div>
                    ))}</div>
                  )
                ) : <p className="muted small">No calendar change was attempted on this call.</p>
              ) : (
                <pre className="record">{JSON.stringify({ ...c, transcript: undefined, writes: undefined }, null, 2)}</pre>
              )}
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}
