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
organisation owner is created from `BOOTSTRAP_ADMIN_*`. Further organisations — production tenants or **sandbox**
organisations for trials and integration testing — and their quotas are created and changed with the operator CLI
(§9).

**Dedicated vision workers** (optional, §2): face analysis in separate `vision` containers of the same image, scaled
on their own. Set `VISION_WORKER_TOKEN` in `.env` (`openssl rand -hex 32`), then
```bash
docker compose -f docker-compose.yml -f docker-compose.vision.yml up -d --build --scale vision=3
```
The app finds every replica through the service name (`VISION_WORKER_URLS=http://vision:8090`); the workers' port is
not published.

### Without Docker
Node 24 or later (required: `pnpm install` refuses older versions), pnpm 10, Postgres 14+.
```bash
pnpm install --frozen-lockfile
pnpm --filter @sp/web build
pnpm --filter @sp/server build
NODE_ENV=production DATABASE_URL=... EVIDENCE_KEY=... SESSION_SECRET=... node apps/server/dist/main.js
# optional dedicated vision worker (on each vision host; the servers then run with VISION_DRIVER=remote):
NODE_ENV=production VISION_WORKER_TOKEN=... node apps/server/dist/vision-server.js
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
* **Dedicated vision workers** (`VISION_DRIVER=remote`; ARCHITECTURE §4): face analysis — the limit above — runs in
  separate worker processes, so it scales on its own hosts while the API servers stay small. Use it when one host's
  CPU is not enough for the analysis, or to keep exam-start peaks of face analysis off the hosts that serve
  requests. On a single host the default in-process pool is as fast and simpler (PERFORMANCE §8).
  - *Topology*: API servers (any number, behind the load balancer) → `VISION_WORKER_URLS` → N workers on a private
    network. A DNS name in `VISION_WORKER_URLS` stands for every address it resolves to (re-resolved every 10 s), so
    `docker compose --scale vision=N` (service name `vision`) or a Kubernetes headless Service needs no URL list;
    static hosts can be listed (`http://10.0.0.21:8090,http://10.0.0.22:8090`). Every server uses every worker,
    picking the one with the shortest expected wait.
  - *Sizing*: a worker uses every CPU of its host by default (`VISION_THREADS` = CPU count, max 8: no event loop or
    database next to it); ≈ 46 analyses/s with 4 threads on a 4-vCPU host in isolation (PERFORMANCE §7.4), i.e.
    ≈ 38 client frames/s. Plan workers from the demand per candidate in the table above (frames/s): e.g. 200
    candidates starting together send ≈ 100 frames/s at the peak ⇒ 3–4 such workers (plan at ≤ 75 %). The API
    servers then need CPU for the request path (≈ 0.7 ms per candidate-second) plus ≈ 10–15 ms per analysed frame
    (evidence, database, identity logic, the HTTP client; PERFORMANCE §8): at 75 % one 2-vCPU server carries ≈ 200
    candidates starting together or ≈ 500 in steady state. Memory: worker ≈ 300 MB + ≈ 100 MB per analysis thread;
    a server without models ≈ 350 MB. These are estimates from a contended VM (PERFORMANCE §8): verify on your
    hardware with the load test.
  - *Settings*: servers `VISION_DRIVER=remote`, `VISION_WORKER_URLS`, `VISION_WORKER_TOKEN` (≥ 24 characters, the
    same everywhere), `VISION_WORKER_TIMEOUT_MS` (30 000: longest wait for one analysis, queue included — keep it below the candidate
    app's 45-s upload timeout so a candidate is told "busy, retry" rather than timing out; the worker drops a frame
    nobody waits for any more); workers
    `VISION_WORKER_TOKEN`, `VISION_WORKER_PORT` (8090), `VISION_THREADS`, `MODELS_DIR`. A worker needs no database,
    evidence key or storage.
  - *Behaviour*: a worker that stops answering is skipped within a second or two and used again once it answers; a
    frame it did not take goes to another worker; with no worker left the servers are not ready (§5) and frames
    answer 503 `vision_busy` + `Retry-After`, as a saturated local pool would. Admission at exam start and load-aware
    sampling use the fleet's queue.
* **Multiple instances**: run N app containers behind a load balancer, set `REDIS_URL` so realtime
  staff updates fan out across instances and rate-limit counters (login, candidate endpoints, integration API)
  are shared by all instances, and use `STORAGE_DRIVER=s3` (or a shared volume) so every
  instance can read evidence. Background jobs (heartbeat timeouts, clock expiry, retention) use
  Postgres row locks and are safe to run on every instance.

### Evidence storage locations (data residency)

Evidence **images** (check-in and identity photos, screenshots, approved ID photos — encrypted blobs) can be kept
in more than one place, for example one bucket per region, and each organisation chooses where its new images go.
**Only images move: the database stays where it is** — candidate records, exams, answers, event records, **face
templates** (the numbers used to compare faces, in Postgres), the audit log and every other table. An organisation
that needs all of its personal data in one region needs this server's database (and backups, logs, Redis) there too:
run a separate deployment in that region.

**Configuration** (operator only; staff never see buckets, directories, endpoints or credentials). The existing
`STORAGE_DRIVER` / `STORAGE_DIR` / `S3_*` settings are the location named `default`, so an existing deployment changes
nothing. Further locations are listed in `STORAGE_LOCATIONS` and configured with `STORAGE_LOCATION_<NAME>_*` (the name
upper-cased, hyphens as underscores):

