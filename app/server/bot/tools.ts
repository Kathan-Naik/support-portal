/**
 * Tools for the debug bot. Read tools see everything (admin-level access).
 * Write tools change internal state only: alerts (flags), tickets the bot opens, internal ticket notes, draft replies.
 * Nothing the bot does reaches a client until a human sends it.
 */
import { Type } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, openReadOnlyDb, all, get, run, now, audit, ROOT } from '../db.ts';
import { deriveCalls, runDetectors } from '../detect.ts';
import { createTicket } from '../tickets.ts';

const MAX_CHARS = 24_000;
const text = (value: unknown) => {
  let s = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + `\n... truncated (${s.length} chars). Narrow the query.`;
  return { content: [{ type: 'text' as const, text: s }], details: {} };
};
const parseJson = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (typeof row[k] === 'string') row[k.replace(/_json$/, '')] = JSON.parse(row[k] as string), delete row[k];
  return row;
};

type ToolDef<P> = Omit<AgentTool<any>, 'execute'> & { execute: (toolCallId: string, params: P) => Promise<{ content: { type: 'text'; text: string }[]; details: object }> };
/** Typebox validates params before execute runs; this narrows them for the body. */
const tool = <P,>(d: ToolDef<P>) => d as unknown as AgentTool<any>;

