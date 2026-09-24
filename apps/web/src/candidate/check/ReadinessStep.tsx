import { useCallback, useEffect, useRef, useState } from 'react';
import { isVirtualCameraLabel } from '@sp/detection';
import { useController, useSnapshot } from '../context';
import { CameraPreview, ScreenHeading, Spinner } from '../components/common';
import { allRequiredPass, evaluateReadiness, ReadinessSmoother, warnings, type ReadinessItem } from './readiness';
import { useFrameAnalysis } from './useFrameAnalysis';

/**
 * Camera setup: camera picker, live (mirrored) preview and a checklist that updates live.
 */
export function ReadinessStep({ onReady, intro }: { onReady: () => void; intro?: string }) {
  const ctrl = useController();
  const { camera } = useSnapshot();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [items, setItems] = useState<ReadinessItem[] | null>(null);
  const smoother = useRef(new ReadinessSmoother());
  const virtual = isVirtualCameraLabel(camera.info?.label ?? '');

  useEffect(() => {
    if (!ctrl.camera.state.wanted || (ctrl.camera.state.state !== 'live' && !ctrl.camera.state.starting)) void ctrl.camera.start();
  }, [ctrl]);

  const refreshCameras = useCallback(() => {
    void ctrl.camera.listCameras().then(setCameras);
  }, [ctrl]);
  useEffect(() => {
    refreshCameras();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameras);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshCameras);
  }, [refreshCameras, camera.generation]);

  useEffect(() => smoother.current.reset(), [camera.generation]);

  const vs = useFrameAnalysis(camera.state === 'live', (a) => {
    const raw = evaluateReadiness({
      cameraState: ctrl.camera.state.state,
      framesFlowing: a.framesFlowing,
      faces: a.faces,
      frame: a.obs.frame,
      faceRegion: a.faceRegion,
      virtualCamera: isVirtualCameraLabel(ctrl.camera.state.info?.label ?? ''),
    });
    setItems(smoother.current.push(raw));
  });

  // Without the camera or model, show the camera part of the checklist only.
  const shown: ReadinessItem[] =
    camera.state !== 'live' || !items
      ? evaluateReadiness({ cameraState: camera.state, framesFlowing: false, faces: [], frame: null, faceRegion: null, virtualCamera: virtual })
      : items;
  const analysisUnavailable = !vs.loading && !vs.vision?.face;
  const ready = camera.state === 'live' && (analysisUnavailable ? true : allRequiredPass(shown));
  const firstFailing = shown.find((i) => i.required && !i.ok);
  // Borderline picture: the candidate may continue (the server judges usability and guides live), with advice.
  const warn = ready && !analysisUnavailable ? warnings(shown).filter((w) => w.id !== 'real_camera') : [];

  return (
    <div className="stack">
      <ScreenHeading>Camera check</ScreenHeading>
      {intro && <p>{intro}</p>}
      <p className="muted">
        Sit where you will take the exam, in a well-lit place, with your face in the middle of the picture. The preview is mirrored like a mirror; nothing is recorded
        at this step. Only a working camera and your face (alone in view) are required to continue — the other items are advice.
      </p>
      <div className="cand-setup">
        <div className="stack">
          <CameraPreview stream={camera.stream} className="cand-preview-large" label="Your camera preview (mirrored)" />
          <label>
            Camera
            <select
              value={camera.info?.deviceId ?? ''}
              onChange={(e) => void ctrl.camera.start(e.target.value)}
              disabled={camera.starting || cameras.length === 0}
              data-testid="camera-select"
            >
              {cameras.length === 0 && <option value="">No camera found</option>}
              {cameras.map((c, i) => (
                <option key={c.deviceId || i} value={c.deviceId}>
                  {c.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          {camera.problem && (
            <div className="banner banner-warning" role="alert">
              {camera.problem}
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" onClick={() => void ctrl.camera.start()}>
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="stack">
          <h2>Checklist</h2>
          {vs.loading && <Spinner label="Loading the camera check…" />}
          {/* Not a live region (it updates with every analysed frame); the status line below is. */}
          <ul className="cand-checklist" data-testid="readiness-checklist">
            {shown.map((it) => (
              <li key={it.id} className={it.ok ? 'ok' : it.required ? 'fail' : 'warn'} data-item={it.id} data-ok={it.ok ? '1' : '0'}>
                <span className="cand-check-icon" aria-hidden="true">
                  {it.ok ? '✓' : it.required ? '•' : '!'}
                </span>
                <div>
                  <div>
                    {it.label}
                    <span className="sr-only">{it.ok ? ' — OK' : it.required ? ' — not yet' : ' — warning'}</span>
                  </div>
                  {!it.ok && <div className="muted small">{it.guidance}</div>}
                </div>
              </li>
            ))}
          </ul>
          {analysisUnavailable && (
            <div className="banner banner-info">
              The automatic camera check could not start in this browser. You can continue — the image will be checked when you verify your identity.
            </div>
          )}
          {/* Persistent live region: the current instruction is announced (politely) when it changes. */}
          <div role="status" aria-atomic="true" className="cand-live-slot" data-testid="readiness-status">
            {firstFailing && !analysisUnavailable ? (
              <p className="cand-guidance">{firstFailing.guidance}</p>
            ) : ready && !analysisUnavailable && warn.length > 0 ? (
              <p className="cand-guidance" data-testid="readiness-warning">
                You can continue. For the best result: {warn[0].guidance}
              </p>
            ) : ready && !analysisUnavailable ? (
              <p className="cand-status-ok">All checks passed. Select Continue.</p>
            ) : null}
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary btn-lg" disabled={!ready} onClick={onReady} data-testid="readiness-continue">
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
