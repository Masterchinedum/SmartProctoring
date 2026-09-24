import { useEffect, useRef, useState } from 'react';
import { createBaselineCalibrator } from '@sp/detection';
import type { Baseline } from '@sp/shared';
import { useSnapshot } from '../context';
import { CameraPreview } from '../components/common';
import { plausibleFaces, useFrameAnalysis } from './useFrameAnalysis';

/** Minimum time the candidate holds still, even if enough samples arrive sooner. */
const MIN_MS = 2500;
/** After this long without a stable baseline we continue without one (the engine uses defaults). */
const GIVE_UP_MS = 20_000;

/**
 * "Hold still and look at the screen": measures the candidate's normal head pose and position for
 * this exam period (relative thresholds for looking-away / movement detection).
 */
export function CalibrationStep({ onDone }: { onDone: (b: Baseline | null) => void }) {
  const { camera } = useSnapshot();
  const cal = useRef(createBaselineCalibrator({ minSamples: 12 }));
  const started = useRef(performance.now());
  const done = useRef(false);
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const vs = useFrameAnalysis(!done.current, (a) => {
    if (done.current) return;
    cal.current.add(a.obs);
    const n = plausibleFaces(a.faces).length;
    setHint(n === 0 ? 'We can’t see your face — sit in front of the camera.' : n > 1 ? 'Make sure only you are in view of the camera.' : null);
    const elapsed = performance.now() - started.current;
    setProgress(Math.min(cal.current.progress(), elapsed / MIN_MS));
    if ((cal.current.ready() && elapsed >= MIN_MS) || elapsed > GIVE_UP_MS) {
      done.current = true;
      onDone(cal.current.result());
    }
  });

  // Without camera analysis there is nothing to calibrate.
  useEffect(() => {
    if (!vs.loading && !vs.vision?.face && !done.current) {
      done.current = true;
      onDone(null);
    }
  }, [vs.loading, vs.vision, onDone]);

  return (
    <div className="stack" data-testid="calibration-step">
      <h1>Hold still and look at the screen</h1>
      <p>We are measuring your normal sitting position so that ordinary movements are not mistaken for looking away. This takes a few seconds.</p>
      <div className="cand-setup">
        <CameraPreview stream={camera.stream} className="cand-preview-large" />
        <div className="stack">
          <div className="cand-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Calibration progress">
            <div className="cand-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="cand-guidance" role="status" aria-live="polite">
            {hint ?? 'Look at the middle of the screen, as you will during the exam.'}
          </p>
        </div>
      </div>
    </div>
  );
}
