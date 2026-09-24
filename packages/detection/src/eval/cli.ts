/**
 * Offline accuracy evaluation CLI for @sp/detection.
 *
 *   pnpm --filter @sp/detection eval                       # synthetic scenarios, 5 seeds, table
 *   pnpm --filter @sp/detection eval -- --write-baseline   # also write docs/accuracy/detection-baseline.json
 *   pnpm --filter @sp/detection eval -- --check            # fail (exit 1) on regression vs the baseline file
 *   pnpm --filter @sp/detection eval -- --trace rec.jsonl --labels rec.labels.json [--trace … --labels …]
 *
 * Options: --seeds N, --seed-base N, --scenario name[,name], --policy policy.json, --out report.json,
 *          --json, --verbose, --no-synthetic. With --trace, synthetic scenarios run only if --scenario is given.
 * Relative paths resolve against the directory pnpm was invoked from (INIT_CWD).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolicy, type DetectionPolicy } from '@sp/shared';
import { aggregate, parseLabels, parseTraceJsonl, runRecordedTrace, runScenario, type EvalReport, type ScenarioRun } from './runner';
import { SCENARIOS } from './scenarios';

interface Args {
  seeds: number;
  seedBase: number;
  scenarios: string[];
  traces: { trace: string; labels: string | null }[];
  policy: string | null;
  out: string | null;
  writeBaseline: boolean;
  check: boolean;
  json: boolean;
  verbose: boolean;
  synthetic: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seeds: 5, seedBase: 1, scenarios: [], traces: [], policy: null, out: null, writeBaseline: false, check: false, json: false, verbose: false, synthetic: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${k}`);
      return v;
    };
    switch (k) {
      case '--':
        break;
      case '--seeds':
        a.seeds = Math.max(1, parseInt(next(), 10));
        break;
      case '--seed-base':
        a.seedBase = parseInt(next(), 10);
        break;
      case '--scenario':
        a.scenarios.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--trace':
        a.traces.push({ trace: next(), labels: null });
        break;
      case '--labels': {
        const last = a.traces[a.traces.length - 1];
        if (!last || last.labels) throw new Error('--labels must follow a --trace');
        last.labels = next();
        break;
      }
      case '--policy':
        a.policy = next();
        break;
      case '--out':
        a.out = next();
        break;
      case '--write-baseline':
        a.writeBaseline = true;
        break;
      case '--check':
        a.check = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--verbose':
        a.verbose = true;
        break;
      case '--no-synthetic':
        a.synthetic = false;
        break;
      case '--help':
      case '-h':
        process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]}*/\n`);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown option ${k}`);
    }
  }
  // With --trace, synthetic scenarios run only when explicitly selected with --scenario.
  if (a.traces.length && !a.scenarios.length) a.synthetic = false;
  return a;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

const invokedFrom = process.env.INIT_CWD || process.cwd();
const abs = (p: string) => (isAbsolute(p) ? p : resolve(invokedFrom, p));

