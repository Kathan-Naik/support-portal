import { Hono } from 'hono';
import { all, get, run, openDb, audit, now } from '../db.ts';
import { requireUser, requireAdmin, scopeCustomer, type Env } from '../auth.ts';
import { deriveCalls, runDetectors } from '../detect.ts';

export const data = new Hono<Env>();

const SEV = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";
const page = (q: Record<string, string>) => {
  const size = Math.min(Math.max(Number(q.size ?? 50), 1), 200);
  const p = Math.max(Number(q.page ?? 1), 1);
  return { size, offset: (p - 1) * size, page: p };
};

/** Health in the client's words, derived from open alerts. */
function health(customerId: string) {
  const crit = get<{ n: number }>("SELECT COUNT(*) n FROM flags WHERE customer_id = ? AND status <> 'resolved' AND severity = 'critical'", customerId)!.n;
  const med = get<{ n: number }>("SELECT COUNT(*) n FROM flags WHERE customer_id = ? AND status <> 'resolved' AND severity IN ('high', 'medium')", customerId)!.n;
  const level = crit ? 'down' : med ? 'degraded' : 'ok';
  return { level, criticalFlags: crit, otherFlags: med };
}

// ---- overview ----------------------------------------------------------------------
data.get('/overview', requireUser, (c) => {
  const user = c.get('user');
  if (user.role === 'client') {
    const cid = user.customer_id!;
    const visible = "EXISTS (SELECT 1 FROM ticket_messages v WHERE v.ticket_id = t.id AND v.internal = 0 AND v.status = 'sent')";
    return c.json({
      role: 'client',
      customer: get('SELECT id, name, booking_system, timezone, business_hours FROM customers WHERE id = ?', cid),
      health: health(cid),
      tickets: all(`SELECT t.key, t.subject, t.status, t.priority, t.updated_at,
          (SELECT COUNT(*) FROM ticket_messages m JOIN users u ON u.id = m.author_id WHERE m.ticket_id = t.id AND m.internal = 0 AND m.status = 'sent' AND u.role = 'admin' AND m.read_at IS NULL) unread
        FROM tickets t WHERE t.customer_id = ? AND t.status IN ('open','pending') AND ${visible} ORDER BY t.updated_at DESC`, cid),
      counts: get(`SELECT SUM(t.status = 'open') open, SUM(t.status = 'pending') pending, SUM(t.status IN ('resolved','closed')) done FROM tickets t WHERE t.customer_id = ? AND ${visible}`, cid),
      unread: get<{ n: number }>(`SELECT COUNT(*) n FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id JOIN users u ON u.id = m.author_id
        WHERE t.customer_id = ? AND m.internal = 0 AND m.status = 'sent' AND u.role = 'admin' AND m.read_at IS NULL`, cid)!.n,
      latestReply: get(`SELECT t.key, t.subject, m.created_at, substr(m.body, 1, 200) preview, m.read_at FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id JOIN users u ON u.id = m.author_id
        WHERE t.customer_id = ? AND m.internal = 0 AND m.status = 'sent' AND u.role = 'admin' ORDER BY m.created_at DESC LIMIT 1`, cid) ?? null,
    });
  }
  const customers = all<{ id: string; name: string; booking_system: string }>('SELECT id, name, booking_system FROM customers ORDER BY name');
  return c.json({
    role: 'admin',
    flags: all(`SELECT severity, COUNT(*) n FROM flags WHERE status <> 'resolved' GROUP BY severity ORDER BY ${SEV}`),
    topFlags: all(`SELECT f.id, f.rule, f.severity, f.title, f.status, f.last_seen, c.name customer, t.key ticket_key FROM flags f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN tickets t ON t.id = f.ticket_id
      WHERE f.status <> 'resolved' ORDER BY ${SEV.replace('severity', 'f.severity')}, f.last_seen DESC LIMIT 6`),
    // Critical alerts grouped by client, with the ticket handling them (if any): the banner on Overview.
    critical: all(`SELECT c.id customer_id, c.name customer, COUNT(*) alerts, MIN(f.first_seen) since, MAX(t.key) ticket_key, MAX(t.subject) ticket_subject
      FROM flags f JOIN customers c ON c.id = f.customer_id LEFT JOIN tickets t ON t.id = f.ticket_id
      WHERE f.severity = 'critical' AND f.status <> 'resolved' GROUP BY c.id ORDER BY since`),
    tickets: all(`SELECT t.key, t.subject, t.status, t.priority, t.updated_at, COALESCE(c.name, 'Internal') customer, t.customer_id,
      (SELECT u.role FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = t.id AND m.internal = 0 AND m.status = 'sent' ORDER BY m.created_at DESC LIMIT 1) last_public_role,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.status = 'draft') drafts
      FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id WHERE t.status IN ('open','pending') ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.updated_at DESC`),
    drafts: get<{ n: number }>("SELECT COUNT(*) n FROM ticket_messages WHERE status = 'draft'")!.n,
    customers: customers.map((cu) => ({
      ...cu, health: health(cu.id),
      ...get(`SELECT COUNT(*) calls, SUM(write_status = 'written') saved, SUM(said_not_written) follow_up, SUM(is_duplicate) duplicates FROM calls WHERE customer_id = ?`, cu.id),
      lastWrite: get<{ ts: string }>("SELECT MAX(ts) ts FROM log_events WHERE customer_id = ? AND service = 'booking-sync' AND status LIKE '2%'", cu.id)?.ts ?? null,
    })),
    logRange: get('SELECT MIN(ts) first, MAX(ts) last, COUNT(*) n FROM log_events'),
  });
});

