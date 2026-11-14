/** Format a UTC ISO time. With a timezone it shows that zone's wall clock and its short name. */
export function when(iso: string | null | undefined, tz?: string, opts: { date?: boolean; year?: boolean } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // en-US gives zone names like PDT/PST; parts are reassembled as "Mon 26 Oct, 17:31 PDT".
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: opts.year ? 'numeric' : undefined,
    hour: opts.date ? undefined : '2-digit', minute: opts.date ? undefined : '2-digit', hourCycle: 'h23',
    timeZoneName: opts.date ? undefined : 'short',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const day = `${p.weekday} ${p.day} ${p.month}${p.year ? ` ${p.year}` : ''}`;
  return opts.date ? day : `${day}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** started_local is "YYYY-MM-DD HH:mm" in the customer's zone already. */
export function localStamp(s: string | null | undefined) {
  if (!s) return '';
  const [date, time] = s.split(' ');
  const d = new Date(`${date}T00:00:00Z`);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${time}`;
}

export function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const OUTCOME_FOR_CLIENT: Record<string, string> = {
  booked: 'booked', rescheduled: 'moved', cancelled: 'cancelled', resolved: 'answered', transferred: 'passed to your team', abandoned: 'hung up',
};
