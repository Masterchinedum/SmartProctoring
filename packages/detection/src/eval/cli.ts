/**
 * Offline accuracy evaluation CLI for @sp/detection.
 *
 *   pnpm --filter @sp/detection eval                       # synthetic scenarios, 10 seeds, table
 *   pnpm --filter @sp/detection eval -- --write-baseline   # also write docs/accuracy/detection-baseline.json
 *   pnpm --filter @sp/detection eval -- --check            # fail (exit 1) on regression vs the baseline file
 *   pnpm --filter @sp/detection eval -- --trace rec.jsonl --labels rec.labels.json [--trace … --labels …]
 *   pnpm --filter @sp/detection eval -- --attention         # only the attention scenarios, with the looking-away summary
 *
 * Options: --seeds N, --seed-base N, --scenario name[,name], --policy policy.json, --out report.json,
 *          --json, --markdown, --verbose, --no-synthetic, --attention, --attention-param key=value (engine attention
 *          tuning for experiments, e.g. gazeMode=deadzone, boundaryPower=2; JSON values). With --trace, synthetic scenarios run only if
 *          --scenario is given. A recorded trace without labels lists what the engine flagged (--verbose: every episode).
 * The looking-away summary (false alerts / h on normal exam-taking; recall and latency of off-screen behaviour) is
 * printed whenever attention scenarios ran, and stored in the report as `attention`.
 * Relative paths resolve against the directory pnpm was invoked from (INIT_CWD).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolicy, type DetectionPolicy } from '@sp/shared';
import { aggregate, attentionSummary, parseLabels, parseTraceJsonl, runRecordedTrace, runScenario, type AttentionSummary, type EvalReport, type ScenarioRun } from './runner';
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
  markdown: boolean;
  verbose: boolean;
  synthetic: boolean;
  attention: boolean;
  attentionParams: Record<string, unknown>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seeds: 10, seedBase: 1, scenarios: [], traces: [], policy: null, out: null, writeBaseline: false, check: false, json: false, markdown: false, verbose: false, synthetic: true, attention: false, attentionParams: {} };
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
      case '--markdown':
        a.markdown = true;
        break;
      case '--no-synthetic':
        a.synthetic = false;
        break;
      case '--attention':
        a.attention = true;
        break;
      case '--attention-param': {
        const [key, ...rest] = next().split('=');
        const raw = rest.join('=');
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          /* a plain string */
        }
        if (raw === 'Infinity') value = Infinity;
        a.attentionParams[key] = value;
        break;
      }
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

