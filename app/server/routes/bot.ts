import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { all, get, run, now } from '../db.ts';
import { requireAdmin, type Env } from '../auth.ts';
import { botStatus, chat, abortSession, sessionContext } from '../bot/agent.ts';

export const bot = new Hono<Env>();

bot.get('/status', requireAdmin, async (c) => c.json(await botStatus()));

bot.get('/sessions', requireAdmin, (c) =>
  c.json(all('SELECT s.id, s.title, s.created_at, s.updated_at, u.name owner, t.key ticket_key FROM bot_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN tickets t ON t.id = s.ticket_id ORDER BY s.updated_at DESC LIMIT 100')));

/** Start an investigation; with ticket_key it is tied to that ticket and findings go there. */
bot.post('/sessions', requireAdmin, async (c) => {
  const body = await c.req.json<{ ticket_key?: string }>().catch(() => ({} as { ticket_key?: string }));
  const tk = body.ticket_key ? get<{ id: number; key: string; subject: string }>('SELECT id, key, subject FROM tickets WHERE key = ?', body.ticket_key) : undefined;
  if (body.ticket_key && !tk) return c.json({ error: `No ticket ${body.ticket_key}.` }, 404);
  const t = now();
  const id = run('INSERT INTO bot_sessions (user_id, ticket_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    c.get('user').id, tk?.id ?? null, tk ? `${tk.key}: ${tk.subject}`.slice(0, 80) : 'New investigation', t, t).lastInsertRowid;
  return c.json({ id: Number(id) }, 201);
});

bot.get('/sessions/:id', requireAdmin, (c) => {
  const id = Number(c.req.param('id'));
  const s = get(`SELECT s.*, t.key ticket_key, t.subject ticket_subject, COALESCE(cu.name, 'Internal') ticket_customer
    FROM bot_sessions s LEFT JOIN tickets t ON t.id = s.ticket_id LEFT JOIN customers cu ON cu.id = t.customer_id WHERE s.id = ?`, id);
  if (!s) return c.json({ error: 'Session not found.' }, 404);
  const messages = all<{ message_json: string }>('SELECT message_json FROM bot_messages WHERE session_id = ? ORDER BY seq', id).map((r) => JSON.parse(r.message_json));
  return c.json({ ...s, messages, context: sessionContext(id, c.req.query('model')) });
});

bot.delete('/sessions/:id', requireAdmin, (c) => {
  run('DELETE FROM bot_sessions WHERE id = ?', Number(c.req.param('id')));
  return c.json({ ok: true });
});

bot.post('/sessions/:id/abort', requireAdmin, (c) => {
  abortSession(Number(c.req.param('id')));
  return c.json({ ok: true });
});

bot.post('/sessions/:id/chat', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!get('SELECT 1 FROM bot_sessions WHERE id = ?', id)) return c.json({ error: 'Session not found.' }, 404);
  const { prompt, model } = await c.req.json<{ prompt?: string; model?: string }>();
  if (!prompt?.trim()) return c.json({ error: 'Ask a question first.' }, 400);
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const emit = (e: object) => stream.writeSSE({ data: JSON.stringify(e) });
    try {
      await chat(id, user.id, `bot:${user.email}`, prompt.trim(), emit, model);
    } catch (err) {
      await emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      await emit({ type: 'done' });
    }
  });
});
