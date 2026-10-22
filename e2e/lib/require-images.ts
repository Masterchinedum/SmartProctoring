import { test } from '@playwright/test';
import { NO_SKIP } from './config';

/** Skip the current test because its images are missing — or, with E2E_NO_SKIP=1 (CI), fail it. */
export function requireImages(missing: readonly string[], what: string): void {
  if (!missing.length) return;
  const why = `${what} ${missing.join(', ')} not found`;
  if (NO_SKIP) throw new Error(`${why} (E2E_NO_SKIP=1: a missing scenario is a failure, not a skip)`);
  test.skip(true, why);
}
