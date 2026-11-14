import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status}).`, res.status);
  return data as T;
}

/** POST a multipart form (fields plus files). Objects are sent as JSON strings. */
export async function apiForm<T = unknown>(path: string, fields: Record<string, unknown>, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const f of files) fd.append('files', f, f.name);
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: fd });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status}).`, res.status);
  return data as T;
}

/** Fetch on mount and whenever `path` changes. `null` skips. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export type Proposal = { subject: string; customer_id: string | null; customer: string | null; priority: string; why: string; flag_ids: number[] };

export type BotEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; isError: boolean; preview: string; ticket_key?: string; proposal?: Proposal; wrote?: 'note' | 'draft' }
  | { type: 'compacted'; tokensBefore: number; tokensAfter: number; when: 'before' | 'during' | 'overflow' }
  | { type: 'context'; tokens: number; window: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** POST to the bot and read its Server-Sent Events stream. */
export async function streamBot(sessionId: number, prompt: string, model: string, onEvent: (e: BotEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/bot/sessions/${sessionId}/chat`, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, model }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text();
    throw new ApiError((t && JSON.parse(t).error) || `Request failed (${res.status}).`, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) onEvent(JSON.parse(data) as BotEvent);
    }
  }
}
