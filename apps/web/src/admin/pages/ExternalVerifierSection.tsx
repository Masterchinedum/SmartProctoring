import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExternalVerifierInfoDTO, ExternalVerifierProvider, ExternalVerifierSettingsDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDateTime } from '../lib/format';
import { ACCEPTED_IMAGE_TYPES, fileToJpeg } from '../lib/image';
import { TONE_CLASS } from '../lib/integrations';
import {
  buildVerifierPatch,
  describeVerifierTest,
  providerName,
  USE_FOR_OPTIONS,
  validateVerifierDraft,
  verifierDraftActivates,
  verifierDraftDirty,
  verifierStatus,
  verifierToDraft,
  type VerifierDraft,
} from '../lib/verifier';
import { ErrorState, Loading } from '../components/Common';
import { ConfirmDialog } from '../components/Modal';

/**
 * Settings → Integrations: optional external second-opinion face verifier (docs/EXTERNAL_VERIFIER.md). Off by default;
 * when a provider is active, face images of the checks it is used for leave this server.
 */
export function ExternalVerifierSection() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings, retry: shouldRetry });
  const info = useQuery({ queryKey: qk.verifierInfo, queryFn: api.verifierInfo, retry: shouldRetry });
  // Saving re-keys (remounts) the form: the "Saved." confirmation lives here.
  const [saved, setSaved] = useState(false);
  if (settings.isPending || info.isPending) return <Loading />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (info.isError) return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;
  const s = settings.data.externalVerifier;
  return <ExternalVerifierForm key={JSON.stringify(s)} current={s} info={info.data} saved={saved} setSaved={setSaved} />;
}

