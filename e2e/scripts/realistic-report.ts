/**
 * Summarises the realistic-webcam measurements (e2e/.artifacts/realistic-metrics.jsonl, written by tests/20-24)
 * as Markdown tables for docs/accuracy/end-to-end.md.
 *
 *   pnpm --filter @sp/e2e rw:report                 # the latest run
 *   pnpm --filter @sp/e2e rw:report -- --run <id>   # one run id (several: comma-separated), or --all
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '../lib/config';

type Rec = Record<string, any> & { runId: string | null; scenario: string; case: string; rep: number; pass: boolean };

const file = join(ARTIFACTS_DIR, 'realistic-metrics.jsonl');
if (!existsSync(file)) {
  console.error(`no measurements in ${file}`);
  process.exit(1);
}
const all: Rec[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Rec);
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1]! : null;
const runs = args.includes('--all') ? null : runArg ? new Set(runArg.split(',')) : new Set([all[all.length - 1]!.runId]);
const recs = all.filter((r) => !runs || runs.has(r.runId));

const med = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};
const max = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};
const f1 = (x: number | null) => (x == null ? '–' : (Math.round(x * 10) / 10).toString());
const frac = (n: number, d: number) => `${n}/${d}`;
const groupBy = (rs: Rec[], key: (r: Rec) => string) => {
  const m = new Map<string, Rec[]>();
  for (const r of rs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const out: string[] = [];
const scen = (s: string) => recs.filter((r) => r.scenario === s);

out.push(`Runs: ${[...new Set(recs.map((r) => r.runId))].join(', ')} — ${recs.length} measurements\n`);

/* ------------------------------------------------ resume (genuine) */
if (scen('resume').length) {
  out.push('### Resume — genuine candidate\n');
  const rows: string[][] = [];
  for (const [k, rs] of groupBy(scen('resume'), (r) => `${r.case}|${r.liveness}`)) {
    const [cs, lv] = k.split('|');
    const first = rs.filter((r) => r.final === 'passed' && r.attempts === 1).length;
    const eventually = rs.filter((r) => r.final === 'passed').length;
    rows.push([
      cs!,
      lv!,
      rs[0]!.target ?? '–',
      rs[0]!.camera ?? '–',
      String(rs.length),
      frac(rs.filter((r) => r.pass).length, rs.length),
      frac(first, rs.length),
      frac(eventually, rs.length),
      `${f1(med(rs.map((r) => r.attempts)))} / ${f1(max(rs.map((r) => r.attempts)))}`,
      `${f1(med(rs.map((r) => r.timeToOutcomeS)))} / ${f1(max(rs.map((r) => r.timeToOutcomeS)))}`,
      String(rs.reduce((a, r) => a + (r.reprompts ?? 0), 0)),
      rs.map((r) => (r.resumeDecisions ?? []).join(' ')).join('; '),
      String(rs.reduce((a, r) => a + (r.mismatchEvents ?? 0), 0)),
    ]);
  }
  out.push(table(['condition', 'liveness', 'target', 'camera', 'runs', 'target met', '1st-attempt pass', 'passed', 'attempts med/max', 'time to outcome s med/max', 're-prompts', 'resume check decisions@similarity', 'false mismatch'], rows), '');
}

/* ------------------------------------------------ resume (impostor) */
if (scen('resume-impostor').length) {
  out.push('### Resume — impostor\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen('resume-impostor'), (r) => r.case)) {
    rows.push([
      cs,
      String(rs.length),
      frac(rs.filter((r) => r.final !== 'passed').length, rs.length),
      frac(rs.filter((r) => r.holdReason === 'identity_mismatch').length, rs.length),
      [...new Set(rs.map((r) => `${r.final}${r.holdReason ? ` (${r.holdReason})` : ''}`))].join(', '),
      `${f1(med(rs.map((r) => r.attempts)))} / ${f1(max(rs.map((r) => r.attempts)))}`,
      `${f1(med(rs.map((r) => r.timeToOutcomeS)))} / ${f1(max(rs.map((r) => r.timeToOutcomeS)))}`,
      rs.map((r) => (r.resumeDecisions ?? []).join(' ')).join('; '),
    ]);
  }
  out.push(table(['impostor', 'runs', 'never passed', 'held: identity_mismatch', 'outcomes', 'attempts med/max', 'time to outcome s med/max', 'resume check decisions@similarity'], rows), '');
}

