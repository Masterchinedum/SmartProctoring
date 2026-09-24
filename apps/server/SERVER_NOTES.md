# Server notes (apps/server)

Fastify 5 + drizzle (Postgres) + FakeVision-testable services. Contract: `packages/shared/src/api.ts`.

## Layout
```
src/
  config.ts            env -> Config (safe dev defaults; production refuses to start without secrets)
  context.ts           Ctx: { config, database, db, vision, storage, keyring, bus, now(), log, live }
  app.ts               buildApp(opts) -> Fastify instance (deps injectable: database, vision, storage, bus, now)
  main.ts              process entry (listen, graceful shutdown)
  db/schema.ts         drizzle schema (all tables)      db/index.ts  createDatabase(), migrate(), Db/Tx types
  drizzle/ (../)       generated SQL migrations — after editing schema.ts: pnpm --filter @sp/server db:generate
  lib/crypto.ts        AES-256-GCM keyring (encrypt/decrypt with AAD), tokens, sha256, scrypt passwords, isJpeg
  lib/storage.ts       BlobStorage (FsStorage | S3Storage | MemoryStorage)
  lib/audit.ts         audit(db, {...}) -> audit_log row
  lib/errors.ts        HttpError + helpers (badRequest, notFound, conflict, invalidState, forbidden, ...)
  auth/staff.ts        cookie sessions, requireStaff(role), getStaff(req), roleAtLeast
  auth/candidate.ts    Bearer token + X-Client-Instance -> CandidatePrincipal
  realtime/bus.ts      LocalBus / RedisBus (REDIS_URL)          realtime/notifier.ts  LiveNotifier (ctx.live)
  realtime/live-route.ts  WS GET /api/admin/live
  services/dto.ts      row->DTO mappers + batched loaders (EventDTO, SessionSummaryDTO, PeriodDTO, IdentityCheckDTO,
                       PauseRequestDTO, HoldDTO, EvidenceRefDTO, IdentityReferenceDTO, NoteDTO, DeviceRecordDTO)
  services/evidence.ts storeEvidence / readEvidence / readEvidenceForStaff (audited) / purge*
  services/session-state.ts   withSession(ctx, id, m => ...) row-locked mutations, periods, clock, server events,
                              holdNow/pauseNow/finalizeSession/startExam, requiredCheckFor, effectivePolicy
  services/session-actions.ts STAFF ACTIONS: decidePauseRequest, holdSession, releaseHold, terminateSession,
                              staffSubmit, extendSessionTime, setLegalHold, regenerateAccessLink, createExamSession
  services/org.ts      orgSettings(org) (defaults filled), orgThresholds(org), mergePolicy, createOrganization
  services/exams.ts    createExam(db, orgId, ExamInput), loadQuestions
  services/grading.ts  isAnswerCorrect, gradeSession
  services/privacy.ts  noticeFor(org, policy, candidate)
  routes/auth.ts       /api/auth/login|logout|me|password
  routes/public.ts     /api/health, /api/public/privacy-notice
  routes/candidate/*   /api/candidate/*
  routes/admin/*       /api/admin/* staff API (sessions, events, evidence, exams, candidates, org, metrics)
  services/reports*.ts session report, timeline, identity comparison, CSV      services/metrics.ts  detection quality
  services/retention.ts  evidence & event-metadata retention (hourly job + retention-cli)
  jobs/runner.ts       JobRunner (ctx.jobs): periodic jobs, each run guarded by a pg advisory lock
  jobs/sweeper.ts      heartbeat timeouts, clock expiry, stale checks (sweepOnce(ctx) for tests)
  jobs/integrations.ts registers the webhooks (5 s), email-alerts (10 s) and abandoned-sessions (hourly) jobs
  auth/api-key.ts      organisation API keys (Bearer sp_live_…; sha256 only) — requireApiKey / getApiKey
  routes/v1/*          /api/v1/* integration API (docs/INTEGRATION_API.md)
  routes/admin/integrations.ts  /api/admin api-keys, webhooks (+ deliveries), email-alerts/test, integrations/status
  services/integration-events.ts  outbox hook called by withSession() (webhook + email rows in the same tx)
  services/webhooks.ts webhook outbox delivery (claim/lease, HMAC signature, backoff, auto-disable, housekeeping)
  services/email-alerts.ts  alert email queue + per-session 5-min digest; lib/mailer.ts (SMTP / MemoryMailer)
  services/abandonment.ts  closes never-ending sessions after org abandonAfterDays (endReason 'abandoned')
  lib/net-guard.ts     SSRF guard (public-address classification, connect-time DNS check) + guarded POST
  lib/redis.ts         ioredis client for the shared rate-limit store (REDIS_URL)
  lib/text-safety.ts   stripUrls(): no links in user-controlled text sent by webhooks / alert emails
  services/login-throttle.ts  per-account failed-login backoff (login_throttle table, keyed by sha256(address))
  services/instance-usage.ts  concurrent use of the verified instance id (UA / networks / heartbeat seq)
  services/rekey.ts    re-encryption after EVIDENCE_KEY rotation (all encrypted columns + evidence blobs)
  scripts/rekey-cli.ts `rekey [--dry-run]` (docs/OPERATIONS.md §3)
  scripts/seed.ts      demo data
  vision/**, eval/**   vision agent. vision/service.ts = facade (VisionService) over pool.ts: worker threads (worker.ts,
                       bundled as dist/vision-worker.js) each running engine.ts (own onnxruntime sessions)
  lib/load-monitor.ts  logs "server overloaded (...)" when the event loop / DB pool / vision queue saturate
  verifiers/**         optional external second-opinion face verifier (docs/EXTERNAL_VERIFIER.md): types.ts (ExternalVerifier),
                       aws-rekognition.ts (CompareFaces), registry.ts (ctx.verifiers: providers, client cache, breaker),
                       settings.ts (org settings.externalVerifier, encrypted key pair), fusion.ts (fuseWithExternal),
                       index.ts maybeExternalSecondOpinion(ctx, org, kind, images, { consentAcceptedAt }) — the seam
  routes/admin/verifiers.ts  GET /api/admin/verifiers, POST /api/admin/verifiers/test (image vs itself)
```