function ExternalVerifierForm({
  current,
  info,
  saved,
  setSaved,
}: {
  current: ExternalVerifierSettingsDTO;
  info: ExternalVerifierInfoDTO;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}) {
  const qc = useQueryClient();
  const [d, setD] = useState<VerifierDraft>(() => verifierToDraft(current));
  const [confirming, setConfirming] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const errors = validateVerifierDraft(d, { keySet: current.accessKeyIdSet, envAllowed: info.envCredentialsAllowed });
  const invalid = Object.keys(errors).length > 0;
  const dirty = verifierDraftDirty(d, current);
  const status = verifierStatus(current);
  const anyAvailable = info.providers.some((p) => p.available);

  const set = (patch: Partial<VerifierDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setSaved(false);
  };
  const save = useMutation({
    mutationFn: () => api.updateSettings({ externalVerifier: buildVerifierPatch(d) }),
    onSuccess: (s) => {
      setConfirming(false);
      qc.setQueryData(qk.settings, s);
      setSaved(true);
    },
  });
  const test = useMutation({ mutationFn: (jpeg: Blob) => api.testVerifier(jpeg) });
  const onTestFile = async (file: File | undefined) => {
    setTestError(null);
    test.reset();
    if (!file) return;
    try {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo.');
      const { blob } = await fileToJpeg(file, 1280, 0.9);
      test.mutate(blob);
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const submit = () => {
    if (invalid || !dirty) return;
    if (verifierDraftActivates(d, current)) setConfirming(true);
    else save.mutate();
  };

  const field = (key: 'region' | 'accessKeyId' | 'secretAccessKey', label: string, props: React.InputHTMLAttributes<HTMLInputElement>, hint?: string) => (
    <label>
      {label}
      <input value={d[key]} onChange={(e) => set({ [key]: e.target.value } as Partial<VerifierDraft>)} aria-invalid={!!errors[key]} autoComplete="off" spellCheck={false} {...props} />
      {hint ? <span className="muted small">{hint}</span> : null}
      {errors[key] ? <span className="text-danger small">{errors[key]}</span> : null}
    </label>
  );
  const testResult = test.data ? describeVerifierTest(test.data) : null;

  return (
    <section className="card stack" aria-labelledby="external-verifier-heading">
      <div className="row">
        <h2 id="external-verifier-heading">Identity second opinion (external face verifier)</h2>
        <span className={TONE_CLASS[status.tone]} data-testid="verifier-status">
          {status.label}
        </span>
      </div>
      <p className="muted small">
        Optional. SmartProctoring compares faces on your own server. You can also ask an external provider for a second opinion on the identity decisions that
        matter most. Its answer is combined with ours: it can settle an inconclusive result or flag a disagreement for human review, but it never records a “possible
        different person” on its own. If the provider is slow or unavailable, our own decision is used alone. Off by default — see <code>docs/EXTERNAL_VERIFIER.md</code>.
      </p>
      {current.active ? (
        <p className="small">
          Active since {current.enabledAt ? formatDateTime(current.enabledAt) : '—'} for:{' '}
          {USE_FOR_OPTIONS.filter((o) => current.useFor[o.key])
            .map((o) => o.label.toLowerCase())
            .join(', ')}
          . Only candidates who accepted the privacy notice after that time are included.
        </p>
      ) : null}
      {!anyAvailable ? (
        <div className="banner banner-info small" role="status">
          External verifiers are switched off on this server (<code>EXTERNAL_VERIFIERS</code>). Ask your system administrator if you need one.
        </div>
      ) : null}
      {d.provider !== 'none' ? (
        <div className="banner banner-warning small">
          <strong>Face images leave your servers.</strong> For the checks you select below, the candidate’s camera image and the image it is compared with are sent to{' '}
          {providerName(d.provider)} in the region you choose. While it is active the candidate privacy notice names the provider. Add it to your list of
          sub-processors and review its data-use terms (for AWS: opt out of the use of AI-service content with an AWS Organizations policy) before you switch it on.
        </div>
      ) : null}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          Provider
          <select value={d.provider} onChange={(e) => set({ provider: e.target.value as ExternalVerifierProvider })}>
            <option value="none">{providerName('none')}</option>
            {info.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available && current.provider !== p.id}>
                {p.name}
                {p.location === 'cloud' ? ' — cloud' : ' — on-premises'}
                {p.available ? '' : ' (not available on this server)'}
              </option>
            ))}
          </select>
        </label>
        {d.provider === 'aws-rekognition' ? (
          <>
            <div className="grid-2">{field('region', 'AWS region', { type: 'text', maxLength: 32, placeholder: 'eu-west-1' }, 'Choose a region that meets your data-residency requirements.')}</div>
            <fieldset className="stack-tight">
              <legend>Credentials</legend>
              <label className="switch">
                <input type="radio" name="verifier-credentials" checked={d.credentialMode === 'key'} onChange={() => set({ credentialMode: 'key' })} />
                <span>
                  Access key <span className="muted small">— an IAM user allowed only <code>rekognition:CompareFaces</code></span>
                </span>
              </label>
              <label className="switch">
                <input
                  type="radio"
                  name="verifier-credentials"
                  checked={d.credentialMode === 'env'}
                  disabled={!info.envCredentialsAllowed && d.credentialMode !== 'env'}
                  onChange={() => set({ credentialMode: 'env', accessKeyId: '', secretAccessKey: '', clearKey: false })}
                />
                <span>
                  This server’s AWS credentials <span className="muted small">— IAM role or environment{info.envCredentialsAllowed ? '' : '; not allowed on this server'}</span>
                </span>
              </label>
              {errors.credentialMode ? <span className="text-danger small">{errors.credentialMode}</span> : null}
              {d.credentialMode === 'key' ? (
                <div className="grid-2">
                  {field(
                    'accessKeyId',
                    'Access key ID',
                    { type: 'text', maxLength: 128, placeholder: current.accessKeyIdSet ? `Stored key …${current.accessKeyIdHint ?? ''} — leave blank to keep it` : 'AKIA…' },
                    current.accessKeyIdSet ? 'A key is stored (encrypted). It is never shown again; enter a new pair to replace it.' : undefined,
                  )}
                  {field('secretAccessKey', 'Secret access key', { type: 'password', maxLength: 256, autoComplete: 'new-password', placeholder: current.accessKeyIdSet ? 'Stored — leave blank to keep it' : '' })}
                </div>
              ) : null}
              {d.credentialMode === 'key' && current.accessKeyIdSet ? (
                <label className="switch">
                  <input type="checkbox" checked={d.clearKey} onChange={(e) => set({ clearKey: e.target.checked })} />
                  <span>Remove the stored key</span>
                </label>
              ) : null}
            </fieldset>
          </>
        ) : null}
        <fieldset className="stack-tight">
          <legend>Ask for a second opinion</legend>
          {USE_FOR_OPTIONS.map((o) => (
            <label className="switch" key={o.key}>
              <input type="checkbox" checked={d.useFor[o.key]} disabled={d.provider === 'none'} onChange={(e) => set({ useFor: { ...d.useFor, [o.key]: e.target.checked } })} />
              <span>
                {o.label} <span className="muted small">— {o.help}</span>
              </span>
            </label>
          ))}
          <span className="muted small">
            Tip: save with every option off first and use “Test connection” — nothing is sent during exams until at least one option is on. Each comparison waits at most{' '}
            {(info.timeoutMs / 1000).toFixed(1)} s; the provider charges per call.
          </span>
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={invalid || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save second-opinion settings'}
          </button>
          <input
            ref={fileRef}
            id="verifier-test-photo"
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            className="visually-hidden"
            disabled={current.provider === 'none' || dirty || test.isPending}
            onChange={(e) => void onTestFile(e.target.files?.[0])}
          />
          <label
            htmlFor="verifier-test-photo"
            className={`btn${current.provider === 'none' || dirty || test.isPending ? ' disabled' : ''}`}
            title={current.provider === 'none' ? 'Choose a provider and save first' : dirty ? 'Save your changes first' : 'Compares a photo with itself using the saved settings'}
          >
            {test.isPending ? 'Testing…' : 'Test connection with a photo…'}
          </label>
          {saved && !dirty ? <span className="text-success">Saved.</span> : null}
        </div>
        {invalid && dirty ? <span className="text-danger small">Fix the highlighted fields before saving.</span> : null}
        {save.isError ? <div className="banner banner-danger" role="alert">{errorMessage(save.error)}</div> : null}
        {testError ? <div className="banner banner-danger" role="alert">{testError}</div> : null}
        {test.isError ? <div className="banner banner-danger" role="alert">{errorMessage(test.error)}</div> : null}
        {testResult ? (
          <div className={`banner banner-${testResult.tone} small`} role="status" data-testid="verifier-test-result">
            {testResult.text}
          </div>
        ) : null}
      </form>
      {confirming ? (
        <ConfirmDialog
          title={`Send face images to ${providerName(d.provider)}?`}
          message={
            <div className="stack">
              <p>
                From now on, for the checks you selected, candidates’ face images are sent to {providerName(d.provider)} for a second comparison. Candidates who
                accepted the privacy notice before now are not included; new candidates see the provider named in the notice.
              </p>
              <p className="muted small">Make sure the provider is listed as a sub-processor and its data-use terms are acceptable. This change is audit-logged.</p>
            </div>
          }
          confirmLabel="Switch on"
          busy={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onConfirm={() => save.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}
