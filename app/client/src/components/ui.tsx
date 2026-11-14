import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export function PageHead({ title, lead, children, crumb }: { title: string; lead?: ReactNode; children?: ReactNode; crumb?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumb}
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {children ? <div className="inline-actions">{children}</div> : null}
    </div>
  );
}

export const Sev = ({ s }: { s: string }) => <span className={`sev sev--${s}`}>{s}</span>;
export const St = ({ s, label }: { s: string; label?: string }) => <span className={`st st--${s}`}>{label ?? s}</span>;
export const Outcome = ({ o, quiet }: { o: string; quiet?: boolean }) => <span className={`badge${quiet || !['booked', 'rescheduled', 'cancelled'].includes(o) ? ' badge--quiet' : ''}`}>{o}</span>;

export function Write({ status, http, dup, client }: { status: string; http?: string | null; dup?: boolean; client?: boolean }) {
  if (dup) return <span className="wr wr--dup">duplicate</span>;
  if (status === 'failed') return <span className="wr wr--failed">{client ? 'not saved' : `failed ${http ?? ''}`}</span>;
  if (status === 'written') return <span className="wr wr--written">{client ? 'saved' : `written ${http ?? ''}`}</span>;
  if (status === 'unknown') return <span className="wr wr--none">unknown</span>;
  return <span className="wr wr--none">{client ? 'no change' : 'no write'}</span>;
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skel" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading</span>
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skel-row" aria-hidden="true" style={{ width: `${92 - (i % 3) * 9}%` }} />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <h3>That did not load.</h3>
      <p>{message}</p>
      {onRetry ? <button type="button" className="btn" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="center-state">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** Render the four states of any data region. */
export function Region<T>({ q, children, rows, empty, isEmpty }: {
  q: { data: T | null; error: string | null; loading: boolean; reload: () => void };
  children: (d: T) => ReactNode; rows?: number; empty?: ReactNode; isEmpty?: (d: T) => boolean;
}) {
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading rows={rows} />;
  if (isEmpty?.(q.data) && empty) return <>{empty}</>;
  return <>{children(q.data)}</>;
}

/** Native <dialog> drawer: focus trap, Esc to close, focus returns to the opener. */
export function Drawer({ open, onClose, title, sub, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { opener.current = document.activeElement; d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="drawer" style={wide ? { width: 'min(52rem, 100%)' } : undefined}
      onClose={() => { onClose(); (opener.current as HTMLElement | null)?.focus?.(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} aria-label={typeof title === 'string' ? title : undefined}>
      {open ? (
        <>
          <div className="drawer__head">
            <div><h2>{title}</h2>{sub ? <p>{sub}</p> : null}</div>
            <button type="button" className="btn" onClick={onClose} autoFocus>Close</button>
          </div>
          <div className="drawer__body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}

export function Confirm({ open, title, children, confirmLabel, onConfirm, onCancel }: { open: boolean; title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} className="confirm" onClose={onCancel} aria-labelledby="confirm-title">
      <div className="confirm__body"><h2 id="confirm-title">{title}</h2><div className="prose">{children}</div></div>
      <div className="confirm__actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const k = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
            if (!k) return; e.preventDefault();
            const n = (i + k + tabs.length) % tabs.length; onChange(tabs[n].id); refs.current[n]?.focus();
          }}>{t.label}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode }[]; value: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return <button key={o.id} type="button" className="chip" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}>{o.label}</button>;
      })}
    </div>
  );
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="switch__track" aria-hidden="true" />{children}
    </button>
  );
}

// ---- toast -------------------------------------------------------------------------
type Toast = { id: number; text: string };
const ToastCtx = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setT({ id: Date.now(), text });
    timer.current = window.setTimeout(() => setT(null), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">{t ? <div key={t.id} className="toast is-in">{t.text}</div> : null}</div>
    </ToastCtx.Provider>
  );
}

/** Tiny, safe markdown for bot answers and analyses: escapes HTML, then handles code, bold, lists, headings, tables. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  const inline = (s: string, k: string): ReactNode[] => {
    const out: ReactNode[] = []; let rest = s; let i = 0;
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/;
    while (rest) {
      const m = rest.match(re);
      if (!m || m.index === undefined) { out.push(rest); break; }
      if (m.index) out.push(rest.slice(0, m.index));
      const tok = m[0];
      out.push(tok.startsWith('`') ? <code key={`${k}-${i++}`}>{tok.slice(1, -1)}</code> : <strong key={`${k}-${i++}`}>{tok.slice(2, -2)}</strong>);
      rest = rest.slice(m.index + tok.length);
    }
    return out;
  };
  let i = 0; let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; blocks.push(<pre key={key++}>{body.join('\n')}</pre>); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line); i += 2; const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      blocks.push(<div key={key++} className="table-wrap"><table><thead><tr>{head.map((h, j) => <th key={j}>{inline(h, `h${j}`)}</th>)}</tr></thead>
        <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `c${ri}${j}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={key++}>{items.map((it, j) => <li key={j}>{inline(it, `l${j}`)}</li>)}</L>); continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push(<h4 key={key++}>{inline(h[2], `hh${key}`)}</h4>); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join('\n'), `p${key}`)}</p>);
  }
  return <div className="prose">{blocks}</div>;
}
