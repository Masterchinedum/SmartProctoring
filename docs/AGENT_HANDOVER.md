# Agent handover — resume the SmartProctoring roadmap

For the next agent picking this up. Read this first, then `docs/HANDOVER.md` (product handover, what was built) and
`docs/ARCHITECTURE.md` (how it works). Branch: `claude/sweet-hamilton-46bh7e`. PR: Masterchinedum/SmartProctoring#1
(draft; subscribe and keep it green). Do not develop on any other branch.

## 1. Where things stand

| # | Area | State |
|---|---|---|
| 1–11 | Node 24, busy-server handling, health checks, metrics, load-aware sampling, CI, exam versions, accommodations, staff MFA, reviewer workflow, model governance | **Done and pushed** |
| 12 | Privacy operations (request register, personal-data export, erasure, consent withdrawal, deletion schedule, operational checks) | **Done and pushed** (see §2) |
| 13–21 | See §3 | Not started — **#13 is next** |

Verification at the time of writing (all green on the pushed branch):

* `pnpm run typecheck` — shared, detection, server, web: pass. `pnpm --filter @sp/e2e typecheck`: pass.
* `pnpm test` — shared 43, detection 169, server 693, web 359 — 1,264 (with the face images fetched, nothing skipped).
* Core browser suite `E2E_FACES_DIR=… E2E_NO_SKIP=1 E2E_SKIP_REALISTIC=1 pnpm --filter @sp/e2e exec playwright test 'tests/[01]'` (CI's `e2e` job) — green in CI on the pushed commit. Locally (4 vCPU, 2 workers) 39/40 in 18 min: `14-accessibility`'s
  keyboard test timed out waiting for "Monitoring active" under load, and passed when re-run alone (3/3, 50 s).

## 2. What #12 added (for orientation)

* Schema + migration `0012_privacy_operations`: `privacy_requests` (details encrypted, AAD `privacy-request:<id>`,
  covered by `rekey`), `job_status` (the retention job's last run). Migration test in `test/migrations.test.ts`.
* Server: `services/privacy-requests.ts` (register, `withdrawConsent`, `eraseCandidate` — now also behind
  `DELETE /candidates/:id` — and `eraseForRequest`), `services/privacy-export.ts` (ZIP via `lib/zip.ts`),
  `services/privacy-ops.ts` (retention preview, operational checks), `services/job-status.ts`, routes in
  `routes/admin/privacy.ts`, candidate route `POST /api/candidate/consent/withdraw`. New end reason
  `candidate_withdrew` (`END_REASONS`; terminated, no score; webhook reason `consent_withdrawn`). Evidence uploads are
  refused for a withdrawn / purged session (`services/ingest.ts`).
* Staff app: `pages/PrivacyPage.tsx` (admin only, nav "Privacy"), helpers `lib/privacy.ts` (+ tests).
* Tests: `apps/server/test/privacy.test.ts`, `test/rekey.test.ts`, `test/migrations.test.ts` (0012); the test ZIP
  reader moved to `apps/server/test/zip-reader.ts` (also used by e2e 11e); e2e `11e-privacy-operations` (dedicated
  instance `PORT + 5`, database `proctor_e2e_privacy`).
* Docs: `PRIVACY.md` §2, §4, §5; `OPERATIONS.md` §6 + runbooks; `SECURITY.md` (privacy operations);
  `ARCHITECTURE.md` §8; `INTEGRATION_API.md` (end reason / webhook reason); `HANDOVER.md` (round 4 row, legal note).

Deliberately left for the owner: the **exam-app button for withdrawing consent** (the server path is done; the
candidate-facing wording should be reviewed first, then linked from the privacy notice and the exam screen —
`apps/web/src/candidate`, with an e2e step clicking it instead of calling the API as 11e does now).

## 3. Remaining roadmap (from the original plan, in order)

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

## 4. How to work in this repo

* Node 24 only. A fresh cloud container has Node 22: download the Node 24 tarball from nodejs.org into the scratchpad
  (check its SHA-256 against `SHASUMS256.txt`), put its `bin` first on PATH and `corepack enable` (pnpm comes from
  `packageManager`); keep the exports in `<scratchpad>/env24.sh` with `PGHOST=127.0.0.1 PGUSER=postgres`,
  `SP_TEST_FACES_DIR` / `SP_TEST_FACESETS_DIR` / `E2E_FACES_DIR` and `SP_REQUIRE_TEST_IMAGES=1`. Start services if down:
  `service postgresql start; service redis-server start`; the tests need trust auth on 127.0.0.1 (as in CI: set
  `trust` in `/etc/postgresql/16/main/pg_hba.conf` and reload), and the databases `proctor` / `proctor_test`. Face
  images: `pnpm --filter @sp/e2e fetch-faces` and `pnpm --filter @sp/server eval:fetch-faces -- --dir <dir>`.
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
  and `Claude-Session: <the session link your environment gives you>` (earlier sessions: session_01EXCTMLZ92wByrEjQWUCpEF,
  session_017yjpdaeHzuYAYFpJxt51TL). PR bodies end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
* Never skip, disable or quarantine a failing test. Never push to another branch. Push with `git push -u origin <branch>`.

## 5. Known gotchas hit so far

* E2E dedicated servers run from source; editing imported server or shared source mid-run changes the running tests.
* Staff cookies expire; re-mint in `beforeEach` for long suites. Login is rate-limited (10/min/IP).
* Event ordering with equal timestamps is nondeterministic: use the `seq` bigserial (`event_reviews`) or content-based
  assertions.
* A 403 `forbidden` now shows a generic message in the staff app by design; specific codes show their message.
* Candidate-app `User-Agent` must match the one captured at check-in, or the server treats it as a second device.
* A drizzle `sql` expression with bound values (e.g. `evidenceDaysSql`) used in both SELECT and GROUP BY renders as two
  different parameter sets, and Postgres rejects the query: group / order by position (`sql\`1\``).
* `pluralize(n, 'day')` in the staff app already includes the number ("3 days").
* On a 4-vCPU container the full core e2e run (2 workers, dedicated servers starting their own vision workers) can starve
  a candidate browser's in-page monitoring: re-run a single spec alone before suspecting the change.
