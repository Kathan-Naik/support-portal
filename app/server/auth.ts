import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { get, run } from './db.ts';

export type SessionUser = { id: number; email: string; name: string; title: string | null; role: 'admin' | 'client'; customer_id: string | null; customer_name: string | null };
export type Env = { Variables: { user: SessionUser } };

const COOKIE = 'portal_session';
const TTL_MS = 1000 * 60 * 60 * 12;

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string) {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length);
  return timingSafeEqual(want, got);
}

export function createSession(c: Context, userId: number) {
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, new Date(Date.now() + TTL_MS).toISOString());
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: TTL_MS / 1000, secure: process.env.NODE_ENV === 'production' });
}

export function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function currentUser(c: Context): SessionUser | undefined {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  return get<SessionUser>(
    `SELECT u.id, u.email, u.name, u.title, u.role, u.customer_id, cu.name AS customer_name
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN customers cu ON cu.id = u.customer_id
     WHERE s.token = ? AND s.expires_at > ?`, token, new Date().toISOString());
}

export async function requireUser(c: Context<Env>, next: Next) {
  const user = currentUser(c);
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
  c.set('user', user);
  await next();
}

export async function requireAdmin(c: Context<Env>, next: Next) {
  const user = currentUser(c);
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'This area is for support staff.' }, 403);
  c.set('user', user);
  await next();
}

/** Clients may only ever see their own customer's rows. Admins may pass any customer or none. */
export function scopeCustomer(user: SessionUser, requested?: string | null) {
  return user.role === 'client' ? user.customer_id! : requested || null;
}
