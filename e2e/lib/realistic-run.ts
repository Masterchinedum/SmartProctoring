import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import type { ProctoringPolicyInput } from '../../packages/shared/src/policy';
import { CandidatePage, launchCameraFile, type CheckOutcome } from './candidate';
import { ARTIFACTS_DIR } from './config';
import { rwFixtureAvailable, rwFixturePath, type RwFixtureName } from './realistic';
import { QUESTIONS, type SessionHandle, type StaffApi } from './staff-api';

/**
 * Helpers for the realistic-webcam scenarios (tests/20-25): camera, policy, check attempts, metrics.
 *
 * Repetitions: every measured case runs `E2E_RW_REPEAT` times (default 1 in the regular suite; the measurement
 * run for docs/accuracy/end-to-end.md uses more). Metrics go to e2e/.artifacts/realistic-metrics.jsonl (one JSON
 * line per run, tagged with the suite run id); `pnpm --filter @sp/e2e rw:report` turns them into tables.
 */

export const RW_REPEAT = Math.max(1, Number(process.env.E2E_RW_REPEAT || 1));
export const METRICS_FILE = join(ARTIFACTS_DIR, 'realistic-metrics.jsonl');

export function reps(): number[] {
  return Array.from({ length: RW_REPEAT }, (_, i) => i + 1);
}

export function skipUnlessRw(...names: RwFixtureName[]): void {
  const missing = names.filter((n) => !rwFixtureAvailable(n));
  test.skip(missing.length > 0, `identity-set images for realistic fixture(s) ${missing.join(', ')} not found (set E2E_FACESETS_DIR)`);
}

export function launchRw(name: RwFixtureName): Promise<Browser> {
  return launchCameraFile(rwFixturePath(name));
}

/**
 * The PRODUCT DEFAULT policy (identity: 15 s periodic samples, 6 s start-up interval for 180 s, bursts of 3,
 * hold for review on a confirmed mismatch, 5 attempts) — only liveness is chosen per scenario, and fullscreen is
 * off (headless Chromium). The older specs' BASE_POLICY (30 s samples) is deliberately not used.
 */
export function rwPolicy(o: { liveness: 'active' | 'off'; identity?: Record<string, unknown> }): ProctoringPolicyInput {
  return { identity: { liveness: o.liveness, idPhotoComparison: 'off', ...(o.identity ?? {}) }, browser: { requireFullscreen: false } } as ProctoringPolicyInput;
}

export async function createRwSession(staff: StaffApi, policy: ProctoringPolicyInput, title: string): Promise<SessionHandle> {
  const exam = await staff.createExam({ policy, title: `${title} ${Date.now().toString(36)}`, questions: QUESTIONS, durationSec: 3600 });
  const cand = await staff.createCandidate();
  return staff.assign(exam, cand);
}

export interface MetricRecord {
  scenario: string;
  case: string;
  rep: number;
  pass: boolean;
  [k: string]: unknown;
}

let commit: string | null | undefined;
function gitCommit(): string | null {
  if (commit === undefined) {
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() + (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() ? '+dirty' : '');
    } catch {
      commit = null;
    }
  }
  return commit;
}

/**
 * Append one measurement (JSON line) for the report, with the machine's load (1 / 5 min load average, CPUs) —
 * timings (time to pass, detection delay, liveness within the challenge window) depend on it.
 */
export function recordMetric(info: TestInfo, rec: MetricRecord): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const [load1, load5] = loadavg();
  const line = {
    runId: process.env.E2E_RUN_ID ?? null,
    at: new Date().toISOString(),
    test: info.title,
    workers: info.config.workers,
    load1: Math.round(load1! * 10) / 10,
    load5: Math.round(load5! * 10) / 10,
    cpus: cpus().length,
    commit: gitCommit(),
    ...rec,
  };
  appendFileSync(METRICS_FILE, `${JSON.stringify(line)}\n`);
  console.log(`[metric] ${JSON.stringify(line)}`);
}

export interface CheckAttempts {
  final: CheckOutcome | 'timeout';
  attempts: number;
  outcomes: CheckOutcome[];
  /** ms from the start of each attempt to its outcome screen. */
  attemptMs: number[];
  /** ms from `t0` to the final outcome. */
  totalMs: number;
  /** In-place liveness re-prompts ("a little further") seen. */
  reprompts: number;
  /** Retry-screen guidance per failed attempt. */
  guidance: string[][];
}

const OUTCOME_IDS: Record<CheckOutcome, string> = {
  ready: 'ready-screen',
  passed: 'check-passed',
  retry: 'check-retry',
  hold: 'hold-screen',
  problem: 'verify-problem',
  failed: 'check-failed',
};

async function currentOutcome(c: CandidatePage): Promise<CheckOutcome | null> {
  for (const [k, id] of Object.entries(OUTCOME_IDS)) if (await c.tid(id).isVisible().catch(() => false)) return k as CheckOutcome;
  return null;
}

/**
 * The check as a candidate goes through it: (intro →) readiness → identity frames → outcome; on "try again"
 * the candidate tries again (like a real person would) up to `maxAttempts` attempts. Counts attempts, time per
 * attempt, and in-place liveness re-prompts. `t0` = when the candidate started (e.g. clicked Resume).
 */
export async function checkWithRetries(c: CandidatePage, o: { purpose?: 'resume' | 'reconnect' | 'reverify'; maxAttempts: number; t0?: number; attemptTimeoutMs?: number }): Promise<CheckAttempts> {
  const t0 = o.t0 ?? Date.now();
  if (o.purpose) {
    await expect(c.tid('check-intro')).toHaveAttribute('data-purpose', o.purpose, { timeout: 30_000 });
    await c.tid('check-intro-continue').click();
  }
  await c.passReadiness();
  const res: CheckAttempts = { final: 'timeout', attempts: 0, outcomes: [], attemptMs: [], totalMs: 0, reprompts: 0, guidance: [] };
  for (;;) {
    res.attempts++;
    const ta = Date.now();
    let outcome: CheckOutcome | null = null;
    let repromptVisible = false;
    while (Date.now() - ta < (o.attemptTimeoutMs ?? 150_000)) {
      outcome = await currentOutcome(c);
      if (outcome) break;
      const rp = await c.tid('verify-reprompt').isVisible().catch(() => false);
      if (rp && !repromptVisible) res.reprompts++;
      repromptVisible = rp;
      await c.traceVerify();
      await c.page.waitForTimeout(250);
    }
    res.attemptMs.push(Date.now() - ta);
    if (!outcome) {
      res.final = 'timeout';
      break;
    }
    res.outcomes.push(outcome);
    res.final = outcome;
    if (outcome !== 'retry') break;
    res.guidance.push(
      (await c.tid('check-retry-guidance').innerText().catch(() => ''))
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
    );
    if (res.attempts >= o.maxAttempts || !(await c.tid('check-try-again').isVisible().catch(() => false))) break;
    await c.tid('check-try-again').click();
    await expect(c.tid('check-retry')).toHaveCount(0);
  }
  res.totalMs = Date.now() - t0;
  return res;
}

/** Wait until the fixture (camera opened at `camAt`) reaches `sec` seconds. */
export async function waitForCameraTime(c: CandidatePage, camAt: number, sec: number): Promise<void> {
  const ms = camAt + sec * 1000 - Date.now();
  if (ms > 0) await c.page.waitForTimeout(ms);
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export const secs = (ms: number | null | undefined): number | null => (ms == null ? null : Math.round(ms / 100) / 10);