| Variable | Purpose |
|---|---|
| `STORAGE_LABEL` | What staff see for `default` (default "Default storage"), e.g. `US (Virginia)` |
| `STORAGE_LOCATIONS` | Comma-separated names of the other locations: lower case letters, digits and hyphens, e.g. `eu,uk` (`default` is reserved) |
| `STORAGE_LOCATION_<NAME>_DRIVER` | `fs` or `s3` (required) |
| `STORAGE_LOCATION_<NAME>_LABEL` | What staff see, e.g. `EU (Frankfurt)` (default: the name) |
| `STORAGE_LOCATION_<NAME>_DIR` | `fs`: the directory (required) |
| `STORAGE_LOCATION_<NAME>_S3_BUCKET`, `_S3_REGION` | `s3`: bucket and its region (both required; the region is shown to staff next to the label) |
| `STORAGE_LOCATION_<NAME>_S3_ENDPOINT`, `_S3_FORCE_PATH_STYLE`, `_S3_PREFIX` | `s3`: S3-compatible endpoint, path-style addressing, key prefix |
| `STORAGE_LOCATION_<NAME>_S3_ACCESS_KEY_ID`, `_S3_SECRET_ACCESS_KEY` | `s3`: both or neither (neither = the default AWS credential chain: IAM role, `AWS_*` variables) |

```bash
STORAGE_LABEL="US (Virginia)"
STORAGE_LOCATIONS=eu
STORAGE_LOCATION_EU_DRIVER=s3
STORAGE_LOCATION_EU_LABEL="EU (Frankfurt)"
STORAGE_LOCATION_EU_S3_BUCKET=sp-evidence-eu
STORAGE_LOCATION_EU_S3_REGION=eu-central-1
```

The server **refuses to start** (exit 1, a `[config]` or `[storage]` message naming the variable) when a location is
inconsistent — unknown driver, missing directory, bucket or region, an access key without its secret, a bad or
duplicate name, two locations pointing at the same directory or the same bucket with overlapping prefixes — and when
a location still in use is missing: one an organisation has chosen, or one that still holds images that are not
deleted. A `STORAGE_LOCATION_*` variable it does not use (a typo, a location not listed) is logged as a warning at
start-up. Give every instance and every operator command (`retention:run`, `rekey`, `storage:move`) the same storage
configuration, and add a new location to every instance **before** an owner chooses it. Each S3 location needs the
same bucket settings as the default one (private, block public access, SSE, a key limited to Get/Put/Delete on its
bucket/prefix; SECURITY.md §4), and its own backups (§4).

**Choosing.** An owner chooses under **Settings → Where evidence images are stored** (administrators see the choice
and the image counts; `PUT /api/admin/settings { evidenceLocation }`, audited as `settings.updated`). It applies to
new images from the moment it is saved, on every instance. Images stored earlier stay where they are, and are read and
deleted there (every evidence row records its location), until you move them. The page shows how many images each
location holds.

**Metrics.** `sp_evidence_storage_errors_total{op,location}` counts failed operations per location (§5); the alert
`SmartProctoringEvidenceStorageErrors` names the location.

#### Runbook: moving an organisation's evidence to another location

1. The organisation's owner switches **Settings → Where evidence images are stored** to the new location (new images
   go there from now on). Find the organisation's id: the `targetId` of that `settings.updated` audit entry, or
   `SELECT id, name FROM organizations`.
2. Count what would move, with the servers' environment (safe while they run):
   ```bash
   pnpm --filter @sp/server storage:move -- --org <orgId> --to eu --dry-run
   # in the Docker image: node dist/scripts/storage-move.js --org <orgId> --to eu --dry-run
   ```
3. Move (in batches, `--batch`, default 100; progress on stderr; `--json` for the summary as JSON):
   ```bash
   pnpm --filter @sp/server storage:move -- --org <orgId> --to eu
   ```
   For every image: copy the encrypted blob to the new location under a new key, **verify** it (read it back, decrypt
   it, compare its SHA-256 with the one recorded at upload), switch the database row to the new place only if nobody
   changed it meanwhile, then delete the old copy. A copy that does not verify is deleted and the image stays where it
   was. Deleted images (tombstones) are skipped; a legal hold does not stop a move (the image is kept, only its place
   changes). Safe to interrupt and run again: it continues with what is left. The run is audit-logged
   (`evidence.storage_moved`, in the organisation's audit log). Exit codes: 0 everything of the organisation is in the
   target location, 3 images remain outside it (see the listed failures: a copy that did not verify, an image missing
   from its old location, a row changed concurrently — run it again), 4 unknown organisation or location, 2 bad
   arguments, 75 another move is running.
4. **Verify**: `storage:move … --dry-run` reports `0` outside the target (exit 0), and the Settings page shows every
   image in the new location. Old copies the run reported as "left behind" (it could not delete them, e.g. missing
   delete permission) are listed with their key; delete them by hand. If a run was killed between switching a row and
   deleting the old copy, one copy may stay behind unlisted: once the dry run reports nothing left in the old location,
   everything under the organisation's prefix `o/<orgId>/` there is unreferenced and can be deleted (e.g.
   `aws s3 rm --recursive s3://<old-bucket>/<prefix>/o/<orgId>/`, or `rm -r <dir>/o/<orgId>`).
5. Backups of the old location still hold the moved images until they expire (§4); align with your privacy notice.

**Rollback** is the same move in the other direction: the owner switches back, then
`storage:move -- --org <orgId> --to default` (or the previous location).

**Retiring a location**: every organisation using it chooses another one, `storage:move` moves each one's images out,
`--dry-run` shows nothing left there; only then remove it from `STORAGE_LOCATIONS` (the server refuses to start while
anything still refers to it).

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
     It covers every encrypted value: evidence blobs (images, each in its own storage location, §2), ID-photo, reference and check-frame face
     templates, stored access tokens, webhook secrets, external-verifier access keys and the integration API responses
     kept for 24 hours for `Idempotency-Key` replays. Progress goes to stderr; the summary names each
     `EVIDENCE_KEYS_OLD` key id as "still needed" or "no longer needed"; the run is audit-logged
     (`keys.rekeyed`). Exit code 0 = nothing left under an old key, 3 = items remain (or failed — see the
     output), 75 = another run holds the lock.
  3. Drop an old key from `EVIDENCE_KEYS_OLD` **only once `rekey --dry-run` reports nothing left under it**
     (exit code 0). Keep a copy of the retired key in your secret manager until backups made before the
     rotation have expired — restoring such a backup needs it.
