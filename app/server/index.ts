import './env.ts';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { ROOT, DB_PATH, openDb, get } from './db.ts';
import { currentUser, createSession, destroySession, verifyPassword, type Env } from './auth.ts';
import { data } from './routes/data.ts';
import { support } from './routes/support.ts';
import { bot } from './routes/bot.ts';
import { botStatus } from './bot/agent.ts';

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run "npm run seed" first.`);
  process.exit(1);
}
openDb();

const app = new Hono<Env>();

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  const u = get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', (email ?? '').trim().toLowerCase());
  if (!u || !verifyPassword(password ?? '', u.password_hash)) return c.json({ error: 'That email and password do not match.' }, 401);
  createSession(c, u.id);
  return c.json({ ok: true });
});
app.post('/api/auth/logout', (c) => { destroySession(c); return c.json({ ok: true }); });
app.get('/api/auth/me', (c) => {
  const user = currentUser(c);
  return user ? c.json(user) : c.json({ error: 'Not signed in.' }, 401);
});
app.get('/api/health', async (c) => c.json({ ok: true, bot: await botStatus() }));

app.route('/api', data);
app.route('/api', support);
app.route('/api/bot', bot);
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

// The two design documents from ../design, linked from the app's About box. Only these two files.
const DOCS: Record<string, string> = { 'design-system.html': 'design-system.html', 'high-level-design.html': 'high-level-design.html' };
app.get('/docs/:file', (c) => {
  const name = DOCS[c.req.param('file')];
  const file = name ? resolve(ROOT, '..', 'design', name) : '';
  if (!name || !existsSync(file)) return c.text('Not found.', 404);
  return c.html(readFileSync(file, 'utf8'));
});

// Built client (npm run build). In development Vite serves the client and proxies /api here.
const dist = resolve(ROOT, 'dist');
if (existsSync(dist)) {
  const rel = relative(process.cwd(), dist) || '.';
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', serveStatic({ path: `${rel}/index.html` }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, async () => {
  const b = await botStatus();
  console.log(`Support portal API on http://localhost:${port}${existsSync(dist) ? ' (serving built client)' : ''}`);
  console.log(`Debug bot: ${b.configured ? `ready (${b.provider} ${b.model})` : b.hasKey ? `unknown model ${b.model}` : 'FIREWORKS_API_KEY not set, bot disabled'}`);
});
