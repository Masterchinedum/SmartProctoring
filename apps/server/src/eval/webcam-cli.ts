/**
 * `pnpm --filter @sp/server eval:identity -- --webcam [options]` — identity accuracy under simulated
 * laptop-webcam conditions, identity v1 vs the current pipeline (docs/accuracy/identity-v2.md).
 *
 *   --facesets <dir>   image cache (default $SP_FACESETS_DIR, else /tmp/claude-0/facesets, else <tmp>/sp-facesets);
 *                      fill it first with `pnpm --filter @sp/server eval:fetch-faces`
 *   --shards <n>       render + analyse in n parallel processes (default 3; 1 = in this process)
 *   --quick            12 identities, 640x480 only, 1 scene per condition (a few minutes)
 *   --no-legacy        skip the identity-v1 baseline
 *   --runs <n>         Monte-Carlo runs per session for the sequential-test simulation (default 100)
 *   --out <file>       write the JSON report
 *   --markdown <file>  write the before/after tables as Markdown
 *   --models <dir>     model directory
 * Internal: --build-only --engine v1|v2 --shard i/n (used by the parallel workers).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RECIPE_V1 } from '../vision/embed-prep';
import { createVisionService } from '../vision/service';
import type { VisionService } from '../vision/types';
import { defaultFacesetsDir, loadFaceset } from './datasets';
import { buildWebcamData, type WebcamDataOptions } from './webcam-eval';
import { buildWebcamReport, currentPipeline, formatWebcamMarkdown, formatWebcamReport, legacyPipeline, type EngineHooks } from './webcam-report';

/**
 * The identity engine's production decision logic (per-session normalisation, check assessment), loaded
 * dynamically so the evaluation measures what ships without a compile-time dependency on the service layer.
 */
export async function loadEngineHooks(): Promise<EngineHooks | undefined> {
  try {
    const m = (await import('../services/identity-evidence')) as Record<string, unknown>;
    const comparisonLLR = m.comparisonLLR as EngineHooks['comparisonLLR'] | undefined;
    const assessCheck = m.assessCheck as EngineHooks['assessCheck'] | undefined;
    if (typeof comparisonLLR === 'function' && typeof assessCheck === 'function') return { comparisonLLR, assessCheck };
  } catch {
    // service layer not available: plain calibrated LLR only
  }
  return undefined;
}

type Engine = 'v1' | 'v2';

function dataOptions(engine: Engine, quick: boolean, facesetDir: string): WebcamDataOptions {
  return {
    facesetDir,
    engineTag: engine,
    // v2 also embeds with the v1 recipe, to measure comparisons against references stored before the change.
    recipes: engine === 'v2' ? [{ ...RECIPE_V1 }] : [],
    ...(quick ? { maxIdentities: 12, resolutions: ['640x480'] as const, scenes: 1 } : {}),
  };
}

function serviceFor(engine: Engine, models?: string): Promise<VisionService & { close(): Promise<void> }> {
  return engine === 'v1'
    ? createVisionService({ modelsDir: models, workers: 1, embedding: RECIPE_V1, enhanceLowLight: false })
    : createVisionService({ modelsDir: models, workers: 1 });
}

async function buildShard(engine: Engine, shard: { index: number; count: number } | undefined, quick: boolean, facesetDir: string, models: string | undefined, log: (m: string) => void): Promise<void> {
  const vision = await serviceFor(engine, models);
  try {
    await buildWebcamData(vision, { ...dataOptions(engine, quick, facesetDir), shard, concurrency: 2, onProgress: (m) => log(`[${engine}${shard ? ` ${shard.index}/${shard.count}` : ''}] ${m}`) });
  } finally {
    await vision.close();
  }
}

/** Run the shards of one engine configuration in parallel child processes (same script, same loader). */
async function buildParallel(engine: Engine, shards: number, quick: boolean, facesetDir: string, models: string | undefined, log: (m: string) => void): Promise<void> {
  const script = fileURLToPath(new URL('./identity-eval-cli.ts', import.meta.url));
  await Promise.all(
    Array.from({ length: shards }, (_, i) =>
      new Promise<void>((res, rej) => {
        const args = [...process.execArgv, script, '--webcam', '--build-only', '--engine', engine, '--shard', `${i}/${shards}`, '--facesets', facesetDir];
        if (quick) args.push('--quick');
        if (models) args.push('--models', models);
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`shard ${i} exited with ${code}`))));
        child.on('error', rej);
      }),
    ),
  );
  log(`[${engine}] ${shards} shards done`);
}

export async function runWebcamCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      webcam: { type: 'boolean', default: true },
      facesets: { type: 'string' },
      shards: { type: 'string' },
      shard: { type: 'string' },
      engine: { type: 'string' },
      'build-only': { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      'no-legacy': { type: 'boolean', default: false },
      runs: { type: 'string' },
      out: { type: 'string' },
      markdown: { type: 'string' },
      models: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const log = values.quiet ? () => {} : (m: string) => process.stderr.write(`[webcam] ${m}\n`);
  const facesetDir = resolve(values.facesets ?? defaultFacesetsDir());
  const quick = values.quick;
  if (values['build-only']) {
    const [i, n] = (values.shard ?? '0/1').split('/').map(Number);
    await buildShard((values.engine as Engine) ?? 'v2', n > 1 ? { index: i, count: n } : undefined, quick, facesetDir, values.models, log);
    return 0;
  }
  const faceset = loadFaceset(facesetDir);
  if (faceset.images.length === 0) {
    console.error(`No face images in ${facesetDir}. Run: pnpm --filter @sp/server eval:fetch-faces`);
    return 2;
  }
  const shards = Math.max(1, Number(values.shards ?? 3));
  const engines: Engine[] = values['no-legacy'] ? ['v2'] : ['v1', 'v2'];
  const t0 = Date.now();
  for (const e of engines) {
    if (shards > 1) await buildParallel(e, shards, quick, facesetDir, values.models, log);
    else await buildShard(e, undefined, quick, facesetDir, values.models, log);
  }
  const noVision = { analyze: () => Promise.reject(new Error('analysis cache incomplete')) } as unknown as VisionService;
  const load = (e: Engine) => buildWebcamData(noVision, { ...dataOptions(e, quick, facesetDir), cachedOnly: true });
  const v2 = await load('v2');
  const parts = [...(engines.includes('v1') ? [{ pipeline: legacyPipeline('default'), data: await load('v1') }] : []), { pipeline: currentPipeline('default'), data: v2 }];
  const hooks = await loadEngineHooks();
  if (!hooks) log('identity-engine hooks not found: reporting the plain calibrated evidence only');
  const report = buildWebcamReport(v2, parts, { runs: values.runs ? Number(values.runs) : 100, hooks });
  console.log(formatWebcamReport(report));
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (values.out) {
    writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
    log(`wrote ${resolve(values.out)}`);
  }
  if (values.markdown) {
    writeFileSync(resolve(values.markdown), formatWebcamMarkdown(report) + '\n');
    log(`wrote ${resolve(values.markdown)}`);
  }
  return 0;
}
