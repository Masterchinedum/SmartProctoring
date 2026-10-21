import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, isMfaChallenge } from '../api/client';
import { qk } from '../api/queries';
import { useMe } from '../auth';
import { useDocumentTitle } from '../../lib/a11y';
import { loginErrorMessage } from '../lib/auth-errors';
import { cleanCode } from '../lib/mfa';
import { ssoDiscoverErrorMessage } from '../lib/sso';
import { ssoErrorMessage } from '@sp/shared';

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
  // Back from an identity provider that did not sign the person in: ?sso_error=<code>.
  const ssoError = params.get('sso_error');
  const [error, setError] = useState<string | null>(() => ssoErrorMessage(ssoError));
  // Second step (two-step sign-in): an authenticator code, or a recovery code. 'sso': sign in with your organisation.
  const [step, setStep] = useState<'password' | 'code' | 'recovery' | 'sso'>(ssoError ? 'sso' : 'password');
  const [code, setCode] = useState('');
  useDocumentTitle(step === 'password' ? 'Sign in — SmartProctoring staff' : step === 'sso' ? 'Sign in with your organisation — SmartProctoring staff' : 'Two-step sign-in — SmartProctoring staff');

  if (me.data) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const res = await api.login(email.trim(), password);
        if (isMfaChallenge(res)) {
          setPassword('');
          setCode('');
          setStep('code');
          return;
        }
        qc.setQueryData(qk.me, res);
      } else {
        qc.setQueryData(qk.me, await api.loginMfa(step === 'code' ? { code } : { recoveryCode: code.trim() }));
      }
      navigate(next, { replace: true });
    } catch (err) {
      // An expired second step goes back to the password (the server asks for it again).
      if ((err as { code?: string }).code === 'mfa_challenge_expired') setStep('password');
      // The organisation signs in with single sign-on: offer it with the address already filled in.
      if ((err as { code?: string }).code === 'sso_required') {
        setPassword('');
        setStep('sso');
      }
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startSso = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.ssoDiscover(email.trim(), next);
      // The server sends the browser on to the organisation's identity provider.
      window.location.assign(res.startUrl);
    } catch (err) {
      setError(ssoDiscoverErrorMessage(err));
      setBusy(false);
    }
  };

  if (step === 'sso') {
    return (
      <main className="login-page">
        <form className="card login-card stack" onSubmit={startSso} aria-labelledby="login-title" data-testid="login-sso">
          <div className="login-brand">
            <span className="brand-mark" aria-hidden>
              SP
            </span>
            <div>
              <h1 id="login-title">Sign in with your organisation</h1>
              <div className="muted">Single sign-on</div>
            </div>
          </div>
          <label>
            Work email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus data-testid="login-sso-email" />
          </label>
          {error ? (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          ) : null}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !email.trim()}>
            {busy ? 'Continuing…' : 'Continue'}
          </button>
          <p className="muted small">You are taken to your organisation’s sign-in page and brought back here afterwards.</p>
          <button
            type="button"
            className="btn btn-link"
            onClick={() => {
              setError(null);
              setStep('password');
            }}
          >
            Sign in with a password instead
          </button>
        </form>
      </main>
    );
  }

  if (step !== 'password') {
    const recovery = step === 'recovery';
    return (
      <main className="login-page">
        <form className="card login-card stack" onSubmit={submit} aria-labelledby="login-title" data-testid="login-mfa">
          <div className="login-brand">
            <span className="brand-mark" aria-hidden>
              SP
            </span>
            <div>
              <h1 id="login-title">Two-step sign-in</h1>
              <div className="muted">{email.trim()}</div>
            </div>
          </div>
          <label>
            {recovery ? 'Recovery code' : 'Code from your authenticator app'}
            <input
              key={step}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete={recovery ? 'off' : 'one-time-code'}
              value={code}
              onChange={(e) => setCode(recovery ? e.target.value : cleanCode(e.target.value))}
              placeholder={recovery ? 'XXXXX-XXXXX' : '6 digits'}
              required
              autoFocus
              data-testid="login-code"
            />
          </label>
          {error ? (
            <div className="banner banner-danger" role="alert">
              {error}
            </div>
          ) : null}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || (recovery ? code.trim().length < 10 : code.length !== 6)}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="btn btn-link"
            onClick={() => {
              setCode('');
              setError(null);
              setStep(recovery ? 'code' : 'recovery');
            }}
          >
            {recovery ? 'Use the code from my authenticator app' : 'I don’t have my phone — use a recovery code'}
          </button>
          <p className="muted small">Lost your phone and your recovery codes? An administrator can reset two-step sign-in for your account.</p>
        </form>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="card login-card stack" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            SP
          </span>
          <div>
            <h1 id="login-title">SmartProctoring</h1>
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
        <button
          type="button"
          className="btn btn-lg"
          data-testid="login-with-sso"
          onClick={() => {
            setError(null);
            setStep('sso');
          }}
        >
          Sign in with your organisation
        </button>
        <p className="muted small">Access to candidate evidence is restricted to authorised staff and every view is logged.</p>
      </form>
    </main>
  );
}
