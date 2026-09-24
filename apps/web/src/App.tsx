import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

// Candidate and staff apps are separate bundles; each owns its own route tree.
const CandidateApp = lazy(() => import('./candidate/CandidateApp'));
const AdminApp = lazy(() => import('./admin/AdminApp'));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="page-loading">Loading…</div>}>
        <Routes>
          <Route path="/take/:token/*" element={<CandidateApp />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
