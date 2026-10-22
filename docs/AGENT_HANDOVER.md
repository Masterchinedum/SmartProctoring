# Agent handover — SmartProctoring after the October 2026 roadmap

For the next agent picking this up. Read this first, then `docs/ROADMAP.md` (what shipped, what was deferred and why,
decisions to review, open questions), `docs/HANDOVER.md` (product handover: what was built, §4 before launch) and
`docs/ARCHITECTURE.md` (how it works). Branch: `claude/sweet-hamilton-46bh7e`. PR: Masterchinedum/SmartProctoring#1
(draft; base `claude/loving-hamilton-sszj2x`, not `main`). Do not develop on any other branch unless the owner says so.

## 1. Where things stand

**The roadmap is complete: items 1–21 are shipped and pushed**, one commit per item (`docs/ROADMAP.md` §1 maps each
item to its commit and documentation). One CI signal is open: the WebKit job (§5). Nothing else is in progress. There is no next task until the owner picks one. The likely
candidates are the open questions in `docs/ROADMAP.md` §4, the deferred parts in §2, and HANDOVER §4 item 11 (security
keys, SCIM Groups, single logout, localisation).

Verification at the end of the roadmap (head `fbf2e28`, the last code change):

* `pnpm run typecheck` (shared, detection, server, web) and `pnpm --filter @sp/e2e typecheck`: clean.
* `pnpm test`: 1,509 — shared 64, detection 169, server 881, web 395 — with the face images present
  (`SP_REQUIRE_TEST_IMAGES=1`, nothing skipped).
* Browser suite, Chromium, everything (`playwright test`, 84 tests incl. the 32 realistic-webcam scenarios), run locally
  on the integrated roadmap (`b00c7c0`, before the cross-browser follow-ups): 82 passed; the 2 failures are the realistic
  liveness case `rwTurnA2_other` (`docs/ROADMAP.md` §4 item 6), which fails the same way at the PR's base `d4be596`.
* CI on the head: `test`, `docker` (image boot, in-process and remote vision worker), `e2e` (core 01–19, Chromium) and
  `e2e-browsers (firefox)` — see §5 for WebKit.

## 2. Map of the roadmap's code (for orientation)

| # | Area | Main code | Migration | e2e |
|---|---|---|---|---|
| 7 | Exam versions | `services/exam-versions.ts`, `services/regrade.ts` | 0007 | 11-staff |
| 8 | Accommodations | `services/accommodations.ts`, candidate `check/AttestStep.tsx` | 0008 | 19 |
| 9 | Staff two-step sign-in | `lib/totp.ts`, `services/mfa.ts`, `services/staff-recovery.ts` | 0009 | 11b (PORT + 3) |
| 10 | Reviewer workflow | `services/review.ts`, `packages/shared/src/{review,incidents,explain}.ts` | 0010 | 11c |
| 11 | Model governance | `services/decision-configs.ts`, `services/calibration.ts` | 0011 | 11d (PORT + 4) |
| 12 | Privacy operations | `services/privacy-{requests,export,ops}.ts`, `services/job-status.ts`, candidate `components/common.tsx` | 0012 | 11e (PORT + 5) |
| 13 | Scheduling and recovery | `services/scheduling.ts`, `services/recovery.ts`, `jobs/sweeper.ts` | 0014 | 19c |
| 14 | Integration API | `packages/shared/src/{integrations,openapi}.ts`, `routes/v1/index.ts`, `auth/api-key.ts`, `services/idempotency.ts` | 0015 (custom SQL tail) | 18b |
| 15 | Sandbox and quotas | `services/{tenancy,quotas,sandbox-purge}.ts`, `scripts/org-cli.ts` | 0017 | 19d (PORT + 8) |
| 16 | SSO and SCIM | `services/sso/*`, `routes/sso.ts`, `routes/scim.ts`, `services/scim.ts`, `lib/net-guard.ts` | 0016 | 11f (PORT + 9) |
| 17 | Data residency | `lib/storage.ts`, `services/evidence-storage.ts`, `services/storage-move.ts` | 0013 | 19b (PORT + 10) |
| 18 | Vision worker | `src/vision-worker/`, `vision/remote.ts`, `vision/wire.ts` | — | `E2E_VISION=remote` option |
| 19 | Resilience | `test/chaos.test.ts`, `test/migration-upgrades.test.ts`, `test/schema-drift.test.ts`, `test/alert-rules.test.ts` | — | 19e (PORT + 12) |
| 20 | Cross-browser | `e2e/lib/camera.ts`, `e2e/lib/browsers.ts`, `apps/web/src/candidate/fullscreen.ts` | — | `@cross-browser` tag |

Migrations are numbered in the order the items landed, not by item number (13 → 0014, 17 → 0013, 16 → 0016,
15 → 0017).

## 3. How to work in this repo

