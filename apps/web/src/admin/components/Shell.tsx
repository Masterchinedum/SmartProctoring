import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { qk } from '../api/queries';
import { useLive } from '../api/live';
import { useAuth } from '../auth';
import { ROLE_LABELS } from '../lib/labels';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/admin', label: 'Live', end: true },
  { to: '/admin/sessions', label: 'Sessions' },
  { to: '/admin/exams', label: 'Exams' },
  { to: '/admin/candidates', label: 'Candidates' },
  { to: '/admin/quality', label: 'Quality' },
  { to: '/admin/audit', label: 'Audit log', adminOnly: true },
  { to: '/admin/settings', label: 'Settings', adminOnly: true },
  { to: '/admin/integrations', label: 'Integrations', adminOnly: true },
  { to: '/admin/users', label: 'Users', adminOnly: true },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, org, isAdmin } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      /* the session may already be gone */
    }
    qc.clear();
    qc.setQueryData(qk.me, null);
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <div className="admin-brand">
          <span className="brand-mark" aria-hidden>
            SP
          </span>
          <div>
            <div className="brand-name">SmartProctoring</div>
            <div className="brand-org" title={org.name}>
              {org.name}
            </div>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {n.label}
              {n.to === '/admin' ? <LiveDot /> : null}
            </NavLink>
          ))}
        </nav>
        <div className="admin-user">
          <div className="user-name" title={user.email}>
            {user.name}
          </div>
          <div className="muted small user-email" title={user.email}>
            {user.email}
          </div>
          <div className="muted small">{ROLE_LABELS[user.role]}</div>
          <button type="button" className="btn btn-sm" onClick={logout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <LiveBanner />
        {children}
      </main>
    </div>
  );
}

function LiveDot() {
  const { status } = useLive();
  const label = status === 'open' ? 'Live updates connected' : status === 'reconnecting' ? 'Live updates disconnected' : 'Connecting…';
  return <span className={`live-dot live-${status}`} title={label} aria-label={label} />;
}

/** Shown whenever the realtime channel is down. */
export function LiveBanner() {
  const { status, nextRetryAt, reconnectNow } = useLive();
  const [, force] = useState(0);
  useEffect(() => {
    if (status !== 'reconnecting') return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [status]);
  if (status !== 'reconnecting') return null;
  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : null;
  return (
    <div className="banner banner-warning live-banner no-print" role="status">
      <span className="pulse-dot warn" aria-hidden />
      Live updates disconnected — retrying{secs != null && secs > 0 ? ` in ${secs}s.` : '…'} Data shown may be out of date.
      <button type="button" className="btn btn-sm" onClick={reconnectNow}>
        Retry now
      </button>
    </div>
  );
}
