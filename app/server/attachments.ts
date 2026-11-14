/** Evidence files on ticket messages: validated, stored under data/uploads, served only to people who can see the message. */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, extname } from 'node:path';
import { DB_PATH, run, all, now } from './db.ts';

export const UPLOAD_DIR = resolve(dirname(DB_PATH), 'uploads');
export const MAX_FILES = 6;
export const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv',
};

export type Attachment = { id: number; message_id: number; filename: string; mime: string; size: number };

export function clearUploads() {
  if (existsSync(UPLOAD_DIR)) rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

/** Throws a message fit to show the user if any file is not acceptable. Nothing is written unless all pass. */
export function checkFiles(files: File[]) {
  if (files.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);
  for (const f of files) {
    if (!ALLOWED[f.type]) throw new Error(`${f.name}: only images, PDF, text or CSV files can be attached.`);
    if (f.size > MAX_BYTES) throw new Error(`${f.name} is larger than 8 MB.`);
    if (f.size === 0) throw new Error(`${f.name} is empty.`);
  }
}

export async function saveFiles(messageId: number, files: File[]) {
  checkFiles(files);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const f of files) {
    const stored = randomBytes(16).toString('hex') + (ALLOWED[f.type] ?? extname(f.name));
    writeFileSync(resolve(UPLOAD_DIR, stored), Buffer.from(await f.arrayBuffer()));
    const name = f.name.replace(/[\\/\r\n"]/g, '_').slice(0, 120) || 'file';
    run('INSERT INTO ticket_attachments (message_id, filename, mime, size, stored_as, created_at) VALUES (?, ?, ?, ?, ?, ?)', messageId, name, f.type, f.size, stored, now());
  }
}

export function attachmentsFor(messageIds: number[]): Attachment[] {
  if (!messageIds.length) return [];
  return all<Attachment>(`SELECT id, message_id, filename, mime, size FROM ticket_attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY id`, ...messageIds);
}

export const pathOf = (stored: string) => resolve(UPLOAD_DIR, stored);
