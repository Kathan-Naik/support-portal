import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const DB_PATH = resolve(ROOT, process.env.DB_PATH ?? 'data/portal.db');

let db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  return db;
}

/** A second connection that SQLite itself refuses to write through. The debug bot's SQL tool uses it. */
let ro: DatabaseSync | null = null;
export function openReadOnlyDb(): DatabaseSync {
  if (ro) return ro;
  // readOnly is supported by node:sqlite at runtime (Node 22.5+); older @types/node lacks it.
  ro = new DatabaseSync(DB_PATH, { readOnly: true } as never);
  return ro;
}

export function applySchema(d: DatabaseSync) {
  d.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
}

export const now = () => new Date().toISOString();

export function audit(actor: string, action: string, target?: string, detail?: string) {
  openDb()
    .prepare('INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(actor, action, target ?? null, detail ?? null, now());
}

type Row = Record<string, unknown>;
export const all = <T = Row>(sql: string, ...params: unknown[]) =>
  openDb().prepare(sql).all(...(params as never[])) as T[];
export const get = <T = Row>(sql: string, ...params: unknown[]) =>
  openDb().prepare(sql).get(...(params as never[])) as T | undefined;
export const run = (sql: string, ...params: unknown[]) => openDb().prepare(sql).run(...(params as never[]));
