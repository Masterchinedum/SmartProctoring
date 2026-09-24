/**
 * CLI for the identity-accuracy harness.
 *
 *   pnpm --filter @sp/server eval:identity -- --dataset <dir> [--perturb] [--out report.json]
 *   pnpm --filter @sp/server eval:identity -- --pairs <master.csv> [--images <dir>] [--perturb] [--out report.json]
 *
 * Options:
 *   --dataset <dir>        folder dataset <dir>/<subject>/<cond>[+<cond>]__<name>.jpg ("reference" tag enrols)
 *   --pairs <csv>          pairs CSV (file_x,file_y,Decision Yes/No); images resolved against --images or the CSV's folder
 *   --perturb              also evaluate synthetic perturbations of every probe
 *   --only <a,b,...>       restrict perturbations by name
 *   --size <px>            normalise images to this max side before analysis (default 640, 0 = original)
 *   --match <x> --mismatch <y> --confirmations <n>   decision thresholds (default: shared DEFAULT_IDENTITY_THRESHOLDS)
 *   --interval <sec>       periodic identity-sample interval for event estimates (default 30)
 *   --models <dir>         model directory (default: MODELS_DIR / apps/server/models)
 *   --no-anonymize         keep folder / file names in ids (default: anonymised s01/i01 ids)
 *   --out <file>           write the JSON report
 *   --quiet                no progress output
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_IDENTITY_THRESHOLDS, identityThresholdsSchema } from '@sp/shared';
import { createVisionService } from '../vision/service';
import { PERTURBATIONS, formatReport, runFolderEval, runPairsEval, type EvalReport } from './identity-eval';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      pairs: { type: 'string' },
      images: { type: 'string' },
      perturb: { type: 'boolean', default: false },
      only: { type: 'string' },
      size: { type: 'string' },
      match: { type: 'string' },
      mismatch: { type: 'string' },
      confirmations: { type: 'string' },
      interval: { type: 'string' },
      models: { type: 'string' },
      'no-anonymize': { type: 'boolean', default: false },
      out: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help || (!values.dataset && !values.pairs)) {
    console.log(
      [
        'Usage: eval:identity (--dataset <dir> | --pairs <csv> [--images <dir>]) [--perturb] [--only a,b] [--size 640]',
        '       [--match 0.45 --mismatch 0.28 --confirmations 2] [--interval 30] [--models <dir>] [--no-anonymize] [--out report.json]',
        '',
        `Perturbations: ${PERTURBATIONS.map((p) => p.name).join(', ')}`,
      ].join('\n'),
    );
    return values.help ? 0 : 2;
  }
  const num = (v: string | undefined) => (v == null ? undefined : Number(v));
  const thresholds = identityThresholdsSchema.parse({
    ...DEFAULT_IDENTITY_THRESHOLDS,
    ...(values.match != null ? { match: num(values.match) } : {}),
    ...(values.mismatch != null ? { mismatch: num(values.mismatch) } : {}),
    ...(values.confirmations != null ? { mismatchConfirmations: num(values.confirmations) } : {}),
  });
  const log = values.quiet ? () => {} : (m: string) => process.stderr.write(`[eval] ${m}\n`);
  const vision = await createVisionService({ modelsDir: values.models });
  const t0 = Date.now();
  try {
    const common = {
      thresholds,
      size: values.size != null ? Number(values.size) : undefined,
      perturb: values.perturb,
      perturbations: values.only ? values.only.split(',').map((s) => s.trim()) : undefined,
      intervalSec: num(values.interval),
      anonymize: !values['no-anonymize'],
      onProgress: log,
    };
    let report: EvalReport;
    if (values.dataset) report = await runFolderEval(vision, resolve(values.dataset), common);
    else report = await runPairsEval(vision, resolve(values.pairs!), values.images ? resolve(values.images) : null, common);
    console.log(formatReport(report));
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${vision.stats.analyzed} analyses, ${vision.stats.avgMs} ms avg`);
    if (values.out) {
      writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
      log(`wrote ${resolve(values.out)}`);
    }
    return 0;
  } finally {
    await vision.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  },
);
