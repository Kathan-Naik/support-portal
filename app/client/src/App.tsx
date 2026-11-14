import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, useApi } from './api.ts';
import { ToastProvider, Loading } from './components/ui.tsx';
import { Login } from './pages/Login.tsx';
import { AdminOverview } from './pages/admin/Overview.tsx';
import { FlagsPage, FlagDetail } from './pages/admin/Flags.tsx';
import { LogsPage } from './pages/admin/Logs.tsx';
import { BotPage } from './pages/admin/Bot.tsx';
import { CallsPage } from './pages/Calls.tsx';
import { TicketsPage, TicketDetail, NewTicket } from './pages/Tickets.tsx';
import { ClientHome } from './pages/client/Home.tsx';

export type Me = { id: number; email: string; name: string; title: string | null; role: 'admin' | 'client'; customer_id: string | null; customer_name: string | null };
const MeCtx = createContext<{ me: Me; signOut: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loc = useLocation();
  const refresh = () => api<Me>('/auth/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { void refresh(); }, []);
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }); setMe(null); };

  if (me === undefined) return <div className="client-main"><Loading /></div>;
  if (!me) return <ToastProvider><Routes><Route path="*" element={<Login onIn={refresh} from={loc.pathname} />} /></Routes></ToastProvider>;
  return (
    <MeCtx.Provider value={{ me, signOut }}>
      <ToastProvider>
        <Routes>
          {me.role === 'admin' ? (
            <Route path="/admin/*" element={<AdminShell />} />
          ) : (
            <Route path="/portal/*" element={<ClientShell />} />
          )}
          <Route path="*" element={<Navigate to={me.role === 'admin' ? '/admin' : '/portal'} replace />} />
        </Routes>
      </ToastProvider>
    </MeCtx.Provider>
  );
}

type Overview = { flags: { severity: string; n: number }[]; tickets: { last_public_role: string | null; drafts: number }[]; drafts: number };

function AdminShell() {
  const { me, signOut } = useMe();
  const loc = useLocation();
  const ov = useApi<Overview>(`/overview?nav=${loc.pathname}`);
  const crit = ov.data?.flags.find((f) => f.severity === 'critical')?.n ?? 0;
  const openFlags = ov.data?.flags.reduce((a, f) => a + f.n, 0) ?? 0;
  // The debug bot is a focused workspace: no portal nav, the chat gets the whole window.
  const focus = loc.pathname.startsWith('/admin/bot');
  const waiting = ov.data?.tickets.filter((t) => t.last_public_role !== 'admin' || t.drafts > 0).length ?? 0;
  const link = (to: string, label: string, n?: number, owed?: boolean, end?: boolean) => (
    <NavLink to={to} end={end} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
      {label}{n ? <span className={`n${owed ? ' n--owed' : ''}`} aria-label={`${n} need attention`}>{n}</span> : null}
    </NavLink>
  );
  return (
    <div className={`app${focus ? ' app--focus' : ''}`}>
      {focus ? null : <aside className="side">
        <a className="wordmark" href="/admin">Support portal</a>
        <p className="side__role">Internal</p>
        <nav aria-label="Admin">
          {link('/admin', 'Overview', undefined, false, true)}
          {link('/admin/tickets', 'Tickets', waiting, waiting > 0)}
          {link('/admin/alerts', 'Logs & Alerts', openFlags, crit > 0)}
          {link('/admin/bot', 'Debug bot')}
        </nav>
        <div className="side__me">
          <AboutDocs />
          <div><b>{me.name}</b><br /><span>{me.email}</span></div>
          <button type="button" className="btn btn--link" onClick={signOut}>Sign out</button>
        </div>
      </aside>}
      <main className={`main${focus ? ' main--focus' : ''}`} id="main">
        <Routes>
          <Route index element={<AdminOverview />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="tickets/new" element={<NewTicket />} />
          <Route path="tickets/:key" element={<TicketDetail />} />
          <Route path="alerts" element={<AlertsLayout counts={{ flags: openFlags, critical: crit }} />}>
            <Route index element={<FlagsPage />} />
            <Route path="flags/:id" element={<FlagDetail />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="calls" element={<CallsPage />} />
          </Route>
          {/* One route for the bot, so starting a session mid-answer never remounts the page. */}
          <Route path="bot/:id?" element={<BotPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Logs & Alerts: one nav entry, three views behind a tab strip. */
function AlertsLayout({ counts }: { counts: { flags: number; critical: number } }) {
  const loc = useLocation();
  const p = loc.pathname;
  const tab = (to: string, label: ReactNode, on: boolean) => (
    <NavLink to={to} className="subnav__link" aria-current={on ? 'page' : undefined}>{label}</NavLink>
  );
  return (
    <>
      <nav className="subnav" aria-label="Logs and alerts">
        {tab('/admin/alerts', <>Alerts{counts.flags ? <span className={`n${counts.critical ? ' n--owed' : ''}`}>{counts.flags}</span> : null}</>, p === '/admin/alerts' || p.startsWith('/admin/alerts/flags'))}
        {tab('/admin/alerts/logs', 'Logs', p.startsWith('/admin/alerts/logs'))}
        {tab('/admin/alerts/calls', 'Calls', p.startsWith('/admin/alerts/calls'))}
      </nav>
      <Outlet />
    </>
  );
}

function ClientShell() {
  const { me, signOut } = useMe();
  const loc = useLocation();
  const ov = useApi<{ unread: number }>(`/overview?nav=${loc.pathname}`);
  const link = (to: string, label: ReactNode, end?: boolean) => <NavLink to={to} end={end} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>{label}</NavLink>;
  return (
    <>
      <header className="topnav-app">
        <div className="container">
          <a className="wordmark" href="/portal">{me.customer_name}</a>
          <nav aria-label="Portal">
            {link('/portal', 'Home', true)}
            {link('/portal/tickets', <>Tickets{ov.data?.unread ? <span className="n" aria-label={`${ov.data.unread} new replies`}>{ov.data.unread}</span> : null}</>)}
          </nav>
          <div className="me"><AboutDocs compact /><span>{me.email}</span><button type="button" className="btn btn--link" onClick={signOut}>Sign out</button></div>
        </div>
      </header>
      <main className="client-main" id="main">
        <Routes>
          <Route index element={<ClientHome />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="tickets/new" element={<NewTicket />} />
          <Route path="tickets/:key" element={<TicketDetail />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </main>
    </>
  );
}

/** Links to the two design documents in ../design, served by the API at /docs. */
function AboutDocs({ compact }: { compact?: boolean }) {
  const links = (
    <>
      <a href="/docs/high-level-design.html" target="_blank" rel="noreferrer">High-level design</a>
      <a href="/docs/design-system.html" target="_blank" rel="noreferrer">Design system</a>
    </>
  );
  if (compact) return <details className="about about--compact"><summary>About</summary><div className="about__menu">{links}</div></details>;
  return <div className="about"><span className="about__label">About this build</span>{links}</div>;
}

export function useGo() { return useNavigate(); }
