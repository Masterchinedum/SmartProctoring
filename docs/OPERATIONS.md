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
Node 24 or later (required: `pnpm install` refuses older versions), pnpm 10, Postgres 14+.
```bash
pnpm install --frozen-lockfile
pnpm --filter @sp/web build
pnpm --filter @sp/server build
NODE_ENV=production DATABASE_URL=... EVIDENCE_KEY=... SESSION_SECRET=... node apps/server/dist/main.js
```

### Upgrades and rollback

Migrations only add tables / columns, and older builds ignore identity-state fields they do not know, so a
rollback does not need a schema downgrade. **One exception makes rolling back from identity engine v2 (face
templates written with embedding model id 2) to a pre-v2 build unsafe:** v2 stores every new face template — identity
references, check-frame and burst-frame templates, approved ID-photo templates — with model id **2** (SFace with flip
test-time augmentation; `vision/embeddings.ts`). A pre-v2 build accepts only model id 1 and refuses to read them
("Embeddings were produced by an unknown model (2)"): for every session enrolled after the upgrade, resume /
reconnect / reverify checks and mid-exam identity samples fail, and ID-photo comparisons for photos uploaded after
the upgrade end as "unable to verify". Templates from before the upgrade (id 1) stay readable by both.

* Roll back only when no exam is running, and only to a build that reads model id 2 (v2 or later). If you must go
  back to a pre-v2 build, first end the running sessions, and re-upload the ID photos approved since the upgrade after
  the rollback (the template is computed on upload).
* Keep the database backup taken just before the upgrade: restoring it is the only way to return to templates a
  pre-v2 build can read (sessions and uploads since then are lost).
* `rekey` (key rotation) re-encrypts templates without reading their model id, so it is safe on either version.
* From migration 0011 every identity decision records the decision configuration, calibration and model versions,
  and browser events the detector version. Older rows show as “unrecorded” on the Quality page; nothing is
  backfilled. An upgrade that ships a new calibration or detector version appears in the Drift section's version
  changes the first time it decides.

## 2. Sizing and scaling

* **Browser side**: behavioural analysis runs on the candidate's device (MediaPipe WASM, ~5 fps face
  mesh + ~1 fps object detection). Recommended candidate hardware: any laptop from the last ~6 years,
  Chrome/Edge/Firefox/Safari current versions, 720p webcam.
* **Server side** (measured with identity v2, docs/PERFORMANCE.md §6–§7):
  - **Limit:** face analysis, which runs in worker threads: ≈ 35 frames/s per 4-vCPU instance, or ≈ 29 with real
    client face crops; each frame costs ≈ 85 ms of CPU.
  - **Demand:** a candidate sends a 3-frame identity burst every 6 s for the first 3 minutes after the exam starts
    or resumes (0.5 frames/s), then every 15 s (0.2 frames/s). Exams set to the *Balanced* sampling intensity
    send 2-frame routine bursts every 12 s, then every 30 s (0.17, then 0.067 frames/s).
  - **Plan:**
    - **≈ 11 candidates per vCPU when everyone starts together**, as in a scheduled exam (≈ 45 per 4-vCPU
      instance);
    - ≈ 27 per vCPU in steady state (≈ 110 per instance);
    - *Balanced* exams: ≈ 20 per vCPU at a synchronised start (≈ 80 per instance), ≈ 70 per vCPU in steady
      state (≈ 280 per instance) (PERFORMANCE §7.7);
    - identity v1 carried ≈ 250 per vCPU.
  - **Unaffected:** heartbeats, answers and events stay fast even when analysis is saturated (heartbeat p95
    ≤ 28 ms at N=500).
* **Start-up peak**: the start-up window, not the check-in (≈ 5.5 frames), is the burst. Each started candidate
  adds 90 frames over its first 3 minutes, so one 4-vCPU instance absorbs only ≈ 14 new candidates per minute
  (≈ 34 on *Balanced*, 30 frames).
  Stagger start times to cut the peak: with starts spread over S minutes, the peak is ≈ (0.2 + 0.9 ÷ S)
  frames/s per candidate. Beyond capacity, identity bursts wait seconds, then answer 503 (retried by the
  client), and check-ins slow down. Check frames are analysed before routine identity samples.