function fmt(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function table(report: EvalReport): string {
  const head = ['event type', 'GT', 'TP', 'FP', 'FN', 'dup', 'precision', 'recall', 'F1', 'FA/h', 'lat mean s', 'lat p95 s'];
  const rows = report.byType.map((m) => [
    m.type,
    String(m.gt),
    String(m.tp),
    String(m.fp),
    String(m.fn),
    String(m.duplicates),
    fmt(m.precision, 3),
    fmt(m.recall, 3),
    fmt(m.f1, 3),
    fmt(m.falseAlertsPerHour, 2),
    fmt(m.latencyMeanSec, 1),
    fmt(m.latencyP95Sec, 1),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function checkRegression(report: EvalReport, baselinePath: string): string[] {
  if (!existsSync(baselinePath)) return [`baseline file not found: ${baselinePath}`];
  const base = JSON.parse(readFileSync(baselinePath, 'utf8')) as EvalReport;
  const problems: string[] = [];
  for (const b of base.byType) {
    const m = report.byType.find((x) => x.type === b.type);
    if (!m) continue;
    if (b.f1 !== null && m.f1 !== null && m.f1 < b.f1 - 0.05) problems.push(`${m.type}: F1 ${m.f1} < baseline ${b.f1} − 0.05`);
    if (m.falseAlertsPerHour > b.falseAlertsPerHour + 0.5) problems.push(`${m.type}: false alerts/h ${m.falseAlertsPerHour} > baseline ${b.falseAlertsPerHour} + 0.5`);
    if (m.duplicates > 0) problems.push(`${m.type}: ${m.duplicates} duplicate events`);
  }
  return problems;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const policy: DetectionPolicy = args.policy ? resolvePolicy(JSON.parse(readFileSync(abs(args.policy), 'utf8'))).detection : resolvePolicy({}).detection;
  const seeds = Array.from({ length: args.seeds }, (_, i) => args.seedBase + i);
  const runs: ScenarioRun[] = [];
  const t0 = Date.now();

  if (args.synthetic) {
    const selected = args.scenarios.length ? SCENARIOS.filter((s) => args.scenarios.some((n) => s.name.includes(n))) : SCENARIOS;
    if (!selected.length) throw new Error(`no scenario matches ${args.scenarios.join(', ')}`);
    for (const sc of selected) for (const seed of seeds) runs.push(runScenario(sc, seed, { policy }));
  }
  for (const tr of args.traces) {
    const records = parseTraceJsonl(readFileSync(abs(tr.trace), 'utf8'));
    const labels = tr.labels ? parseLabels(readFileSync(abs(tr.labels), 'utf8')) : [];
    runs.push(runRecordedTrace(tr.trace, records, labels, { policy }));
  }
  if (!runs.length) throw new Error('nothing to evaluate');

  const report = aggregate(runs, policy, args.synthetic ? seeds : []);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`@sp/detection accuracy evaluation — ${runs.length} traces, ${report.monitoredHours} h monitored, seeds ${seeds.join(',')} (${elapsed} s)\n\n`);
    process.stdout.write(`${table(report)}\n\n`);
    process.stdout.write(
      `checks: no duplicate events = ${report.checks.noDuplicateEvents}; one event per ongoing issue = ${report.checks.oneEventPerOngoingIssue}; ` +
        `clean-session false alerts/h = ${fmt(report.checks.cleanSessionFalseAlertsPerHour, 2)}; max engine ms/tick = ${report.checks.maxMsPerTick}\n`,
    );
    if (args.verbose) {
      process.stdout.write('\nper scenario:\n');
      for (const s of report.scenarios) {
        const parts = [`expected ${JSON.stringify(s.expected)}`, `detected ${JSON.stringify(s.detected)}`];
        if (Object.keys(s.falsePositives).length) parts.push(`FALSE POSITIVES ${JSON.stringify(s.falsePositives)}`);
        if (Object.keys(s.missed).length) parts.push(`MISSED ${JSON.stringify(s.missed)}`);
        if (s.duplicates) parts.push(`DUPLICATES ${s.duplicates}`);
        process.stdout.write(`  ${s.scenario.padEnd(24)} runs=${s.runs} ${s.monitoredMin} min  ${parts.join('  ')}\n`);
      }
      for (const r of runs) {
        for (const [type, c] of r.counts) {
          for (const fp of c.fpEpisodes) process.stdout.write(`    FP ${r.scenario}#${r.seed} ${type} at +${((fp.startedAt - r.result.startT) / 1000).toFixed(1)}s..${fp.endedAt === null ? 'open' : `+${((fp.endedAt - r.result.startT) / 1000).toFixed(1)}s`} conf=${fp.confidence}\n`);
          for (const fn of c.fnLabels) process.stdout.write(`    FN ${r.scenario}#${r.seed} ${type} at +${((fn.start - r.result.startT) / 1000).toFixed(1)}s..+${((fn.end - r.result.startT) / 1000).toFixed(1)}s\n`);
        }
      }
    }
  }

  const outPath = args.out ? abs(args.out) : args.writeBaseline ? join(repoRoot(), 'docs/accuracy/detection-baseline.json') : null;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!args.json) process.stdout.write(`\nwrote ${outPath}\n`);
  }
  if (args.check) {
    const problems = checkRegression(report, join(repoRoot(), 'docs/accuracy/detection-baseline.json'));
    if (problems.length) {
      process.stderr.write(`\nREGRESSION:\n  ${problems.join('\n  ')}\n`);
      process.exit(1);
    }
    if (!args.json) process.stdout.write('\nno regression against the stored baseline\n');
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`eval: ${(e as Error).message}\n`);
  process.exit(2);
}