* Node 24 only. A fresh cloud container has Node 22: download the Node 24 tarball from nodejs.org into the scratchpad
  (check its SHA-256 against `SHASUMS256.txt`), put its `bin` first on PATH and `corepack enable` (pnpm comes from
  `packageManager`); keep the exports in `<scratchpad>/env24.sh` with `PGHOST=127.0.0.1 PGUSER=postgres`,
  `SP_TEST_FACES_DIR` / `SP_TEST_FACESETS_DIR` / `E2E_FACES_DIR` and `SP_REQUIRE_TEST_IMAGES=1`. Start services if down:
  `service postgresql start; service redis-server start`; the tests need trust auth on 127.0.0.1 (as in CI: set
  `trust` in `/etc/postgresql/16/main/pg_hba.conf` and reload), and the databases `proctor` / `proctor_test`. Face
  images: `pnpm --filter @sp/e2e fetch-faces` and `pnpm --filter @sp/server eval:fetch-faces -- --dir <dir>`.
* Unit: `pnpm test` (all packages). Single file: `cd apps/server && pnpm exec vitest run test/governance.test.ts`.
* DB migrations: `cd apps/server && pnpm exec drizzle-kit generate --name <name>`. To regenerate a migration you just
  wrote: delete the `.sql`, its `meta/<n>_snapshot.json` and its journal entry, then generate again (custom SQL — the
  tail under `-- custom SQL (re-append after regenerating)` — must be re-appended by hand). Every new migration needs a
  case in `test/migrations.test.ts`; `test/migration-upgrades.test.ts` and `test/schema-drift.test.ts` pick it up by
  themselves (a schema.ts edit without a migration fails the drift test).
* Browser suite: build first `pnpm --filter @sp/web run build`, then
  `E2E_FACES_DIR=$S/faces E2E_NO_SKIP=1 E2E_SKIP_REALISTIC=1 E2E_SKIP_BUILD=1 pnpm --filter @sp/e2e exec playwright test 'tests/[01]' --reporter=line`
  (~20 min with 2 workers). Single scenario: `… playwright test tests/11d`. **CI's core job only runs `tests/[01]*`**:
  name a new spec so it starts with `0` or `1` (e.g. `19f-…`), or it runs only nightly. Dedicated-instance specs
  (e2e README table) start their own server from source at test time: do not change imported server source while they
  run. Firefox / WebKit: `pnpm --filter @sp/e2e exec playwright install firefox webkit` on a developer machine, then
  `E2E_BROWSERS=webkit pnpm --filter @sp/e2e exec playwright test --project=webkit` (only `@cross-browser` scenarios;
  the cloud container has only Chromium — never run `playwright install` there). `E2E_CAMERA=shim` runs Chromium with
  the same camera shim.
* Several checkouts at once (parallel agents): give each its own `E2E_PORT` (dedicated instances use up to `PORT + 40`)
  and `E2E_DATABASE_URL`, never kill processes you did not start, and never use broad `pkill -f` patterns.
* Patterns to follow: mutations through `withSession` / `m.addEvent`; audit every staff action with `audit(tx, …)`;
  encrypt personal free text with `keyring.encryptString(text, aad)` and add the column to `rekey`'s `COLUMN_TARGETS`
  (a coverage test fails otherwise); organisation-scoped queries always filter by `orgId`; API errors via
  `lib/errors.ts` (`conflict`, `forbidden` with a specific code — the staff app shows the message for specific 403
  codes, not for `forbidden`); a new `sp_*` metric needs a row in OPERATIONS §5 (`alert-rules.test.ts`); an
  integration API change updates `packages/shared/src/integrations.ts`, `docs/INTEGRATION_API.md` (changelog) and the
  committed `docs/openapi.json` (a test keeps it current).
* Never put model identifiers in commits, PR text or code. Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  and `Claude-Session: <the session link your environment gives you>` (earlier sessions: session_01EXCTMLZ92wByrEjQWUCpEF,
  session_017yjpdaeHzuYAYFpJxt51TL). PR bodies end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
* Never skip, disable or quarantine a failing test. Never push to another branch. Push with `git push -u origin <branch>`.

## 4. Known gotchas

* E2E dedicated servers run from source; editing imported server or shared source mid-run changes the running tests.
* Staff cookies expire; re-mint in `beforeEach` for long suites. Login is rate-limited (10/min/IP).
* Event ordering with equal timestamps is nondeterministic: use the `seq` bigserial (`event_reviews`) or content-based
  assertions.
* A 403 `forbidden` shows a generic message in the staff app by design; specific codes show their message.
* Candidate-app `User-Agent` must match the one captured at check-in, or the server treats it as a second device.
* A drizzle `sql` expression with bound values used in both SELECT and GROUP BY renders as two different parameter
  sets, and Postgres rejects the query: group / order by position (`sql\`1\``).
