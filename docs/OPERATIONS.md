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
reverse proxy (camera access requires HTTPS in browsers) and set `PUBLIC_URL`, `TRUST_PROXY=true`,
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
  staff updates fan out across instances, and use `STORAGE_DRIVER=s3` (or a shared volume) so every
  instance can read evidence. Background jobs (heartbeat timeouts, clock expiry, retention) use
  Postgres row locks and are safe to run on every instance.

## 3. Keys and secrets

* `EVIDENCE_KEY` encrypts all images and face templates (AES-256-GCM). Losing it makes evidence
  unreadable — store it in a secret manager and back it up separately from the database.
* **Rotation**: generate a new key, move the old one into `EVIDENCE_KEYS_OLD` (comma-separated) and
  set the new one as `EVIDENCE_KEY`. New evidence uses the new key; old evidence stays readable. Old
  keys can be dropped once all evidence encrypted with them has passed retention.
* `SESSION_SECRET` signs staff session cookies; rotating it signs everyone out.

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

**A candidate needs more time.** Use Staff submit / terminate for early endings; to extend time,
edit the exam duration before the candidate starts (per-session extensions are on the roadmap).
