# Operations guide

## 1. Deploying

### Docker Compose (single host)
```bash
cp .env.example .env
# fill in: EVIDENCE_KEY (openssl rand -base64 32), SESSION_SECRET (openssl rand -base64 48),
#          BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, PUBLIC_URL, POSTGRES_PASSWORD
docker compose up -d --build
```
The app listens on `:8080` and serves both the API and the web app. Put it behind a TLS-terminating
reverse proxy (camera access requires HTTPS in browsers) and set `PUBLIC_URL`, `TRUST_PROXY=<your proxy addresses, e.g. loopback,uniquelocal>` (never `true`),
`COOKIE_SECURE=true`. WebSockets must be proxied for `/api/admin/live`.

Database migrations run automatically at start-up. On first start, if no staff user exists, the
organisation owner is created from `BOOTSTRAP_ADMIN_*`.

### Without Docker
Node ≥ 20.11 (22 recommended), pnpm 10, Postgres 14+.
```bash
pnpm install --frozen-lockfile
pnpm --filter @sp/web build
pnpm --filter @sp/server build
NODE_ENV=production DATABASE_URL=... EVIDENCE_KEY=... SESSION_SECRET=... node apps/server/dist/main.js
```

## 2. Sizing and scaling

* **Browser side**: behavioural analysis runs on the candidate's device (MediaPipe WASM, ~5 fps face
  mesh + ~1 fps object detection). Recommended candidate hardware: any laptop from the last ~6 years,
  Chrome/Edge/Firefox/Safari current versions, 720p webcam.
* **Server side**: identity verification costs one face detection + one embedding per sample
  (~25–60 ms CPU). With the default 30 s interval, one vCPU sustains roughly 500–1,000 concurrent
  candidates; check-ins are burstier (≈10 frames each). Tune `VISION_CONCURRENCY` to the core count.
* **Multiple instances**: run N app containers behind a load balancer, set `REDIS_URL` so realtime
  staff updates fan out across instances and rate-limit counters (login, candidate endpoints, integration API)
  are shared by all instances, and use `STORAGE_DRIVER=s3` (or a shared volume) so every
  instance can read evidence. Background jobs (heartbeat timeouts, clock expiry, retention) use
  Postgres row locks and are safe to run on every instance.

## 3. Keys and secrets

* `EVIDENCE_KEY` encrypts all images and face templates (AES-256-GCM). Losing it makes evidence
  unreadable — store it in a secret manager and back it up separately from the database.
* **Rotation**:
  1. Generate a new key (`openssl rand -base64 32`), set it as `EVIDENCE_KEY` and move the old one into
     `EVIDENCE_KEYS_OLD` (comma-separated), then restart **every** instance. New data uses the new key; old data
     stays readable.
  2. Re-encrypt what is still under the old key, with the same environment as the servers (safe while they run;
     interrupt and re-run at will — it continues where it stopped):
     ```bash
     pnpm --filter @sp/server rekey --dry-run      # or: node apps/server/dist/scripts/rekey.js --dry-run
     pnpm --filter @sp/server rekey                # re-encrypts in batches (--batch-size, default 200)
     ```
     It covers every encrypted value: evidence blobs (images), ID-photo, reference and check-frame face
     templates, stored access tokens and webhook secrets. Progress goes to stderr; the summary names each
     `EVIDENCE_KEYS_OLD` key id as "still needed" or "no longer needed"; the run is audit-logged
     (`keys.rekeyed`). Exit code 0 = nothing left under an old key, 3 = items remain (or failed — see the
     output), 75 = another run holds the lock.
  3. Drop an old key from `EVIDENCE_KEYS_OLD` **only once `rekey --dry-run` reports nothing left under it**
     (exit code 0). Keep a copy of the retired key in your secret manager until backups made before the
     rotation have expired — restoring such a backup needs it.
* `SESSION_SECRET` signs staff session cookies; rotating it signs everyone out.
* **Staff sign-in**: sessions expire after `STAFF_SESSION_IDLE_MIN` (default 60) minutes without activity and
  `STAFF_SESSION_MAX_HOURS` (default 12) hours at most; the staff app then returns to the sign-in page and back
  to the page that was open. After 5 failed sign-ins in a row for an address (no 15-minute pause), further
  attempts for it wait 30 s, then 1, 2, 4 … up to 15 minutes, whatever the client IP (`auth.login_failed`
  audit entries, reason `throttled`). An administrator's password reset lifts the wait.

## 4. Backups

Back up Postgres (e.g. daily `pg_dump`, or managed-service PITR) and the evidence store (volume
snapshot or S3 versioning with lifecycle aligned to your retention period). Evidence is encrypted, so
backups do not expose images without the key — but remember that purged evidence may persist in
backups until they expire; align backup retention with the privacy notice.

## 5. Health and monitoring

* `GET /api/health` → `{ ok, db, vision }` for load-balancer checks.
* Structured JSON logs (pino) on stdout; `LOG_LEVEL` controls verbosity.
* Watch for: rising `reporting_interrupted` events (network problems), `monitoring_degraded` events
  (under-powered candidate devices), and the “Detection quality” page (dismissal rate per detector —
  a rising rate signals false positives or a threshold that needs tuning).

