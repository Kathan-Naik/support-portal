import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Leaves } from '../components/Leaves.tsx';

const DEMO = [
  { email: 'admin@support.example', label: 'Support admin', who: 'Deployment Engineer' },
  { email: 'frontdesk@sunrisedental.example', label: 'Client', who: 'Sunrise Dental' },
];

export function Login({ onIn }: { onIn: () => void; from: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent, preset?: string) => {
    e?.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/auth/login', { body: { email: preset ?? email, password: preset ? 'demo1234' : password } });
      onIn();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      document.getElementById('email')?.focus();
    } finally { setBusy(false); }
  };
  return (
    <>
    <Leaves />
    <main className="login" id="main">
      <div>
        <h1>Support for your AI phone agent.</h1>
        <p className="login__lead">Something not right with your calls or bookings? Open a ticket, add an example call, and follow it here until it is fixed.</p>
        <p className="login__lead login__lead--quiet">Our support team works every ticket with the call logs, live alerts and a debug assistant behind it.</p>
      </div>
      <div className="plate">
        <form onSubmit={submit} noValidate>
          <div className="plate__head"><b>Sign in</b></div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(err)} aria-describedby="login-err" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input className="input" id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="err" id="login-err" aria-live="polite">{err}</p>
          <button type="submit" className="btn btn--primary" aria-busy={busy} disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
        </form>
        <div className="demo">
          <p>Seeded accounts, password demo1234:</p>
          {DEMO.map((d) => (
            <button key={d.email} type="button" onClick={() => submit(undefined, d.email)} disabled={busy}>
              {d.who}<span>{d.label}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
    </>
  );
}
