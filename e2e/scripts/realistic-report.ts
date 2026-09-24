/**
 * Summarises the realistic-webcam measurements (e2e/.artifacts/realistic-metrics.jsonl, written by tests/20-24):
 * environment (commit, workers, machine load), a summary against the targets, per-scenario tables and every run
 * that missed its target.
 *
 *   pnpm --filter @sp/e2e rw:report                          # the latest run, printed
 *   pnpm --filter @sp/e2e rw:report -- --run <id>[,<id>...]  # given run ids (or --all)
 *   pnpm --filter @sp/e2e rw:report -- --run <id> --write    # also replace the generated section of
 *                                                            # docs/accuracy/end-to-end.md (between the rw:tables markers)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, REPO_DIR } from '../lib/config';

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

/* ------------------------------------------------ helpers */
const nums = (xs: unknown[]) => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const med = (xs: unknown[]): number | null => {
  const v = nums(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};
const max = (xs: unknown[]): number | null => (nums(xs).length ? Math.max(...nums(xs)) : null);
const min = (xs: unknown[]): number | null => (nums(xs).length ? Math.min(...nums(xs)) : null);
const f1 = (x: number | null) => (x == null ? '–' : (Math.round(x * 10) / 10).toString());
const mm = (xs: unknown[]) => `${f1(med(xs))} / ${f1(max(xs))}`;
const frac = (n: number, d: number) => `${n}/${d}`;
const groupBy = (rs: Rec[], key: (r: Rec) => string) => {
  const m = new Map<string, Rec[]>();
  for (const r of rs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const scen = (...s: string[]) => recs.filter((r) => s.includes(r.scenario));
const out: string[] = [];
const verdict = (ok: boolean) => (ok ? '**met**' : '**NOT met**');

/* ------------------------------------------------ environment */
const loads = recs.map((r) => r.load1);
out.push(
  `Measurement runs: ${[...new Set(recs.map((r) => r.runId))].join(', ')} — ${recs.length} measurements, ` +
    `${recs[0]?.at?.slice(0, 16).replace('T', ' ')} to ${recs[recs.length - 1]?.at?.slice(0, 16).replace('T', ' ')} UTC; ` +
    `commit ${[...new Set(recs.map((r) => r.commit ?? '?'))].join(', ')}; ${[...new Set(recs.map((r) => r.workers))].join('/')} Playwright worker(s) on ` +
    `${[...new Set(recs.map((r) => r.cpus ?? '?'))].join('/')} CPUs; machine load (1-min load average at the end of each test) ` +
    `min ${f1(min(loads))} / median ${f1(med(loads))} / max ${f1(max(loads))}.\n`,
);

/* ------------------------------------------------ summary against the targets */
{
  const rows: string[][] = [];
  const res = scen('resume');
  const target = (t: string) => res.filter((r) => r.target === t);
  const first = target('first');
  if (first.length)
    rows.push([
      'Returning student resumes on the FIRST attempt (typical / dim, same day; another day in typical light; liveness on in typical light)',
      String(first.length),
      frac(first.filter((r) => r.pass).length, first.length),
      `time to pass ${mm(first.filter((r) => r.final === 'passed').map((r) => r.timeToOutcomeS))} s`,
      verdict(first.every((r) => r.pass)),
    ]);
  const w2 = target('within2');
  if (w2.length)
    rows.push([
      'Resume within 2 attempts (backlit, side lamp, VGA camera, other room / camera, liveness in dim / other room)',
      String(w2.length),
      frac(w2.filter((r) => r.pass).length, w2.length),
      `1st attempt ${frac(w2.filter((r) => r.final === 'passed' && r.attempts === 1).length, w2.length)}; time ${mm(w2.filter((r) => r.final === 'passed').map((r) => r.timeToOutcomeS))} s`,
      verdict(w2.every((r) => r.pass)),
    ]);
  const hon = target('honest');
  if (hon.length)
    rows.push([
      'Another day AND poor light: passes or honestly "unable to verify" with guidance — never a mismatch',
      String(hon.length),
      frac(hon.filter((r) => r.pass).length, hon.length),
      `passed ${frac(hon.filter((r) => r.final === 'passed').length, hon.length)} (1st attempt ${hon.filter((r) => r.final === 'passed' && r.attempts === 1).length})`,
      verdict(hon.every((r) => r.pass)),
    ]);
  const falseMismatch = res.reduce((a, r) => a + (r.mismatchEvents ?? 0), 0) + scen('genuine-long').reduce((a, r) => a + (r.identityMismatch ?? 0), 0);
  rows.push(['Genuine candidate never called a different person (all resume + long runs)', String(res.length + scen('genuine-long').length), `${falseMismatch} false identity_mismatch`, '', verdict(falseMismatch === 0)]);
  const imp = scen('resume-impostor');
  if (imp.length)
    rows.push([
      "Impostor never passes a resume check (B typical / dim / backlit; son resumes father's exam)",
      String(imp.length),
      frac(imp.filter((r) => r.pass).length, imp.length),
      `held as identity_mismatch ${frac(imp.filter((r) => r.holdReason === 'identity_mismatch').length, imp.length)}`,
      verdict(imp.every((r) => r.pass)),
    ]);
  const sw = scen('swap').filter((r) => (r.minimum ?? 'hold') === 'hold');
  if (sw.length) {
    const d = sw.filter((r) => r.detected);
    const m = med(d.map((r) => r.delayFromNewPersonS));
    rows.push([
      'Quick swap right after exam start (typical light; gap / cross-dissolve / slide; 720p / 480p): held as identity_mismatch, median ≲ 20 s',
      String(sw.length),
      frac(d.length, sw.length),
      `delay new person in view → hold ${mm(d.map((r) => r.delayFromNewPersonS))} s`,
      verdict(d.length === sw.length && m != null && m <= 20),
    ]);
  }
  const sig = scen('swap', 'family-swap').filter((r) => r.minimum === 'signal');
  for (const [label, rs] of [
    ['Swap in a dim room (no gap, 480p): held, or staff-visible suspect / inconclusive (non-matching identity check or identity event) within ~30 s', sig.filter((r) => r.scenario === 'swap')],
    ['Family member (father replaces son) mid-exam: held, or staff-visible suspect / inconclusive within ~30 s', sig.filter((r) => r.scenario === 'family-swap')],
  ] as const) {
    if (!rs.length) continue;
    rows.push([
      label,
      String(rs.length),
      frac(rs.filter((r) => r.pass).length, rs.length),
      `held ${frac(rs.filter((r) => r.detected).length, rs.length)}, delay ${mm(rs.filter((r) => r.detected).map((r) => r.delayFromNewPersonS))} s; first signal ${mm(rs.map((r) => r.staffSignalDelayS))} s`,
      verdict(rs.every((r) => r.pass)),
    ]);
  }
  const gl = scen('genuine-long');
  if (gl.length)
    rows.push([
      'Genuine candidate ≥ 5 min with lighting changes and head movement: zero identity_mismatch, no hold',
      String(gl.length),
      frac(gl.filter((r) => r.pass).length, gl.length),
      `${gl.reduce((a, r) => a + (r.samples ?? 0), 0)} samples; identity_unverifiable ${gl.reduce((a, r) => a + (r.identityUnverifiable ?? 0), 0)}`,
      verdict(gl.every((r) => r.pass)),
    ]);
  const lv = scen('liveness').filter((r) => (r.poseSmoothing ?? 'on') === 'on');
  if (lv.length)
    rows.push([
      'Active liveness with realistic head turns (typical / dim / other room + VGA) passes',
      String(lv.length),
      frac(lv.filter((r) => r.pass).length, lv.length),
      `1st attempt ${frac(lv.filter((r) => r.firstAttempt).length, lv.length)}; time ${mm(lv.filter((r) => r.pass).map((r) => r.timeToOutcomeS))} s`,
      verdict(lv.every((r) => r.pass)),
    ]);
  const st = scen('liveness-still');
  if (st.length) rows.push(['A still photo never passes active liveness (held "could not verify", never a mismatch)', String(st.length), frac(st.filter((r) => r.pass).length, st.length), '', verdict(st.every((r) => r.pass))]);
  const ct = scen('camera-test');
  if (ct.length)
    rows.push([
      'Staff camera test page: enrol A, A consistent, B confirmed as a different person',
      String(ct.length),
      frac(ct.filter((r) => r.pass).length, ct.length),
      `B suspect after ${mm(ct.map((r) => r.suspectAfterS))} s, confirmed after ${mm(ct.map((r) => r.confirmedAfterS))} s`,
      verdict(ct.every((r) => r.pass)),
    ]);
  out.push('### Summary against the targets\n');
  out.push(table(['requirement / target', 'runs', 'met', 'key numbers (median / max)', 'verdict'], rows), '');
}

/* ------------------------------------------------ resume (genuine) */
if (scen('resume').length) {
  out.push('### Resume — genuine candidate (scenario 20)\n');
  const rows: string[][] = [];
  for (const [k, rs] of groupBy(scen('resume'), (r) => `${r.case}|${r.liveness}`)) {
    const [cs, lv] = k.split('|');
    rows.push([
      cs!,
      lv!,
      rs[0]!.target ?? '–',
      rs[0]!.camera ?? '–',
      String(rs.length),
      frac(rs.filter((r) => r.pass).length, rs.length),
      frac(rs.filter((r) => r.final === 'passed' && r.attempts === 1).length, rs.length),
      frac(rs.filter((r) => r.final === 'passed').length, rs.length),
      mm(rs.map((r) => r.attempts)),
      mm(rs.map((r) => r.timeToOutcomeS)),
      String(rs.reduce((a, r) => a + (r.reprompts ?? 0), 0)),
      rs.map((r) => (r.resumeDecisions ?? []).join(' ')).join('; '),
      String(rs.reduce((a, r) => a + (r.mismatchEvents ?? 0), 0)),
    ]);
  }
  out.push(table(['condition', 'liveness', 'target', 'camera', 'runs', 'target met', '1st-attempt pass', 'passed', 'attempts med/max', 'time to outcome s med/max', 're-prompts', 'resume-check decisions @ similarity', 'false mismatch'], rows), '');
}

/* ------------------------------------------------ resume (impostor) */
if (scen('resume-impostor').length) {
  out.push('### Resume — impostor (scenarios 20 / 3)\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen('resume-impostor'), (r) => r.case)) {
    rows.push([
      cs,
      String(rs.length),
      frac(rs.filter((r) => r.final !== 'passed').length, rs.length),
      frac(rs.filter((r) => r.holdReason === 'identity_mismatch').length, rs.length),
      [...new Set(rs.map((r) => `${r.final}${r.holdReason ? ` (${r.holdReason})` : ''}`))].join(', '),
      mm(rs.map((r) => r.attempts)),
      mm(rs.map((r) => r.timeToOutcomeS)),
      rs.map((r) => (r.resumeDecisions ?? []).join(' ')).join('; '),
    ]);
  }
  out.push(table(['impostor', 'runs', 'never passed', 'held: identity_mismatch', 'outcomes', 'attempts med/max', 'time to outcome s med/max', 'resume-check decisions @ similarity'], rows), '');
}

/* ------------------------------------------------ swaps */
for (const s of ['swap', 'family-swap']) {
  if (!scen(s).length) continue;
  out.push(s === 'swap' ? '### Quick swap right after exam start (scenario 21)\n' : '### Family member takes over mid-exam (scenarios 21 / 3)\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen(s), (r) => r.case)) {
    const det = rs.filter((r) => r.detected);
    rows.push([
      cs,
      rs[0]!.camera ?? '–',
      String(rs.length),
      `${rs[0]!.minimum ?? 'hold'}: ${frac(rs.filter((r) => r.pass).length, rs.length)}`,
      frac(det.length, rs.length),
      mm(det.map((r) => r.delayFromNewPersonS)),
      mm(det.map((r) => r.delayFromTransitionS)),
      f1(med(rs.map((r) => r.startBeforeSwapS))),
      mm(rs.map((r) => r.staffSignalDelayS)),
      frac(rs.filter((r) => r.suspectSeen).length, rs.length),
      frac(rs.filter((r) => r.falseAlarmBeforeSwap).length, rs.length),
      rs.map((r) => (r.checksAfterSwap ?? []).slice(0, 4).join(' ')).join('; '),
    ]);
  }
  out.push(
    table(
      ['variant', 'camera', 'runs', 'requirement met', 'held (identity_mismatch)', 'delay s: new person in view → hold, med/max', 'delay s: transition start → hold', 'exam start → swap s', 'first staff-visible signal s', 'suspect seen', 'false alarm before swap', 'first identity checks after the swap (s after new person in view)'],
      rows,
    ),
    '',
  );
}

/* ------------------------------------------------ genuine long */
if (scen('genuine-long').length) {
  out.push('### Genuine candidate, long runs (scenario 22)\n');
  const rows = scen('genuine-long').map((r) => [
    r.case,
    String(r.rep),
    r.camera ?? '–',
    f1(r.minutes),
    String(r.samples),
    Object.entries(r.decisions ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
    r.minSimilarity == null ? '–' : r.minSimilarity.toFixed(2),
    r.medianSimilarity == null ? '–' : r.medianSimilarity.toFixed(2),
    String(r.identityMismatch),
    String(r.identityUnverifiable),
    String(r.lightingUnusable ?? 0),
    r.heldAfterS == null ? 'no' : `after ${r.heldAfterS} s (${r.holdReason})`,
    (r.evidenceStates ?? []).join(', '),
  ]);
  out.push(table(['case', 'run', 'camera', 'minutes', 'identity samples', 'decisions', 'min similarity', 'median similarity', 'identity_mismatch', 'identity_unverifiable', 'lighting_unusable', 'held', 'evidence states'], rows), '');
}

/* ------------------------------------------------ liveness */
if (scen('liveness', 'liveness-still').length) {
  out.push('### Active liveness at check-in (scenario 23)\n');
  const rows: string[][] = [];
  for (const [cs, rs] of groupBy(scen('liveness'), (r) => `${r.case}${r.poseSmoothing && r.poseSmoothing !== 'on' ? ' — raw pose (A/B: client smoothing off)' : ''}`)) {
    rows.push([cs, rs[0]!.camera ?? '–', String(rs.length), frac(rs.filter((r) => r.pass).length, rs.length), frac(rs.filter((r) => r.firstAttempt).length, rs.length), mm(rs.filter((r) => r.pass).map((r) => r.timeToOutcomeS)), String(rs.reduce((a, r) => a + (r.reprompts ?? 0), 0))]);
  }
  for (const [cs, rs] of groupBy(scen('liveness-still'), (r) => r.case)) {
    rows.push([`${cs} (must never pass)`, '–', String(rs.length), `${frac(rs.filter((r) => r.final === 'ready').length, rs.length)} passed`, '–', `${mm(rs.map((r) => r.timeToOutcomeS))} → ${[...new Set(rs.map((r) => r.holdReason ?? r.final))].join(', ')}`, '–']);
  }
  out.push(table(['case', 'camera', 'runs', 'passed', '1st attempt', 'time s med/max', 're-prompts'], rows), '');
}

/* ------------------------------------------------ camera test */
if (scen('camera-test').length) {
  out.push('### Staff camera & identity test page (scenario 24)\n');
  out.push(
    table(
      ['run', 'camera', 'enrolment', 'states with A', 'states with B', 'B suspect after s', 'B confirmed after s'],
      scen('camera-test').map((r) => [String(r.rep), String(r.camera).replace(/ · \/.*?\.y4m/, ''), r.enrolMessage, (r.statesWithA ?? []).join(', '), (r.statesWithB ?? []).join(', '), f1(r.suspectAfterS), f1(r.confirmedAfterS)]),
    ),
    '',
  );
}

/* ------------------------------------------------ misses */
const misses = recs.filter((r) => !r.pass);
out.push('### Runs that missed their target\n');
if (!misses.length) out.push('None.\n');
else
  out.push(
    table(
      ['test', 'what happened'],
      misses.map((r) => [
        r.test,
        [
          r.final ? `outcome ${r.final}` : null,
          r.attempts != null ? `${r.attempts} attempt(s)` : null,
          r.holdReason ? `hold ${r.holdReason}` : null,
          r.detected === false ? 'not held' : null,
          r.staffSignalDelayS != null ? `first signal after ${r.staffSignalDelayS} s` : String(r.scenario).includes('swap') ? 'no staff-visible signal' : null,
          r.resumeDecisions?.length ? `checks ${r.resumeDecisions.join(' ')}` : null,
          r.checksAfterSwap?.length ? `after swap ${r.checksAfterSwap.slice(0, 5).join(' ')}` : null,
          r.identityMismatch ? `${r.identityMismatch} identity_mismatch` : null,
          r.load1 != null ? `load ${r.load1}` : null,
        ]
          .filter(Boolean)
          .join('; '),
      ]),
    ),
    '',
  );

const text = out.join('\n');
console.log(text);
if (args.includes('--write')) {
  const doc = join(REPO_DIR, 'docs/accuracy/end-to-end.md');
  const cur = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
  const start = '<!-- rw:tables:start (generated by `pnpm --filter @sp/e2e rw:report -- --run <id> --write`) -->';
  const end = '<!-- rw:tables:end -->';
  const i = cur.indexOf('<!-- rw:tables:start');
  const j = cur.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`${doc}: markers not found`);
  writeFileSync(doc, `${cur.slice(0, i)}${start}\n\n${text}\n${cur.slice(j)}`);
  console.error(`wrote the generated section of ${doc}`);
}