## 6. Retention job
Runs hourly inside the server. To run manually: `pnpm --filter @sp/server retention:run`.
See `docs/PRIVACY.md` §4 for the rules (legal hold, tombstones).

Retention starts when a session ends. Sessions that can never end on their own — invited, ready, paused,
on hold, or active with the exam clock stopped (disconnect policy `stop`) — are closed by the hourly
`abandoned-sessions` job once they have had no candidate or staff activity for the organisation's
**Settings → Retention → “Close unfinished sessions after … days”** (`abandonAfterDays`, default 30):
status *terminated*, end reason *closed after inactivity* (`abandoned`), no score (answers are kept), a
neutral timeline entry and an audit entry `session.abandoned`. Retention then runs from that end time.
Candidates who still need the exam get a new assignment (a new link).

## 7. Runbooks

**Candidate is on hold for a possible different person.** Open the session → Identity tab or the
event's “Compare images”. Compare the reference and the later images; ignore clothing, hair,
background, lighting and camera angle. If it is the same person: *Release* (keep “require fresh
identity check” on). If the reference itself was poor (e.g. very dark check-in) and you have verified
the person by other means, release with *authorise re-enrolment* — a new reference is created at the
next check, the old one is kept and the action is audit-logged. Otherwise *Terminate* or leave on
hold pending your institution's process. Mark the event reviewed or dismissed.

**Candidate cannot pass “unable to verify”.** The candidate sees guidance (lighting, distance,
camera). After the configured number of attempts the session is routed to review automatically.
Contact the candidate, then release with a fresh check.

**Candidate's browser crashed / they switched devices.** Nothing to do: reopening the same link
triggers a reconnect check (readiness, live-person, identity) and the exam continues with answers
and remaining time preserved. The gap appears in the timeline as an unobserved “disconnected” period.

**A candidate needs more time (accommodation or technical loss).** Open the session → *Extend time*
and enter the minutes and a reason. The extension applies to that session only, is shown on the
timeline as a neutral "Time extended" entry and is audit-logged.

**A webhook shows “Disabled after repeated failures”.** The receiving endpoint failed
`WEBHOOK_DISABLE_AFTER_FAILURES` (default 20) consecutive attempts over at least an hour; the audit log has
`webhook.auto_disabled` and the alert recipients were emailed. Open **Integrations → Webhooks →
Deliveries** to see the last HTTP status / error (e.g. `HTTP 500`, `Connection refused`, TLS problem,
`not a public address`). Fix the receiver, use **Send test**, then **Enable**: notifications that waited
(up to 72 h) are delivered, each with its original delivery id so the receiver can drop duplicates.
Individual deliveries can be re-sent with **Redeliver**.

**The receiver rejects our signature.** It must compute the HMAC over the raw body bytes (not re-serialised
JSON) with the current secret (`whsec_…`), and its clock must be within 5 minutes. After **New secret**
the old secret stops working immediately — update the receiver at the same time.

**Email alerts do not arrive.** Integrations → Email alerts shows whether SMTP is configured; use **Send
test email** (a 502 shows the SMTP server's answer). Check SPF/DKIM for `SMTP_FROM` and the recipients'
spam folders. Alerts are throttled to one email per session per 5 minutes (later ones are combined);
failed sends are retried for about 50 minutes.

**An API key was leaked.** Integrations → API keys → **Revoke** (effective immediately), create a new key
and deploy it. The audit log (actor “API key ‘name’”, actions `api.*`) shows what the key did.

## 8. Integrations configuration

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | unset | Enables email alerts. Unset = the staff app shows email alerts as unavailable. |
| `SMTP_PORT` | 587 (465 if `SMTP_SECURE=true`) | SMTP port. |
| `SMTP_SECURE` | `true` when port 465 | `true` = implicit TLS; `false` = STARTTLS when offered. |
| `SMTP_USER` / `SMTP_PASSWORD` | unset | SMTP authentication. |
| `SMTP_FROM` | — (required with `SMTP_HOST`) | From header, e.g. `SmartProctoring <proctoring-alerts@example.com>`. |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | `false` in production, `true` otherwise | Allow webhook URLs on localhost / private networks and plain `http://`… only for development. In production webhooks must be `https://` and resolve to public addresses (checked when saved and again at connect time). |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | 20 | Consecutive failed attempts (spanning ≥ 1 h) before a webhook is disabled. |
| `API_RATE_LIMIT_PER_MINUTE` | 600 | Integration API requests per minute per API key (429 above). Counted across all instances when `REDIS_URL` is set; otherwise per instance. |

Background jobs (advisory-lock guarded, one instance at a time): `webhooks` every 5 s (plus immediately
after a change), `email-alerts` every 10 s, `abandoned-sessions` hourly. Webhook attempts have a 10 s
timeout and are retried after 30 s, 1 min, 2 min, 5 min, 15 min, 30 min, 1 h, 2 h and 6 h (10 attempts).
Delivery records and queued alert emails contain candidate names and are deleted after 30 days.
Customer-facing documentation of the API and webhooks: `docs/INTEGRATION_API.md`.

Outbound network: allow egress to your SMTP server and to the webhook receivers. Webhook requests come
from the server's own IP with `User-Agent: SmartProctoring-Webhooks/1.0`.