* **Built-in protection at the peak** (both on by default; they use the capacity signal of §5):
  - *Admission at exam start.* While an instance is at capacity, "Start exam" is deferred: HTTP 503
    `start_deferred` with `Retry-After` (5–30 s). The candidate app says "Many candidates are starting at the same
    time…", waits as asked plus a random spread and tries again by itself. The exam clock has not started, the
    passed check-in stays valid, and nobody waits longer than `EXAM_START_MAX_DEFER_SEC` (default 300) in total:
    after that the start goes ahead whatever the load. Starts are thereby staggered automatically. Staff see the
    delay on the "Exam started" timeline entry ("The start was held back 40 s while the server was busy"); metric
    `sp_exam_starts_deferred_total`. Off: `EXAM_START_ADMISSION=false`.
  - *Load-aware sampling.* While the face-analysis queue is long, routine identity samples of sessions whose
    evidence is consistent are spaced out, in proportion to the queue, **at most to the Balanced sampling
    intensity** (12 s in the start-up window, 30 s after), whose accuracy was measured (§7.7). Never slowed: the
    faster sampling while evidence builds up (*suspect*, *monitoring*, unusable images), and every sample the
    candidate's browser takes on its own (exam start and resume, a break in the face track, an abrupt appearance
    change, a face returning). Metrics `sp_identity_sampling_pressure`, `sp_identity_samples_spaced_out_total`.
    Off: `LOAD_AWARE_SAMPLING=false`.
  These smooth a peak; they do not replace sizing. Plan capacity as below and treat sustained deferrals or
  spacing as a signal to add instances.
* **Tuning**: `VISION_THREADS` (default CPU count − 1) = CPU threads for face analysis; `PG_POOL_MAX` (default
  20 per instance; instances × `PG_POOL_MAX` < Postgres `max_connections`); `PG_STATEMENT_TIMEOUT_MS`
  (default 60 s). Memory ≈ 400 MB + 100 MB per vision thread. Postgres: ≈ 0.25 vCPU and ≈ 1,500 queries/s per
  1,000 candidates.
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
     templates, stored access tokens, webhook secrets and external-verifier access keys. Progress goes to stderr; the summary names each
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
* **Two-step sign-in**: staff turn it on under *Account & security* (any authenticator app: Microsoft / Google
  Authenticator, 1Password, Authy …); owners can require it for administrators and owners or for everyone under
  *Settings → Two-step sign-in*. Authenticator codes depend on the clock: keep the servers on NTP (codes are accepted one
  30-second step early or late, so a server clock more than ~30 s off starts refusing correct codes). With SMTP configured, staff are emailed about every change to their
  two-step sign-in and whenever a recovery code is used.

## 4. Backups

Back up Postgres (e.g. daily `pg_dump`, or managed-service PITR) and the evidence store (volume
snapshot or S3 versioning with lifecycle aligned to your retention period). Evidence is encrypted, so
backups do not expose images without the key — but remember that purged evidence may persist in
backups until they expire; align backup retention with the privacy notice.

## 5. Health and monitoring

* Health probes (no authentication):

  | Probe | Answers | Use it for |
  |---|---|---|
  | `GET /api/health/live` | 200 while the process answers (no database or vision check) | liveness (restart when it stops answering) |
  | `GET /api/health/ready` (= `GET /api/health`) | `{ ok, db, vision }`; 503 when Postgres does not answer within 2 s (`db: "timeout"` / `"error"`) or face analysis has no worker (`vision: "unavailable"`) | load balancer / readiness, the Dockerfile `HEALTHCHECK` |
  | `GET /api/health/capacity` | `{ accepting, reasons }`, always 200 | whether this instance should take more exam starts: alerting, autoscaling, admission |

  `reasons`: `vision_queue_long` (a new identity sample would wait longer than `CAPACITY_MAX_VISION_WAIT_MS`, default
  2 000 ms, in the face-analysis queue), `vision_unavailable`, `event_loop_lagging` (p99 >
  `CAPACITY_MAX_EVENT_LOOP_MS`, default 200), `database_pool_exhausted` (more than `CAPACITY_MAX_DB_WAITING`, default
  5, requests waiting for a connection). **Never route load-balancer traffic on capacity**: a busy instance still
  serves its own candidates (heartbeats, answers and events stay fast), and taking it out of rotation at an exam-start
  peak would push its load onto the others. Sustained `accepting: false` means add an instance or CPU.
* Structured JSON logs (pino) on stdout; `LOG_LEVEL` controls verbosity. Every request has an id: `reqId` on each of
  its log lines and `X-Request-Id` on its response. A plain-token `X-Request-Id` from your proxy (e.g. nginx
  `proxy_set_header X-Request-Id $request_id;`) is kept, so one id follows a request through both logs. Once
  authenticated, a request's lines also carry `sessionId` + `orgId` (candidate), `staffId` + `orgId` (staff app) or
  `apiKeyId` + `orgId` (integration API).
