/**
 * Prints the identity-labelled EVALUATION set as JSON, straight from the single source of truth
 * apps/server/src/eval/datasets.ts (manifest, identity aliases, families, local cache):
 *
 *   apps/server/node_modules/.bin/tsx tools/recognizer/ts/export_faceset.mts > $RECOG_WORK/eval/faceset.json
 *
 * Download the images first with `pnpm --filter @sp/server eval:fetch-faces` (cache: $SP_FACESETS_DIR or
 * /tmp/claude-0/facesets).
 */
import { FACESET_SOURCES, loadFaceset } from '../../../apps/server/src/eval/datasets.ts';

const fs = loadFaceset();
process.stdout.write(
  JSON.stringify(
    {
      dir: fs.dir,
      sources: FACESET_SOURCES,
      missing: fs.missing.map((m) => `${m.source}/${m.path}`),
      images: fs.images.map((i) => ({ file: i.file, identity: i.identity, family: i.family ?? null, source: i.source, path: i.path })),
    },
    null,
    1,
  ) + '\n',
);
