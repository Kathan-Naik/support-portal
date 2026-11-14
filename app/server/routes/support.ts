import { Hono } from 'hono';
import { all, get, run, now, audit } from '../db.ts';
import { requireUser, requireAdmin, scopeCustomer, type Env } from '../auth.ts';
import { createTicket, cleanEvidence, PRIORITIES } from '../tickets.ts';
import { readFileSync, existsSync } from 'node:fs';
import { checkFiles, saveFiles, attachmentsFor, pathOf } from '../attachments.ts';
import type { Context } from 'hono';

/** Accept JSON or multipart (fields + files[] for evidence attachments). */
async function readBody(c: Context): Promise<{ fields: Record<string, unknown>; files: File[] }> {
  if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
    const form = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(form['files'] ?? []).filter((f): f is File => f instanceof File && f.size > 0);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form)) if (k !== 'files') fields[k] = Array.isArray(v) ? v[0] : v;
    for (const k of ['evidence', 'flag_ids']) if (typeof fields[k] === 'string' && fields[k]) { try { fields[k] = JSON.parse(fields[k] as string); } catch { fields[k] = undefined; } }
    for (const k of ['draft', 'internal']) if (typeof fields[k] === 'string') fields[k] = fields[k] === 'true';
    return { fields, files };
  }
  return { fields: await c.req.json<Record<string, unknown>>(), files: [] };
}

/**
 * Tickets are the only channel between support and a client, and the unit of work for problems.
 * A message is a client post, a support reply (sent or draft), or an internal note.
 * Clients only ever receive sent, non-internal messages, and never see internal tickets (customer_id NULL).
 * Alerts (flags) link to the ticket that handles them.
 */
export const support = new Hono<Env>();

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const VISIBLE_TO_CLIENT = "m.internal = 0 AND m.status = 'sent'";
const SEV = "CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

support.get('/tickets', requireUser, (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const where: string[] = []; const args: unknown[] = [];
  if (user.role === 'client') {
    where.push('t.customer_id = ?'); args.push(user.customer_id);
    // A ticket support opened with only a draft or notes does not exist for the client yet.
    where.push(`EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND ${VISIBLE_TO_CLIENT})`);
  } else if (q.customer === 'internal') where.push('t.customer_id IS NULL');
  else if (q.customer) { where.push('t.customer_id = ?'); args.push(q.customer); }
  if (q.status) { where.push('t.status = ?'); args.push(q.status); }
  const rows = all<Record<string, unknown>>(`SELECT t.id, t.key, t.subject, t.category, t.status, t.priority, t.origin, t.created_at, t.updated_at, c.name customer, t.customer_id,
      u.name created_by_name, u.role created_by_role, a.name assignee,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND ${VISIBLE_TO_CLIENT}) messages,
      (SELECT u2.role FROM ticket_messages m2 LEFT JOIN users u2 ON u2.id = m2.author_id WHERE m2.ticket_id = t.id AND m2.internal = 0 AND m2.status = 'sent' ORDER BY m2.created_at DESC LIMIT 1) last_public_role,
      (SELECT COUNT(*) FROM ticket_messages m3 WHERE m3.ticket_id = t.id AND m3.status = 'draft') drafts,
      (SELECT COUNT(*) FROM ticket_messages m4 LEFT JOIN users u4 ON u4.id = m4.author_id WHERE m4.ticket_id = t.id AND m4.internal = 0 AND m4.status = 'sent' AND u4.role = 'admin' AND m4.read_at IS NULL) unread,
      (SELECT COUNT(*) FROM flags f WHERE f.ticket_id = t.id AND f.status <> 'resolved') alerts,
      (SELECT f.severity FROM flags f WHERE f.ticket_id = t.id AND f.status <> 'resolved' ORDER BY ${SEV} LIMIT 1) top_severity
    FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id JOIN users u ON u.id = t.created_by LEFT JOIN users a ON a.id = t.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC`, ...args);
  return c.json(user.role === 'client'
    ? rows.map(({ drafts, alerts, top_severity, assignee, origin, ...r }) => r)
    : rows);
});

