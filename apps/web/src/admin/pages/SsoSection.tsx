import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SSO_ASSIGNABLE_ROLES, SSO_DEFAULT_CLAIMS, SSO_PROVIDER_KIND_LABEL, type IdentityProviderDTO, type SsoAssignableRole, type SsoOverviewDTO, type SsoProviderKind, type SsoTestResultDTO } from '@sp/shared';
import { useAuth } from '../auth';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { CopyButton, ErrorState, Loading } from '../components/Common';
import { ConfirmDialog, Modal } from '../components/Modal';
import { formatDate, formatDateTime } from '../lib/format';
import { ROLE_LABELS } from '../lib/labels';
import { certificateDaysLeft, draftFromProvider, draftToInput, emptyDraft, validateDraft, type ProviderDraft } from '../lib/sso';
import { SecretModal } from './IntegrationsPage';

/**
 * Settings → Single sign-on (identity providers, "require single sign-on") and SCIM provisioning. Owners change it;
 * administrators see it and can test a connection.
 */
export function SingleSignOnSection() {
  const q = useQuery({ queryKey: qk.sso, queryFn: api.ssoOverview, retry: shouldRetry });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <ProvidersCard overview={q.data} />
      <ScimCard overview={q.data} />
    </>
  );
}

function ProvidersCard({ overview }: { overview: SsoOverviewDTO }) {
  const { isOwner } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<IdentityProviderDTO | 'new' | null>(null);
  const [deleting, setDeleting] = useState<IdentityProviderDTO | null>(null);
  const [tests, setTests] = useState<Record<string, SsoTestResultDTO>>({});
  const del = useMutation({
    mutationFn: (id: string) => api.deleteSsoProvider(id),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: qk.sso });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testSsoProvider(id),
    onSuccess: (r, id) => setTests((t) => ({ ...t, [id]: r })),
  });
  return (
    <section className="card stack" aria-labelledby="sso-title" data-testid="settings-sso">
      <div className="row">
        <h2 id="sso-title">Single sign-on</h2>
        <div className="spacer" />
        {isOwner ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            Add identity provider
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Staff sign in with their organisation account (Microsoft Entra ID, Okta, Google Workspace or any OpenID Connect or SAML 2.0 provider) by choosing “Sign in with your
        organisation” and entering their work email. <strong>After single sign-on, your identity provider is responsible for the second step</strong>: SmartProctoring does not ask
        for its own two-step sign-in code, so require multi-factor authentication in your identity provider. Owners can always sign in with their password and two-step sign-in, in
        case the identity provider is unavailable.
      </p>
      {!isOwner ? <p className="small muted">Only an owner can change single sign-on.</p> : null}
      {overview.providers.length === 0 ? (
        <p className="small">No identity provider is set up.</p>
      ) : (
        <ul className="stack" aria-label="Identity providers">
          {overview.providers.map((p) => (
            <li key={p.id} className="card stack-tight" data-testid="sso-provider">
              <div className="row">
                <strong>{p.name}</strong>
                <span className="badge">{SSO_PROVIDER_KIND_LABEL[p.kind]}</span>
                {p.enabled ? <span className="badge badge-success">Enabled</span> : <span className="badge">Disabled</span>}
                {p.jit.enabled ? <span className="badge badge-info">Creates accounts ({ROLE_LABELS[p.jit.defaultRole]})</span> : null}
                <div className="spacer" />
                <button type="button" className="btn btn-sm" disabled={test.isPending} onClick={() => test.mutate(p.id)}>
                  Test connection
                </button>
                {isOwner ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(p)}>
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
              <div className="small">
                Email domains: <strong>{p.domains.join(', ')}</strong> · {p.linkedUsers} linked account{p.linkedUsers === 1 ? '' : 's'}
              </div>
              <ProviderUrls p={p} />
              <CertificateWarning p={p} />
              {tests[p.id] ? <TestResult result={tests[p.id]} /> : null}
            </li>
          ))}
        </ul>
      )}
      {test.isError ? <div className="banner banner-danger" role="alert">{errorMessage(test.error)}</div> : null}
      <RequireSsoControl overview={overview} />
      {editing ? <ProviderModal provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Staff who signed in through it are signed out, and their accounts are no longer linked to it. Accounts stay; they can sign in again once a provider is set up (or with a password an administrator sets). This is recorded in the audit log."
          confirmLabel="Delete provider"
          danger
          busy={del.isPending}
          error={del.isError ? errorMessage(del.error) : null}
          onConfirm={() => del.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

function UrlRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <div className="row nowrap">
          <code className="grow small" data-testid={testId}>
            {value}
          </code>
          <CopyButton text={value} label="Copy" />
        </div>
      </td>
    </tr>
  );
}

/** What to enter at the identity provider. */
function ProviderUrls({ p }: { p: IdentityProviderDTO }) {
  return (
    <table className="kv-table small">
      <tbody>
        {p.oidc ? <UrlRow label="Redirect URI (register it at the provider)" value={p.oidc.redirectUri} testId="sso-redirect-uri" /> : null}
        {p.saml ? (
          <>
            <UrlRow label="Service provider metadata" value={p.saml.metadataUrl} testId="sso-metadata-url" />
            <UrlRow label="Entity ID (audience)" value={p.saml.spEntityId} />
            <UrlRow label="Reply URL (assertion consumer service)" value={p.saml.acsUrl} />
          </>
        ) : null}
        <UrlRow label="Sign-in link for your staff" value={p.signInUrl} testId="sso-sign-in-url" />
      </tbody>
    </table>
  );
}

function CertificateWarning({ p }: { p: IdentityProviderDTO }) {
  const days = certificateDaysLeft(p);
  if (days == null || days > 30) return null;
  return (
    <div className="banner banner-warning small" role="status">
      {days < 0 ? 'The signing certificate has expired: ' : `The signing certificate expires in ${days} day${days === 1 ? '' : 's'}: `}
      add the identity provider’s new certificate before the old one stops being used.
    </div>
  );
}

function TestResult({ result }: { result: SsoTestResultDTO }) {
  return (
    <div className={`banner small ${result.ok ? 'banner-success' : 'banner-danger'}`} role="status" data-testid="sso-test-result">
      <strong>{result.ok ? 'Connection works.' : 'Connection problem.'}</strong>
      <ul>
        {result.checks.map((c, i) => (
          <li key={i}>
            {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Require single sign-on" — owners only, with a warning about who is signed out. */
function RequireSsoControl({ overview }: { overview: SsoOverviewDTO }) {
  const { isOwner } = useAuth();
  const qc = useQueryClient();
  const [value, setValue] = useState(overview.requireSso);
  const [confirming, setConfirming] = useState(false);
  const hasEnabled = overview.providers.some((p) => p.enabled);
  const m = useMutation({
    mutationFn: () => api.updateSettings({ requireSso: value }),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: qk.sso });
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
  return (
    <fieldset className="stack-tight" data-testid="sso-require">
      <legend>Require single sign-on</legend>
      <label className="switch">
        <input type="checkbox" checked={value} disabled={!isOwner || m.isPending || (!hasEnabled && !overview.requireSso)} onChange={(e) => setValue(e.target.checked)} aria-describedby="sso-require-hint" />
        <span>Everyone except owners must sign in with single sign-on</span>
      </label>
      <span id="sso-require-hint" className="small muted">
        {hasEnabled || overview.requireSso
          ? 'Password sign-in then stops working for administrators and reviewers, and those signed in with a password are signed out. Owners keep their password and two-step sign-in as break-glass access.'
          : 'Enable an identity provider first.'}
        {isOwner ? '' : ' Only an owner can change this.'}
      </span>
      {isOwner && value !== overview.requireSso ? (
        <div className="row">
          <button type="button" className="btn btn-primary btn-sm" disabled={m.isPending} onClick={() => (value ? setConfirming(true) : m.mutate())}>
            {m.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}
      {m.isError && !confirming ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      {confirming ? (
        <ConfirmDialog
          title="Require single sign-on?"
          message="Administrators and reviewers who are signed in with a password are signed out now and must use “Sign in with your organisation” from then on. Make sure single sign-on works for them first (Test connection, then try it yourself in a private window). Owners can still sign in with their password."
          confirmLabel="Require single sign-on"
          danger
          busy={m.isPending}
          error={m.isError ? errorMessage(m.error) : null}
          onConfirm={() => m.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </fieldset>
  );
}

function ProviderModal({ provider, onClose }: { provider: IdentityProviderDTO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = provider != null;
  const [d, setD] = useState<ProviderDraft>(() => (provider ? draftFromProvider(provider) : emptyDraft('oidc')));
  const [touched, setTouched] = useState(false);
  const errors = validateDraft(d);
  const hasErrors = Object.keys(errors).length > 0;
  const set = (patch: Partial<ProviderDraft>) => setD((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => (provider ? api.updateSsoProvider(provider.id, draftToInput(d, true)) : api.createSsoProvider(draftToInput(d, false))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sso });
      onClose();
    },
  });
  const err = (key: string) => (touched && errors[key] ? <span className="text-danger small">{errors[key]}</span> : null);
  const defaults = SSO_DEFAULT_CLAIMS[d.kind];
  return (
    <Modal
      title={editing ? `Edit ${provider.name}` : 'Add identity provider'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="sso-provider-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add provider'}
          </button>
        </>
      }
    >
      <form
        id="sso-provider-form"
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!hasErrors) save.mutate();
        }}
      >
        <div className="grid-2">
          <label>
            Protocol
            <select value={d.kind} disabled={editing} onChange={(e) => setD({ ...emptyDraft(e.target.value as SsoProviderKind), name: d.name, domains: d.domains })}>
              <option value="oidc">{SSO_PROVIDER_KIND_LABEL.oidc}</option>
              <option value="saml">{SSO_PROVIDER_KIND_LABEL.saml}</option>
            </select>
          </label>
          <label>
            Name shown to staff
            <input type="text" value={d.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. University login" aria-invalid={touched && !!errors.name} />
            {err('name')}
          </label>
        </div>
        <label>
          Email domains
          <input type="text" value={d.domains} onChange={(e) => set({ domains: e.target.value })} placeholder="example.edu, staff.example.edu" aria-invalid={touched && !!errors.domains} aria-describedby="sso-domains-hint" />
          <span id="sso-domains-hint" className="muted small">
            Staff with these addresses are sent to this provider, and only these addresses are accepted from it. A domain can belong to one provider only.
          </span>
          {err('domains')}
        </label>
        {d.kind === 'oidc' ? (
          <fieldset className="stack-tight">
            <legend>OpenID Connect</legend>
            <label>
              Issuer URL
              <input type="url" value={d.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" aria-invalid={touched && !!errors.issuer} />
              {err('issuer')}
            </label>
            <div className="grid-2">
              <label>
                Client (application) ID
                <input type="text" value={d.clientId} onChange={(e) => set({ clientId: e.target.value })} autoComplete="off" aria-invalid={touched && !!errors.clientId} />
                {err('clientId')}
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  value={d.clientSecret}
                  autoComplete="new-password"
                  disabled={d.removeSecret}
                  onChange={(e) => set({ clientSecret: e.target.value })}
                  placeholder={provider?.oidc?.clientSecretSet ? 'Stored — leave blank to keep it' : 'Optional for public clients'}
                />
                <span className="muted small">Stored encrypted and never shown again.</span>
              </label>
            </div>
            {provider?.oidc?.clientSecretSet ? (
              <label className="switch">
                <input type="checkbox" checked={d.removeSecret} onChange={(e) => set({ removeSecret: e.target.checked, clientSecret: '' })} />
                <span>Remove the stored client secret</span>
              </label>
            ) : null}
            <label>
              Scopes
              <input type="text" value={d.scopes} onChange={(e) => set({ scopes: e.target.value })} aria-invalid={touched && !!errors.scopes} />
              {err('scopes')}
            </label>
            <label className="switch">
              <input type="checkbox" checked={d.requireVerifiedEmail} onChange={(e) => set({ requireVerifiedEmail: e.target.checked })} />
              <span>
                Only accept email addresses the provider marks as verified <span className="muted small">(turn off for Microsoft Entra ID, which does not send this; use a single-tenant issuer)</span>
              </span>
            </label>
          </fieldset>
        ) : (
          <fieldset className="stack-tight">
            <legend>SAML 2.0</legend>
            <div className="grid-2">
              <label>
                Identity provider entity ID (issuer)
                <input type="text" value={d.entityId} onChange={(e) => set({ entityId: e.target.value })} aria-invalid={touched && !!errors.entityId} />
                {err('entityId')}
              </label>
              <label>
                Single sign-on URL
                <input type="url" value={d.ssoUrl} onChange={(e) => set({ ssoUrl: e.target.value })} placeholder="https://idp.example.edu/saml/sso" aria-invalid={touched && !!errors.ssoUrl} />
                {err('ssoUrl')}
              </label>
            </div>
            <label>
              Signing certificate (PEM; add the new one here during a certificate change)
              <textarea rows={5} value={d.certificates} onChange={(e) => set({ certificates: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" aria-invalid={touched && !!errors.certificates} spellCheck={false} />
              {err('certificates')}
            </label>
          </fieldset>
        )}
        <fieldset className="stack-tight">
          <legend>{d.kind === 'oidc' ? 'Claims' : 'Attributes'} (leave blank for the usual names)</legend>
          <div className="grid-2">
            <label>
              Email
              <input type="text" value={d.claimEmail} onChange={(e) => set({ claimEmail: e.target.value })} placeholder={d.kind === 'saml' ? `${defaults.email}, mail or an email NameID` : defaults.email} />
            </label>
            <label>
              Name
              <input type="text" value={d.claimName} onChange={(e) => set({ claimName: e.target.value })} placeholder={defaults.name} />
            </label>
            <label>
              Groups (for roles of new accounts)
              <input type="text" value={d.claimGroups} onChange={(e) => set({ claimGroups: e.target.value })} placeholder={defaults.groups} />
            </label>
          </div>
        </fieldset>
        <fieldset className="stack-tight">
          <legend>New staff</legend>
          <label className="switch">
            <input type="checkbox" checked={d.jitEnabled} onChange={(e) => set({ jitEnabled: e.target.checked })} />
            <span>Create an account at the first sign-in of someone with one of these domains</span>
          </label>
          <label>
            Role of new accounts
            <select value={d.jitDefaultRole} disabled={!d.jitEnabled} onChange={(e) => set({ jitDefaultRole: e.target.value as SsoAssignableRole })}>
              {SSO_ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <span className="muted small">Accounts are never created as owners. Without this option, add staff on the Users page (or by SCIM) first; they are linked at their first sign-in.</span>
          </label>
          {d.roleMappings.map((m, i) => (
            <div className="row" key={i}>
              <label className="grow">
                Group
                <input type="text" value={m.group} disabled={!d.jitEnabled} onChange={(e) => set({ roleMappings: d.roleMappings.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)) })} aria-invalid={touched && !!errors[`roleMappings.${i}`]} />
                {err(`roleMappings.${i}`)}
              </label>
              <label>
                gets the role
                <select value={m.role} disabled={!d.jitEnabled} onChange={(e) => set({ roleMappings: d.roleMappings.map((x, j) => (j === i ? { ...x, role: e.target.value as SsoAssignableRole } : x)) })}>
                  {SSO_ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn btn-sm" aria-label={`Remove the mapping for group ${m.group || i + 1}`} onClick={() => set({ roleMappings: d.roleMappings.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-sm" disabled={!d.jitEnabled} onClick={() => set({ roleMappings: [...d.roleMappings, { group: '', role: 'admin' }] })}>
              Add group → role mapping
            </button>
          </div>
        </fieldset>
        <label className="switch">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>Enabled (staff can sign in with it)</span>
        </label>
        {!editing ? <p className="small muted">Save first to get the redirect URI or the service provider metadata to enter at your identity provider, then test the connection and enable it.</p> : null}
        {touched && hasErrors ? <div className="text-danger small">Fix the highlighted fields.</div> : null}
        {save.isError ? <div className="banner banner-danger" role="alert">{errorMessage(save.error)}</div> : null}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ SCIM */

function ScimCard({ overview }: { overview: SsoOverviewDTO }) {
  const { isOwner } = useAuth();
  const qc = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const token = overview.scim.token;
  const create = useMutation({
    mutationFn: api.createScimToken,
    onSuccess: (r) => {
      setConfirm(null);
      setSecret(r.secret);
      void qc.invalidateQueries({ queryKey: qk.sso });
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeScimToken,
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: qk.sso });
    },
  });
  return (
    <section className="card stack" aria-labelledby="scim-title" data-testid="settings-scim">
      <h2 id="scim-title">Staff provisioning (SCIM)</h2>
      <p className="small muted">
        Your identity provider can create, update and deactivate staff accounts automatically. Deactivating someone there disables their account here and signs them out
        everywhere. Roles come from the <code>roles</code> attribute (reviewer or admin). Owner accounts are never changed by SCIM.
      </p>
      <table className="kv-table small">
        <tbody>
          <UrlRow label="SCIM base URL (tenant URL)" value={overview.scim.baseUrl} testId="scim-base-url" />
          <tr>
            <th scope="row">Token</th>
            <td data-testid="scim-token-status">
              {token ? (
                <>
                  <code>{token.prefix}…</code> created {formatDate(token.createdAt)}
                  {token.createdBy ? ` by ${token.createdBy.name}` : ''} · {token.lastUsedAt ? `last used ${formatDateTime(token.lastUsedAt)}` : 'not used yet'}
                </>
              ) : (
                'No token: provisioning is off.'
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {isOwner ? (
        <div className="row">
          {token ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setConfirm('rotate')}>
                Replace token
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm('revoke')}>
                Revoke token
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
              Create SCIM token
            </button>
          )}
        </div>
      ) : (
        <p className="small muted">Only an owner can create or revoke the SCIM token.</p>
      )}
      {create.isError && !confirm ? <div className="banner banner-danger" role="alert">{errorMessage(create.error)}</div> : null}
      {secret ? (
        <SecretModal title="SCIM token created" secret={secret} onClose={() => setSecret(null)}>
          Enter it as the secret token (bearer token) in your identity provider’s provisioning settings, with the SCIM base URL above.
        </SecretModal>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={confirm === 'rotate' ? 'Replace the SCIM token?' : 'Revoke the SCIM token?'}
          message={
            confirm === 'rotate'
              ? 'The current token stops working at once: enter the new one in your identity provider straight away, or provisioning fails until you do.'
              : 'Provisioning stops at once. Accounts stay as they are.'
          }
          confirmLabel={confirm === 'rotate' ? 'Replace token' : 'Revoke token'}
          danger
          busy={create.isPending || revoke.isPending}
          error={create.isError ? errorMessage(create.error) : revoke.isError ? errorMessage(revoke.error) : null}
          onConfirm={() => (confirm === 'rotate' ? create.mutate() : revoke.mutate())}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