export function buildTools(actor: string, userId: number): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    tool({
      name: 'describe_schema', label: 'Read schema',
      description: 'Return the SQLite schema of the portal database (tables, columns, comments). Call this before writing SQL.',
      parameters: Type.Object({}),
      execute: async () => text(readFileSync(resolve(ROOT, 'server/schema.sql'), 'utf8')),
    }),
    tool({
      name: 'sql_query', label: 'Run SQL',
      description: 'Run a read-only SQL query (SELECT or WITH) against the portal database. Use for any question the other tools do not cover: aggregations, joins between calls and log_events, time windows. Returns at most `limit` rows.',
      parameters: Type.Object({
        sql: Type.String({ description: 'A single SELECT or WITH statement.' }),
        limit: Type.Optional(Type.Number({ description: 'Max rows, default 100, max 500.' })),
      }),
      execute: async (_id, p: { sql: string; limit?: number }) => {
        const sql = p.sql.trim().replace(/;\s*$/, '');
        if (!/^(select|with)\b/i.test(sql) || sql.includes(';')) throw new Error('Only a single SELECT or WITH statement is allowed.');
        const limit = Math.min(Math.max(p.limit ?? 100, 1), 500);
        const rows = openReadOnlyDb().prepare(`SELECT * FROM (${sql}) LIMIT ${limit}`).all();
        return text({ row_count: rows.length, rows });
      },
    }),
    tool({
      name: 'search_logs', label: 'Search logs',
      description: 'Search integration.log events. Services: booking-sync (writes), booking-auth (token refresh), avail-sync (nightly availability), call-ingest (webhooks). Timestamps are UTC ISO strings.',
      parameters: Type.Object({
        customer_id: Type.Optional(Type.String()), service: Type.Optional(Type.String()), level: Type.Optional(Type.String({ description: 'DEBUG, INFO, WARN or ERROR' })),
        status: Type.Optional(Type.String({ description: 'HTTP status, e.g. 401' })), appointment_id: Type.Optional(Type.String()),
        contains: Type.Optional(Type.String({ description: 'Substring of the raw line' })), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ description: 'Default 50, max 300' })), order: Type.Optional(Type.String({ description: 'asc (default) or desc' })),
      }),
      execute: async (_id, p: Record<string, string | number | undefined>) => {
        const where: string[] = []; const args: unknown[] = [];
        for (const k of ['customer_id', 'service', 'level', 'status', 'appointment_id'] as const) if (p[k]) { where.push(`${k} = ?`); args.push(p[k]); }
        if (p.contains) { where.push('raw LIKE ?'); args.push(`%${p.contains}%`); }
        if (p.from) { where.push('ts >= ?'); args.push(p.from); }
        if (p.to) { where.push('ts <= ?'); args.push(p.to); }
        const lim = Math.min(Number(p.limit ?? 50), 300);
        const order = p.order === 'desc' ? 'DESC' : 'ASC';
        const total = get<{ n: number }>(`SELECT COUNT(*) n FROM log_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args)!.n;
        const rows = all<{ raw: string }>(`SELECT raw FROM log_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts ${order} LIMIT ${lim}`, ...args);
        return text(`${total} matching lines, showing ${rows.length}:\n` + rows.map((r) => r.raw).join('\n'));
      },
    }),
    tool({
      name: 'get_call', label: 'Open call',
      description: 'Full detail for one call: derived fields, transcript and every booking-sync event for its appointment.',
      parameters: Type.Object({ call_id: Type.String() }),
      execute: async (_id, p: { call_id: string }) => {
        const call = get<Record<string, unknown>>('SELECT * FROM calls WHERE call_id = ?', p.call_id);
        if (!call) throw new Error(`No call ${p.call_id}`);
        const writes = call.appointment_id ? all<{ raw: string }>('SELECT raw FROM log_events WHERE appointment_id = ? ORDER BY ts', call.appointment_id) : [];
        const dups = all<{ call_id: string }>('SELECT call_id FROM calls WHERE telephony_sid = ? AND call_id <> ?', call.telephony_sid, p.call_id);
        return text({ ...call, write_events: writes.map((w) => w.raw), same_telephony_sid: dups.map((d) => d.call_id) });
      },
    }),
    tool({
      name: 'list_flags', label: 'List flags',
      description: 'List alerts (flagged errors from the detectors), most severe first, with the ticket handling each one if any.',
      parameters: Type.Object({ customer_id: Type.Optional(Type.String()), status: Type.Optional(Type.String({ description: 'open, acknowledged or resolved' })) }),
      execute: async (_id, p: { customer_id?: string; status?: string }) => text(all(
        `SELECT f.id, f.rule, f.severity, f.customer_id, f.title, f.summary, f.count, f.first_seen, f.last_seen, f.status, t.key AS ticket_key FROM flags f LEFT JOIN tickets t ON t.id = f.ticket_id
         WHERE (? IS NULL OR f.customer_id = ?) AND (? IS NULL OR f.status = ?)
         ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, f.last_seen DESC`,
        p.customer_id ?? null, p.customer_id ?? null, p.status ?? null, p.status ?? null)),
    }),
    tool({
      name: 'get_flag', label: 'Open flag',
      description: 'One flag with its full analysis, recommendation and evidence.',
      parameters: Type.Object({ id: Type.Number() }),
      execute: async (_id, p: { id: number }) => {
        const f = get<Record<string, unknown>>('SELECT * FROM flags WHERE id = ?', p.id);
        if (!f) throw new Error(`No flag ${p.id}`);
        return text(parseJson(f, 'evidence_json'));
      },
    }),
    tool({
      name: 'get_ticket', label: 'Open ticket',
      description: 'A ticket by key (e.g. SUP-1001) with its linked alerts and all messages, including internal notes and unsent drafts. customer_id null means an internal ticket.',
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_id, p: { key: string }) => {
        const t = get<Record<string, unknown>>("SELECT t.*, COALESCE(c.name, 'Internal (no client)') AS customer_name FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id WHERE t.key = ?", p.key);
        if (!t) throw new Error(`No ticket ${p.key}`);
        const evidence = typeof t.evidence_json === 'string' ? JSON.parse(t.evidence_json) : null; delete t.evidence_json;
        const attachments = all('SELECT a.filename, a.mime, a.size, m.created_at FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE m.ticket_id = ?', t.id);
        return text({ ...t, evidence, attachments, alerts: all('SELECT id, rule, severity, title, status FROM flags WHERE ticket_id = ?', t.id), messages: all('SELECT m.created_at, m.internal, m.status, m.read_at, m.author_kind, u.name AS author, u.role, m.body FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE ticket_id = ? ORDER BY m.created_at', t.id) });
      },
    }),
    // ---- write tools: internal only ---------------------------------------------------
    tool({
      name: 'rerun_detectors', label: 'Re-run detectors',
      description: 'Recompute derived call fields and re-run every detector. Flag statuses are kept. Use after data changes.',
      parameters: Type.Object({}), executionMode: 'sequential',
      execute: async () => { const db = openDb(); deriveCalls(db); const r = runDetectors(db); audit(actor, 'bot.rerun_detectors'); return text(r); },
    }),
    tool({
      name: 'update_flag', label: 'Update alert',
      description: 'Change an alert status (open, acknowledged, resolved) and optionally link it to a ticket.',
      parameters: Type.Object({ id: Type.Number(), status: Type.Optional(Type.String()), ticket_key: Type.Optional(Type.String()) }),
      execute: async (_id, p: { id: number; status?: string; ticket_key?: string }) => {
        if (p.status && !['open', 'acknowledged', 'resolved'].includes(p.status)) throw new Error('status must be open, acknowledged or resolved');
        const tk = p.ticket_key ? get<{ id: number }>('SELECT id FROM tickets WHERE key = ?', p.ticket_key) : undefined;
        if (p.ticket_key && !tk) throw new Error(`No ticket ${p.ticket_key}`);
        run('UPDATE flags SET status = COALESCE(?, status), ticket_id = COALESCE(?, ticket_id) WHERE id = ?', p.status ?? null, tk?.id ?? null, p.id);
        audit(actor, 'bot.update_flag', `flag:${p.id}`, `${p.status ?? ''} ${p.ticket_key ?? ''}`.trim());
        return text(`Alert ${p.id} updated.`);
      },
    }),
    tool({
      name: 'add_internal_note', label: 'Add internal note',
      description: 'Add an internal note to a ticket. Internal notes are visible to support staff only, never to the client.',
      parameters: Type.Object({ ticket_key: Type.String(), body: Type.String() }),
      execute: async (_id, p: { ticket_key: string; body: string }) => {
        const t = get<{ id: number }>('SELECT id FROM tickets WHERE key = ?', p.ticket_key);
        if (!t) throw new Error(`No ticket ${p.ticket_key}`);
        run("INSERT INTO ticket_messages (ticket_id, author_id, author_kind, body, internal, created_at) VALUES (?, NULL, 'bot', ?, 1, ?)", t.id, p.body, now());
        run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), t.id);
        audit(actor, 'bot.add_internal_note', p.ticket_key);
        return { content: [{ type: 'text', text: `Internal note added to ${p.ticket_key}.` }], details: { ticket_key: p.ticket_key, wrote: 'note' } };
      },
    }),
    tool({
      name: 'draft_reply', label: 'Draft client reply',
      description: 'Save a DRAFT reply on a ticket. It is not sent: a support admin reviews and sends it from the ticket. Use this for every message meant for a client. Write in plain language for a non-technical business owner.',
      parameters: Type.Object({ ticket_key: Type.String({ description: 'e.g. SUP-1001' }), body: Type.String() }),
      execute: async (_id, p: { ticket_key: string; body: string }) => {
        const t = get<{ id: number }>('SELECT id FROM tickets WHERE key = ?', p.ticket_key);
        if (!t) throw new Error(`No ticket ${p.ticket_key}. Drafts go on an existing ticket; ask an admin to open one for the client.`);
        const r = run("INSERT INTO ticket_messages (ticket_id, author_id, author_kind, body, internal, status, created_at) VALUES (?, NULL, 'bot', ?, 0, 'draft', ?)", t.id, p.body, now());
        run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), t.id);
        audit(actor, 'bot.draft_reply', p.ticket_key, `message:${r.lastInsertRowid}`);
        return { content: [{ type: 'text', text: `Draft saved on ${p.ticket_key}. An admin must review and send it.` }], details: { ticket_key: p.ticket_key, wrote: 'draft' } };
      },
    }),
    tool({
      name: 'propose_ticket', label: 'Propose ticket',
      description: 'Call this once you have enough evidence that a problem needs a ticket (a cause or a clear pattern, with counts and examples). It creates nothing: it shows the admin a proposal card with a Create button. Do not call create_ticket until the admin asks.',
      parameters: Type.Object({
        subject: Type.String({ description: 'Short, specific, e.g. "BookWell rejects Sunrise Dental credentials"' }),
        customer_id: Type.Optional(Type.String({ description: 'Client the problem affects. Omit for an internal ticket that spans clients or concerns only our systems.' })),
        priority: Type.Optional(Type.String({ description: 'urgent, high, normal or low' })),
        why: Type.String({ description: 'Two or three sentences: what is wrong, the evidence, who is affected.' }),
        flag_ids: Type.Optional(Type.Array(Type.Number(), { description: 'Alert ids this ticket should own' })),
      }),
      execute: async (_id, p: { subject: string; customer_id?: string; priority?: string; why: string; flag_ids?: number[] }) => {
        const customer = p.customer_id ? get<{ name: string }>('SELECT name FROM customers WHERE id = ?', p.customer_id) : undefined;
        if (p.customer_id && !customer) throw new Error(`No client ${p.customer_id}`);
        const proposal = { subject: p.subject, customer_id: p.customer_id ?? null, customer: customer?.name ?? null, priority: p.priority ?? 'normal', why: p.why, flag_ids: p.flag_ids ?? [] };
        return { content: [{ type: 'text', text: 'Proposal shown to the admin with a Create ticket button. Wait for them to ask before creating it.' }], details: { proposal } };
      },
    }),
    tool({
      name: 'create_ticket', label: 'Create ticket',
      description: 'Open a ticket for a problem you investigated. Your findings become an internal note; alerts are linked; an optional draft reply waits for an admin. A client ticket stays invisible to the client until an admin sends a reply. Only call when the admin asks you to create a ticket.',
      parameters: Type.Object({
        subject: Type.String(),
        customer_id: Type.Optional(Type.String({ description: 'Omit for an internal ticket' })),
        priority: Type.Optional(Type.String({ description: 'urgent, high, normal or low' })),
        category: Type.Optional(Type.String({ description: 'bookings, calls, ingestion, billing or general' })),
        findings: Type.String({ description: 'Internal note for staff: cause, evidence with call ids and log timestamps, impact, next actions.' }),
        draft_reply: Type.Optional(Type.String({ description: 'Optional plain-language reply for the client, saved as a draft. Only with customer_id.' })),
        flag_ids: Type.Optional(Type.Array(Type.Number())),
      }),
      execute: async (_id, p: { subject: string; customer_id?: string; priority?: string; category?: string; findings: string; draft_reply?: string; flag_ids?: number[] }) => {
        if (p.draft_reply && !p.customer_id) throw new Error('A draft reply needs a client; leave it out for an internal ticket.');
        const messages = [{ body: p.findings, internal: true, author_id: null, author_kind: 'bot' as const }];
        if (p.draft_reply) messages.push({ body: p.draft_reply, internal: false, draft: true, author_id: null, author_kind: 'bot' as const } as never);
        const r = createTicket({
          customer_id: p.customer_id ?? null, created_by: userId, origin: 'bot', subject: p.subject, category: p.category, priority: p.priority,
          messages, flag_ids: p.flag_ids ?? [], actor,
        });
        return {
          content: [{ type: 'text', text: `Created ${r.key}${p.customer_id ? ` for ${p.customer_id}` : ' (internal)'}; linked ${r.linkedFlags} alert(s)${p.draft_reply ? '; draft reply waiting for an admin' : ''}. Tell the admin the key.` }],
          details: { ticket_key: r.key },
        };
      },
    }),
  ];
  return tools;
}
