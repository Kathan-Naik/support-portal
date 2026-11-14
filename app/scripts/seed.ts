/**
 * Seed the portal database from the real exercise data.
 *   npm run seed            rebuild data/portal.db from seed/data
 * Everything numeric in tickets and flags is computed from the data, not typed in.
 */
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, applySchema, DB_PATH, ROOT, get, all } from '../server/db.ts';
import { deriveCalls, runDetectors } from '../server/detect.ts';
import { hashPassword } from '../server/auth.ts';
import { clearUploads } from '../server/attachments.ts';

const DATA = resolve(ROOT, process.env.SEED_DATA_DIR ?? 'seed/data');
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo1234';

for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
clearUploads();
const db = openDb();
applySchema(db);

// ---- customers ---------------------------------------------------------------
type RawCustomer = { customer_id: string; name: string; business_type: string; timezone: string; booking_system: string; integration: string; business_hours: string; staff: string[]; go_live: string };
const customers = JSON.parse(readFileSync(resolve(DATA, 'customers.json'), 'utf8')) as RawCustomer[];
const insCustomer = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const c of customers) insCustomer.run(c.customer_id, c.name, c.business_type, c.timezone, c.booking_system, c.integration, c.business_hours, JSON.stringify(c.staff), c.go_live);

// ---- integration.log ---------------------------------------------------------
const insLog = db.prepare(`INSERT INTO log_events (ts, level, service, customer_id, op, event, appointment_id, status, error, error_description, attempt, final, action, latency_ms, external_id, sid, fields_json, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let logCount = 0;
db.exec('BEGIN');
for (const line of readFileSync(resolve(DATA, 'integration.log'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(\S+)\s+(\w+)\s+(\S+)\s+(.*)$/);
  if (!m) continue;
  const [, ts, level, service, rest] = m;
  const fields: Record<string, string> = {};
  const words: string[] = [];
  for (const t of rest.matchAll(/(\w+)=("([^"]*)"|\S+)|(\S+)/g)) {
    if (t[1]) fields[t[1]] = t[3] ?? t[2];
    else words.push(t[4]);
  }
  const n = (k: string) => (fields[k] !== undefined ? Number(fields[k]) : null);
  insLog.run(ts, level, service, fields.customer ?? null, fields.op ?? null, words[0] ?? null, fields.appointment_id ?? null, fields.status ?? null,
    fields.error ?? null, fields.error_description ?? null, n('attempt'), fields.final === 'true' ? 1 : 0, fields.action ?? null, n('latency_ms'),
    fields.external_id ?? null, fields.sid ?? null, JSON.stringify(fields), line);
  logCount++;
}
db.exec('COMMIT');

// ---- calls.json ----------------------------------------------------------------
type RawCall = { call_id: string; telephony_sid: string; customer_id: string; direction: string; started_at: string; duration_sec: number; caller_name: string; caller_phone_last4: string; intent_tag: string; outcome: string; transferred: boolean; appointment_id: string | null; transcript: string; ingested_at: string };
const calls = JSON.parse(readFileSync(resolve(DATA, 'calls.json'), 'utf8')) as RawCall[];
const insCall = db.prepare(`INSERT INTO calls (call_id, telephony_sid, customer_id, direction, started_at, started_local, duration_sec, caller_name, caller_phone_last4, intent_tag, outcome, transferred, appointment_id, transcript, ingested_at, ingest_lag_sec)
  VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
db.exec('BEGIN');
for (const c of calls) insCall.run(c.call_id, c.telephony_sid, c.customer_id, c.direction, c.started_at, c.duration_sec, c.caller_name, c.caller_phone_last4, c.intent_tag, c.outcome, c.transferred ? 1 : 0, c.appointment_id, c.transcript, c.ingested_at);
db.exec('COMMIT');

deriveCalls(db);
const flags = runDetectors(db);

// ---- users -------------------------------------------------------------------------
const created = '2026-10-01T16:00:00Z';
const insUser = db.prepare('INSERT INTO users (email, name, title, role, customer_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const pw = hashPassword(PASSWORD);
const admin = Number(insUser.run('admin@support.example', 'Deployment Engineer', 'Deployment Engineer', 'admin', null, pw, created).lastInsertRowid);
// Two accounts only: the support admin, and the client whose bookings are failing.
const clientUsers: Record<string, number> = {
  cust_a: Number(insUser.run('frontdesk@sunrisedental.example', 'Sunrise Dental front desk', 'Front desk', 'client', 'cust_a', pw, created).lastInsertRowid),
};

// ---- Sunrise Dental: BookWell credential failure, worked on ticket SUP-1001 ------------------
const A = 'cust_a';
type L = { ts: string; raw: string; op: string; status: string; error: string; error_description: string };
const lastOkRefresh = get<L>("SELECT * FROM log_events WHERE customer_id = ? AND event = 'token_refresh' AND status = '200' ORDER BY ts DESC LIMIT 1", A)!;
const firstBadRefresh = get<L>("SELECT * FROM log_events WHERE customer_id = ? AND event = 'token_refresh' AND status <> '200' ORDER BY ts LIMIT 1", A)!;
const lastBadRefresh = get<L>("SELECT * FROM log_events WHERE customer_id = ? AND event = 'token_refresh' AND status <> '200' ORDER BY ts DESC LIMIT 1", A)!;
const badRefreshes = get<{ n: number }>("SELECT COUNT(*) n FROM log_events WHERE customer_id = ? AND event = 'token_refresh' AND status <> '200'", A)!.n;
const lastOkWrite = get<L>("SELECT * FROM log_events WHERE customer_id = ? AND service = 'booking-sync' AND status LIKE '2%' ORDER BY ts DESC LIMIT 1", A)!;
const firstDead = get<L>("SELECT * FROM log_events WHERE customer_id = ? AND action = 'dead_letter' ORDER BY ts LIMIT 1", A)!;
type C = { call_id: string; started_at: string; started_local: string; outcome: string; caller_name: string; write_op: string };
const affected = all<C>('SELECT * FROM calls WHERE customer_id = ? AND said_not_written = 1 ORDER BY started_at', A);
const by = (o: string) => affected.filter((c) => c.outcome === o).length;
const tzA = customers.find((c) => c.customer_id === A)!.timezone;
const loc = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: tzA, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(iso));

const insTicket = db.prepare(`INSERT INTO tickets (key, customer_id, created_by, origin, assignee_id, subject, category, status, priority, created_at, updated_at)
  VALUES (?, ?, ?, 'portal', ?, ?, ?, ?, ?, ?, ?)`);
const insMsg = db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, author_kind, body, internal, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

const t1 = Number(insTicket.run('SUP-1001', A, clientUsers[A], admin, 'The AI stopped booking appointments', 'bookings', 'open', 'urgent', '2026-11-02T16:02:00Z', '2026-11-02T16:45:00Z').lastInsertRowid);
insMsg.run(t1, clientUsers[A], 'user', "The AI stopped booking appointments sometime last week. What's going on??", 0, 'sent', '2026-11-02T16:02:00Z');
insMsg.run(t1, admin, 'user', "Thanks for flagging this. I'm looking into it now and will update you within the hour.", 0, 'sent', '2026-11-02T16:09:00Z');
insMsg.run(t1, admin, 'user', [
  'Root cause',
  `BookWell stopped accepting the OAuth2 client secret we hold for Sunrise Dental between ${loc(lastOkRefresh.ts)} (last good refresh) and ${loc(firstBadRefresh.ts)} (first rejection): 401 invalid_client, "${firstBadRefresh.error_description}". ${badRefreshes} refreshes in a row since, still failing at the end of the log. Without a token every booking-sync write gets 401 invalid_token, retries 3 times, then dead-letters. Who changed the secret is not in our data.`,
  '',
  'Impact',
  `${affected.length} callers between ${affected[0].started_local} and ${affected.at(-1)!.started_local} (Pacific) were told their change was made: ${by('booked')} new bookings missing from BookWell, ${by('rescheduled')} reschedules still at the old time, ${by('cancelled')} cancellations still holding a slot. Lakeside Auto and Maple Hair are not affected. See the 3 linked critical alerts.`,
  '',
  'Why it was not caught',
  '- The agent confirms and records the outcome before the write result is known, so our data said "booked".',
  '- Refresh failures log at WARN and dead letters at ERROR; neither alerts.',
  '- avail-sync uses the nightly export, not OAuth, so availability looked healthy.',
  '- Auth errors are retried like transient ones; three attempts cannot fix a rejected secret.',
].join('\n'), 1, 'sent', '2026-11-02T16:40:00Z');
insMsg.run(t1, admin, 'user', [
  'Timeline (Pacific)',
  `- ${loc(lastOkWrite.ts)}: last write BookWell accepted`,
  `- ${loc(lastOkRefresh.ts)}: last token refresh that worked (valid 1 hour)`,
  `- ${loc(firstBadRefresh.ts)}: first refresh rejected, 401 invalid_client, WARN only`,
  `- ${loc(firstDead.ts)}: first write dead-lettered (${affected[0].call_id}, the caller was told it was done)`,
  `- ${loc(affected.at(-1)!.started_at)}: last affected call (${affected.at(-1)!.call_id})`,
  `- ${loc(lastBadRefresh.ts)}: still failing at the end of the log`,
  `- ${loc('2026-11-02T16:02:00Z')}: clinic opens this ticket`,
  '',
  'Actions',
  '- [ ] Ask the clinic who changed the BookWell API credentials around 17:30 PT on 26 Oct',
  '- [ ] Check our secret store history and deploys for 26 Oct',
  '- [ ] Install the new secret; confirm one token refresh returns 200',
  `- [ ] Replay the ${affected.length} dead letters, checking each slot is still free`,
  '- [ ] Send the clinic the drafted update below',
  '- [ ] Agent says "request received, the clinic will confirm" until writes succeed',
  '- [ ] Confirm to callers only after a 2xx write; record outcome=pending_write otherwise',
  '- [ ] Alert on 2 consecutive refresh failures and on any dead letter',
  '- [ ] Treat 401 invalid_client as non-retryable',
].join('\n'), 1, 'sent', '2026-11-02T16:42:00Z');
db.prepare("UPDATE flags SET ticket_id = ?, status = 'acknowledged' WHERE customer_id = ? AND rule IN ('auth_refresh_failing', 'dead_letter_writes', 'said_not_written')").run(t1, A);

// ---- SUP-1002: internal ticket, duplicate call records across all clients ---------------------
const dupTotal = get<{ n: number }>('SELECT COUNT(*) n FROM calls WHERE is_duplicate = 1')!.n;
const dupGroups = get<{ n: number }>('SELECT COUNT(DISTINCT telephony_sid) n FROM calls WHERE is_duplicate = 1')!.n;
const ackTimeouts = get<{ n: number; first: string; last: string }>("SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM log_events WHERE service = 'call-ingest'")!;
const t2 = Number(insTicket.run('SUP-1002', null, admin, admin, 'Duplicate call records from webhook redelivery', 'ingestion', 'open', 'normal', '2026-11-02T17:10:00Z', '2026-11-02T17:10:00Z').lastInsertRowid);
insMsg.run(t2, admin, 'user', [
  'Internal ticket, no client involved.',
  '',
  `${dupGroups} calls were ingested more than once, creating ${dupTotal} extra call records across all three clients. Counting records instead of telephony_sid overstates call volume and outcomes.`,
  '',
  `Cause: call-ingest acknowledges the telephony webhook only after processing. Past 10s the provider redelivers, and call-ingest assigns a new call_id instead of upserting on telephony_sid. ${ackTimeouts.n} timeouts were logged (${ackTimeouts.first} to ${ackTimeouts.last}, all Lakeside Auto), but some duplicate groups have no logged timeout, so redeliveries are not fully logged.`,
  '',
  'No double bookings: every duplicated appointment has exactly one booking-sync write.',
  '',
  'Actions',
  '- [ ] Ack the webhook first, process asynchronously',
  '- [ ] Upsert calls on telephony_sid',
  "- [ ] Log every redelivery with the provider's attempt header",
].join('\n'), 1, 'sent', '2026-11-02T17:10:00Z');
db.prepare("UPDATE flags SET ticket_id = ? WHERE rule IN ('duplicate_ingest', 'webhook_ack_timeout')").run(t2);

// ---- The drafted update for the clinic: a DRAFT reply on SUP-1001, waiting for an admin to send -------------
db.prepare("INSERT INTO ticket_messages (ticket_id, author_id, author_kind, body, internal, status, created_at) VALUES (?, ?, 'user', ?, 0, 'draft', ?)").run(
  t1, admin,
  [
    "Hi, thanks for flagging this, and I'm sorry. You were right, and here is what happened.",
    "Since about 5:30 PM on Monday 26 October, BookWell has been refusing our system's login for your account. It reports that the access key we use is no longer valid. Your AI assistant kept answering calls and told patients their appointments were booked, moved or cancelled, but none of those changes reached your BookWell calendar.",
    `Who is affected: ${affected.length} patients who called between Monday 26 and Saturday 31 October: ${by('booked')} new bookings, ${by('rescheduled')} reschedules and ${by('cancelled')} cancellations. The list is in your portal under Calls, filtered to "Needs follow-up", with each patient's name, the last four digits of their phone number and what they were told.`,
    'What we need from you today: did anyone at the practice change or regenerate the BookWell connection or API key around 5 PM last Monday? Either way, could someone with BookWell admin access join a 10-minute call this morning so we can reconnect it?',
    "What we're doing: until the connection is back, the assistant will take requests and tell callers your front desk will confirm, instead of confirming itself. Once it's back, we'll add the changes to BookWell, checking each time slot is still free, and tell you which ones need a personal call.",
    "I'll send you an update by 11 AM today.",
  ].join('\n\n'),
  '2026-11-02T16:45:00Z',
);

const counts = Object.fromEntries(['customers', 'users', 'calls', 'log_events', 'flags', 'tickets', 'ticket_messages']
  .map((t) => [t, (get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)!).n]));
console.log(`Seeded ${DB_PATH}`);
console.table(counts);
console.log(`Parsed ${logCount} log lines. Flags:`);
console.table(flags);
console.log(`\nSign in with password "${PASSWORD}":`);
console.table([
  { role: 'admin', email: 'admin@support.example' },
  { role: 'client (Sunrise Dental)', email: 'frontdesk@sunrisedental.example' },
]);