## Writing staff routes (admin agent)
`src/routes/admin/index.ts` exports `adminRoutes: FastifyPluginAsync`; app.ts does
`app.register(adminRoutes, { prefix: '/api/admin' })`. Split into files under `src/routes/admin/` and
register them from index.ts.

```ts
import { getStaff, requireStaff } from '../../auth/staff.js';
app.get('/sessions/:id', { preHandler: requireStaff('reviewer') }, async (req) => {
  const staff = getStaff(req);             // { id, orgId, role, name, user, ip }
  const ctx = app.ctx;                      // or req.server.ctx
  // ALWAYS scope queries by staff.orgId
});
```
* Errors: `throw notFound(...)`, `throw invalidState(...)` etc. (lib/errors.ts). ZodError -> 400 validation_failed automatically,
  so `schema.parse(req.body)` is enough.
* Time: use `ctx.now()` (tests control it), never Date.now() for domain timestamps.
* Audit: `await audit(ctx.db, { orgId, actorType: 'staff', actorId: staff.id, action: 'x.y', targetType, targetId, meta, ip: req.ip, at: ctx.now() })`.
* Evidence image: `readEvidenceForStaff(ctx, id, { id: staff.id, orgId: staff.orgId, ip: req.ip })` (audits `evidence.view`);
  send `data` with `Content-Type: image/jpeg`, `Cache-Control: private, no-store`.
* Session lifecycle changes MUST go through services/session-actions.ts (they lock the row, record events/periods,
  queue candidate commands and publish realtime). `actor = { id: staff.id, orgId: staff.orgId, ip: req.ip }`.
  They return the fresh SessionSummaryDTO.
* Realtime cost control (docs/PERFORMANCE.md): the notifier builds nothing for orgs without staff subscribers
  (`bus.hasSubscribers`, Redis-wide via PUBSUB NUMSUB), batches loads (50 ms) and coalesces summaries per session
  (<= 1 / 2 s). withSession passes `visible: false` when only heartbeat timestamps changed (dto.ts `staffVisibleKey`
  — extend it when SessionSummaryDTO gains a field derived from exam_sessions); those refresh only every 10 s
  (keepalive; the staff UI calls a summary stale only after 25 s, web admin lib/liveness.ts — keep them in step).
  A change nobody received (org unwatched) arms no per-session throttle.
