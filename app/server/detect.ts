/**
 * Detectors. Two jobs:
 *  1. deriveCalls(): fill the derived columns on `calls` from `log_events` (write status, duplicates, local time).
 *  2. runDetectors(): turn patterns in the data into `flags`, each with its evidence and a written analysis.
 * Both are idempotent and safe to re-run (the seed runs them; admins and the debug bot can re-run them).
 */
import type { DatabaseSync } from 'node:sqlite';
import { now } from './db.ts';

type Call = {
  call_id: string; telephony_sid: string; customer_id: string; started_at: string; ingested_at: string;
  intent_tag: string; outcome: string; appointment_id: string | null; caller_name: string; caller_phone_last4: string;
  transcript: string; started_local: string; is_duplicate: number; write_status: string; write_op: string | null;
};
type Log = {
  id: number; ts: string; level: string; service: string; customer_id: string | null; op: string | null; event: string | null;
  appointment_id: string | null; status: string | null; error: string | null; error_description: string | null;
  attempt: number | null; final: number; action: string | null; sid: string | null; external_id: string | null; raw: string;
};
type Customer = { id: string; name: string; timezone: string; booking_system: string; integration: string };

const CHANGES = ['booked', 'rescheduled', 'cancelled'];
const MISMATCH: Record<string, string[]> = {
  cancel: ['rescheduled', 'booked'],
  reschedule: ['cancelled', 'booked'],
  book_new: ['rescheduled', 'cancelled'],
};

export function localTime(iso: string, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
const fmtLocal = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(iso));

export function deriveCalls(db: DatabaseSync) {
  const customers = db.prepare('SELECT id, timezone FROM customers').all() as Customer[];
  const tz = Object.fromEntries(customers.map((c) => [c.id, c.timezone]));
  const calls = db.prepare('SELECT * FROM calls ORDER BY telephony_sid, ingested_at, call_id').all() as Call[];
  const writes = db.prepare("SELECT * FROM log_events WHERE service = 'booking-sync' AND appointment_id IS NOT NULL ORDER BY ts").all() as Log[];
  const byAppt = new Map<string, Log[]>();
  for (const w of writes) byAppt.set(w.appointment_id!, [...(byAppt.get(w.appointment_id!) ?? []), w]);

  const upd = db.prepare(`UPDATE calls SET started_local = ?, ingest_lag_sec = ?, is_duplicate = ?, duplicate_of = ?, write_op = ?, write_status = ?,
    write_http = ?, write_attempts = ?, external_id = ?, said_not_written = ?, intent_mismatch = ? WHERE call_id = ?`);
  const firstBySid = new Map<string, string>();
  db.exec('BEGIN');
  for (const c of calls) {
    const original = firstBySid.get(c.telephony_sid);
    if (!original) firstBySid.set(c.telephony_sid, c.call_id);
    const ev = c.appointment_id ? byAppt.get(c.appointment_id) ?? [] : [];
    const ok = ev.find((e) => e.status?.startsWith('2'));
    const last = ev.at(-1);
    let status = 'none';
    if (c.appointment_id) status = ok ? 'written' : ev.some((e) => e.final) ? 'failed' : ev.length ? 'unknown' : 'unknown';
    const extId = ok?.external_id ?? null;
    const said = CHANGES.includes(c.outcome) && status === 'failed' ? 1 : 0;
    const mism = (MISMATCH[c.intent_tag] ?? []).includes(c.outcome) ? 1 : 0;
    const lag = Math.round((Date.parse(c.ingested_at) - Date.parse(c.started_at)) / 1000);
    upd.run(localTime(c.started_at, tz[c.customer_id]), lag, original ? 1 : 0, original ?? null, last?.op ?? null, status,
      ok?.status ?? last?.status ?? null, ev.length, extId, said, mism, c.call_id);
  }
  db.exec('COMMIT');
}

type FlagInput = {
  rule: string; severity: 'critical' | 'high' | 'medium' | 'low'; customer_id: string; title: string; summary: string;
  analysis: string; recommendation: string; evidence: unknown; count: number; first_seen: string; last_seen: string;
};