* **Prometheus metrics**: set `METRICS_TOKEN` (≥ 24 characters, e.g. `openssl rand -hex 24`) and scrape `GET /metrics`
  with `Authorization: Bearer <token>` (Prometheus `authorization: { credentials: … }`). Without the variable the
  endpoint does not exist. Instance metrics describe one process; `sp_cluster_*` metrics are read from Postgres and
  are the same on every instance (aggregate with `max`, not `sum`).

  | Metric | What it tells you |
  |---|---|
  | `sp_vision_queued`, `sp_vision_oldest_wait_seconds`, `sp_vision_estimated_wait_seconds` `{priority}` | face-analysis backlog now (interactive = check frames, background = identity samples) |
  | `sp_vision_queue_wait_seconds`, `sp_vision_analysis_seconds` (histograms) `{priority}` | queue latency and inference time per analysis |
  | `sp_vision_analyses_total{priority,result}`, `sp_vision_refused_total{priority}` | analyses done / failed, refused with 503 `vision_busy` |
  | `sp_vision_workers`, `sp_vision_in_flight` | workers ready (0 = no face analysis possible) |
  | `sp_capacity_accepting`, `sp_capacity_limited{reason}` | `/api/health/capacity` as numbers |
  | `sp_identity_decisions_total{kind,trigger,decision}` | identity outcomes (`kind` check / sample; `decision` match, inconclusive, mismatch, unable_to_verify): check completion, *unable to verify* and mismatch rates |
  | `sp_identity_model_info{calibration,embedding_model}` | the decision calibration and face-template model running (a change between deploys changes decisions) |
  | `sp_http_requests_total`, `sp_http_request_duration_seconds` `{method,route,status}` | request rate, errors and latency per route pattern |
  | `sp_db_pool_connections{state}` | Postgres pool: total / idle / waiting |
  | `sp_staff_websockets` | open staff dashboards |
  | `sp_job_runs_total{job,result}`, `sp_job_duration_seconds`, `sp_job_last_success_timestamp_seconds` `{job}` | background jobs (`retention`, `webhooks`, `email-alerts`, `abandoned-sessions`, `sweeper`): ok / failed / skipped (another instance ran it) |
  | `sp_retention_failures_total` | sessions retention could not purge (retried next hour) |
  | `sp_evidence_storage_errors_total{op}` | evidence store put / get / delete failures (disk, S3) |
  | `sp_cluster_sessions{status}`, `sp_cluster_sessions_reporting_interrupted` | sessions in progress; how many browsers stopped reporting |
  | `sp_cluster_webhook_deliveries_pending`, `sp_cluster_webhook_oldest_pending_seconds`, `sp_cluster_webhook_deliveries_failed_24h`, `sp_cluster_webhooks_disabled` | webhook backlog, retry age, dead letters, disabled endpoints |
  | `sp_cluster_email_alerts_pending`, `sp_cluster_email_alert_oldest_pending_seconds` | alert-email backlog |
  | `sp_cluster_review_holds_overdue`, `sp_cluster_review_flags_undecided`, `sp_cluster_review_oldest_undecided_flag_seconds`, `sp_cluster_reviews_escalated` | review backlog: exams on hold past the organisation's review target, undecided flags and the oldest one's age, open escalations |
  | `sp_cluster_metrics_up` | 0 = the `sp_cluster_*` values could not be read in this scrape |
  | `process_*`, `nodejs_*` | CPU, memory, heap, GC, event-loop lag |

  Suggested alerts, as a Prometheus rules file to adapt: [`docs/prometheus-alerts.yml`](prometheus-alerts.yml)
  (face-analysis latency and refusals, capacity, reporting outage, retention, evidence storage, webhook backlog,
  identity mismatch and *unable to verify* rates, no vision worker). `rekey` (key rotation) is a command, not a
  service: it reports progress on stderr and in its exit code (§3).
* Capacity: a `server overloaded (event loop lagging | database pool exhausted | face analysis queue long)`
  warning (at most one a minute, with the numbers under `loadMonitor`) means this instance is at its limit —
  requests are queuing. Occasional warnings during check-in bursts are expected; sustained ones mean add an
  instance or CPU (docs/PERFORMANCE.md §6). HTTP 503 `vision_busy` = the face-analysis queue is full.
  `Retry-After` (1–30 s) is the instance's estimate of how long the analyses already queued need (queue length ×
  measured analysis time ÷ workers); the candidate app waits at least that long plus a random 0–50 % (so candidates
  refused together do not all return together) and tells the candidate the server is busy, not that their
  connection failed.
* Watch for: rising `reporting_interrupted` events (network problems), `monitoring_degraded` events
  (under-powered candidate devices), and the “Detection quality” page (dismissal rate per detector —
  a rising rate signals false positives or a threshold that needs tuning; **Drift** compares the last week with
  the four weeks before and lists version changes next to any signal; **Identity decisions by condition** shows
  whether lighting, camera resolution or a browser explains a rise in “could not verify”).

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

