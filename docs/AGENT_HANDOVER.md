# Agent handover — resume the SmartProctoring roadmap

For the next agent picking this up. Read this first, then `docs/HANDOVER.md` (product handover, what was built) and
`docs/ARCHITECTURE.md` (how it works). Branch: `claude/sweet-hamilton-46bh7e`. PR: Masterchinedum/SmartProctoring#1
(draft; subscribe and keep it green). Do not develop on any other branch.

## 1. Where things stand

| # | Area | State |
|---|---|---|
| 1–10 | Node 24, busy-server handling, health checks, metrics, load-aware sampling, CI, exam versions, accommodations, staff MFA, reviewer workflow | **Done and pushed** (last pushed commit `7db31c2`) |
| 11 | Model governance (versioned identity decision configs, four-eyes approval, rollback, calibration by condition, drift, version stamps) | **Implemented, verified, not yet committed** (see §2) |
| 12 | Privacy operations (DSAR register, consent withdrawal, personal-data export, retention preview, job health) | **Started**: shared types drafted (`packages/shared/src/privacy-ops.ts`, not exported yet); ZIP writer done (`apps/server/src/lib/zip.ts`, tested). Nothing wired. |
| 13–21 | See §4 | Not started |

Verification at the time of writing (all green on the working tree that includes #11):

* `pnpm run typecheck` — shared, detection, server, web: pass. `pnpm --filter @sp/e2e typecheck`: pass.
* `pnpm test` — shared 43, detection 169, server 659 (+20 skipped: two suites need real face-model files), web 354.
* Core browser suite `E2E_FACES_DIR=… E2E_NO_SKIP=1 E2E_SKIP_REALISTIC=1 pnpm --filter @sp/e2e exec playwright test 'tests/[01]'` — **39/39 passed** (includes new `11d-model-governance`).

## 2. Uncommitted work (commit it first)

Everything in `git status` is the #11 change set plus two drafts. Suggested commit split (or one commit with the
message "Model governance: versioned identity decision configurations, calibration and drift"):

* **#11 governance** — `packages/shared/src/governance.ts` (+ test), `packages/shared/src/index.ts`,
  `packages/shared/src/api.ts` (`decisionConfigVersion`, `IdentityDecisionVersionsDTO`, `identity.versions`,
  `engineVersion` on the batch schema), `apps/server/src/services/decision-configs.ts`,
  `services/calibration.ts`, `routes/admin/governance.ts` (registered in `routes/admin/index.ts`), schema + migration
  `drizzle/0011_model_governance.sql` (+ snapshot, journal), stamping in `services/checks.ts`,
  `services/identity-samples.ts`, `services/session-state.ts`, `services/org.ts` (`decisionStamp`), `vision/embeddings.ts`
  (`EMBEDDING_MODEL_VERSION`), `services/ingest.ts` + `routes/candidate/index.ts` (`engine_version`), `services/dto.ts`,
  `services/reports.ts`, `routes/v1/index.ts` (versions hidden from integrations), `routes/admin/org.ts` (thresholds
  read-only: 409 `decision_config_required`), web: `lib/governance.ts` (+ test), `pages/QualityGovernance.tsx`,
  `pages/QualityPage.tsx`, `pages/SettingsPage.tsx` (read-only thresholds, review targets kept),
  `pages/ReportPage.tsx`, `pages/session/IdentityTab.tsx`, `api/client.ts`, `api/queries.ts`, `lib/auth-errors.test.ts`
  (`errorMessage` shows specific 403 reasons), `lib/misc.test.ts`; candidate `api.ts` sends the detector version;
  detection: `packages/detection/src/version.ts` (+ fingerprint test `version.test.ts`, pinned hash `c69cef7069b2d2ef`);
  tests: `apps/server/test/governance.test.ts`, `test/admin/org.test.ts`, `test/migrations.test.ts` (0011),
  `test/integrations/api.test.ts`; e2e `e2e/tests/11d-model-governance.spec.ts` (+ `e2e/README.md` rows);
  docs `ARCHITECTURE.md` §9, `OPERATIONS.md` (runbooks), `SECURITY.md` (model governance), `HANDOVER.md` (row).
* **Drafts, safe to commit** (complete and tested, or unexported): `apps/server/src/lib/zip.ts` + `zip.test.ts`
  (streaming ZIP writer, no dependency, cross-checked with Python `zipfile` and `unzip -t`);
  `packages/shared/src/privacy-ops.ts` (types only, not in the shared index yet).

Before committing: `git diff --stat` should show the files above and nothing else. Run `pnpm run typecheck`.