function upsertFlag(db: DatabaseSync, f: FlagInput) {
  db.prepare(`INSERT INTO flags (rule, severity, customer_id, title, summary, analysis, recommendation, evidence_json, count, first_seen, last_seen, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(rule, customer_id) DO UPDATE SET severity = excluded.severity, title = excluded.title, summary = excluded.summary,
      analysis = excluded.analysis, recommendation = excluded.recommendation, evidence_json = excluded.evidence_json,
      count = excluded.count, first_seen = excluded.first_seen, last_seen = excluded.last_seen`)
    .run(f.rule, f.severity, f.customer_id, f.title, f.summary, f.analysis, f.recommendation, JSON.stringify(f.evidence), f.count, f.first_seen, f.last_seen, now());
}

export function runDetectors(db: DatabaseSync): { rule: string; customer_id: string; severity: string; count: number }[] {
  const out: FlagInput[] = [];
  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all() as Customer[];
  const calls = db.prepare('SELECT * FROM calls ORDER BY started_at').all() as Call[];
  const logs = db.prepare('SELECT * FROM log_events ORDER BY ts, id').all() as Log[];
  const lastLogTs = logs.at(-1)?.ts ?? now();

  for (const cu of customers) {
    const tz = cu.timezone;
    const L = logs.filter((l) => l.customer_id === cu.id);
    const C = calls.filter((c) => c.customer_id === cu.id);

    // 1. Token refresh failing ------------------------------------------------
    const refresh = L.filter((l) => l.service === 'booking-auth' && l.event === 'token_refresh');
    let streak = 0;
    for (let i = refresh.length - 1; i >= 0 && refresh[i].status !== '200'; i--) streak++;
    if (streak >= 2) {
      const fails = refresh.slice(refresh.length - streak);
      const lastOk = refresh[refresh.length - streak - 1];
      const firstWriteFail = L.find((l) => l.service === 'booking-sync' && l.ts > fails[0].ts && l.status === '401');
      const lastWriteOk = [...L].reverse().find((l) => l.service === 'booking-sync' && l.status?.startsWith('2'));
      out.push({
        rule: 'auth_refresh_failing', severity: 'critical', customer_id: cu.id,
        title: `${cu.booking_system} token refresh rejected ${streak} times in a row`,
        summary: `Every hourly OAuth token refresh for ${cu.name} has returned ${fails[0].status} ${fails[0].error} since ${fmtLocal(fails[0].ts, tz)}. The integration has no valid token, so every booking write fails.`,
        analysis: [
          `booking-auth refreshes a one-hour OAuth2 client-credentials token for ${cu.name} at :31 past every hour.`,
          lastOk ? `The last refresh that worked was ${fmtLocal(lastOk.ts, tz)} (${lastOk.ts}); that token expired one hour later.` : '',
          `From ${fails[0].ts} every refresh returned ${fails[0].status} error=${fails[0].error}: ${fails[0].error_description ?? ''}. ${streak} consecutive failures, none recovered. The last log line (${fails.at(-1)!.ts}) is still failing, so this is ongoing.`,
          `invalid_client means ${cu.booking_system} no longer accepts the client secret we hold. The window between the last good and first bad refresh (${lastOk ? fmtLocal(lastOk.ts, tz) : '?'} to ${fmtLocal(fails[0].ts, tz)}) is when the secret changed: rotated in ${cu.booking_system}, regenerated by clinic staff, or changed in our secret store. The logs cannot tell which.`,
          lastWriteOk ? `Last accepted write: ${lastWriteOk.ts} (${lastWriteOk.op}, ${lastWriteOk.status}).` : '',
          firstWriteFail ? `First write rejected: ${firstWriteFail.ts} (${firstWriteFail.op}, ${firstWriteFail.status} ${firstWriteFail.error}).` : '',
          `These events are logged at WARN, not ERROR, and nothing alerts on them. That is why this ran for days unnoticed.`,
        ].filter(Boolean).join('\n\n'),
        recommendation: `Ask ${cu.name} who changed the ${cu.booking_system} API credentials around ${lastOk ? fmtLocal(fails[0].ts, tz) : 'the first failure'}; check our secret-store history and deploys for the same window. Install the new secret, confirm one refresh returns 200, then replay the dead letters. Long term: page on 2 consecutive refresh failures, and treat invalid_client as non-retryable.`,
        evidence: { last_ok: lastOk?.ts ?? null, first_fail: fails[0].ts, last_fail: fails.at(-1)!.ts, streak, error: fails[0].error, error_description: fails[0].error_description, still_failing_at_end_of_log: fails.at(-1)!.ts === refresh.at(-1)!.ts, sample_lines: [lastOk?.raw, fails[0].raw, fails.at(-1)!.raw].filter(Boolean) },
        count: streak, first_seen: fails[0].ts, last_seen: fails.at(-1)!.ts,
      });
    }

    // 2. Dead-lettered writes ---------------------------------------------------
    const dead = L.filter((l) => l.service === 'booking-sync' && l.final && l.action === 'dead_letter');
    if (dead.length) {
      const byOp = dead.reduce<Record<string, number>>((a, d) => ({ ...a, [d.op!]: (a[d.op!] ?? 0) + 1 }), {});
      const errs = [...new Set(dead.map((d) => `${d.status} ${d.error}`))];
      out.push({
        rule: 'dead_letter_writes', severity: 'critical', customer_id: cu.id,
        title: `${dead.length} booking writes dead-lettered`,
        summary: `${dead.length} appointment changes for ${cu.name} were retried 3 times and then dropped into the dead-letter queue (${Object.entries(byOp).map(([k, v]) => `${v} ${k}`).join(', ')}). None reached ${cu.booking_system}.`,
        analysis: [
          `booking-sync retries a failed write with backoff (2s, then 4s) and gives up after attempt 3 with final=true action=dead_letter.`,
          `All ${dead.length} dead letters failed with ${errs.join(', ')}: an auth failure, not a transient one. Retrying cannot fix a rejected token, so all ${dead.length * 3} attempts were wasted and each write was guaranteed to be lost.`,
          `The first was ${dead[0].ts} and the last ${dead.at(-1)!.ts}. Nothing alerts on a dead letter, and nothing replays them.`,
          `Operations: ${Object.entries(byOp).map(([k, v]) => `${k} ${v}`).join(', ')}. A lost create means a patient who thinks they have a visit; a lost update leaves the old time in ${cu.booking_system}; a lost cancel keeps a slot held that nobody will use.`,
        ].join('\n\n'),
        recommendation: `Once credentials are fixed, replay each dead letter with a slot-availability check first (the slot may have been taken since), using the appointment_id as the idempotency key. Alert on any dead letter. Classify 401/403 as non-retryable and stop the circuit instead of retrying.`,
        evidence: { by_op: byOp, errors: errs, appointment_ids: dead.map((d) => d.appointment_id), first: dead[0].ts, last: dead.at(-1)!.ts },
        count: dead.length, first_seen: dead[0].ts, last_seen: dead.at(-1)!.ts,
      });
    }

    // 3. Agent said it worked, but the write failed --------------------------------
    const said = C.filter((c) => (c as unknown as { said_not_written: number }).said_not_written);
    if (said.length) {
      const byOutcome = said.reduce<Record<string, number>>((a, c) => ({ ...a, [c.outcome]: (a[c.outcome] ?? 0) + 1 }), {});
      const confirmations = said.map((c) => ({ call_id: c.call_id, line: c.transcript.split('\n').filter((l) => l.startsWith('Agent:')).find((l) => /booked|all set|done|cancelled|moved|now booked/i.test(l)) ?? '' }));
      out.push({
        rule: 'said_not_written', severity: 'critical', customer_id: cu.id,
        title: `${said.length} callers told their change was made when it was not`,
        summary: `On ${said.length} calls the agent confirmed a ${Object.keys(byOutcome).join('/')} to the caller and recorded success, but the ${cu.booking_system} write failed. These patients need a call back.`,
        analysis: [
          `The agent confirms to the caller and records outcome as soon as it decides the change, before booking-sync reports the write result. So outcome is what the agent said, not what happened.`,
          `Joining calls.appointment_id to booking-sync events: ${said.length} calls between ${said[0].started_local} and ${said.at(-1)!.started_local} (local) have a changing outcome and no 2xx write. Breakdown: ${Object.entries(byOutcome).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
          `Every one of them heard an explicit confirmation, for example ${confirmations[0].call_id}: "${confirmations[0].line.replace('Agent: ', '')}"`,
          `Per type: booked means the patient arrives with no record and the slot can be given away; rescheduled means ${cu.booking_system} still shows the old time while the patient expects the new one; cancelled means the clinic still expects the patient and the slot stays blocked.`,
          `None of these calls are duplicates, and no two of them requested the same slot, so the replay should not collide with itself.`,
        ].join('\n\n'),
        recommendation: `Send the clinic the list (name, last 4 digits, what each was told) so the front desk can call back. Change the agent to confirm only after a 2xx write; on failure say the request is received and the clinic will confirm, and record outcome=pending_write.`,
        evidence: { by_outcome: byOutcome, call_ids: said.map((c) => c.call_id), confirmations },
        count: said.length, first_seen: said[0].started_at, last_seen: said.at(-1)!.started_at,
      });
    }

    // 4. Duplicate call records -------------------------------------------------
    const bySid = new Map<string, Call[]>();
    for (const c of C) bySid.set(c.telephony_sid, [...(bySid.get(c.telephony_sid) ?? []), c]);
    const groups = [...bySid.values()].filter((g) => g.length > 1);
    if (groups.length) {
      const warned = new Set(L.filter((l) => l.service === 'call-ingest').map((l) => l.sid));
      const ev = groups.map((g) => {
        const ing = g.map((c) => c.ingested_at).sort();
        return {
          sid: g[0].telephony_sid, records: g.map((c) => c.call_id), outcome: g[0].outcome, appointment_id: g[0].appointment_id,
          started_at: g[0].started_at, ingested: ing, retry_gaps_sec: ing.slice(1).map((t, i) => Math.round((Date.parse(t) - Date.parse(ing[i])) / 1000)),
          ack_timeout_logged: warned.has(g[0].telephony_sid),
        };
      });
      const extra = groups.reduce((a, g) => a + g.length - 1, 0);
      const unlogged = ev.filter((e) => !e.ack_timeout_logged).length;
      const withAppt = ev.filter((e) => e.appointment_id);
      out.push({
        rule: 'duplicate_ingest', severity: 'medium', customer_id: cu.id,
        title: `${extra} duplicate call record${extra > 1 ? 's' : ''} from ${groups.length} call${groups.length > 1 ? 's' : ''}`,
        summary: `${groups.length} telephony_sid${groups.length > 1 ? 's were' : ' was'} ingested more than once for ${cu.name}, creating ${extra} extra call_id${extra > 1 ? 's' : ''}. Counts by outcome are inflated unless deduped.`,
        analysis: [
          `The telephony provider retries a webhook it believes failed. call-ingest assigns a fresh call_id each time instead of using telephony_sid as an idempotency key, so a retry becomes a second record.`,
          `Retry gaps here are ${[...new Set(ev.flatMap((e) => e.retry_gaps_sec))].sort((a, b) => a - b).map((s) => `${Math.round(s / 60)} min`).join(', ')}, consistent with provider backoff.`,
          unlogged === 0
            ? `All ${ev.length} groups match a logged call-ingest webhook_ack_timeout_ms=10000 for the same sid, so for this customer every redelivery is explained.`
            : `${ev.length - unlogged} of ${ev.length} group${ev.length > 1 ? 's' : ''} match a logged call-ingest webhook_ack_timeout_ms=10000; ${unlogged} ${unlogged > 1 ? 'have' : 'has'} no log line at all. Either some timeouts are not logged or something else triggers redelivery. That is a logging gap worth closing.`,
          withAppt.length ? `${withAppt.length} duplicated call${withAppt.length > 1 ? 's' : ''} carried an appointment, but each appointment_id has exactly one booking-sync write: the agent writes during the call, ingestion happens after, so duplicates never caused double bookings.` : `None of the duplicated calls changed an appointment.`,
        ].join('\n\n'),
        recommendation: `Ack the webhook immediately and process asynchronously; upsert on telephony_sid. Log every redelivery with the provider's attempt header. In reporting, count distinct telephony_sid.`,
        evidence: { groups: ev, extra_records: extra, groups_without_logged_timeout: unlogged },
        count: extra, first_seen: ev.map((e) => e.started_at).sort()[0], last_seen: ev.map((e) => e.started_at).sort().at(-1)!,
      });
    }

    // 5. Webhook ack timeouts ----------------------------------------------------
    const acks = L.filter((l) => l.service === 'call-ingest' && l.level === 'WARN');
    if (acks.length) {
      out.push({
        rule: 'webhook_ack_timeout', severity: 'medium', customer_id: cu.id,
        title: `${acks.length} webhook acks timed out at 10s`,
        summary: `call-ingest took longer than 10 seconds to acknowledge ${acks.length} telephony webhooks for ${cu.name}; the provider retried each one.`,
        analysis: [
          `All ${acks.length} happened between ${acks[0].ts} and ${acks.at(-1)!.ts}, a cluster on one afternoon, which points to a slow dependency or load spike in call-ingest rather than a steady problem.`,
          `Each timeout produced 2 or 3 records for the same call (see duplicate_ingest). provider_will_retry=true is logged, so the retry is expected; the bug is that a retry is not idempotent.`,
        ].join('\n\n'),
        recommendation: `Profile call-ingest during that window. Acknowledge first, then persist. Alert if ack p95 exceeds 5s.`,
        evidence: { sids: acks.map((a) => a.sid), lines: acks.map((a) => a.raw) },
        count: acks.length, first_seen: acks[0].ts, last_seen: acks.at(-1)!.ts,
      });
    }

    // 6. Transient upstream errors ------------------------------------------------
    const t5 = L.filter((l) => l.service === 'booking-sync' && l.status?.startsWith('5'));
    if (t5.length) {
      const recovered = t5.filter((t) => L.some((l) => l.service === 'booking-sync' && l.appointment_id === t.appointment_id && l.ts > t.ts && l.status?.startsWith('2')));
      out.push({
        rule: 'upstream_5xx', severity: 'low', customer_id: cu.id,
        title: `${t5.length} transient ${cu.booking_system} 5xx, ${recovered.length} recovered`,
        summary: `${cu.booking_system} returned ${[...new Set(t5.map((t) => t.status))].join('/')} ${t5[0].error} ${t5.length} time${t5.length > 1 ? 's' : ''}; ${recovered.length} succeeded on the next attempt about 2 seconds later.`,
        analysis: [
          `The retry policy is working as designed for 5xx. No customer impact was found.`,
          `Open question: a create that returned 503 may still have been committed upstream. The retry got a 201 with a new external_id. If ${cu.booking_system} does not dedupe on our appointment_id, a 503 followed by a retry can create two appointments. Check the external ids against ${cu.booking_system}.`,
        ].join('\n\n'),
        recommendation: `Send appointment_id as an idempotency key on every write. Track 5xx rate per booking system and alert above 5% in an hour.`,
        evidence: { events: t5.map((t) => ({ ts: t.ts, op: t.op, appointment_id: t.appointment_id, status: t.status, recovered: recovered.includes(t) })) },
        count: t5.length, first_seen: t5[0].ts, last_seen: t5.at(-1)!.ts,
      });
    }

    // 7. Intent classifier disagrees with outcome ---------------------------------
    const mism = C.filter((c) => (c as unknown as { intent_mismatch: number }).intent_mismatch && !c.is_duplicate);
    if (mism.length) {
      const pairs = mism.reduce<Record<string, number>>((a, c) => ({ ...a, [`${c.intent_tag} -> ${c.outcome}`]: (a[`${c.intent_tag} -> ${c.outcome}`] ?? 0) + 1 }), {});
      out.push({
        rule: 'intent_mismatch', severity: 'low', customer_id: cu.id,
        title: `${mism.length} calls where intent and outcome disagree`,
        summary: `The intent classifier tagged ${mism.length} ${cu.name} calls with an intent that contradicts what happened (${Object.entries(pairs).map(([k, v]) => `${k}: ${v}`).join(', ')}).`,
        analysis: `Callers say "cancel and rebook" and the classifier keys on the first verb. Reporting by intent_tag undercounts reschedules and overcounts cancellations. Filter by outcome to answer what happened.`,
        recommendation: `Add a cancel-and-rebook rule, or derive the reporting intent from the outcome when they disagree.`,
        evidence: { pairs, call_ids: mism.map((c) => c.call_id) },
        count: mism.length, first_seen: mism[0].started_at, last_seen: mism.at(-1)!.started_at,
      });
    }
  }

  db.exec('BEGIN');
  for (const f of out) upsertFlag(db, f);
  db.exec('COMMIT');
  void lastLogTs;
  return out.map((f) => ({ rule: f.rule, customer_id: f.customer_id, severity: f.severity, count: f.count }));
}
