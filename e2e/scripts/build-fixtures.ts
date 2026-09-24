/**
 * Builds (or refreshes) every fake-camera fixture into e2e/.fixtures without running the tests.
 * Global setup does the same automatically; this is handy after changing E2E_FACES_DIR / E2E_FACESETS_DIR.
 *   pnpm --filter @sp/e2e fixtures                       # studio fixtures + realistic webcam fixtures
 *   E2E_RW_ONLY=rwSwapGap,rwA_typical pnpm --filter @sp/e2e fixtures
 */
import { FACES_DIR } from '../lib/config';
import { ensureFixtures } from '../lib/fixtures';
import { ensureRealisticFixtures, FACESETS_DIR, type RwFixtureName } from '../lib/realistic';

const r = await ensureFixtures((m) => console.log(m));
console.log(`built: ${r.built.join(', ') || '(none — all up to date)'}`);
if (r.skipped.length) console.log(`skipped (face images missing in ${FACES_DIR}): ${r.skipped.join(', ')}`);
const only = (process.env.E2E_RW_ONLY ?? '').split(',').filter(Boolean) as RwFixtureName[];
const rw = ensureRealisticFixtures((m) => console.log(m), only);
console.log(`realistic built: ${rw.built.join(', ') || '(none — all up to date)'}`);
if (rw.skipped.length) console.log(`realistic skipped (identity sets missing in ${FACESETS_DIR}): ${rw.skipped.join(', ')}`);
