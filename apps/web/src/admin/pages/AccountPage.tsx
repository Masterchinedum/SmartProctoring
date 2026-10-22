import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { qk } from '../api/queries';
import { useAuth } from '../auth';
import { formatDateTime } from '../lib/format';
import { cleanCode } from '../lib/mfa';
import { PageHeader } from '../components/Common';
import { MfaSetup, RecoveryCodes } from '../components/MfaSetup';
import { Modal } from '../components/Modal';

/** The signed-in staff member's own account: two-step sign-in and password. */
export function AccountPage() {
  const { user, org, security } = useAuth();
  return (
    <div className="stack">
      <PageHeader title="Account & security" subtitle={`${user.name} · ${user.email}`} />
      <TwoStepSection account={user.email} org={org.name} security={security} />
      <PasswordSection />
    </div>
  );
}

function TwoStepSection({ account, org, security }: { account: string; org: string; security: ReturnType<typeof useAuth>['security'] }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | 'setup' | 'replace' | 'codes' | 'disable'>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.me });
  const done = () => {
    setMode(null);
    refresh();
  };

  return (
    <section className="card stack" aria-labelledby="two-step-title" data-testid="two-step">
      <div className="row">
        <h2 id="two-step-title">Two-step sign-in</h2>
        {security.mfaEnabled ? <span className="badge badge-success">On</span> : <span className="badge">Off</span>}
        {security.mfaRequired ? <span className="badge badge-info">Required by your organisation</span> : null}
      </div>
      {security.signInMethod === 'sso' ? (
        <p className="small" data-testid="signed-in-with-sso">
          You signed in with single sign-on: your organisation’s identity provider checks the second step, so SmartProctoring does not ask for a code.
          {security.ssoRequired ? ' Your organisation requires single sign-on.' : ' The settings below apply when you sign in with your password.'}
        </p>
      ) : null}
      {security.mfaEnabled ? (
        <>
          <p className="small">
            On since {formatDateTime(security.mfaEnabledAt)}. At each sign-in you enter a code from your authenticator app after your password.{' '}
            <strong>{security.recoveryCodesLeft ?? 0}</strong> unused recovery code{security.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {(security.recoveryCodesLeft ?? 0) <= 3 ? (
            <div className="banner banner-warning small">You are running low on recovery codes. Create new ones and store them safely.</div>
          ) : null}
          {mode === 'replace' ? (
            <MfaSetup account={account} org={org} replacing onDone={done} onCancel={() => setMode(null)} />
          ) : (
            <div className="row tight">
              <button type="button" className="btn" onClick={() => setMode('replace')}>
                Move to a new phone…
              </button>
              <button type="button" className="btn" onClick={() => setMode('codes')}>
                New recovery codes…
              </button>
              {security.mfaRequired ? null : (
                <button type="button" className="btn btn-danger" onClick={() => setMode('disable')}>
                  Turn off…
                </button>
              )}
            </div>
          )}
        </>
      ) : mode === 'setup' ? (
        <MfaSetup account={account} org={org} onDone={done} onCancel={() => setMode(null)} />
      ) : (
        <>
          <p className="small">Protect your account with a code from an authenticator app on your phone in addition to your password. Recommended for everyone; your organisation may require it.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => setMode('setup')} data-testid="two-step-enable">
              Set up two-step sign-in
            </button>
          </div>
        </>
      )}
      {mode === 'codes' ? <NewCodesDialog account={account} org={org} onClose={done} /> : null}
      {mode === 'disable' ? <DisableDialog onClose={() => setMode(null)} onDone={done} /> : null}
    </section>
  );
}

function NewCodesDialog({ account, org, onClose }: { account: string; org: string; onClose: () => void }) {
  const [code, setCode] = useState('');
  const m = useMutation({ mutationFn: () => api.regenerateRecoveryCodes(code) });
  return (
    <Modal title="New recovery codes" onClose={onClose}>
      {m.data ? (
        <RecoveryCodes codes={m.data.codes} account={account} org={org} onDone={onClose} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <p className="small">New codes replace all your current ones, used or not. Enter a code from your authenticator app to continue.</p>
          <label>
            Code from your authenticator app
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))} />
          </label>
          {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={code.length !== 6 || m.isPending}>
              {m.isPending ? 'Creating…' : 'Create new codes'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function DisableDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const m = useMutation({ mutationFn: () => api.disableMfa(password, code.trim()), onSuccess: onDone });
  return (
    <Modal
      title="Turn off two-step sign-in?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={!password || code.trim().length < 6 || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Turning off…' : 'Turn off'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">Your account will be protected by your password only. Your recovery codes stop working.</p>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Code from your authenticator app (or a recovery code)
          <input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const m = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
    },
  });
  const mismatch = repeat.length > 0 && next !== repeat;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length >= 10 && !mismatch) m.mutate();
  };
  return (
    <section className="card stack" aria-labelledby="password-title">
      <h2 id="password-title">Password</h2>
      <form className="stack" onSubmit={submit}>
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <div className="grid-2">
          <label>
            New password (at least 10 characters)
            <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
          <label>
            Repeat the new password
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required aria-invalid={mismatch} />
            {mismatch ? <span className="text-danger small">The passwords do not match.</span> : null}
          </label>
        </div>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
        {m.isSuccess ? (
          <div className="banner banner-success" role="status">
            Password changed. Other browsers signed in to your account were signed out.
          </div>
        ) : null}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!current || next.length < 10 || mismatch || m.isPending}>
            {m.isPending ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}