## 3. Work in progress: #12 privacy operations

Draft contents of `privacy-ops.ts`: request kinds (`access`, `erasure`, `rectification`, `restriction`, `objection`,
`consent_withdrawal`, `other`), statuses (`open`, `in_progress`, `completed`, `rejected`), channels, zod schemas
(`createPrivacyRequestSchema`, `updatePrivacyRequestSchema` — completing or rejecting needs a resolution note; extension
≤ 60 days with a reason), `PrivacyRequestDTO` / `PrivacyRequestsDTO`, `withdrawConsentSchema`,
`RetentionPreviewDTO`, `RetentionJobStatusDTO` (stale after 3 h; the job runs hourly).

Plan, in order:

1. Schema: `privacy_requests` table (org, kind, status, subject text, candidate id nullable, channel, received/due
   timestamps, extension days + reason, details **encrypted** with `keyring.encryptString` and AAD per row, assignee,
   created/closed by, resolution note, exported/erased timestamps, session id, source staff|candidate). Index
   `(org_id, status, due_at)`. Migration `0012_privacy_operations`; add a migration test like `0011` in
   `test/migrations.test.ts`. Add the table to `rekey` (`services/rekey.ts`) since it holds encrypted fields.
2. Services: `services/privacy-requests.ts` (create/list/update, due date = received + 30 days, overdue flag, audit
   every change). Export of a candidate: a ZIP via `lib/zip.ts` containing `candidate.json`, per session
   `session.json` (the report from `buildSessionReport`), `answers.json`, `events.json`, `identity-checks.json`,
   and evidence images decrypted through `readEvidence` (skip purged ones and say so in `README.txt`). Audit
   the export. Erasure reuses `DELETE /candidates/:id` logic (`routes/admin/candidates.ts`), including the legal-hold
   and open-session refusals, and records `erasedAt` on the request.
3. Candidate consent withdrawal: `POST /api/candidate/consent/withdraw` (`withdrawConsentSchema`). The session ends
   with a dedicated end reason (add `candidate_withdrew` to `END_REASONS` in `packages/shared/src/session.ts`; find
   every switch on end reasons with `grep -rn "staff_terminated" apps packages`). Purge the session's evidence and
   templates (`purgeSessionEvidence`, reason `consent_withdrawn`), keep the event timeline and the answers, and create
   a `consent_withdrawal` request automatically. Add a candidate-app entry point only once the copy is reviewed
   (`apps/web/src/candidate`); the server path comes first.
4. Retention preview: `GET /api/admin/retention/preview` — counts per day of evidence due (reuse the SQL in
   `services/retention.ts`: `evidenceDaysSql`, `eventDaysSql`) without deleting; legal holds listed; overdue = due and
   not purged. Job health: persist the last run summary (new table or `organizations`-independent row) in
   `runRetention` so `RetentionJobStatusDTO` can be served; expose it on `GET /api/admin/ops/checks` together with
   the other operational checks (`services/capacity.ts`, `instance-usage.ts`).
5. Web: `apps/web/src/admin/pages/PrivacyPage.tsx` (register table, due dates, overdue highlighted, detail drawer
   with export/erase actions behind confirmation, retention preview, job status). Add to `AdminApp.tsx` routes and
   `components/Shell.tsx` NAV (owner/admin only). Accessibility: run `expectNoA11yIssues` in the e2e.
6. e2e `e2e/tests/11e-privacy-operations.spec.ts` on a dedicated instance (`PORT + 5`, database
   `siblingDatabaseUrl(DATABASE_URL, 'privacy')`, add to the `e2e/README.md` dedicated-server table): create an access
   request → export downloads a valid ZIP (unzip it in the test, check `candidate.json`); erasure of a candidate with
   a legal hold is refused; consent withdrawal ends the session and deletes its images.
7. Docs: `PRIVACY.md` §2 data inventory rows for requests and exports, §4 for withdrawal, §5 for the DSAR process;
   `OPERATIONS.md` runbook "A data-subject request arrives"; `SECURITY.md` for the register's access rules.

## 4. Remaining roadmap (from the original plan, in order)

* **#13 Candidate recovery, scheduling windows, resume policy** — reschedule an invited session into a window
  (`exam_sessions` gets `windowStartsAt`/`windowEndsAt`; start refused outside it with a candidate message), a resume
  policy per exam (max reconnects / max time since last heartbeat before the session is ended), staff "reopen for
  recovery" action. Reuse `candidate-actions.ts` and `session-limits.ts`.