* `pluralize(n, 'day')` in the staff app already includes the number ("3 days").
* After-commit work (a passed check's frame purge, a decided burst's extra frames) runs after the response: a test
  that counts evidence right after a check-in must wait for it (`vi.waitFor(…, { timeout: 15_000, interval: 50 })`;
  vitest's default `waitFor` timeout of 1 s is too short under load). `chaos.test.ts` `checkInPurged` is the pattern.
* On a 4-vCPU container the full core e2e run (2 workers, dedicated servers starting their own vision workers) can
  starve a candidate browser's in-page monitoring, and timing tests (detection eval, vision latency bounds) can miss
  their limits while other suites run: re-run a single spec / file alone before suspecting the change.
* The container can restart while idle: Postgres and Redis then come back down (`service postgresql start; service
  redis-server start`; the trust config and databases survive on disk).
* `df` inside the container shows the session's disk allowance; agent worktrees (~2.7 GB each with `node_modules` and
  e2e fixtures) fill it fast. Remove a worktree once its commit is integrated.

## 5. Loose ends (as of 2026-10-22)

1. **CI**: `test`, `docker`, `e2e` (Chromium) and `e2e-browsers (firefox)` are green; WebKit is not fully green:
   `e2e-webkit-macos` 9/10 (`d8adb14`), `e2e-browsers (webkit)` on Linux 6/10. Check CI on the head first; a red
   Chromium / Firefox / unit / docker job comes before anything else.
2. **WebKit job (red)**: Playwright's WebKit on Linux delivers the camera shim's canvas to the app's `<video>` only
   intermittently. History, all visible in the job logs' diagnostics (candidate logs end with the WebGL renderer; a
   readiness failure names each checklist item, the analysis video's state and whether video / canvas are changing):
   no WebGL headless → headed under Xvfb; MediaPipe "GLctx" → the app's OffscreenCanvas fix (`61c8eb7`); analysis video
   paused off-viewport → in the viewport (`e2afb6c`); video frozen on its first frame while the canvas changed →
   timer-driven `captureStream(fps)` from an opaque 64×48 px canvas (WebKit only, `e2e/lib/camera.ts`). Now the
   readiness check passes everywhere and 6 of 10 scenarios pass on Linux (slow / uneven frames). The new
   `e2e-webkit-macos` job (headed, Postgres from Homebrew) needed the shim to supply `navigator.mediaDevices` and to sit
   on `MediaDevices.prototype` (macOS WebKit hands the page another MediaDevices object, whose native getUserMedia
   waits for a permission prompt); it then passed 9 of 10 — the failure was the staff browser's page crashing on a
   reload in 04. Owner's call (`docs/ROADMAP.md` §4 item 7): make the macOS job the WebKit check and drop or demote the
   Linux entry. Do not skip or quarantine the WebKit scenarios to get green.
   Firefox needed: headed under Xvfb, one worker, `E2E_DELEGATE=gpu` (CPU delegate WASM starved the main thread; in-process
   WebGL broke MediaPipe — keep `webgl.out-of-process` at its default).
3. **Flakes fixed in tests only — watch whether they come back:**
   * `14-accessibility` "small screens…" (`26f0d54`): the enabled "Agree and continue" button once measured 2.93:1 (the
     disabled opacity). The spec waits for `opacity: 1`. Root cause not confirmed (`candidate/screens/Welcome.tsx`,
     `canContinue`).
   * `05-resume-identity` "room goes dark…" (`015f0b9`): two prompts can show the same darkness guidance; the spec takes
     the first match. Product question in `docs/ROADMAP.md` §4 item 1.
4. **Owner decisions pending**: `docs/ROADMAP.md` §3 (decisions made on the owner's behalf) and §4 (open questions).
   Do not change those behaviours without the owner's answer.
5. **Agent branches**: local `worktree-agent-*` branches hold the agents' pre-integration commits (their content landed
   by cherry-pick under other hashes). They are local only and can be deleted.

### Definition of done for a new task

Code with organisation scoping and audit entries; a migration plus its case in `test/migrations.test.ts` when the
schema changes (and `rekey` coverage for any new encrypted column); server tests; web unit tests for new helpers; an e2e
scenario for user-visible flows (a dedicated instance — next free offset `PORT + 6`, `+ 7`, `+ 11`, `+ 13` onwards —
when it changes organisation-wide settings; a name starting with `0` or `1` so CI runs it); docs (`ARCHITECTURE.md`,
`OPERATIONS.md` runbook, `SECURITY.md` / `PRIVACY.md` where relevant, `INTEGRATION_API.md` for any API change, a row in
`HANDOVER.md` §3c, the e2e README, `docs/ROADMAP.md`); then `pnpm run typecheck`, `pnpm test`, the core e2e suite, one
commit per task, push, and CI green before starting the next task.