/* ------------------------------------------------ swaps */
for (const s of ['swap', 'family-swap']) {
  if (!scen(s).length) continue;
  out.push(s === 'swap' ? '### Quick swap right after exam start\n' : '### Family member takes over mid-exam\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen(s), (r) => r.case)) {
    const det = rs.filter((r) => r.detected);
    rows.push([
      cs,
      rs[0]!.camera ?? '–',
      String(rs.length),
      frac(det.length, rs.length),
      `${f1(med(det.map((r) => r.delayFromNewPersonS)))} / ${f1(max(det.map((r) => r.delayFromNewPersonS)))}`,
      f1(med(rs.map((r) => r.startBeforeSwapS))),
      frac(rs.filter((r) => r.suspectSeen).length, rs.length),
      `${f1(med(rs.map((r) => r.staffSignalDelayS)))} / ${f1(max(rs.map((r) => r.staffSignalDelayS)))}`,
      frac(rs.filter((r) => r.falseAlarmBeforeSwap).length, rs.length),
      `${rs[0]!.minimum ?? 'hold'}: ${frac(rs.filter((r) => r.pass).length, rs.length)}`,
      rs.map((r) => (r.checksAfterSwap ?? []).slice(0, 4).join(' ')).join('; '),
    ]);
  }
  out.push(table(['variant', 'camera', 'runs', 'detected (held)', 'delay s med/max (new person in view → hold)', 'exam start → swap s', 'suspect seen', 'first staff-visible signal s med/max', 'false alarm before swap', 'requirement met', 'first checks after swap'], rows), '');
}

/* ------------------------------------------------ genuine long */
if (scen('genuine-long').length) {
  out.push('### Genuine candidate, long runs\n');
  const rows = scen('genuine-long').map((r) => [
    r.case,
    String(r.rep),
    f1(r.minutes),
    String(r.samples),
    Object.entries(r.decisions ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
    r.minSimilarity == null ? '–' : r.minSimilarity.toFixed(2),
    String(r.identityMismatch),
    String(r.identityUnverifiable),
    r.heldAfterS == null ? 'no' : `after ${r.heldAfterS} s (${r.holdReason})`,
    (r.evidenceStates ?? []).join(', '),
  ]);
  out.push(table(['case', 'run', 'minutes', 'identity samples', 'decisions', 'min similarity', 'identity_mismatch', 'identity_unverifiable', 'held', 'evidence states'], rows), '');
}

/* ------------------------------------------------ liveness */
if (scen('liveness').length || scen('liveness-still').length) {
  out.push('### Active liveness at check-in\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen('liveness'), (r) => r.case)) {
    rows.push([
      cs,
      rs[0]!.camera ?? '–',
      String(rs.length),
      frac(rs.filter((r) => r.pass).length, rs.length),
      frac(rs.filter((r) => r.firstAttempt).length, rs.length),
      `${f1(med(rs.map((r) => r.timeToOutcomeS)))} / ${f1(max(rs.map((r) => r.timeToOutcomeS)))}`,
      String(rs.reduce((a, r) => a + (r.reprompts ?? 0), 0)),
    ]);
  }
  for (const [cs, rs] of groupBy(scen('liveness-still'), (r) => r.case)) {
    rows.push([cs, '–', String(rs.length), `${frac(rs.filter((r) => r.final === 'ready').length, rs.length)} (must be 0)`, '–', `${f1(med(rs.map((r) => r.timeToOutcomeS)))} to ${[...new Set(rs.map((r) => r.holdReason ?? r.final))].join(', ')}`, '–']);
  }
  out.push(table(['case', 'camera', 'runs', 'passed', '1st attempt', 'time s med/max', 're-prompts'], rows), '');
}

/* ------------------------------------------------ camera test */
if (scen('camera-test').length) {
  out.push('### Staff camera & identity test page\n');
  out.push(
    table(
      ['run', 'camera', 'enrolment', 'states with A', 'states with B', 'suspect after s', 'confirmed after s'],
      scen('camera-test').map((r) => [String(r.rep), r.camera, r.enrolMessage, (r.statesWithA ?? []).join(', '), (r.statesWithB ?? []).join(', '), f1(r.suspectAfterS), f1(r.confirmedAfterS)]),
    ),
    '',
  );
}

console.log(out.join('\n'));