* **#14 Integration API maturity** — per-key scopes (read-only vs write), key expiry, idempotency keys on `POST`,
  webhook signature verification helper documented, OpenAPI document generated from `packages/shared/src/integrations.ts`
  zod schemas, contract tests. `docs/INTEGRATION_API.md` is the public contract: update it with every change.
* **#15 Sandbox organisations and per-tenant quotas** — `organizations.kind` (`sandbox` | `production`), quotas for
  exams, candidates, sessions per month, enforced in `services/session-limits.ts`; sandbox data auto-purged.
* **#16 SSO (OIDC + SAML) and SCIM** — per-org identity provider config; SAML needs an XML library (check the licence
  first; `docs/HANDOVER.md` lists licensing decisions). Keep local password login as break-glass for owners.
* **#17 Data residency** — per-org evidence storage backend/region (`services/evidence.ts` uses `ctx.storage`);
  migration path for existing blobs; documented in `docs/OPERATIONS.md` §2.
* **#18 Dedicated vision worker** — move `vision/` analysis behind a small HTTP/queue worker; keep the in-process
  driver for dev; `docs/PERFORMANCE.md` §6 has the capacity numbers to beat.
* **#19 Chaos tests, migration tests, extra metrics** — kill the DB connection mid-batch, restart during an identity
  check, migrations from every previous tag (`test/migrations.test.ts` pattern), more Prometheus series
  (`services/metrics.ts`) and matching alerts in `docs/prometheus-alerts.yml`.
* **#20 Cross-browser e2e** — Firefox and WebKit projects in `e2e/playwright.config.ts` with an injected fake camera
  (Playwright's `--use-fake-device-for-media-stream` is Chromium-only; Firefox needs a `media.navigator.streams.fake`
  pref; WebKit needs a canvas-backed `getUserMedia` shim in `e2e/lib/candidate.ts`). Only the core scenarios.
* **#21 Final** — `docs/ROADMAP.md` (what shipped, what is deferred and why), full verification (all tests, both
  e2e tiers, docker build), PR #1 description updated with the mirror of `.github/pull_request_template.md` if present.

## 5. How to work in this repo

* Node 24 only. In the sandbox: `source <scratchpad>/env24.sh` (sets PATH; the scratchpad path changes per session).
  Start services if down: `service postgresql start; service redis-server start`.
* Unit: `pnpm test` (all packages). Single file: `cd apps/server && pnpm exec vitest run test/governance.test.ts`.
* DB migrations: `cd apps/server && pnpm exec drizzle-kit generate --name <name>`. To regenerate a migration you just
  wrote: delete the `.sql`, its `meta/<n>_snapshot.json` and its journal entry, then generate again (custom SQL must be
  re-appended by hand). Every new migration needs a case in `test/migrations.test.ts`.
* Browser suite: build first `pnpm --filter @sp/web run build`, then
  `E2E_FACES_DIR=$S/faces E2E_NO_SKIP=1 E2E_SKIP_REALISTIC=1 E2E_SKIP_BUILD=1 pnpm --filter @sp/e2e exec playwright test 'tests/[01]' --reporter=line`
  (~15 min). Single scenario: `… playwright test tests/11d`. Dedicated-instance specs (11b, 11d, 17, 18) start their own
  server from source at test time: do not change imported server source while they run.
* Patterns to follow: mutations through `withSession` / `m.addEvent`; audit every staff action with `audit(tx, …)`;
  encrypt personal free text with `keyring.encryptString(text, aad)`; organisation-scoped queries always filter by
  `orgId`; API errors via `lib/errors.ts` (`conflict`, `forbidden` with a specific code — the staff app shows the
  message for specific 403 codes, not for `forbidden`).
* Never put model identifiers in commits, PR text or code. Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  and `Claude-Session: https://claude.ai/code/session_01EXCTMLZ92wByrEjQWUCpEF`. PR bodies end with
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
* Never skip, disable or quarantine a failing test. Never push to another branch. Push with `git push -u origin <branch>`.

## 6. Known gotchas hit so far

* E2E dedicated servers run from source; editing imported server or shared source mid-run changes the running tests.
* Staff cookies expire; re-mint in `beforeEach` for long suites. Login is rate-limited (10/min/IP).
* Event ordering with equal timestamps is nondeterministic: use the `seq` bigserial (`event_reviews`) or content-based
  assertions.
* A 403 `forbidden` now shows a generic message in the staff app by design; specific codes show their message.
* Candidate-app `User-Agent` must match the one captured at check-in, or the server treats it as a second device.
