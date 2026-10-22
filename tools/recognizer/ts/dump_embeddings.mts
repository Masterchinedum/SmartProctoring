/**
 * Runs the PRODUCTION TypeScript vision engine (apps/server/src/vision/engine.ts) on a list of images and prints
 * one JSON line per image: {file, ok, landmarks, embedding}. Used by tools/recognizer/check_parity.py to prove
 * that the Python crop/embedding path matches the server, and to run a candidate model end-to-end.
 *
 *   apps/server/node_modules/.bin/tsx tools/recognizer/ts/dump_embeddings.mts [--models <dir>] <list.txt | files...>
 *
 * --models: directory holding face_detection_yunet_2023mar.onnx and face_recognition_sface_2021dec.onnx (a
 * candidate model can be tested by placing it there under the SFace file name). Default: apps/server/models.
 * --raw: embed with RECIPE_V1 (single raw view) instead of the engine's default recipe (v2: flip TTA / denoise),
 * which is what check_parity.py compares against.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VisionEngine } from '../../../apps/server/src/vision/engine.ts';
import { RECIPE_V1 } from '../../../apps/server/src/vision/embed-prep.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let modelsDir = resolve(here, '../../../apps/server/models');
let raw = false;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--models') modelsDir = resolve(args[++i]);
  else if (args[i] === '--raw') raw = true;
  else if (args[i].endsWith('.txt')) files.push(...readFileSync(args[i], 'utf8').split(/\r?\n/).filter(Boolean));
  else files.push(args[i]);
}
const engine = await VisionEngine.create({ modelsDir, threads: 2, ...(raw ? { embedding: RECIPE_V1 } : {}) });
for (const file of files) {
  try {
    const a = await engine.analyze(readFileSync(file), { embed: true });
    process.stdout.write(
      JSON.stringify({
        file,
        ok: !!a.embedding,
        landmarks: a.primary?.landmarks.map((p) => [p.x, p.y]) ?? null,
        embedding: a.embedding ? Array.from(a.embedding) : null,
      }) + '\n',
    );
  } catch (err) {
    process.stdout.write(JSON.stringify({ file, ok: false, error: String(err) }) + '\n');
  }
}
await engine.close();
