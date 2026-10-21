import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { TotpSetupDTO } from '@sp/shared';
import { api, errorMessage } from '../api/client';
import { downloadText } from '../lib/download';
import { cleanCode, formatSecret, qrMatrix, recoveryCodesFile } from '../lib/mfa';
import { CopyButton } from './Common';

/** The QR code of an otpauth:// URI, drawn as SVG (no markup from strings). */
export function QrCode({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const m = useMemo(() => qrMatrix(text), [text]);
  const n = m.length + 8; // 4-module quiet zone
  return (
    <svg className="qr-code" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      {m.flatMap((row, r) => row.map((dark, c) => (dark ? <rect key={`${r}-${c}`} x={c + 4} y={r + 4} width={1} height={1} fill="#000" /> : null)))}
    </svg>
  );
}

/** Fresh recovery codes, shown once: copy / download, and an explicit "I saved them". */
export function RecoveryCodes({ codes, account, org, onDone, doneLabel = 'Done' }: { codes: string[]; account: string; org: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const file = recoveryCodesFile(codes, account, org);
  return (
    <div className="stack" data-testid="recovery-codes">
      <div className="banner banner-warning small">
        <strong>Save these recovery codes now — they are shown only once.</strong> Each one signs you in once if you lose your phone. Keep them in a password manager or
        printed in a safe place.
      </div>
      <ol className="recovery-codes mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="row tight">
        <CopyButton text={codes.join('\n')} label="Copy codes" />
        <button type="button" className="btn btn-sm" onClick={() => downloadText(file, 'smartproctoring-recovery-codes.txt')}>
          Download as a file
        </button>
      </div>
      <label className="inline">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="codes-saved" />I have saved my recovery codes
      </label>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone} data-testid="codes-done">
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Set up an authenticator app: scan (or type) the secret, confirm with a code, save the recovery codes. With
 * `replacing`, two-step sign-in is already on and the current factor is required too.
 */
export function MfaSetup({ account, org, replacing = false, onDone, onCancel }: { account: string; org: string; replacing?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<TotpSetupDTO | null>(null);
  const [code, setCode] = useState('');
  const [currentCode, setCurrentCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const begin = useMutation({ mutationFn: api.mfaSetup, onSuccess: setSetup });
  const confirm = useMutation({ mutationFn: () => api.mfaConfirm(code, replacing ? currentCode.trim() : undefined), onSuccess: (r) => setCodes(r.codes) });

  if (codes) return <RecoveryCodes codes={codes} account={account} org={org} onDone={onDone} />;
  if (!setup) {
    return (
      <div className="stack" data-testid="mfa-setup-start">
        <p>
          You need an authenticator app on your phone — for example Microsoft Authenticator, Google Authenticator, 1Password or Authy. At each sign-in you then enter the 6-digit
          code it shows, in addition to your password.
        </p>
        {begin.isError ? <div className="banner banner-danger" role="alert">{errorMessage(begin.error)}</div> : null}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => begin.mutate()} disabled={begin.isPending} data-testid="mfa-setup-begin">
            {begin.isPending ? 'Preparing…' : replacing ? 'Set up a new authenticator app' : 'Set up two-step sign-in'}
          </button>
          {onCancel ? (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <form
      className="stack"
      data-testid="mfa-setup-scan"
      onSubmit={(e) => {
        e.preventDefault();
        confirm.mutate();
      }}
    >
      <ol className="stack mfa-steps">
        <li>
          In your authenticator app, add an account and scan this QR code:
          <div className="mfa-qr">
            <QrCode text={setup.otpauthUri} label={`QR code for ${setup.issuer}, ${setup.account}`} />
            <div className="small">
              <div className="muted">Cannot scan? Enter this key instead (time-based):</div>
              <div className="mono mfa-secret" data-testid="mfa-secret">
                {formatSecret(setup.secret)}
              </div>
              <CopyButton text={setup.secret} label="Copy key" />
            </div>
          </div>
        </li>
        <li>
          <label>
            Enter the 6-digit code the app now shows
            <input
              className="mfa-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(cleanCode(e.target.value))}
              aria-describedby="mfa-code-hint"
              data-testid="mfa-code"
            />
          </label>
          <span id="mfa-code-hint" className="small muted">
            The code changes every 30 seconds.
          </span>
        </li>
        {replacing ? (
          <li>
            <label>
              And a code from your current authenticator app (or a recovery code)
              <input value={currentCode} onChange={(e) => setCurrentCode(e.target.value)} autoComplete="off" data-testid="mfa-current-code" />
            </label>
          </li>
        ) : null}
      </ol>
      {confirm.isError ? <div className="banner banner-danger" role="alert">{errorMessage(confirm.error)}</div> : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={code.length !== 6 || (replacing && !currentCode.trim()) || confirm.isPending} data-testid="mfa-confirm">
          {confirm.isPending ? 'Checking…' : 'Turn on two-step sign-in'}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
