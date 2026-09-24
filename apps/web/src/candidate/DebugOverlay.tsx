import { useEffect, useState } from 'react';
import { useController } from './context';
import type { DebugSnapshot } from './debug';

/**
 * Candidate debug overlay — only with `?debug=1` on the take URL (never shown otherwise). A small panel for
 * validating a real webcam: camera resolution, analysis rate, faces, the server's answer to the latest check
 * frame (quality, guidance, adaptive progress), the latest identity burst (decision, similarity, accumulated
 * evidence), the next routine sample and the identity triggers that fired.
 */
export function DebugOverlay() {
  const ctrl = useController();
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!ctrl.debug.enabled) return;
    const refresh = () => setSnap(ctrl.debug.snapshot(ctrl.runtimeDebug()));
    refresh();
    const id = setInterval(refresh, 500);
    const unsub = ctrl.debug.subscribe(refresh);
    return () => {
      clearInterval(id);
      unsub();
    };
  }, [ctrl]);

  if (!ctrl.debug.enabled || !snap) return null;
  const v = ctrl.camera.video;
  const rt = snap.runtime;
  const b = snap.lastBurst;
  const res = b?.response ?? null;
  const cf = snap.lastCheckFrame;
  const q = cf?.quality ?? null;
  const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

  return (
    <aside className="cand-debug" data-testid="debug-overlay" aria-label="Debug information">
      <div className="cand-debug-head">
        <strong>Debug</strong>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'hide' : 'show'}
        </button>
      </div>
      {open && (
        <>
          <h2>Camera</h2>
          <table>
            <tbody>
              <tr>
                <th>resolution</th>
                <td data-testid="debug-camera-resolution">
                  {v.videoWidth || '—'}×{v.videoHeight || '—'} {ctrl.camera.state.info?.label ? `(${ctrl.camera.state.info.label.slice(0, 40)})` : ''}
                </td>
              </tr>
              <tr>
                <th>analysis</th>
                <td>
                  {rt ? `${rt.analysisWidth}×${rt.analysisHeight}, ${fmt(rt.fps, 1)} fps` : 'monitoring not running'}
                </td>
              </tr>
              <tr>
                <th>faces</th>
                <td>{rt ? rt.faces : '—'}</td>
              </tr>
              {rt && (
                <tr>
                  <th>appearance</th>
                  <td>
                    d={fmt(rt.appearance.distance, 3)} / thr {fmt(rt.appearance.threshold, 3)} (baseline {rt.appearance.baselineFrames})
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {cf && (
            <>
              <h2>Last check frame</h2>
              <table data-testid="debug-check-frame">
                <tbody>
                  <tr>
                    <th>step</th>
                    <td>
                      {String(cf.step)} — <span className={cf.accepted ? 'good' : 'bad'}>{cf.accepted ? 'accepted' : 'rejected'}</span>
                      {cf.stepSatisfied != null && <> · step {cf.stepSatisfied ? 'satisfied' : 'not yet'}</>}
                      {cf.crop && <> · sent {cf.crop.width}×{cf.crop.height}{cf.crop.face ? ' face crop' : ' full frame'}</>}
                    </td>
                  </tr>
                  {q && (
                    <tr>
                      <th>quality</th>
                      <td>
                        {q.usable ? <span className="good">usable</span> : <span className="bad">unusable</span>} · eyes {fmt(q.interEyePx, 0)} px · bright {fmt(q.brightness, 0)} · contrast {fmt(q.contrast, 1)} · sharp{' '}
                        {fmt(q.sharpness, 0)} · yaw {fmt(q.yawDeg, 0)}° pitch {fmt(q.pitchDeg, 0)}°{q.issues.length ? ` · ${q.issues.join(', ')}` : ''}
                      </td>
                    </tr>
                  )}
                  {cf.measured && (
                    <tr>
                      <th>measured</th>
                      <td>
                        yaw {fmt(cf.measured.yawDeg, 1)}° pitch {fmt(cf.measured.pitchDeg, 1)}°
                      </td>
                    </tr>
                  )}
                  {cf.progress && (
                    <tr>
                      <th>progress</th>
                      <td data-testid="debug-check-progress">
                        frontal {cf.progress.frontalAccepted} (+{cf.progress.frontalNeeded} wanted) · identity {cf.progress.identity ?? '—'} · steps{' '}
                        {cf.progress.steps.map((s) => `${s.index}:${s.satisfied ? '✓' : '·'}`).join(' ') || '—'} · {cf.progress.canComplete ? <span className="good">can complete</span> : 'collecting'}
                      </td>
                    </tr>
                  )}
                  {cf.guidance.length > 0 && (
                    <tr>
                      <th>guidance</th>
                      <td className="warn">{cf.guidance.join(' ')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
          {snap.lastCheckOutcome && (
            <p>
              check outcome: <strong>{snap.lastCheckOutcome.outcome}</strong> at {time(snap.lastCheckOutcome.at)}
            </p>
          )}

          <h2>Identity samples</h2>
          <table data-testid="debug-identity">
            <tbody>
              <tr>
                <th>last burst</th>
                <td>
                  {b ? (
                    <>
                      {b.trigger} · {b.frames} frame{b.frames === 1 ? '' : 's'} · {time(b.at)}
                      {res ? (
                        <>
                          {' '}
                          · <span className={res.result.decision === 'match' ? 'good' : res.result.decision === 'mismatch' ? 'bad' : 'warn'}>{res.result.decision}</span> · sim {fmt(res.result.similarity)}
                        </>
                      ) : (
                        ' · queued (offline)'
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
              {res?.evidence && (
                <tr>
                  <th>evidence</th>
                  <td>
                    <span className={res.evidence.state === 'consistent' ? 'good' : res.evidence.state === 'monitoring' ? 'warn' : 'bad'}>{res.evidence.state}</span> · swap p{' '}
                    {fmt(res.evidence.swapProbability, 3)} · {res.evidence.samples} samples
                  </td>
                </tr>
              )}
              {res?.result.guidance?.length ? (
                <tr>
                  <th>guidance</th>
                  <td className="warn">{res.result.guidance.join(' ')}</td>
                </tr>
              ) : null}
              <tr>
                <th>next sample</th>
                <td data-testid="debug-next-sample">
                  {rt ? (rt.burstActive ? `capturing (${rt.pendingTrigger ?? '…'})` : rt.pendingTrigger ? `waiting: ${rt.pendingTrigger}` : rt.nextSampleInMs != null ? `in ${(rt.nextSampleInMs / 1000).toFixed(1)} s` : '—') : '—'}
                  {rt && ` · budget ${rt.budgetLeft}/min`}
                </td>
              </tr>
            </tbody>
          </table>

          <h2>Triggers</h2>
          {snap.triggers.length === 0 && (rt?.swapTriggers.length ?? 0) === 0 ? (
            <p>none yet</p>
          ) : (
            <ol data-testid="debug-triggers">
              {[
                ...snap.triggers.map((t) => ({ at: t.at, text: `${t.trigger} (${t.source})` })),
                ...(rt?.swapTriggers ?? []).map((f) => ({ at: f.armedAt ?? f.t, text: `swap: ${f.trigger} — ${f.reason}${f.detail ? ` ${JSON.stringify(f.detail)}` : ''}` })),
              ]
                .sort((x, y) => x.at - y.at)
                .slice(-15)
                .map((t, i) => (
                  <li key={i}>
                    {time(t.at)} {t.text}
                  </li>
                ))}
            </ol>
          )}
        </>
      )}
    </aside>
  );
}