**Exams are on hold longer than the review target** (`SmartProctoringHoldsOverdue`, red “overdue” on the
dashboard). Candidates are waiting: open **Review queue → Overdue**, assign the exams and decide each hold
(release, with a fresh identity check where appropriate, or terminate). Targets are set in **Settings → Review
targets** (default: held exams within 15 minutes, flags within 72 hours); staffing for exam days should follow
the hold target.

**Review backlog** (`SmartProctoringReviewBacklogOld`, or a long **Review queue → All waiting**). Assign
sessions to reviewers; decide technical and low-severity flags in bulk and close-in-time flags as incidents on a
session's Review tab; escalate what needs a second opinion (an administrator resolves escalated reviews).

**A staff member lost their phone (two-step sign-in).** They sign in with one of their recovery codes and set up
the new phone under *Account & security → Move to a new phone*. Without recovery codes: an administrator (an
owner for an owner) uses **Users → Reset two-step sign-in** after confirming who they are talking to (the person is
signed out and emailed; with the organisation's requirement they set it up again at their next sign-in).

**Nobody can sign in as an owner any more** (the only owner lost their phone and recovery codes, or forgot their
password, and no other owner exists). An operator with server access verifies the person's identity out of band
and runs, with the server's environment:

    pnpm --filter @sp/server staff-access --email owner@example.edu --reset-mfa --reason "Ticket 1234: called back on the number on file"
    pnpm --filter @sp/server staff-access --email owner@example.edu --reset-password --reason "…"   # prints a temporary password once
    # in the Docker image: node apps/server/dist/scripts/staff-access.js --email … --reset-mfa --reason "…"

It ends the account's sessions, lifts its sign-in backoff, writes `user.mfa_reset` / `user.updated` (actor
*system*, with the reason) to the organisation's audit log and emails the person. Hand a temporary password over
through a trusted channel; they change it on their account page. Exit codes: 0 done, 2 bad arguments, 4 no such
address. Afterwards, add a second owner so this is not needed again.

**Changing the identity thresholds.** Only on evidence: an offline evaluation on your own consented data
(`docs/accuracy/`), a pilot, or the Quality page's *Identity decisions by condition*. An administrator opens
**Detection quality → Identity decision configuration → Propose new thresholds…**, enters the complete set and the
reason (ticket, evidence). A second administrator reads the preview — how many of the last 30 days' samples would be
labelled differently — and approves (or rejects with a note). It applies to the next identity decision, also in
exams in progress. Lowering the mismatch threshold makes the system slower to suspect a different person; raising it
makes false suspicions (and holds of genuine candidates) more likely.

**False suspicions or holds rose after a threshold change.** Detection quality → *Drift* lists the change next to the
signal. Restore the previous version: *History → Restore…* on that version, with the reason. It is active at once (no
second approval: it was approved before) and withdraws any proposal waiting. Then decide the affected holds as usual
— a version change never re-decides past samples.

**Drift flagged after a server upgrade** (a new calibration, recogniser model or detector version in the version
changes). Compare the segments (lighting, browser, resolution) to see whether it is general or one environment.
Organisation thresholds can compensate only temporarily; report it with the Quality page figures. Roll back the
deployment only per §1 *Upgrades and rollback* (face templates are tied to the model).

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
| `EXTERNAL_VERIFIERS` | `aws-rekognition` | External second-opinion face verifiers organisations may switch on (each organisation still opts in; off by default). `none` = face images never leave this server. `docs/EXTERNAL_VERIFIER.md`. |
| `EXTERNAL_VERIFIER_ENV_CREDENTIALS` | `false` | Let organisations use this server's AWS credentials (IAM role / `AWS_*` environment) instead of storing their own access key. Single-tenant deployments only. |
| `EXTERNAL_VERIFIER_TIMEOUT_MS` | 4000 | Deadline per external comparison (retry included); afterwards the internal decision stands alone. |

Background jobs (advisory-lock guarded, one instance at a time): `webhooks` every 5 s (plus immediately
after a change), `email-alerts` every 10 s, `abandoned-sessions` hourly. Webhook attempts have a 10 s
timeout and are retried after 30 s, 1 min, 2 min, 5 min, 15 min, 30 min, 1 h, 2 h and 6 h (10 attempts).
Delivery records and queued alert emails contain candidate names and are deleted after 30 days.
Customer-facing documentation of the API and webhooks: `docs/INTEGRATION_API.md`.

Outbound network: allow egress to your SMTP server and to the webhook receivers (and, if an organisation enables
the external face verifier, to `rekognition.<region>.amazonaws.com`). Webhook requests come
from the server's own IP with `User-Agent: SmartProctoring-Webhooks/1.0`. Nothing else calls out: the face-analysis
runtime's own usage telemetry (onnxruntime) is switched off (`ORT_DISABLE_TELEMETRY=1`, set by the server when unset).