/** A client opens a ticket; an admin opens one for a client (or an internal one with no client). */
support.post('/tickets', requireUser, async (c) => {
  const user = c.get('user');
  const { fields, files } = await readBody(c);
  const b = fields as { subject?: string; body?: string; category?: string; priority?: string; customer_id?: string | null; flag_ids?: number[]; draft?: boolean; internal?: boolean; evidence?: unknown };
  try { checkFiles(files); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  const subject = clean(b.subject, 160); const body = clean(b.body, 20000);
  if (!subject || !body) return c.json({ error: user.role === 'client' ? 'Add a subject and describe the problem.' : 'Add a subject and a message.' }, 400);
  const admin = user.role === 'admin';
  const customer = admin ? (clean(b.customer_id, 40) || null) : user.customer_id!;
  // With no client the first post can only be an internal note.
  const internalNote = admin && (customer === null || Boolean(b.internal));
  try {
    const r = createTicket({
      customer_id: customer, created_by: user.id, subject, category: clean(b.category, 40), priority: b.priority, actor: user.email,
      status: admin && !internalNote && !b.draft ? 'pending' : 'open',
      messages: [{ body, author_id: user.id, internal: internalNote, draft: admin && !internalNote && Boolean(b.draft) }],
      flag_ids: admin ? (b.flag_ids ?? []).map(Number).filter(Boolean) : [],
      evidence: cleanEvidence(b.evidence),
    });
    if (files.length) await saveFiles(r.messageIds[0], files);
    return c.json({ key: r.key }, 201);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
});

support.get('/tickets/:key', requireUser, (c) => {
  const user = c.get('user');
  const t = get<Record<string, unknown> & { id: number; customer_id: string | null }>(`SELECT t.*, c.name customer, c.booking_system, c.timezone, u.name created_by_name, u.role created_by_role, a.name assignee
    FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id JOIN users u ON u.id = t.created_by LEFT JOIN users a ON a.id = t.assignee_id WHERE t.key = ?`, c.req.param('key'));
  const hidden = !t || (user.role === 'client' && (t.customer_id !== user.customer_id || !get(`SELECT 1 FROM ticket_messages m WHERE m.ticket_id = ? AND ${VISIBLE_TO_CLIENT}`, t.id)));
  if (hidden) return c.json({ error: 'Ticket not found.' }, 404);
  const messages = all(`SELECT m.id, m.body, m.internal, m.status, m.author_kind, m.created_at, m.read_at, u.name author, u.role author_role, u.title author_title
    FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = ? ${user.role === 'client' ? `AND ${VISIBLE_TO_CLIENT}` : ''} ORDER BY m.status = 'draft', m.created_at, m.id`, t!.id);
  const files = attachmentsFor((messages as { id: number }[]).map((m) => m.id));
  const withFiles = (messages as { id: number }[]).map((m) => ({ ...m, attachments: files.filter((f) => f.message_id === m.id) }));
  const evidence = typeof t!.evidence_json === 'string' ? JSON.parse(t!.evidence_json as string) : null;
  delete t!.evidence_json;
  if (user.role === 'client') {
    // Opening the ticket is reading it: stamp support replies the client has not seen.
    run(`UPDATE ticket_messages SET read_at = ? WHERE ticket_id = ? AND internal = 0 AND status = 'sent' AND read_at IS NULL
      AND author_id IN (SELECT id FROM users WHERE role = 'admin')`, now(), t!.id);
    const { assignee_id, assignee, origin, ...rest } = t!;
    return c.json({ ...rest, evidence, messages: withFiles });
  }
  const alerts = all(`SELECT f.id, f.rule, f.severity, f.title, f.status, f.count, f.customer_id, cu.name customer FROM flags f LEFT JOIN customers cu ON cu.id = f.customer_id
    WHERE f.ticket_id = ? ORDER BY ${SEV}`, t!.id);
  const investigations = all('SELECT id, title, updated_at FROM bot_sessions WHERE ticket_id = ? ORDER BY updated_at DESC', t!.id);
  return c.json({ ...t, evidence, messages: withFiles, alerts, investigations });
});

support.post('/tickets/:key/messages', requireUser, async (c) => {
  const user = c.get('user');
  const { fields, files } = await readBody(c);
  const b = fields as { body?: string; internal?: boolean; draft?: boolean; status?: string };
  try { checkFiles(files); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  const t = get<{ id: number; customer_id: string | null; status: string }>('SELECT id, customer_id, status FROM tickets WHERE key = ?', c.req.param('key'));
  if (!t || (user.role === 'client' && t.customer_id !== user.customer_id)) return c.json({ error: 'Ticket not found.' }, 404);
  const body = clean(b.body, 20000);
  if (!body && !files.length) return c.json({ error: 'Write a reply first.' }, 400);
  const admin = user.role === 'admin';
  const internal = admin && (b.internal || t.customer_id === null) ? 1 : 0;
  const status = admin && b.draft && !internal ? 'draft' : 'sent';
  const msgId = Number(run('INSERT INTO ticket_messages (ticket_id, author_id, body, internal, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', t.id, user.id, body || '(attached files)', internal, status, now()).lastInsertRowid);
  if (files.length) await saveFiles(msgId, files);
  let ticketStatus = t.status;
  if (!admin) ticketStatus = 'open';
  else if (!internal && status === 'sent') ticketStatus = STATUSES.includes(b.status ?? '') ? b.status! : 'pending';
  run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', ticketStatus, now(), t.id);
  audit(user.email, internal ? 'ticket.note' : status === 'draft' ? 'ticket.draft' : 'ticket.reply', c.req.param('key'));
  return c.json({ ok: true, status: ticketStatus }, 201);
});

// ---- drafts: admins edit, send or discard ------------------------------------------
const findMsg = (key: string, id: number) =>
  get<{ id: number; ticket_id: number; status: string; customer_id: string | null }>('SELECT m.id, m.ticket_id, m.status, t.customer_id FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id WHERE t.key = ? AND m.id = ?', key, id);

support.patch('/tickets/:key/messages/:id', requireAdmin, async (c) => {
  const m = findMsg(c.req.param('key'), Number(c.req.param('id')));
  if (!m) return c.json({ error: 'Message not found.' }, 404);
  if (m.status !== 'draft') return c.json({ error: 'Sent messages cannot be edited.' }, 409);
  const body = clean((await c.req.json<{ body?: string }>()).body, 20000);
  if (!body) return c.json({ error: 'The draft is empty.' }, 400);
  run('UPDATE ticket_messages SET body = ? WHERE id = ?', body, m.id);
  return c.json({ ok: true });
});

support.post('/tickets/:key/messages/:id/send', requireAdmin, (c) => {
  const m = findMsg(c.req.param('key'), Number(c.req.param('id')));
  if (!m) return c.json({ error: 'Message not found.' }, 404);
  if (m.status !== 'draft') return c.json({ error: 'Already sent.' }, 409);
  if (!m.customer_id) return c.json({ error: 'This is an internal ticket; there is no client to send to.' }, 409);
  // The sender owns the message from here on, even when the debug bot drafted it.
  run("UPDATE ticket_messages SET status = 'sent', created_at = ?, author_id = ?, author_kind = 'user' WHERE id = ?", now(), c.get('user').id, m.id);
  run("UPDATE tickets SET status = 'pending', updated_at = ? WHERE id = ?", now(), m.ticket_id);
  audit(c.get('user').email, 'ticket.send_draft', c.req.param('key'), `message:${m.id}`);
  return c.json({ ok: true });
});

support.delete('/tickets/:key/messages/:id', requireAdmin, (c) => {
  const m = findMsg(c.req.param('key'), Number(c.req.param('id')));
  if (!m || m.status !== 'draft') return c.json({ error: 'Only drafts can be discarded.' }, 409);
  run('DELETE FROM ticket_messages WHERE id = ?', m.id);
  audit(c.get('user').email, 'ticket.discard_draft', c.req.param('key'), `message:${m.id}`);
  return c.json({ ok: true });
});

support.patch('/tickets/:key', requireUser, async (c) => {
  const user = c.get('user');
  const b = await c.req.json<{ status?: string; priority?: string; assignee_id?: number | null }>();
  const t = get<{ id: number; customer_id: string | null }>('SELECT id, customer_id FROM tickets WHERE key = ?', c.req.param('key'));
  if (!t || (user.role === 'client' && t.customer_id !== user.customer_id)) return c.json({ error: 'Ticket not found.' }, 404);
  if (b.status && !STATUSES.includes(b.status)) return c.json({ error: 'Unknown status.' }, 400);
  if (user.role === 'client') {
    if (!b.status || !['resolved', 'open'].includes(b.status)) return c.json({ error: 'You can mark a ticket resolved or reopen it.' }, 403);
    run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', b.status, now(), t.id);
  } else {
    if (b.priority && !PRIORITIES.includes(b.priority)) return c.json({ error: 'Unknown priority.' }, 400);
    run(`UPDATE tickets SET status = COALESCE(?, status), priority = COALESCE(?, priority),
      assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END, updated_at = ? WHERE id = ?`,
      b.status ?? null, b.priority ?? null, b.assignee_id !== undefined ? 1 : 0, b.assignee_id ?? null, now(), t.id);
  }
  audit(user.email, 'ticket.update', c.req.param('key'), JSON.stringify(b));
  return c.json({ ok: true });
});

// ---- attachments: only for people who can see the message they are on ------------------------
support.get('/attachments/:id', requireUser, (c) => {
  const user = c.get('user');
  const a = get<{ filename: string; mime: string; stored_as: string; internal: number; status: string; customer_id: string | null }>(
    `SELECT a.filename, a.mime, a.stored_as, m.internal, m.status, t.customer_id FROM ticket_attachments a
     JOIN ticket_messages m ON m.id = a.message_id JOIN tickets t ON t.id = m.ticket_id WHERE a.id = ?`, Number(c.req.param('id')));
  const allowed = a && (user.role === 'admin' || (a.customer_id === user.customer_id && !a.internal && a.status === 'sent'));
  if (!allowed || !existsSync(pathOf(a!.stored_as))) return c.json({ error: 'File not found.' }, 404);
  const inline = a!.mime.startsWith('image/') || a!.mime === 'application/pdf';
  return c.body(readFileSync(pathOf(a!.stored_as)), 200, {
    'content-type': a!.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${a!.filename}"`,
  });
});
