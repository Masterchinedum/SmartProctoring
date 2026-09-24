import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SEVERITIES,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  type ApiKeyDTO,
  type IntegrationStatusDTO,
  type OrgSettingsDTO,
  type Severity,
  type WebhookDTO,
  type WebhookDeliveryDTO,
} from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { formatDate, formatDateTime } from '../lib/format';
import {
  DEFAULT_WEBHOOK_DRAFT,
  deliveryResult,
  deliveryStatus,
  MAX_ALERT_RECIPIENTS,
  parseRecipients,
  toggleEvent,
  TONE_CLASS,
  validateWebhookDraft,
  webhookStatus,
  webhookToDraft,
  type WebhookDraft,
} from '../lib/integrations';
import { SEVERITY_LABELS } from '../lib/labels';
import { CopyButton, EmptyState, ErrorState, Loading, PageHeader } from '../components/Common';
import { ConfirmDialog, Modal } from '../components/Modal';
import { RelativeTime } from '../components/Time';

/** Settings → Integrations: API keys, webhooks and email alerts (administrators). */
export function IntegrationsPage() {
  const status = useQuery({ queryKey: qk.integrationStatus, queryFn: api.integrationStatus, retry: shouldRetry });
  return (
    <div className="stack integrations-page">
      <PageHeader
        title="Integrations"
        subtitle="Connect SmartProctoring to your LMS or HR system (API keys, webhooks) and send alert emails to your staff."
        back={<Link to="/admin/settings">‹ Settings</Link>}
      />
      {status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : null}
      <ApiKeysSection status={status.data} />
      <WebhooksSection status={status.data} />
      <EmailAlertsSection status={status.data} />
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function SecretModal({ title, secret, children, onClose }: { title: string; secret: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          I have stored it
        </button>
      }
    >
      <div className="stack">
        <div className="banner banner-warning small">Copy it now. For security it is shown only once and cannot be displayed again.</div>
        <div className="row nowrap">
          <code className="secret-box grow" data-testid="secret-value">
            {secret}
          </code>
          <CopyButton text={secret} />
        </div>
        <div className="muted small">{children}</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ API keys */

function ApiKeysSection({ status }: { status: IntegrationStatusDTO | undefined }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.apiKeys, queryFn: api.apiKeys, retry: shouldRetry });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDTO | null>(null);
  const create = useMutation({
    mutationFn: () => api.createApiKey(name.trim()),
    onSuccess: (r) => {
      setCreated({ name: r.apiKey.name, secret: r.secret });
      setName('');
      void qc.invalidateQueries({ queryKey: qk.apiKeys });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: qk.apiKeys });
    },
  });

  return (
    <section className="card stack">
      <h2>API keys</h2>
      <p className="muted small">
        Keys let your LMS or HR system call the integration API: list exams, create candidates, assign exams and read results and reports. A key belongs to this
        organisation and never gives access to evidence images or the staff app.
        {status ? (
          <>
            {' '}
            API base URL: <code>{status.apiBaseUrl}</code> <CopyButton text={status.apiBaseUrl} label="Copy URL" className="link-btn" /> — see <code>docs/INTEGRATION_API.md</code>.
          </>
        ) : null}
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <label className="grow">
          <span className="visually-hidden">Key name</span>
          <input type="text" placeholder="Name, e.g. Moodle production" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create API key'}
        </button>
      </form>
      {create.isError ? <div className="banner banner-danger">{errorMessage(create.error)}</div> : null}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No API keys yet">Create a key for each system that connects to SmartProctoring.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'row-disabled' : ''}>
                  <td>
                    <strong>{k.name}</strong>
                  </td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td className="small">
                    {formatDate(k.createdAt)}
                    {k.createdBy ? <div className="muted">by {k.createdBy.name}</div> : null}
                  </td>
                  <td className="small">{k.lastUsedAt ? <RelativeTime at={k.lastUsedAt} /> : <span className="muted">Never</span>}</td>
                  <td>{k.revokedAt ? <span className="badge" title={formatDateTime(k.revokedAt)}>Revoked {formatDate(k.revokedAt)}</span> : <span className="badge badge-success">Active</span>}</td>
                  <td>
                    {!k.revokedAt ? (
                      <button type="button" className="btn btn-sm" onClick={() => setRevoking(k)}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {created ? (
        <SecretModal title={`API key “${created.name}” created`} secret={created.secret} onClose={() => setCreated(null)}>
          Send it as <code>Authorization: Bearer …</code>. Store it in your integration’s secret store. If it is lost, create a new key and revoke this one.
        </SecretModal>
      ) : null}
      {revoking ? (
        <ConfirmDialog
          title={`Revoke “${revoking.name}”?`}
          message="Systems using this key stop working immediately. This cannot be undone."
          confirmLabel="Revoke key"
          danger
          busy={revoke.isPending}
          error={revoke.isError ? errorMessage(revoke.error) : null}
          onConfirm={() => revoke.mutate(revoking.id)}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ webhooks */

function WebhooksSection({ status }: { status: IntegrationStatusDTO | undefined }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.webhooks, queryFn: api.webhooks, retry: shouldRetry });
  const [editing, setEditing] = useState<WebhookDTO | 'new' | null>(null);
  const [secret, setSecret] = useState<{ title: string; secret: string } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookDTO | null>(null);
  const [deleting, setDeleting] = useState<WebhookDTO | null>(null);
  const [rotating, setRotating] = useState<WebhookDTO | null>(null);
  const [testResult, setTestResult] = useState<{ hook: WebhookDTO; delivery: WebhookDeliveryDTO } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.webhooks });

  const test = useMutation({
    mutationFn: (w: WebhookDTO) => api.testWebhook(w.id).then((delivery) => ({ hook: w, delivery })),
    onSuccess: (r) => {
      setTestResult(r);
      void qc.invalidateQueries({ queryKey: qk.webhookDeliveries(r.hook.id) });
    },
  });
  const toggle = useMutation({ mutationFn: (w: WebhookDTO) => api.updateWebhook(w.id, { active: !w.active }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: (r) => {
      setRotating(null);
      setSecret({ title: 'New signing secret', secret: r.secret });
      refresh();
    },
  });

  const disabledByFailures = q.data?.items.filter((w) => !w.active && w.disabledReason === 'failures') ?? [];
  return (
    <section className="card stack">
      <div className="row">
        <h2>Webhooks</h2>
        <div className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add webhook
        </button>
      </div>
      <p className="muted small">
        SmartProctoring POSTs a signed JSON notification to your endpoint when something happens (event observed, exam on hold, pause requested, exam submitted…).
        Notifications contain identifiers, observations and links to this staff app — never images.
        {status ? ` Failed deliveries are retried ${status.webhooks.maxAttempts} times over about 10 hours; a webhook that keeps failing is switched off automatically.` : ''}
      </p>
      {disabledByFailures.length ? (
        <div className="banner banner-danger" role="alert">
          {disabledByFailures.length === 1 ? 'A webhook was' : `${disabledByFailures.length} webhooks were`} disabled after repeated delivery failures. Fix the receiving endpoint, send a
          test, then enable {disabledByFailures.length === 1 ? 'it' : 'them'} again — waiting notifications are then delivered.
        </div>
      ) : null}
      {testResult ? (
        <div className={`banner ${testResult.delivery.status === 'succeeded' ? 'banner-success' : 'banner-danger'} small`} role="status">
          Test to <code>{hostOf(testResult.hook.url)}</code>:{' '}
          {testResult.delivery.status === 'succeeded' ? `delivered (HTTP ${testResult.delivery.lastStatusCode}).` : `failed — ${deliveryResult(testResult.delivery)}`}
        </div>
      ) : null}
      {test.isError ? <div className="banner banner-danger">{errorMessage(test.error)}</div> : null}
      {toggle.isError ? <div className="banner banner-danger">{errorMessage(toggle.error)}</div> : null}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No webhooks yet">Add a webhook to receive notifications in your own system.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Notifications</th>
                <th>Status</th>
                <th>Last delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((w) => {
                const st = webhookStatus(w);
                return (
                  <tr key={w.id} className={w.active ? '' : 'row-disabled'}>
                    <td className="break-all">
                      <code>{w.url}</code>
                      {w.description ? <div className="muted small">{w.description}</div> : null}
                    </td>
                    <td className="small">
                      {w.events.map((e) => WEBHOOK_EVENT_LABELS[e]).join(', ')}
                      {w.events.some((e) => e.startsWith('event.')) ? <div className="muted">Events: {SEVERITY_LABELS[w.minSeverity].toLowerCase()} severity and above</div> : null}
                    </td>
                    <td>
                      <span className={TONE_CLASS[st.tone]} title={st.hint}>
                        {st.label}
                      </span>
                      {w.pendingDeliveries ? <div className="muted small">{w.pendingDeliveries} waiting</div> : null}
                    </td>
                    <td className="small">
                      {w.lastSuccessAt ? (
                        <div>
                          OK <RelativeTime at={w.lastSuccessAt} />
                        </div>
                      ) : null}
                      {w.lastFailureAt ? (
                        <div className="text-danger">
                          Failed <RelativeTime at={w.lastFailureAt} />
                        </div>
                      ) : null}
                      {!w.lastSuccessAt && !w.lastFailureAt ? <span className="muted">None yet</span> : null}
                    </td>
                    <td>
                      <div className="row tight">
                        <button type="button" className="btn btn-sm" onClick={() => test.mutate(w)} disabled={test.isPending}>
                          Send test
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setDeliveriesFor(w)}>
                          Deliveries
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(w)}>
                          Edit
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => toggle.mutate(w)} disabled={toggle.isPending}>
                          {w.active ? 'Disable' : 'Enable'}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setRotating(w)}>
                          New secret
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setDeleting(w)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <WebhookModal
          webhook={editing === 'new' ? null : editing}
          httpsRequired={status?.webhooks.httpsRequired ?? true}
          onClose={() => setEditing(null)}
          onCreated={(s) => setSecret({ title: 'Webhook created', secret: s })}
        />
      ) : null}
      {secret ? (
        <SecretModal title={secret.title} secret={secret.secret} onClose={() => setSecret(null)}>
          Use it to verify the <code>X-SmartProctoring-Signature</code> header (HMAC-SHA256 of <code>timestamp.body</code>) — see <code>docs/INTEGRATION_API.md</code> for a
          ready-made verification function.
        </SecretModal>
      ) : null}
      {deliveriesFor ? <DeliveriesModal webhook={deliveriesFor} onClose={() => setDeliveriesFor(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this webhook?"
          message={
            <>
              Notifications to <code>{deleting.url}</code> stop immediately and its delivery history is deleted.
            </>
          }
          confirmLabel="Delete webhook"
          danger
          busy={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
      {rotating ? (
        <ConfirmDialog
          title="Create a new signing secret?"
          message="The old secret stops working immediately: update the receiving system with the new secret right away, or its signature checks will fail."
          confirmLabel="Create new secret"
          busy={rotate.isPending}
          error={rotate.isError ? errorMessage(rotate.error) : null}
          onConfirm={() => rotate.mutate(rotating.id)}
          onCancel={() => setRotating(null)}
        />
      ) : null}
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function WebhookModal({ webhook, httpsRequired, onClose, onCreated }: { webhook: WebhookDTO | null; httpsRequired: boolean; onClose: () => void; onCreated: (secret: string) => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<WebhookDraft>(() => (webhook ? webhookToDraft(webhook) : { ...DEFAULT_WEBHOOK_DRAFT }));
  const [touched, setTouched] = useState(false);
  const errors = validateWebhookDraft(d, { httpsRequired });
  const valid = Object.keys(errors).length === 0;
  const save = useMutation({
    mutationFn: async () => {
      const body = { url: d.url.trim(), description: d.description.trim(), events: d.events, minSeverity: d.minSeverity, active: d.active };
      if (webhook) {
        await api.updateWebhook(webhook.id, body);
        return null;
      }
      return (await api.createWebhook(body)).secret;
    },
    onSuccess: (secret) => {
      void qc.invalidateQueries({ queryKey: qk.webhooks });
      onClose();
      if (secret) onCreated(secret);
    },
  });
  const set = (patch: Partial<WebhookDraft>) => setD((x) => ({ ...x, ...patch }));
  const usesEvents = d.events.includes('event.created') || d.events.includes('event.closed');
  return (
    <Modal
      title={webhook ? 'Edit webhook' : 'Add webhook'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="webhook-form" className="btn btn-primary" disabled={save.isPending || (touched && !valid)}>
            {save.isPending ? 'Saving…' : webhook ? 'Save' : 'Create webhook'}
          </button>
        </>
      }
    >
      <form
        id="webhook-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) save.mutate();
        }}
      >
        <label>
          Endpoint URL
          <input type="text" inputMode="url" autoComplete="off" spellCheck={false} value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://lms.example.com/hooks/proctoring" aria-invalid={touched && !!errors.url} />
          {touched && errors.url ? <span className="text-danger small">{errors.url}</span> : <span className="muted small">Must be reachable from the internet{httpsRequired ? ' over https://' : ''}. Redirects are not followed.</span>}
        </label>
        <label>
          Description (optional)
          <input type="text" value={d.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Moodle grade sync" />
        </label>
        <fieldset className="stack-tight">
          <legend>Notifications</legend>
          {WEBHOOK_EVENT_TYPES.map((t) => (
            <label key={t} className="switch">
              <input type="checkbox" checked={d.events.includes(t)} onChange={(e) => set({ events: toggleEvent(d.events, t, e.target.checked) })} />
              <span>
                {WEBHOOK_EVENT_LABELS[t]} <code className="muted small">{t}</code>
              </span>
            </label>
          ))}
          {touched && errors.events ? <span className="text-danger small">{errors.events}</span> : null}
        </fieldset>
        <label>
          Minimum severity for proctoring events
          <select value={d.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as Severity })} disabled={!usesEvents}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
                {s === 'medium' ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
          <span className="muted small">Applies to “{WEBHOOK_EVENT_LABELS['event.created']}” and “{WEBHOOK_EVENT_LABELS['event.closed']}”. Neutral session changes are never sent as events.</span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
          <span>Active{webhook && !webhook.active && d.active ? ' (enabling resets the failure count and sends waiting notifications)' : ''}</span>
        </label>
        {save.isError ? <div className="banner banner-danger">{errorMessage(save.error)}</div> : null}
      </form>
    </Modal>
  );
}

function DeliveriesModal({ webhook, onClose }: { webhook: WebhookDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.webhookDeliveries(webhook.id), queryFn: () => api.webhookDeliveries(webhook.id), retry: shouldRetry, refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const redeliver = useMutation({
    mutationFn: (id: string) => api.redeliverWebhook(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.webhookDeliveries(webhook.id) });
      void qc.invalidateQueries({ queryKey: qk.webhooks });
    },
  });
  return (
    <Modal
      title={`Deliveries — ${hostOf(webhook.url)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">The latest 100 deliveries. Redelivering sends the same notification again with the same delivery id, so receivers can ignore duplicates.</p>
        {redeliver.isError ? <div className="banner banner-danger">{errorMessage(redeliver.error)}</div> : null}
        {q.isPending ? (
          <Loading />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title="No deliveries yet">Notifications appear here as they are sent. Use “Send test” to try the endpoint.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Notification</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((d) => {
                  const st = deliveryStatus(d);
                  return (
                    <DeliveryRow
                      key={d.id}
                      d={d}
                      label={st.label}
                      tone={TONE_CLASS[st.tone]}
                      open={open === d.id}
                      onToggle={() => setOpen(open === d.id ? null : d.id)}
                      onRedeliver={() => redeliver.mutate(d.id)}
                      busy={redeliver.isPending && redeliver.variables === d.id}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function DeliveryRow({ d, label, tone, open, onToggle, onRedeliver, busy }: { d: WebhookDeliveryDTO; label: string; tone: string; open: boolean; onToggle: () => void; onRedeliver: () => void; busy: boolean }) {
  const detail = useQuery({ queryKey: ['integrations', 'delivery', d.id], queryFn: () => api.webhookDelivery(d.id), enabled: open, retry: shouldRetry });
  return (
    <>
      <tr>
        <td className="small nowrap" title={formatDateTime(d.createdAt)}>
          <RelativeTime at={d.createdAt} />
        </td>
        <td className="small">{d.eventType === 'ping' ? 'Test (ping)' : (WEBHOOK_EVENT_LABELS[d.eventType] ?? d.eventType)}</td>
        <td>
          <span className={tone}>{label}</span>
          {d.status === 'pending' && d.nextAttemptAt ? <div className="muted small">next {formatDateTime(d.nextAttemptAt)}</div> : null}
        </td>
        <td className="small">
          {d.attempts}/{d.maxAttempts}
        </td>
        <td className="small break-all">{deliveryResult(d)}</td>
        <td>
          <div className="row tight nowrap">
            <button type="button" className="btn btn-sm" onClick={onToggle} aria-expanded={open}>
              {open ? 'Hide' : 'Payload'}
            </button>
            {d.eventType !== 'ping' ? (
              <button type="button" className="btn btn-sm" onClick={onRedeliver} disabled={busy}>
                {busy ? 'Sending…' : 'Redeliver'}
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            {detail.isPending ? <Loading /> : detail.isError ? <ErrorState error={detail.error} /> : <pre className="kv-json payload-json">{JSON.stringify(detail.data.payload, null, 2)}</pre>}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ email alerts */

function EmailAlertsSection({ status }: { status: IntegrationStatusDTO | undefined }) {
  const q = useQuery({ queryKey: qk.settings, queryFn: api.settings, retry: shouldRetry });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <EmailAlertsForm key={JSON.stringify([q.data.alertRecipients, q.data.emailAlerts])} settings={q.data} status={status} />;
}

function EmailAlertsForm({ settings, status }: { settings: OrgSettingsDTO; status: IntegrationStatusDTO | undefined }) {
  const qc = useQueryClient();
  const [text, setText] = useState(settings.alertRecipients.join('\n'));
  const [toggles, setToggles] = useState(settings.emailAlerts);
  const [saved, setSaved] = useState(false);
  const available = status?.email.available ?? false;
  const parsed = parseRecipients(text);
  const tooMany = parsed.emails.length > MAX_ALERT_RECIPIENTS;
  const invalid = parsed.invalid.length > 0 || tooMany;
  const dirty = JSON.stringify(parsed.emails) !== JSON.stringify(settings.alertRecipients) || JSON.stringify(toggles) !== JSON.stringify(settings.emailAlerts);
  const save = useMutation({
    mutationFn: () => api.updateSettings({ alertRecipients: parsed.emails, emailAlerts: toggles }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      setSaved(true);
    },
  });
  const test = useMutation({ mutationFn: () => api.testEmail() });

  const toggle = (key: keyof OrgSettingsDTO['emailAlerts'], label: string, help: string) => (
    <label className="switch">
      <input
        type="checkbox"
        checked={toggles[key]}
        disabled={!available}
        onChange={(e) => {
          setToggles((t) => ({ ...t, [key]: e.target.checked }));
          setSaved(false);
        }}
      />
      <span>
        {label} <span className="muted small">— {help}</span>
      </span>
    </label>
  );

  return (
    <section className="card stack">
      <h2>Email alerts</h2>
      {!status ? null : available ? (
        <p className="muted small">
          Alert emails are sent from <code>{status.email.from}</code>. At most one email per exam session every 5 minutes: alerts that follow within that time are combined into
          one email. Emails contain the candidate’s name, what was observed and a link to the session — never images.
        </p>
      ) : (
        <div className="banner banner-warning small" role="status">
          Email alerts are unavailable: this server has no outgoing email (SMTP) configured. Ask your system administrator to set <code>SMTP_HOST</code>,{' '}
          <code>SMTP_FROM</code> and the SMTP credentials (see <code>docs/OPERATIONS.md</code>). Webhooks and the live dashboard work without email.
        </div>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) save.mutate();
        }}
      >
        <label>
          Recipients (one email address per line)
          <textarea
            rows={3}
            value={text}
            disabled={!available}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder="proctoring-team@example.edu"
            aria-invalid={invalid}
          />
          {parsed.invalid.length ? <span className="text-danger small">Not valid: {parsed.invalid.join(', ')}</span> : null}
          {tooMany ? <span className="text-danger small">At most {MAX_ALERT_RECIPIENTS} recipients</span> : null}
        </label>
        <fieldset className="stack-tight">
          <legend>Send an email when</legend>
          {toggle('holds', 'An exam is put on hold', 'e.g. a possible different person needs review, or a pause ran too long')}
          {toggle('pauseRequests', 'A candidate requests a pause that needs approval', 'the candidate keeps working until someone decides')}
          {toggle('highSeverity', 'A high-severity event is observed', 'e.g. more than one person in view, a phone visible, a possible different person')}
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!available || invalid || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save email alerts'}
          </button>
          <button type="button" className="btn" disabled={!available || settings.alertRecipients.length === 0 || test.isPending} onClick={() => test.mutate()} title={settings.alertRecipients.length === 0 ? 'Save at least one recipient first' : undefined}>
            {test.isPending ? 'Sending…' : 'Send test email'}
          </button>
          {saved && !dirty ? <span className="text-success">Saved.</span> : null}
          {test.isSuccess ? <span className="text-success">Test email sent to {test.data.recipients.join(', ')}.</span> : null}
        </div>
        {save.isError ? <div className="banner banner-danger">{errorMessage(save.error)}</div> : null}
        {test.isError ? <div className="banner banner-danger">{errorMessage(test.error)}</div> : null}
      </form>
    </section>
  );
}
