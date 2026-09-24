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
  routes/admin/index.ts  EMPTY plugin owned by the admin-API agent (registered with prefix /api/admin)
  jobs/runner.ts       JobRunner (ctx.jobs): periodic jobs, each run guarded by a pg advisory lock
  jobs/sweeper.ts      heartbeat timeouts, clock expiry, stale checks (sweepOnce(ctx) for tests)
  scripts/seed.ts      demo data
  vision/**, eval/**   vision agent
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
  `reference:<referenceId>`, `frame:<frameId>`.

## Background jobs
`ctx.jobs.register({ name, intervalMs, runAtStart?, run: (ctx) => Promise })` from any plugin; jobs start on
`onReady` when jobs are enabled (SWEEPER_ENABLED, default on outside tests). app.ts registers `sweeper` (5 s) and
`retention` (hourly, calls services/retention.ts `runRetentionExclusive`) — do not start a second scheduler.

## Candidate-side services (for reference)
checks.ts (start/frames/complete: liveness, reference, ID photo, resume/reconnect/reverify, re-enrolment),
identity-samples.ts (mid-exam aggregation, camera_feed_suspect), ingest.ts (events batch, evidence PUT),
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
* Server-side updates of events never change `version` (that sequence belongs to the reporting client).
* Error codes the web client relies on: 401 invalid_token, 409 superseded, 409 check_required, 409 invalid_state.

## Tests
`pnpm --filter @sp/server test` (vitest, real Postgres at 127.0.0.1:5432, user postgres). `test/global-setup.ts`
migrates a per-run template DB; `createTestEnv()` in `test/helpers.ts` clones it per test file and returns
`{ app, ctx, clock, vision (FakeVisionService), storage, org, users{owner,admin,reviewer}, exam, questions,
candidate, session{id,token,link}, login(role) -> cookie, candidateClient(token?, instanceId?), newSession(), newExam(), close() }`.
Staff password for all seeded test users: `TEST_PASSWORD`. Fake camera frames: `FakeVisionService.encode({ person: 'alice', yawDeg: 20 })`.

## Running
* dev: `pnpm --filter @sp/server seed && pnpm --filter @sp/server dev` (port 8080; web dev server proxies /api)
* build: `pnpm --filter @sp/server build` -> `node apps/server/dist/main.js` (migrations: apps/server/drizzle)
