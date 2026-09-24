import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { setUnauthorizedHandler } from './api/client';
import { qk } from './api/queries';
import { LiveProvider } from './api/live';
import { AuthProvider, useAuth, useMe } from './auth';
import { Shell } from './components/Shell';
import { EmptyState, ErrorState, Loading } from './components/Common';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/session/SessionDetailPage';
import { ComparePage } from './pages/ComparePage';
import { ReportPage } from './pages/ReportPage';
import { ExamsPage } from './pages/exams/ExamsPage';
import { ExamDetailPage } from './pages/exams/ExamDetailPage';
import { ExamEditPage } from './pages/exams/ExamEditPage';
import { CandidatesPage } from './pages/candidates/CandidatesPage';
import { CandidateDetailPage } from './pages/candidates/CandidateDetailPage';
import { QualityPage } from './pages/QualityPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { SettingsPage } from './pages/SettingsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { UsersPage } from './pages/UsersPage';
import './admin.css';

/** Staff application, mounted at /admin/*. */
export default function AdminApp() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<AuthedLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/:id" element={<SessionDetailPage />} />
        <Route path="sessions/:id/compare/:eventId" element={<ComparePage />} />
        <Route path="sessions/:id/report" element={<ReportPage />} />
        <Route path="exams" element={<ExamsPage />} />
        <Route path="exams/new" element={<AdminOnly><ExamEditPage /></AdminOnly>} />
        <Route path="exams/:id" element={<ExamDetailPage />} />
        <Route path="exams/:id/edit" element={<AdminOnly><ExamEditPage /></AdminOnly>} />
        <Route path="candidates" element={<CandidatesPage />} />
        <Route path="candidates/:id" element={<CandidateDetailPage />} />
        <Route path="quality" element={<QualityPage />} />
        <Route path="audit" element={<AdminOnly><AuditLogPage /></AdminOnly>} />
        <Route path="settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="integrations" element={<AdminOnly><IntegrationsPage /></AdminOnly>} />
        <Route path="users" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="*" element={<EmptyState title="Page not found">This page does not exist.</EmptyState>} />
      </Route>
    </Routes>
  );
}

function AuthedLayout() {
  const qc = useQueryClient();
  const location = useLocation();
  const me = useMe();

  useEffect(() => {
    // Any 401 from the staff API: drop the cached user so we route to the login page.
    setUnauthorizedHandler(() => qc.setQueryData(qk.me, null));
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  if (me.isPending) return <Loading label="Loading…" />;
  if (me.isError) {
    return (
      <div className="center-page">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} title="Could not reach the server" />
      </div>
    );
  }
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/admin/login${next && next !== '/admin' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  return (
    <AuthProvider me={me.data}>
      <LiveProvider>
        <Shell>
          <Outlet />
        </Shell>
      </LiveProvider>
    </AuthProvider>
  );
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <EmptyState title="Administrators only">Your role (reviewer) cannot open this page.</EmptyState>;
  return <>{children}</>;
}