// ---- customers ---------------------------------------------------------------------
data.get('/customers', requireUser, (c) => {
  const user = c.get('user');
  const rows = all<Record<string, unknown> & { id: string; staff_json: string }>('SELECT * FROM customers WHERE (? IS NULL OR id = ?) ORDER BY name', scopeCustomer(user), scopeCustomer(user));
  return c.json(rows.map(({ staff_json, ...r }) => ({ ...r, staff: JSON.parse(staff_json), health: health(r.id) })));
});

// ---- calls ---------------------------------------------------------------------------
// Calls are internal: clients work through tickets, support reads the calls.
data.get('/calls', requireAdmin, (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const { size, offset, page: p } = page(q);
  const where: string[] = []; const args: unknown[] = [];
  const cust = scopeCustomer(user, q.customer);
  if (cust) { where.push('c.customer_id = ?'); args.push(cust); }
  if (q.from) { where.push('substr(c.started_local, 1, 10) >= ?'); args.push(q.from); }
  if (q.to) { where.push('substr(c.started_local, 1, 10) <= ?'); args.push(q.to); }
  if (q.intent) { where.push('c.intent_tag = ?'); args.push(q.intent); }
  if (q.outcome) { const o = q.outcome.split(','); where.push(`c.outcome IN (${o.map(() => '?').join(',')})`); args.push(...o); }
  if (q.write) { const w = q.write.split(','); where.push(`c.write_status IN (${w.map(() => '?').join(',')})`); args.push(...w); }
  if (q.followUp === '1') where.push('c.said_not_written = 1');
  if (q.mismatch === '1') where.push('c.intent_mismatch = 1');
  if (q.dups !== '1') where.push('c.is_duplicate = 0');
  if (q.q) { where.push('(lower(c.caller_name) LIKE ? OR c.caller_phone_last4 LIKE ? OR c.call_id LIKE ? OR c.appointment_id LIKE ? OR lower(c.transcript) LIKE ?)'); const s = `%${q.q.toLowerCase()}%`; args.push(s, s, s, s, s); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = q.sort === 'asc' ? 'ASC' : 'DESC';
  const total = get<{ n: number }>(`SELECT COUNT(*) n FROM calls c ${w}`, ...args)!.n;
  const rows = all(`SELECT c.call_id, c.customer_id, cu.name customer, c.started_at, c.started_local, c.duration_sec, c.caller_name, c.caller_phone_last4,
      c.intent_tag, c.outcome, c.appointment_id, c.write_op, c.write_status, c.write_http, c.write_attempts, c.is_duplicate, c.said_not_written, c.intent_mismatch
    FROM calls c JOIN customers cu ON cu.id = c.customer_id ${w} ORDER BY c.started_at ${order} LIMIT ? OFFSET ?`, ...args, size, offset);
  const facets = get(`SELECT SUM(c.said_not_written) followUp, SUM(c.write_status = 'failed') failed FROM calls c ${w}`, ...args);
  return c.json({ total, page: p, size, rows, facets });
});

data.get('/calls/:id', requireAdmin, (c) => {
  const user = c.get('user');
  const call = get<Record<string, unknown> & { customer_id: string; appointment_id: string | null; telephony_sid: string }>(
    'SELECT c.*, cu.name customer, cu.booking_system, cu.timezone FROM calls c JOIN customers cu ON cu.id = c.customer_id WHERE call_id = ?', c.req.param('id'));
  if (!call || (user.role === 'client' && call.customer_id !== user.customer_id)) return c.json({ error: 'Call not found.' }, 404);
  const writes = call.appointment_id ? all(`SELECT ts, level, op, status, error, attempt, final, action, external_id, latency_ms${user.role === 'admin' ? ', raw' : ''} FROM log_events WHERE appointment_id = ? ORDER BY ts`, call.appointment_id) : [];
  const duplicates = all('SELECT call_id, ingested_at FROM calls WHERE telephony_sid = ? AND call_id <> ?', call.telephony_sid, call.call_id);
  return c.json({ ...call, writes, duplicates });
});

// ---- logs (admin) ------------------------------------------------------------------
data.get('/logs', requireAdmin, (c) => {
  const q = c.req.query();
  const { size, offset, page: p } = page(q);
  const where: string[] = []; const args: unknown[] = [];
  for (const k of ['service', 'level', 'status', 'appointment_id'] as const) if (q[k]) { const v = q[k].split(','); where.push(`${k} IN (${v.map(() => '?').join(',')})`); args.push(...v); }
  if (q.customer) { where.push('customer_id = ?'); args.push(q.customer); }
  if (q.from) { where.push('ts >= ?'); args.push(q.from); }
  if (q.to) { where.push('ts <= ?'); args.push(q.to + 'T23:59:59.999Z'); }
  if (q.q) { where.push('raw LIKE ?'); args.push(`%${q.q}%`); }
  if (q.problems === '1') where.push("(level IN ('WARN','ERROR') OR (status IS NOT NULL AND status NOT LIKE '2%' AND status <> 'ok'))");
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = get<{ n: number }>(`SELECT COUNT(*) n FROM log_events ${w}`, ...args)!.n;
  const rows = all(`SELECT id, ts, level, service, customer_id, op, event, appointment_id, status, error, error_description, attempt, final, action, latency_ms, sid, raw FROM log_events ${w} ORDER BY ts ${q.sort === 'asc' ? 'ASC' : 'DESC'}, id LIMIT ? OFFSET ?`, ...args, size, offset);
  const byLevel = all(`SELECT level, COUNT(*) n FROM log_events ${w} GROUP BY level`, ...args);
  const byDay = all(`SELECT substr(ts, 1, 10) day, SUM(level = 'ERROR') errors, SUM(level = 'WARN') warns, COUNT(*) n FROM log_events ${w} GROUP BY day ORDER BY day`, ...args);
  return c.json({ total, page: p, size, rows, byLevel, byDay });
});

// ---- flags (admin) -------------------------------------------------------------------
data.get('/flags', requireAdmin, (c) => {
  const q = c.req.query();
  const where: string[] = []; const args: unknown[] = [];
  if (q.status) { where.push('f.status = ?'); args.push(q.status); } else where.push("f.status <> 'resolved'");
  if (q.severity) { where.push('f.severity = ?'); args.push(q.severity); }
  if (q.customer) { where.push('f.customer_id = ?'); args.push(q.customer); }
  if (q.ticket === 'none') where.push('f.ticket_id IS NULL');
  return c.json(all(`SELECT f.id, f.rule, f.severity, f.customer_id, c.name customer, f.title, f.summary, f.count, f.first_seen, f.last_seen, f.status,
      t.key ticket_key, t.subject ticket_subject, t.status ticket_status
    FROM flags f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN tickets t ON t.id = f.ticket_id
    WHERE ${where.join(' AND ')} ORDER BY ${SEV.replace(/severity/g, 'f.severity')}, f.last_seen DESC`, ...args));
});

data.get('/flags/:id', requireAdmin, (c) => {
  const f = get<Record<string, unknown> & { evidence_json: string }>(`SELECT f.*, c.name customer, c.timezone, t.key ticket_key, t.subject ticket_subject, t.status ticket_status
    FROM flags f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN tickets t ON t.id = f.ticket_id WHERE f.id = ?`, Number(c.req.param('id')));
  if (!f) return c.json({ error: 'Alert not found.' }, 404);
  const { evidence_json, ...rest } = f;
  return c.json({ ...rest, evidence: JSON.parse(evidence_json) });
});

data.patch('/flags/:id', requireAdmin, async (c) => {
  const body = await c.req.json<{ status?: string; ticket_key?: string | null }>();
  const id = Number(c.req.param('id'));
  if (body.status && !['open', 'acknowledged', 'resolved'].includes(body.status)) return c.json({ error: 'Unknown status.' }, 400);
  const tk = body.ticket_key ? get<{ id: number }>('SELECT id FROM tickets WHERE key = ?', body.ticket_key) : null;
  if (body.ticket_key && !tk) return c.json({ error: `No ticket ${body.ticket_key}.` }, 400);
  run('UPDATE flags SET status = COALESCE(?, status), ticket_id = CASE WHEN ? THEN ? ELSE ticket_id END WHERE id = ?',
    body.status ?? null, body.ticket_key !== undefined ? 1 : 0, tk?.id ?? null, id);
  audit(c.get('user').email, 'flag.update', `flag:${id}`, JSON.stringify(body));
  return c.json({ ok: true });
});

data.post('/flags/rescan', requireAdmin, (c) => {
  const db = openDb();
  deriveCalls(db);
  const result = runDetectors(db);
  audit(c.get('user').email, 'flags.rescan', undefined, `${result.length} flags`);
  return c.json({ ok: true, flags: result.length, at: now() });
});

data.get('/users', requireAdmin, (c) => c.json(all("SELECT id, name, email, title, role, customer_id FROM users ORDER BY role, name")));
data.get('/audit', requireAdmin, (c) => c.json(all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')));