* `SESSION_SECRET` signs staff session cookies; rotating it signs everyone out.
* `VISION_WORKER_TOKEN` (dedicated vision workers only) authenticates the servers to the workers. Rotate without
  downtime: set the workers to `VISION_WORKER_TOKEN=<new>,<old>` and restart them one by one, restart the servers
  with `<new>`, then set the workers to `<new>` only.
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

Back up Postgres (e.g. daily `pg_dump`, or managed-service PITR) and the evidence store — every storage location
(§2) — (volume snapshot or S3 versioning with lifecycle aligned to your retention period). Evidence is encrypted, so
backups do not expose images without the key — but remember that purged evidence may persist in
backups until they expire; align backup retention with the privacy notice.

## 5. Health and monitoring

* Health probes (no authentication):

  | Probe | Answers | Use it for |
  |---|---|---|
  | `GET /api/health/live` | 200 while the process answers (no database or vision check) | liveness (restart when it stops answering) |
  | `GET /api/health/ready` (= `GET /api/health`) | `{ ok, db, vision }`; 503 when Postgres does not answer within 2 s (`db: "timeout"` / `"error"`) or face analysis has no worker (`vision: "unavailable"`) | load balancer / readiness, the Dockerfile `HEALTHCHECK` |
  | `GET /api/health/capacity` | `{ accepting, reasons }`, always 200 | whether this instance should take more exam starts: alerting, autoscaling, admission |

  With dedicated vision workers (`VISION_DRIVER=remote`) the server's `ready` means *at least one worker ready*
  (`visionWorkers: { ready, configured }` in the answer), and capacity reads the fleet's queue. Each worker has its
  own probes, without authentication: `GET /health/live` (the process answers) and `GET /health/ready` (200 while at
  least one analysis thread is ready; the image's `HEALTHCHECK` uses it in a worker container). Everything else on a
  worker needs the token.

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
  are the same on every instance (aggregate with `max`, not `sum`). The slow-moving ones (background job status,
  retention backlog, privacy requests) are read at most every 30 s, one query each.

  | Metric | What it tells you |
  |---|---|
  | `sp_vision_queued`, `sp_vision_oldest_wait_seconds`, `sp_vision_estimated_wait_seconds` `{priority}` | face-analysis backlog now (interactive = check frames, background = identity samples) |
  | `sp_vision_queue_wait_seconds`, `sp_vision_analysis_seconds` (histograms) `{priority}` | queue latency and inference time per analysis |
  | `sp_vision_analyses_total{priority,result}`, `sp_vision_refused_total{priority}` | analyses done / failed, refused with 503 `vision_busy` |
  | `sp_vision_workers`, `sp_vision_in_flight` | analysis threads ready (0 = no face analysis possible); with dedicated workers, summed over the workers in use |
  | `sp_vision_remote_workers{state}` | dedicated vision workers: `up` (in use), `unready` (no thread ready), `down` (not answering, or the token is rejected), `unknown` |
  | `sp_vision_remote_overhead_seconds` (histogram) | dedicated vision workers: time per analysis beyond the worker's own queue wait and analysis (the HTTP hop; p50 ≈ 2–5 ms measured on one host, PERFORMANCE §8) |
  | `sp_vision_remote_failures_total{reason}` | dedicated vision workers: failed requests / load polls (`connect`, `timeout`, `reset`, `unauthorized`, `bad_response`, `server_error`) |
  | `sp_capacity_accepting`, `sp_capacity_limited{reason}` | `/api/health/capacity` as numbers |
  | `sp_exam_starts_deferred_total`, `sp_identity_sampling_pressure`, `sp_identity_samples_spaced_out_total` | exam starts held back at capacity; how far routine identity samples are spaced out because of the face-analysis queue (§2) |
  | `sp_identity_decisions_total{kind,trigger,decision}` | identity outcomes (`kind` check / sample; `decision` match, inconclusive, mismatch, unable_to_verify): check completion, *unable to verify* and mismatch rates |
  | `sp_identity_model_info{calibration,embedding_model}` | the decision calibration and face-template model running (a change between deploys changes decisions) |
  | `sp_checks_completed_total{purpose,outcome}` | readiness / identity checks finished (`purpose` initial, resume, reconnect, reverify; `outcome` passed, retry, held, failed, or abandoned — expired or replaced by a new check without being completed): check-in pass rate, how often candidates end on hold |
  | `sp_http_requests_total`, `sp_http_request_duration_seconds` `{method,route,status}` | request rate, errors and latency per route pattern |
  | `sp_db_pool_connections{state}` | Postgres pool: total / idle / waiting |
  | `sp_db_pool_acquire_seconds` (histogram) | how long requests wait for a pooled Postgres connection (opening a new one included): saturation shows here before requests queue |
  | `sp_db_connection_errors_total{kind}` | `connect`: a connection could not be opened (Postgres down, refusing connections, max_connections reached); `lost`: an open connection was closed by Postgres or the network (restart, failover, killed session) — each request it was serving failed with 500 and was retried by the client |
  | `sp_staff_websockets` | open staff dashboards |
  | `sp_job_runs_total{job,result}`, `sp_job_duration_seconds`, `sp_job_last_success_timestamp_seconds` `{job}` | background jobs (`retention`, `webhooks`, `email-alerts`, `abandoned-sessions`, `api-idempotency`, `sandbox-purge`, `sweeper`): ok / failed / skipped (another instance ran it) |
  | `sp_retention_failures_total` | sessions retention could not purge (retried next hour) |
  | `sp_evidence_storage_errors_total{op,location}` | evidence store put / get / delete failures (disk, S3), per storage location (§2) |
  | `sp_evidence_storage_seconds{op,location}` (histogram) | evidence store latency per operation and storage location (failures included); a check frame or identity sample holds its database transaction while its image is written |
  | `sp_cluster_sessions{status}`, `sp_cluster_sessions_reporting_interrupted` | sessions in progress; how many browsers stopped reporting |
  | `sp_cluster_webhook_deliveries_pending`, `sp_cluster_webhook_oldest_pending_seconds`, `sp_cluster_webhook_deliveries_failed_24h`, `sp_cluster_webhooks_disabled` | webhook backlog, retry age, dead letters, disabled endpoints |
  | `sp_cluster_email_alerts_pending`, `sp_cluster_email_alert_oldest_pending_seconds` | alert-email backlog |
  | `sp_cluster_review_holds_overdue`, `sp_cluster_review_flags_undecided`, `sp_cluster_review_oldest_undecided_flag_seconds`, `sp_cluster_reviews_escalated` | review backlog: exams on hold past the organisation's review target, undecided flags and the oldest one's age, open escalations |
  | `sp_cluster_api_keys_expiring_soon` | integration API keys (not revoked) that expire within 14 days — rotate them (§7) |
  | `sp_cluster_job_last_success_timestamp_seconds{job}`, `sp_cluster_job_last_run_failed{job}` | background jobs that record their runs in the database (`retention`): the last success on any instance (kept across restarts, unlike `sp_job_last_success_timestamp_seconds`), and whether the last run failed — Privacy → Deletion schedule shows the same |
  | `sp_cluster_retention_overdue_sessions`, `sp_cluster_retention_overdue_oldest_seconds` | ended sessions whose images are past their deletion date and still stored (legal holds excluded), and how long the oldest is overdue — Privacy → Operational checks "Deletion on schedule" |
  | `sp_cluster_privacy_requests_open{kind}`, `sp_cluster_privacy_requests_overdue` | data-subject requests open or in progress, by kind, and those past their response deadline |
  | `sp_cluster_organizations_at_quota{quota,level}` | organisations at (`level="reached"`) or near (`"warning"`, from 80 %) a quota (`exams`, `candidates`, `sessionsPerMonth`) — a customer will soon be refused, or is (§9) |
  | `sp_cluster_metrics_up` | 0 = the `sp_cluster_*` values could not be read in this scrape |
  | `process_*`, `nodejs_*` | CPU, memory, heap, GC, event-loop lag |

  Suggested alerts, as a Prometheus rules file to adapt: [`docs/prometheus-alerts.yml`](prometheus-alerts.yml)
  (face-analysis latency and refusals, capacity, reporting outage, check-ins ending on hold, retention not running or
  failing, images past their deletion date, overdue privacy requests, evidence storage errors and latency, Postgres
  unreachable / dropping connections / pool saturated, webhook backlog, identity mismatch and *unable to verify*
  rates, no vision worker, a dedicated vision worker down, API keys about to expire); `runbook_url` points at the runbook in §7. A test
  (`apps/server/test/alert-rules.test.ts`) checks the file's structure, that every series it uses exists, that its
  runbook links resolve and that every series is listed above (`promtool check rules` is not needed in CI).
  `rekey` (key rotation) is a command, not a service: it reports progress on stderr and in its exit code (§3).
* Postgres restarts and failovers: open connections are closed by Postgres; each request using one at that moment
  fails with 500 (its transaction rolled back) and the candidate app resends it; the pool reconnects by itself and
  `/api/health/ready` reports `db: "error"` while no connection can be opened (runbook in §7). Background jobs that
  failed retry on their next run. Redis going away (with `REDIS_URL`) affects nothing but the shared rate-limit
  counters (requests are let through, `redis rate-limit store error` is logged) and live staff updates across
  instances (`redis bus error`); both reconnect by themselves.
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

Every real run (scheduled or `retention:run`, not `--dry-run`) is recorded in the database (`job_status`): when it
started and ended, what it deleted, or the error that stopped it — whichever server ran it. **Privacy → Deletion
schedule** shows it with what is due over the next 30 days, what is past its date and not yet deleted, and the
sessions under legal hold (`GET /api/admin/retention/preview`). **Privacy → Operational checks**
(`GET /api/admin/ops/checks`) warns when the job has not succeeded for 3 hours, failed, or left images past their
date (warning after 2 hours, failing after a day), next to overdue privacy requests, this server's face-analysis
capacity, failing webhooks and alert emails.

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

<a id="runbook-check-ins-held"></a>**Many check-ins end on hold** (`SmartProctoringCheckInsHeldOften`,
`sp_checks_completed_total{purpose="initial",outcome="held"}`). Candidates cannot start until staff decide, so work
the Review queue first (the entries above). Then find the cause: Detection quality → *Identity decisions by
condition* (lighting, camera resolution, browser) for "could not verify" after every attempt, *Drift* and
`sp_identity_model_info` for a change of the check itself, failed live-person steps in the sessions' check details.
A real rise in different-person holds is rare; compare a few cases before suspecting candidates.

**Candidate's browser crashed / they switched devices.** Nothing to do: reopening the same link
triggers a reconnect check (readiness, live-person, identity) and the exam continues with answers
and remaining time preserved. The gap appears in the timeline as an unobserved “disconnected” period.

**A candidate missed their window / needs another time.** An exam assigned with a scheduling window can be started
only inside it (the check-in opens 30 minutes earlier); outside it the candidate's link shows when it opens or that it
has closed. While the exam has not started: session page → *Reschedule…* (admin) with the new opening / closing time
in your time zone (empty = no window) and an optional note; the same link keeps working — tell the candidate the new
time. An exam that started is never cut off by its window, so nothing is needed for candidates already writing. A
session whose window closed unused is closed as abandoned after the organisation's inactivity period, counted from
the closing.

**An exam is on hold under the interruption rules** (hold reason *Interrupted more often or longer than the exam rules
allow*: the exam's *Interruptions and recovery* rules limit reopening it in a new browser window and the time
disconnected). The timeline entry says which limit and the numbers. Contact the candidate; if the interruptions were
outside their control (network, power), *Release hold* (keep the fresh identity check on) — the reconnection allowance
starts again; otherwise *Terminate* per your process. With *End the exam* in those rules the exam was submitted
instead (end reason *Ended by the interruption rules*): reopen it for recovery if it should continue.

**An exam is on hold because of an additional display** (hold reason *Additional display connected (the exam allows
only one)*: the exam's *Require a single display* rule, Chrome and Edge only). The candidate's hold screen asks them to
disconnect it and shows whether only one display is connected now. Contact them if needed, then *Release hold*. A
display still connected when the exam continues puts it on hold again. For a
candidate who needs a second display (a magnifier, for example), grant the *Assistive technology* accommodation before
the exam starts: it waives the rule for that candidate.

**Reopen an exam for recovery** (power cut at a test centre, an exam terminated or submitted by mistake, time lost to
a technical problem, an exam closed after inactivity). Session page → *Reopen for recovery…* (admin): the dialog says
whether it can be reopened and why not — never an exam the candidate submitted themselves, nor one whose consent was
withdrawn or whose images were deleted under the retention policy; a completed review must be reopened first. Give
the reason (timeline and audit log; not sent to integrations) and add minutes if no time is left (e.g. after the time
ran out). The candidate opens the same link, passes a fresh camera and identity check and continues with their answers
and remaining time; the exam clock stays stopped until then. An exam that never started returns to the check-in
(reschedule it too if its window closed). Integrations receive `session.reopened`; the score is computed again when
the exam ends again.

**A dedicated vision worker is down** (`SmartProctoringVisionWorkerDown`, `sp_vision_remote_workers{state="down"}`;
the server log says `remote vision: worker not answering` or `rejected VISION_WORKER_TOKEN`). The other workers
carry its frames, so check capacity (`/api/health/capacity`) first. Then look at the worker: its container health /
`GET /health/ready`, its log (models not found, out of memory), the network between server and worker, and — for
`unauthorized` — that `VISION_WORKER_TOKEN` is identical on both sides. When every worker is down the servers report
not ready (`vision: "unavailable"`) and frames answer 503 with `Retry-After`; candidates' apps retry by themselves.
The servers pick a worker up again within a few seconds of it answering; no restart needed.

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

**Setting up single sign-on** (Settings → Single sign-on; owners only, administrators can view and test). The
organisation is found from the **email domain** staff type on the sign-in page ("Sign in with your organisation"), so
claim every domain your staff sign in with; a domain can belong to one provider on the whole server (ask the operator
if one is already claimed). Each provider also has its own sign-in link to bookmark or put on an intranet page.
Order of work: add the provider **disabled** → copy the redirect URI (OIDC) or the service-provider metadata URL
(SAML) into the identity provider → finish the provider form → **Test connection** → enable → sign in yourself in a
private window → only then consider **Require single sign-on**. After single sign-on SmartProctoring does not ask for
its own two-step sign-in: **require MFA in the identity provider** for this application.

* **Microsoft Entra ID (OpenID Connect).** Entra admin centre → App registrations → New registration (single tenant),
  redirect URI type *Web* = the redirect URI shown in SmartProctoring. Certificates & secrets → new client secret.
  Issuer = `https://login.microsoftonline.com/<tenant-id>/v2.0` (the tenant-specific issuer, never `common` or
  `organizations`); client ID = the application (client) ID. Token configuration → optional claim `email` (ID
  token), or set the email claim in SmartProctoring to `preferred_username` when your sign-in names are email
  addresses. Entra does not send `email_verified`: switch off "Only accept email addresses the provider marks as
  verified" (safe with a single-tenant issuer: only your tenant can sign in, and only your claimed domains are
  accepted). Groups for roles of new accounts: Token configuration → groups claim (object IDs; map them by ID).
  Conditional Access: require MFA for the app.
* **Okta (OpenID Connect).** Applications → Create App Integration → OIDC, *Web application*, grant type
  authorization code, sign-in redirect URI = the redirect URI. Issuer = `https://<your-org>.okta.com` (org
  authorization server) or `https://<your-org>.okta.com/oauth2/default`; client ID / secret from the app. Okta sends
  `email_verified`; keep the check on. Groups: add a `groups` claim (filter, e.g. starts with `proctoring-`) to the ID
  token. Sign-on policy: require MFA.
* **Google Workspace (OpenID Connect).** Google Cloud console → APIs & Services → Credentials → OAuth client ID,
  *Web application*, authorised redirect URI = the redirect URI; consent screen *Internal*. Issuer
  `https://accounts.google.com`. Google signs in any Google account, so the **email domains are what restrict it to
  your staff** — claim only your Workspace domains. Google sends no groups claim: create accounts on the Users page or
  by SCIM, or keep just-in-time accounts as reviewers. Enforce 2-step verification in the Admin console.
* **SAML 2.0 (Entra ID enterprise app, Okta SAML app, ADFS, Shibboleth…).** Give the identity provider the
  service-provider metadata URL (or: entity ID / identifier = the metadata URL, reply / ACS URL = the URL shown). In
  SmartProctoring enter the identity provider's entity ID (issuer), its single sign-on URL (HTTP-Redirect binding) and
  its signing certificate (PEM; from its metadata). Send the email as the NameID (format emailAddress) or as an
  attribute (`email`, `mail` or Entra's `…/claims/emailaddress`); prefer a persistent NameID if your provider
  offers one. Sign the assertion or the whole response (SHA-256). SmartProctoring does not sign its requests and
  does not accept encrypted assertions (TLS protects the browser leg), and only SP-initiated sign-in works: start
  from SmartProctoring's sign-in page or sign-in link, not from the identity provider's app tile.
* **New staff.** Either add them on the Users page / by SCIM (they are linked at their first single sign-on), or
  turn on *Create an account at the first sign-in* with a default role (reviewer is the safe choice) and optional
  group → role mappings. Accounts are never created as owners; roles of existing accounts are not changed at sign-in.

**Setting up SCIM provisioning.** Settings → Single sign-on → *Staff provisioning (SCIM)* → **Create SCIM token**
(owner; shown once). Entra ID: the enterprise application → Provisioning → Automatic, tenant URL = the SCIM base URL,
secret token = the token; map `userPrincipalName` (or `mail`) → `userName`, `displayName`, `Switch([IsSoftDeleted]…)`
→ `active` (the default mapping), and for roles an app role → `roles[primary eq "True"].value` with the values
`reviewer` / `admin`. Okta: the app → Provisioning → SCIM 2.0, base URL and *HTTP Header* authentication with the
token; enable create / update / deactivate. Deactivating or unassigning someone disables the account here and signs
them out everywhere; SCIM never changes owners (manage them on the Users page). Rotate the token with **Replace token**
(the old one stops at once — update the identity provider immediately); **Revoke token** stops provisioning.

**Single sign-on is down** (the identity provider is unavailable or misconfigured; staff see "Your organisation's
identity provider could not be reached" or "Single sign-on did not complete"). The audit log has the precise reason
under `auth.sso_failed` (e.g. `discovery_failed`, `token_rejected` with the library's message, `wrong_recipient`,
`replayed`). **Owners can always sign in with their password and two-step sign-in**: an owner can turn off *Require
single sign-on* so administrators and reviewers can use passwords (an administrator sets them on the Users page —
accounts created by SCIM or at first sign-in have none), fix the provider, then turn it on again. If no owner can sign
in at all, the operator uses the `staff-access` CLI (above).

**A certificate rollover at the SAML identity provider.** Add the new signing certificate next to the old one in the
provider form (up to three), save, let the identity provider switch, then remove the old one. The provider card warns
30 days before the last certificate expires.

**Someone's address was given to a new person** (a re-used mailbox), or they moved to a new account at the identity
provider: their next single sign-on is refused ("linked to a different identity"). Check who it is, then Users →
**Unlink single sign-on**; the next sign-in links the account to the identity that signs in with that address.

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

<a id="runbook-privacy-requests-overdue"></a>**A data-subject request arrives** (a candidate asks for a copy of their data, its deletion, a correction…;
`SmartProctoringPrivacyRequestsOverdue` when one is past its deadline).
Privacy → *Record a request…* the day it arrives, with the date received (the one-month deadline counts from it) and
the candidate record. Access: open the request → *Export the candidate's data (ZIP)*, check it, send it through a
secure channel, then *Completed* with how it was sent. Erasure: *Erase the candidate…* (refused while an exam of
theirs runs or is under legal hold: finish it, or decide whether the hold still applies), then *Completed*. Need
longer (a complex request)? Extend the deadline with the reason and tell the person before the first month ends.
`docs/PRIVACY.md` §5 has the rest.

**A candidate withdrew consent in the exam app.** Their exam has ended and its images are deleted; the register has an
open *Consent withdrawn* request linked to the session. Contact them about an alternative (e.g. the accommodation
*identity verified by staff*, or *no camera*, and a new assignment), decide whether their approved ID photo is still
needed, and complete the request with what was agreed.

<a id="runbook-retention-failing"></a>**Operational checks show "Retention job — Failing" or "Deletion on schedule — Failing"**
(`SmartProctoringRetentionNotRunning`, `SmartProctoringRetentionLastRunFailed`,
`SmartProctoringEvidencePastDeletionDate[Day]`). The server log has the
error (`retention run failed` / `retention: evidence purge failed`). Usual causes: the evidence store is unreachable
or refuses deletes (S3 permissions), or the database was unavailable. Once fixed, run
`pnpm --filter @sp/server retention:run` (or wait for the next hour) and check the page again. "No successful run for
over 3 hours" with no error means no server runs background jobs: at least one must have `SWEEPER_ENABLED` on.

<a id="runbook-database-unreachable"></a>**Postgres is unreachable or keeps dropping connections**
(`SmartProctoringDatabaseUnreachable`, `SmartProctoringDatabaseConnectionsDropped`; `/api/health/ready` answers 503 with
`db: "error"` or `"timeout"`; log lines `cannot connect to the database`, `database connection lost`). While Postgres
is down every request that needs it fails with 500: candidates' browsers keep answers, events and images and resend
them when it is back (answers by `clientSeq`, events by id and version, images and identity samples by id — a resend
never duplicates anything, also when the original request was in fact committed); staff pages show an error. No
restart is needed: a connection lost in the middle of a request fails only that request (Postgres rolls its
transaction back, and images it had already written are deleted again), the pool discards broken connections and
opens new ones as soon as Postgres answers. Check the Postgres server or managed service, its disk (Postgres stops
writing on a full disk), `max_connections` (the sum of `PG_POOL_MAX` over all instances plus headroom for
migrations, `rekey` and backups) and the network or proxy in between. Repeated drops without an outage: a proxy or
PgBouncer closing connections, or an `idle_in_transaction_session_timeout` shorter than a slow evidence upload.

<a id="runbook-database-pool"></a>**Requests wait for a database connection** (`SmartProctoringDatabasePoolSlow`,
`SmartProctoringDatabasePoolExhausted`, capacity reason `database_pool_exhausted`; `sp_db_pool_acquire_seconds`). The
instance has more concurrent work than its pool (`PG_POOL_MAX`, default 20): add an instance (keep the sum of pools
below `max_connections`) or raise `PG_POOL_MAX`. If the load is normal, look for slow statements (`pg_stat_activity`,
`pg_stat_statements`) and for transactions held open by a slow evidence store (next entry).

<a id="runbook-evidence-storage-slow"></a>**Storing images is slow** (`SmartProctoringEvidenceStorageSlow`,
`sp_evidence_storage_seconds{op="put"}`). A check frame or identity sample keeps its database transaction open while
its image is written, so a slow disk or S3 endpoint slows check-ins and can exhaust the Postgres pool. Check the
volume (I/O wait, nearly full disk) or the S3 endpoint's latency and throttling (region, VPC endpoint, request
rate); `sp_evidence_storage_errors_total` rising alongside means it is failing, not only slow.

**A customer hit a quota** (staff see "… can have at most N candidates", "This would create N exam sessions, but only
M more can be created this month…"; integrations get `409 quota_exceeded` with `details: { quota, limit, used,
requested, resetsAt }`; `sp_cluster_organizations_at_quota{level="reached"}`; nothing was created). Look at the
organisation's usage: `pnpm --filter @sp/server org:list` (or Settings → *Usage and limits* in their staff app).
* *Exams*: archived exams do not count — they can archive exams they no longer use.
* *Candidates*: deleting candidates who are no longer needed frees places (a sandbox also deletes unused ones
  automatically after its clean-up period).
* *Exam sessions this month*: sessions count in the calendar month (UTC) they were **created** in; deleting candidates
  or sessions does not give them back. The count starts again at 00:00 UTC on the 1st (the message gives the date).
* To raise a limit (after checking the contract or the trial's terms):
  `pnpm --filter @sp/server org:set -- --org <id> --sessions-per-month 500 --reason "Ticket 123"` (`unlimited` removes
  the limit, `default` returns to the kind's default). It applies to the next request; the change is in the
  organisation's audit log (`organization.updated`, actor *system*). A sandbox that becomes a customer:
  `org:set -- --org <id> --kind production --reset-quotas` (the clean-up stops for it at once).

**An API key was leaked.** Integrations → API keys → **Revoke** (effective immediately), create a new key with the
same access and deploy it. The audit log (actor “API key ‘name’”, actions `api.*`) shows what the key did.

**Rotating an API key** (it expires soon — “Expires in N days” on the Integrations page, the *API keys* operational
check, the `SmartProctoringApiKeysExpiringSoon` alert — or someone who knew it left). Keys cannot be extended, so:
1. Integrations → API keys: create a new key with the **same access** (the list shows each key's access) and an
   expiry (default one year).
2. Give it to the team running the connected system and have them replace the old key in their secret store. Both
   keys work meanwhile, so there is no downtime; `Idempotency-Key`s are shared by the organisation's keys, so retries
   in flight are still recognised.
3. Wait until the new key's **Last used** changes and the old one's stops changing, then **Revoke** the old key.

**Operational checks show "API keys — Failing" (a key expired while still in use).** The system using it now gets
`401 api_key_expired` on every request. Create a new key with the same access, have it deployed, then revoke the
expired key (that clears the check). "Needs attention" means a key expires within 14 days: rotate it as above.

**An integration gets `403 insufficient_scope`.** The key lacks the permission that endpoint needs (the response's
`details.requiredScope`; the scopes table is in `docs/INTEGRATION_API.md` §1). Keys' permissions cannot be changed:
create a key with the needed access, deploy it, revoke the old one.

**An integration gets `409 idempotency_key_in_use` or `422 idempotency_key_reused`.** 409: it retried while its first
request was still running — retrying after a second returns the stored response. 422: it reused an `Idempotency-Key`
for a different request within 24 hours — it must send a new key per new request (`docs/INTEGRATION_API.md` §1).

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
| `SSO_ALLOW_PRIVATE_NETWORKS` | the `WEBHOOK_ALLOW_PRIVATE_NETWORKS` value | Allow identity providers (OIDC discovery, JWKS, token endpoint) on localhost / private networks. Leave off in production unless your identity provider is only reachable on a private network you trust; requests are otherwise checked like webhooks (public addresses only, DNS pinned at connect time, no redirects). `https://` is required in production either way. |
| `SSO_TIMEOUT_MS` | 10000 | Deadline per request to an identity provider. |
| `SCIM_RATE_LIMIT_PER_MINUTE` | 600 | SCIM requests per minute per token (429 above; shared across instances with `REDIS_URL`). |

Background jobs (advisory-lock guarded, one instance at a time): `webhooks` every 5 s (plus immediately
after a change), `email-alerts` every 10 s, `abandoned-sessions` hourly, `api-idempotency` hourly (deletes stored
`Idempotency-Key` responses older than 24 hours), `sandbox-purge` hourly (sandbox organisations only, §9). Webhook attempts have a 10 s
timeout and are retried after 30 s, 1 min, 2 min, 5 min, 15 min, 30 min, 1 h, 2 h and 6 h (10 attempts).
Delivery records and queued alert emails contain candidate names and are deleted after 30 days.
Customer-facing documentation of the API and webhooks: `docs/INTEGRATION_API.md`; the OpenAPI 3.1 document is served
at `GET /api/v1/openapi.json` (no API key, 60 requests per minute per address) and committed as `docs/openapi.json` —
regenerate it with `pnpm --filter @sp/server openapi -- --out ../../docs/openapi.json` after changing
`packages/shared/src/integrations.ts` (a server test fails while it is out of date; `-- --check ../../docs/openapi.json`
only checks).

Outbound network: allow egress to your SMTP server and to the webhook receivers (and, if an organisation enables
the external face verifier, to `rekognition.<region>.amazonaws.com`; with OpenID Connect single sign-on, to the
identity providers' issuer, JWKS and token endpoints — SAML needs no outbound call). Webhook requests come
from the server's own IP with `User-Agent: SmartProctoring-Webhooks/1.0`. Nothing else calls out: the face-analysis
runtime's own usage telemetry (onnxruntime) is switched off (`ORT_DISABLE_TELEMETRY=1`, set by the server when unset).

## 9. Organisations: sandbox and quotas

Every organisation is a **production** organisation (the default, and every organisation that existed before this
feature) or a **sandbox**: a tenant for trying SmartProctoring out and for testing integrations, **not for real
candidates**. Only the server operator creates organisations and sets their kind and quotas — staff see them
(Settings → *Usage and limits*) but cannot change them.

A sandbox is marked everywhere: a permanent banner in the staff app ("Sandbox — data is deleted after 14 days; not
for real candidates"), a *Practice environment* notice on the candidate's welcome screen, `[SmartProctoring sandbox]`
and a first line in alert emails, and `"sandbox": true` in every webhook envelope (`docs/INTEGRATION_API.md` §3).

**Quotas** (per organisation; `null` = no limit):

| Quota | Counts | Production default | Sandbox default |
|---|---|---|---|
| `exams` | exams that are not archived (drafts and published) | no limit | 5 |
| `candidates` | candidate records | no limit | 50 |
| `sessionsPerMonth` | exam sessions **created** in the calendar month, in **UTC** (assignments in the staff app and the integration API; an assignment that returns a candidate's existing session does not count; deleted sessions still count) | no limit | 100 |

They are enforced when an exam is created, imported or published again from the archive, when a candidate is
created (staff app or `POST /api/v1/candidates`; updating an existing one is always allowed), and when an assignment
creates sessions (a batch is accepted whole or refused whole). Checks run under a per-organisation lock, so parallel
requests cannot exceed a limit. A refusal is HTTP 409 `quota_exceeded` with a plain-language message. The monthly
session count is kept per month in `org_usage` (a counter, also kept for organisations without limits, so Settings
shows usage and a limit set mid-month counts what was already created). Counting started with the upgrade that
introduced it: sessions created earlier in that month are not counted.

**Creating an organisation** (with the servers' environment; in the Docker image `node dist/scripts/org.js create …`):

```bash
pnpm --filter @sp/server org:create -- --name "Acme University (trial)" --kind sandbox \
  --owner-email it-admin@acme.example --owner-name "Pat Admin" --reason "Trial, ticket 123"
# optional: --candidates 20 --sessions-per-month 50 --exams 3 (or unlimited) --purge-after-days 7 --json
```

It prints the organisation (id, kind, limits) and the first owner's **temporary password, once** — hand it over
through a trusted channel; the owner signs in at the staff app and changes it on their account page (and sets up
two-step sign-in). An address can belong to one organisation only (exit 4 if it is taken). Without `--kind` the
organisation is production without limits.

**Changing kind, quotas or the clean-up period**:

```bash
pnpm --filter @sp/server org:list                      # every organisation with its kind, limits and usage (--json)
pnpm --filter @sp/server org:set -- --org <id> --candidates 200 --sessions-per-month unlimited --reason "Ticket 124"
pnpm --filter @sp/server org:set -- --org <id> --exams default        # back to the kind's default
pnpm --filter @sp/server org:set -- --org <id> --kind production --reset-quotas   # a trial becomes a customer
pnpm --filter @sp/server org:set -- --org <id> --kind sandbox --confirm-purge     # see the warning below
```

Each change is audited in the organisation's audit log (`organization.created` / `organization.updated`, actor
*system*, with `--reason`) and applies to the next request on every instance. **Turning a production organisation
into a sandbox deletes its data**: the next clean-up deletes every session, image and candidate not used for the
clean-up period — so `org:set` refuses it without `--confirm-purge` (exit 3). Exit codes: 0 done, 2 bad arguments,
3 confirmation needed, 4 unknown organisation.

**Sandbox clean-up** (job `sandbox-purge`, hourly on a server with background jobs; `sandbox:purge` by hand). For each
sandbox organisation, data not used for its clean-up period (`--purge-after-days`, default 14):
* exam sessions that ended before the cut-off, and unfinished ones without activity since (last change, heartbeat,
  hold, scheduling window) — their images and face templates first (each image in the storage location its row
  records, §2), then the records (events, answers, checks, notes, reviews…);
* candidates left without any session, created and last changed before the cut-off (with their approved ID photo).

Kept: sessions under **legal hold** (and so their candidates; listed in the run's audit entry), exams (configuration;
the exam quota limits them), staff accounts, API keys, webhooks, the privacy register and the audit log. Production
organisations are never touched. Each run that deleted (or kept for a legal hold) something writes a `sandbox.purge`
audit entry to the organisation with the counts; every real run is recorded in `job_status`, and a sandbox's
**Privacy → Operational checks** shows *Sandbox clean-up* (warning after 3 hours without a successful run, failing on
an error). By hand (holds the same lock as the job; safe while the servers run):

```bash
pnpm --filter @sp/server sandbox:purge -- --dry-run          # what would be deleted (all sandboxes; --org <id> for one, --json)
pnpm --filter @sp/server sandbox:purge                       # exit 3 when some images could not be deleted (retried next run), 75 when a run is in progress
```

