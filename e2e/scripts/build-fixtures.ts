/**
 * Builds (or refreshes) every fake-camera fixture into e2e/.fixtures without running the tests.
 * Global setup does the same automatically; this is handy after changing E2E_FACES_DIR.
 *   pnpm --filter @sp/e2e fixtures
 */
import { FACES_DIR } from '../lib/config';
import { ensureFixtures } from '../lib/fixtures';

const r = await ensureFixtures((m) => console.log(m));
console.log(`built: ${r.built.join(', ') || '(none — all up to date)'}`);
if (r.skipped.length) console.log(`skipped (face images missing in ${FACES_DIR}): ${r.skipped.join(', ')}`);