* Other writes that change what staff dashboards show: call `ctx.live.eventChanged(eventId)` (after review/notes) or
  `ctx.live.sessionChanged(sessionId)`.
* DTO loaders: `loadSessionSummaries(ctx, db, { orgId, where?, limit?, offset?, orderBy? })` (where can reference
  examSessions/exams/candidates columns), `loadSessionEventDTOs(db, sessionId, ...conds)`, `eventRowsToDTOs(db, rows)`,
  `loadIdentityCheckDTOs`, `loadIdentityReferenceDTOs`, `loadPeriodDTOs`, `loadPauseRequestDTOs`, `loadNoteDTOs`,
  `loadDeviceRecordDTOs`, `effectivePolicy(session, exam, org)`.
* Assignments: `createExamSession(ctx, db, { orgId, examId, candidateId })` -> `{ session, accessToken, accessLink }`.
* ID photo: `(ctx.vision as IdPhotoCapableVisionService).processIdPhoto(buf)` then store with
  `storeEvidence(ctx, db, { orgId, candidateId, kind: 'id_photo', capturedAt, data })` and set
  `candidates.idPhotoEmbedding = ctx.keyring.encrypt(serializeEmbeddings([emb]), 'idphoto:' + candidateId)`,
  idPhotoEvidenceId, idPhotoQuality, idPhotoApprovedAt/By. The candidate check decrypts with the same AAD.
* Access link display: `accessLinkFor(ctx, sessionRow)`.
* Encrypted AADs in use: `evidence:<evidenceId>`, `access-token:<sessionId>`, `idphoto:<candidateId>`,
  `reference:<referenceId>`, `frame:<frameId>`, `sample-frame:<frameId>`, `webhook-secret:<webhookId>`, `external-verifier:<orgId>` (base64
  inside organizations.settings.externalVerifier.credentialsEnc; rekey target `external_verifier_credentials`).
  A NEW encrypted column must be
  added to services/rekey.ts `COLUMN_TARGETS` (test/rekey.test.ts fails for an uncovered bytea column).

## Background jobs
`ctx.jobs.register({ name, intervalMs, runAtStart?, run: (ctx) => Promise })` from any plugin; jobs start on
`onReady` when jobs are enabled (SWEEPER_ENABLED, default on outside tests). app.ts registers `sweeper` (5 s) and
`retention` (hourly, calls services/retention.ts `runRetentionExclusive`) — do not start a second scheduler.
jobs/integrations.ts adds `webhooks`, `email-alerts` and `abandoned-sessions`. Tests call the job bodies directly:
`deliverDueWebhooks(ctx)`, `sendDueEmailAlerts(ctx)`, `closeAbandonedSessions(ctx)` (jobs are off in tests, so the
after-commit "kicks" are no-ops).

## Integrations (webhooks, email alerts, API keys)
* Outbox: `withSession()` runs `enqueueIntegrationNotifications(m)` after `m.flush()` inside the session
  transaction (in a savepoint: a failure is logged and never breaks the proctoring change). It maps the events
  touched by the mutation (`m.touchedEventIds`; "created" = `firstReceivedAt == m.now`) to webhook notifications
  and email alerts. So any NEW code path that changes events must go through a SessionMutation (addEvent /
  updateEvent / closeEvent / touchEvent) — then webhooks and emails follow automatically, including sweeper paths.
* Webhook payloads / emails: identifiers, catalog titles/observations, links (`PUBLIC_URL/admin/sessions/:id`);
  never images, event `details`, similarity scores or staff free-text notes. Client-reported events
  (client_browser / client_vision) always use the EVENT_CATALOG title/observation (`outboundEventText`); other
  user-controlled text (pause reason) goes through `stripUrls` — also re-applied when an email is rendered.
