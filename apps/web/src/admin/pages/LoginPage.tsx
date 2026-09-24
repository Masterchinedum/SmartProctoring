import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from '../api/client';
import { qk } from '../api/queries';
import { useMe } from '../auth';

function safeNext(next: string | null): string {
  // Only allow in-app admin paths (no open redirects).
  if (next && next.startsWith('/admin') && !next.startsWith('//') && !next.startsWith('/admin/login')) return next;
  return '/admin';
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me.data) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password);
      qc.setQueryData(qk.me, res);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) setError('Incorrect email or password.');
      else if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a minute and try again.');
      else if (err instanceof ApiError && err.status === 403) setError('This account is disabled. Contact your administrator.');
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card stack" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            SP
          </span>
          <div>
            <h1>SmartProctoring</h1>
            <div className="muted">Staff sign in</div>
          </div>
        </div>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Access to candidate evidence is restricted to authorised staff and every view is logged.</p>
      </form>
    </div>
  );
}
