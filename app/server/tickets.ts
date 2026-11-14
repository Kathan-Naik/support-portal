/** One way to open a ticket, shared by the API (people) and the debug bot. */
import { get, run, now, audit } from './db.ts';

export type NewMessage = { body: string; internal?: boolean; draft?: boolean; author_id: number | null; author_kind?: 'user' | 'bot' };
export type NewTicket = {
  customer_id: string | null;           // null = internal ticket, never visible to a client
  created_by: number;                   // the user who opened it (for the bot: the admin running it)
  origin?: 'portal' | 'bot';
  subject: string;
  category?: string;
  priority?: string;
  status?: 'open' | 'pending';
  messages: NewMessage[];
  flag_ids?: number[];                  // alerts this ticket now owns
  evidence?: Evidence | null;           // what the reporter gave: when it started, example calls
  actor: string;                        // for the audit log
};

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export type Evidence = { started_at?: string; examples?: { caller?: string; phone_last4?: string; when?: string; what?: string }[] };

/** Keep only well-formed, bounded evidence; null when nothing useful was given. */
export function cleanEvidence(raw: unknown): Evidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Evidence;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const examples = (Array.isArray(r.examples) ? r.examples : []).slice(0, 10).map((e) => ({
    caller: s(e?.caller, 80), phone_last4: s(e?.phone_last4, 4).replace(/\D/g, ''), when: s(e?.when, 60), what: s(e?.what, 400),
  })).filter((e) => e.caller || e.phone_last4 || e.when || e.what);
  const started_at = s(r.started_at, 60);
  return started_at || examples.length ? { ...(started_at ? { started_at } : {}), ...(examples.length ? { examples } : {}) } : null;
}

export function createTicket(t: NewTicket): { id: number; key: string; linkedFlags: number; messageIds: number[] } {
  if (t.customer_id && !get('SELECT 1 FROM customers WHERE id = ?', t.customer_id)) throw new Error(`No client ${t.customer_id}`);
  const n = get<{ n: number }>('SELECT COALESCE(MAX(id), 0) + 1001 n FROM tickets')!.n;
  const key = `SUP-${n}`;
  const at = now();
  const priority = PRIORITIES.includes(t.priority ?? '') ? t.priority! : 'normal';
  const evidence = t.evidence ? JSON.stringify(t.evidence) : null;
  const id = Number(run(`INSERT INTO tickets (key, customer_id, created_by, origin, assignee_id, subject, category, status, priority, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    key, t.customer_id, t.created_by, t.origin ?? 'portal', t.created_by, t.subject, t.category || 'general', t.status ?? 'open', priority, evidence, at, at).lastInsertRowid);
  const messageIds: number[] = [];
  for (const m of t.messages) {
    messageIds.push(Number(run('INSERT INTO ticket_messages (ticket_id, author_id, author_kind, body, internal, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, m.author_id, m.author_kind ?? 'user', m.body, m.internal ? 1 : 0, m.draft && !m.internal ? 'draft' : 'sent', at).lastInsertRowid));
  }
  let linkedFlags = 0;
  for (const f of t.flag_ids ?? []) linkedFlags += Number(run("UPDATE flags SET ticket_id = ?, status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END WHERE id = ?", id, f).changes);
  audit(t.actor, t.origin === 'bot' ? 'bot.create_ticket' : 'ticket.create', key, t.customer_id ?? 'internal');
  return { id, key, linkedFlags, messageIds };
}