* `finalizeSession(m, 'abandoned', …)` = status terminated, no grading, neutral `session_terminated`
  (details.reason 'abandoned_after_inactivity'). Staff DTOs carry `SessionEndReason` (incl. 'abandoned'); the
  candidate state maps it to `endReason: null` (EndReason contract unchanged).
* Tests: `createTestEnv({ mailer: new MemoryMailer() })` enables email alerts; `env.ctx.config.webhooks` can be
  tweaked per test (allowPrivateNetworks is true outside production, so a local http receiver works).

## Candidate-side services (for reference)
checks.ts (start/frames/complete: adaptive progress, liveness, gallery reference, ID photo, resume/reconnect/reverify,
re-enrolment), identity-samples.ts (bursts, evidence accumulator -> identity_mismatch / identity_unverifiable,
camera_feed_suspect), identity-evidence.ts (PURE: per-session normalisation, LLR accumulator, check assessment,
cadence, identitySampleRequest), identity-gallery.ts (PURE: enrolment gallery + baseline, burst aggregation),
identity-selftest.ts (staff camera self-test, in-memory; routes/admin/tools.ts), ingest.ts (events batch, evidence PUT),
candidate-actions.ts (consent, start, answers, heartbeat + command queue, pause, submit),
candidate-state.ts (CandidateSessionState, instanceInControl).

## Behaviour notes (candidate side)
* Questions/answers are served only to the in-control instance (activeInstanceId == verifiedInstanceId == X-Client-Instance)
  of an ACTIVE exam (and after submission for review) — never while paused / on hold.
* Answers/identity samples captured before the current pause/hold started are still accepted (late delivery).
* Client events: rejected before check-in, inside paused/on_hold periods and after the end; spans running into a
  pause are cut at the pause start (`details.endClampedBy`). Network outages (`reporting_interrupted`,
  'disconnected' periods) do NOT block events — the outbox delivers them late (`deliveredLate`).
* multiple_instances: recorded at check start when another live instance is on a different device (UA / camera
  hash); for the same device (likely a reload) only if the old window heartbeats after being superseded.
  Also (details.detectedBy 'concurrent_use'): the verified instance id used from two places — another UA, two
  networks alternating A→B→A→B within 60 s, or interleaved heartbeat `seq` streams (services/instance-usage.ts,
  state in exam_sessions.instance_usage, hashes only). Then verifiedInstanceId is cleared (reconnect check) and a
  require_check command is queued. Candidate routes run it in a preHandler; heartbeat() runs it with `seq`.
* Server-side updates of events never change `version` (that sequence belongs to the reporting client).
* Reconnect (new browser instance): the old instance's still-open client events are closed at the gap start
  (`details.closedBy='instance_replaced'`); late updates reported by a non-active instance are clamped at the
  'disconnected' period (`details.endClampedBy='instance_replaced'`) and never stay open.
* Identity v2 (docs/ARCHITECTURE.md §4): burst frames live in `identity_sample_frames` (embedding encrypted with AAD
  `sample-frame:<id>` only until the burst is decided, then nulled); one `identity_checks` row per decided burst.
  Evidence / cadence state is `exam_sessions.identity_state` (`evidence`, `activeSince`, `sampleRequest`,
  `pendingBursts`); `resetIdentityCounters()` (every start / pause / hold / resume / release) resets it and, when the
  session is active, requests an `exam_start` sample. The sweeper decides bursts whose frames stopped arriving.
  `identity_references.baseline` holds the enrolment baseline (null for pre-v2 references: global calibration only).
* Re-enrolment (`reEnrollAuthorized`) is honoured ONLY by the reverify check of the hold it was given for
  (checks.ts `reEnrollmentApplies`); any new hold, a release without check or passing the check clears it. A
  re-enrolled person who does not match the old reference still gets an `identity_mismatch` (details.reEnrolled).
* Per-session caps (config.sessionLimits / SESSION_MAX_EVIDENCE_ITEMS, SESSION_MAX_EVIDENCE_MB,
  SESSION_MAX_CHECKS_PER_HOUR): 413 `storage_limit` (screenshots may use 80 % of the budget; check frames the
  rest; identity samples are still decided but their images are not stored), 429 `too_many_checks`.