function markdown(report: EvalReport): string {
  const pct = (v: number | null) => (v === null ? '—' : v.toFixed(3));
  const lines = [
    '| Event type | GT | TP | FP | FN | Dup | Precision | Recall | F1 | False alerts / h | Onset latency mean (s) | p95 (s) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.byType.map(
      (m) =>
        `| \`${m.type}\` | ${m.gt} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.duplicates} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${fmt(m.falseAlertsPerHour, 2)} | ${fmt(m.latencyMeanSec, 1)} | ${fmt(m.latencyP95Sec, 1)} |`,
    ),
    '',
    '| Scenario | Runs | Minutes | Expected | Detected | False positives | Missed |',
    '|---|---:|---:|---|---|---|---|',
    ...report.scenarios.map((s) => {
      const f = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ×${v}`).join(', ') || '—';
      return `| ${s.scenario} | ${s.runs} | ${s.monitoredMin} | ${f(s.expected)} | ${f(s.detected)} | ${f(s.falsePositives)} | ${f(s.missed)} |`;
    }),
  ];
  return lines.join('\n');
}

function attentionTable(a: AttentionSummary): string {
  const out: string[] = [];
  const pad = (rows: string[][]) => {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')).join('\n');
  };
  if (a.normal.rows.length) {
    out.push(`normal exam-taking (${a.normal.hours} h): looking-away-family false alerts`);
    const rows = [['scenario', 'runs', 'hours', 'looking_away', 'repeated', 'same-direction', 'family / h', 'sessions flagged']];
    for (const r of a.normal.rows)
      rows.push([r.scenario, String(r.runs), r.hours.toFixed(1), String(r.fp.looking_away ?? 0), String(r.fp.repeated_looking_away ?? 0), String(r.fp.offscreen_attention_pattern ?? 0), r.perHour.toFixed(2), `${r.flaggedRuns}/${r.runs}`]);
    const bt = a.normal.byType;
    const flagged = a.normal.rows.reduce((x, r) => x + r.flaggedRuns, 0);
    const runs = a.normal.rows.reduce((x, r) => x + r.runs, 0);
    rows.push(['TOTAL per hour', '', a.normal.hours.toFixed(1), fmt(bt.looking_away?.perHour ?? 0), fmt(bt.repeated_looking_away?.perHour ?? 0), fmt(bt.offscreen_attention_pattern?.perHour ?? 0), fmt(a.normal.familyPerHour), `${flagged}/${runs}`]);
    out.push(pad(rows));
  }
  if (a.offscreen.rows.length) {
    out.push('', 'off-screen behaviour: recall of the measured detector, and caught by any looking-away-family event');
    const rows = [['scenario', 'measures', 'recall', 'lat mean s', 'lat p95 s', 'caught (family)', 'family lat s', 'FA elsewhere', 'FA/h']];
    for (const r of a.offscreen.rows)
      rows.push([r.scenario, r.measures.join(','), `${r.detected}/${r.required}`, fmt(r.latencyMeanSec, 1), fmt(r.latencyP95Sec, 1), `${r.caught}/${r.required}`, fmt(r.familyLatencyMeanSec, 1), String(r.falseAlerts), fmt(r.falseAlertsPerHour)]);
    out.push(pad(rows));
  }
  return out.join('\n');
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

  if (args.attention && !args.traces.length) args.synthetic = true;
  if (args.synthetic) {
    const pool = args.attention ? SCENARIOS.filter((s) => s.group) : SCENARIOS;
    const selected = args.scenarios.length ? pool.filter((s) => args.scenarios.some((n) => s.name.includes(n))) : pool;
    if (!selected.length) throw new Error(`no scenario matches ${args.scenarios.join(', ')}`);
    for (const sc of selected) for (const seed of seeds) runs.push(runScenario(sc, seed, { policy, attentionParams: args.attentionParams }));
  }
  for (const tr of args.traces) {
    const records = parseTraceJsonl(readFileSync(abs(tr.trace), 'utf8'));
    const labels = tr.labels ? parseLabels(readFileSync(abs(tr.labels), 'utf8')) : [];
    runs.push(runRecordedTrace(tr.trace, records, labels, { policy, attentionParams: args.attentionParams }));
  }
  if (!runs.length) throw new Error('nothing to evaluate');

  const report: EvalReport & { attention?: AttentionSummary } = aggregate(runs, policy, args.synthetic ? seeds : []);
  const att = attentionSummary(runs, SCENARIOS);
  if (att.normal.rows.length || att.offscreen.rows.length) report.attention = att;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (args.markdown) process.stdout.write(`${markdown(report)}\n`);
  else {
    process.stdout.write(`@sp/detection accuracy evaluation — ${runs.length} traces, ${report.monitoredHours} h monitored, seeds ${seeds.join(',')} (${elapsed} s)\n\n`);
    process.stdout.write(`${table(report)}\n\n`);
    process.stdout.write(
      `checks: no duplicate events = ${report.checks.noDuplicateEvents}; one event per ongoing issue = ${report.checks.oneEventPerOngoingIssue}; ` +
        `clean-session false alerts/h = ${fmt(report.checks.cleanSessionFalseAlertsPerHour, 2)}; max engine ms/tick = ${report.checks.maxMsPerTick}\n`,
    );
    if (report.attention) process.stdout.write(`\n${attentionTable(report.attention)}\n`);
    // A recorded trace without labels: list what the engine flagged (what the owner wants to review).
    for (const r of runs.filter((x) => x.seed === 0 && x.labels.length === 0)) {
      const eps = [...r.result.preds].sort((a, b) => a.startedAt - b.startedAt);
      process.stdout.write(`\n${r.scenario}: ${(r.result.monitoredMs / 60000).toFixed(1)} min monitored, ${eps.length} episode(s)\n`);
      for (const p of eps) {
        const rel = (x: number) => `+${((x - r.result.startT) / 1000).toFixed(1)}s`;
        const d = p.details as { direction?: string; count?: number };
        process.stdout.write(`  ${p.type.padEnd(28)} ${rel(p.startedAt)}..${p.endedAt === null ? 'open' : rel(p.endedAt)}  conf=${p.confidence.toFixed(2)}${d.direction ? `  ${d.direction}` : ''}${d.count ? `  ×${d.count}` : ''}\n`);
      }
    }
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
    if (!args.json && !args.markdown) process.stdout.write(`\nwrote ${outPath}\n`);
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