* Error codes the web client relies on: 401 invalid_token, 409 superseded, 409 check_required, 409 invalid_state.

## Staff-side notes
* `SessionSummaryDTO.accessLink` is null everywhere (lists, dashboard, WS, action results) except the admin+
  session detail and the admin+ exam-assignment list (`loadSessionSummaries({ includeAccessLink })`).
* WS `/api/admin/live` re-validates the staff session every 60 s and before delivering broadcasts when the last
  check is > 5 s old; closes with code 4401 after logout / revocation / disable. Session notes are pushed as
  `{ type: 'note' }` messages. It never drops messages silently: over 1,000 held broadcasts or 4 MB queued
  (`LIVE_LIMITS`) it closes with 4408 ('resync') and the admin client reconnects at once. `hello` is sent once the
  subscription is live (`bus.whenSubscribed`, Redis SUBSCRIBE confirmed); the admin client refetches its live views
  on the first `hello` of every socket (first load included) and re-applies messages that arrived meanwhile.
* Reporting outages in the report (services/reporting-gaps.ts): a `reporting_interrupted` span counts as observed
  only if the same browser came back (`closedBy 'heartbeat_resumed'`) or something captured during it arrived late
  (client event, screenshot, identity sample). Otherwise it is unobserved: `finalizeSession` turns the active time
  from the last heartbeat to the end into a 'disconnected' period (reason `browser_not_returned`) and closes the
  gone browser's open episodes at the gap start (`closedBy 'browser_not_returned'`); the report derives the same
  split for ongoing outages / older data.
* Logs never contain candidate tokens: `/take/<token>`, `?token=` and Authorization are redacted (lib/log-redact.ts).

## Performance rules (hot paths; measured in docs/PERFORMANCE.md)
* Never run CPU-heavy work on the main thread: onnxruntime's `run()` is synchronous (it blocked the event loop
  for 47 % of the time at 500 candidates). New image work goes into the vision engine (worker threads).
  `AnalyzeOptions.priority: 'background'` for work nobody waits on (identity samples).
* The heartbeat is ONE guarded UPDATE (candidate-actions.ts `fastHeartbeat`, xmin = row version from candidate
  auth); anything that needs more (commands, outage end, clock start/expiry, concurrent-use signal) falls back to
  the locked path. Keep the two paths equivalent when changing heartbeat semantics (test/perf-paths.test.ts).
* Candidate routes pass the principal (`c`) to services so withSession reuses its exam/org/candidate rows
  (`SessionPreload`) instead of re-reading them. The candidate auth query is a named prepared statement.
* exam_sessions: don't index a column the heartbeat writes (last_heartbeat_at, monitoring, updated_at, ...) —
  heartbeat updates are HOT (no index maintenance) thanks to that and fillfactor 80 (migration 0004).
* Server-generated evidence ids skip the existence check (storeEvidence); with no active webhook and no mailer
  the integration outbox hook skips its savepoint (the lock query tells whether webhooks exist).

## Tests
`pnpm --filter @sp/server test` (vitest, real Postgres at 127.0.0.1:5432, user postgres). `test/global-setup.ts`
migrates a per-run template DB; `createTestEnv()` in `test/helpers.ts` clones it per test file and returns
`{ app, ctx, clock, vision (FakeVisionService), storage, org, users{owner,admin,reviewer}, exam, questions,
candidate, session{id,token,link}, login(role) -> cookie, candidateClient(token?, instanceId?), newSession(), newExam(), close() }`.
Staff password for all seeded test users: `TEST_PASSWORD`. Fake camera frames: `FakeVisionService.encode({ person: 'alice', yawDeg: 20 })`.
Staff sessions expire after 60 min of (test-clock) inactivity: mint a fresh cookie (`staffApi(env, role)`) after
moving the clock further. Login tests: vary `remoteAddress` (10 logins/min/IP) and remember the per-account
backoff after 5 failures.

## Running
* dev: `pnpm --filter @sp/server seed && pnpm --filter @sp/server dev` (port 8080; web dev server proxies /api)
* build: `pnpm --filter @sp/server build` -> `node apps/server/dist/main.js` (migrations: apps/server/drizzle)
