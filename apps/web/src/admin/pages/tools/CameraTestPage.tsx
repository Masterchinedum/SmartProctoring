import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_IDENTITY_THRESHOLDS, type IdentityTestResponse, type NormBox } from '@sp/shared';
import { facesFromMediapipe, plausibleFaces } from '@sp/detection';
import { api } from '../../api/client';
import { useAuth } from '../../auth';
import { PageHeader } from '../../components/Common';
import { DECISION_LABELS, qualityIssueLabel } from '../../lib/labels';
import { formatSimilarity } from '../../lib/format';
import { barPercent, EVIDENCE_STATE_LABELS, evidenceTone, selfTestErrorMessage, similarityBand, summarizeProbes, type ProbeRecord, type SimilarityScale } from '../../lib/cameraTest';
import { AnalysisFrame, captureFaceCrop } from '../../../candidate/monitoring/frames';
import { loadVision, type Vision } from '../../../candidate/monitoring/vision';

/**
 * Tools → Camera & identity test (/admin/tools/camera-test, reviewer+).
 *
 * Validates the identity pipeline with the operator's own webcam, exactly as an exam would: the camera at
 * 1280×720, a live face box, face-centred native-resolution crops (like the candidate app), enrolment frames
 * (mode=enroll), then probe bursts every ~1.5 s (mode=probe) showing similarity, decision, per-sample LLR and
 * the accumulated evidence. POST /api/admin/tools/identity-test — nothing is stored (transient in-memory
 * gallery per staff user, 15 minutes); only the use of the tool is audit-logged.
 */

const ENROL_FRAMES = 8;
const ENROL_SPACING_MS = 380;
const PROBE_EVERY_MS = 1500;
const PROBE_BURST = 2;
const PROBE_BURST_SPACING_MS = 220;
const HISTORY = 40;

function newTestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function CameraTestPage() {
  const { isAdmin } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [camInfo, setCamInfo] = useState<{ width: number; height: number; label: string } | null>(null);
  const [vision, setVision] = useState<Vision | null>(null);
  const [live, setLive] = useState<{ faces: number; box: NormBox | null; brightness: number | null; yaw: number | null }>({ faces: 0, box: null, brightness: null, yaw: null });
  const boxRef = useRef<NormBox | null>(null);
  const [testId, setTestId] = useState(newTestId);
  const [enrolled, setEnrolled] = useState(0);
  const [busy, setBusy] = useState<'enrol' | 'reset' | null>(null);
  const [probing, setProbing] = useState(false);
  const probingRef = useRef(false);
  const [last, setLast] = useState<IdentityTestResponse | null>(null);
  const [lastRoundTrip, setLastRoundTrip] = useState<number | null>(null);
  const [history, setHistory] = useState<ProbeRecord[]>([]);
  const [message, setMessage] = useState<{ tone: 'info' | 'warning' | 'danger' | 'success'; text: string } | null>(null);
  const [scale, setScale] = useState<SimilarityScale>({ min: 0, max: 1, match: DEFAULT_IDENTITY_THRESHOLDS.match, mismatch: DEFAULT_IDENTITY_THRESHOLDS.mismatch });

  /* ------------------------------------------------------------ org thresholds (admins can read settings) */
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api
      .settings()
      .then((s) => alive && setScale((x) => ({ ...x, match: s.identityThresholds.match, mismatch: s.identityThresholds.mismatch })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  /* ------------------------------------------------------------ camera */
  const startCamera = useCallback(async () => {
    setCamError(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        await new Promise<void>((resolve) => {
          if (v.readyState >= 2 && v.videoWidth) resolve();
          else v.addEventListener('loadeddata', () => resolve(), { once: true });
        });
        const track = stream.getVideoTracks()[0];
        setCamInfo({ width: v.videoWidth, height: v.videoHeight, label: track?.label ?? '' });
      }
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setCamError(name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this page and try again.' : 'The camera could not be started. Check that it is connected and not in use by another application.');
    }
  }, []);

  useEffect(() => {
    void startCamera();
    return () => {
      probingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [startCamera]);

  /* ------------------------------------------------------------ live face box (MediaPipe, downscaled) */
  useEffect(() => {
    let alive = true;
    loadVision()
      .then((v) => alive && setVision(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!vision?.face) return;
    const frame = new AnalysisFrame();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const step = () => {
      if (!alive) return;
      const v = videoRef.current;
      try {
        const small = v && v.readyState >= 2 && v.videoWidth ? frame.draw(v) : null;
        const res = small ? vision.detectFaces(small) : null;
        if (res && small) {
          const faces = plausibleFaces(facesFromMediapipe(res, null, { width: small.width, height: small.height }));
          const f = faces.length === 1 ? faces[0] : (faces[0] ?? null);
          boxRef.current = faces.length === 1 ? f!.box : null;
          setLive({ faces: faces.length, box: f?.box ?? null, brightness: null, yaw: f ? f.yaw : null });
        }
      } catch {
        /* ignore a failed frame */
      }
      timer = setTimeout(step, 150);
    };
    step();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [vision]);

  /* ------------------------------------------------------------ server calls */
  const send = useCallback(
    async (mode: 'enroll' | 'probe'): Promise<{ res: IdentityTestResponse; ms: number } | null> => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return null;
      const crop = await captureFaceCrop(v, boxRef.current);
      if (!crop) return null;
      const t0 = performance.now();
      const res = await api.identityTest(testId, mode, crop.blob);
      return { res, ms: Math.round(performance.now() - t0) };
    },
    [testId],
  );

  const enrol = async () => {
    setBusy('enrol');
    setMessage({ tone: 'info', text: 'Enrolling: look at the screen and move your head slightly (a little left, right, up, down) …' });
    let accepted = 0;
    try {
      for (let i = 0; i < ENROL_FRAMES; i++) {
        const out = await send('enroll');
        if (out) {
          setLast(out.res);
          setLastRoundTrip(out.ms);
          setEnrolled(out.res.enrolledFrames);
          if (out.res.quality?.usable) accepted++;
        }
        await sleep(ENROL_SPACING_MS);
      }
      setHistory([]);
      setMessage(
        accepted > 0
          ? { tone: 'success', text: `Enrolled ${accepted} of ${ENROL_FRAMES} frames. Now start the live comparison.` }
          : { tone: 'warning', text: 'No frame was usable for enrolment — see the quality issues and guidance below, then try again.' },
      );
    } catch (e) {
      setMessage({ tone: 'danger', text: selfTestErrorMessage(e) ?? 'Enrolment failed.' });
    } finally {
      setBusy(null);
    }
  };

  const probeLoop = async () => {
    while (probingRef.current) {
      const started = performance.now();
      for (let i = 0; i < PROBE_BURST && probingRef.current; i++) {
        try {
          const out = await send('probe');
          if (out) {
            const r = out.res;
            setLast(r);
            setLastRoundTrip(out.ms);
            setHistory((h) =>
              [
                ...h,
                {
                  at: Date.now(),
                  similarity: r.similarity,
                  decision: r.decision,
                  llr: r.llr,
                  evidence: r.evidence,
                  issues: r.quality?.issues ?? [],
                  analyzeMs: r.timingsMs?.analyze ?? 0,
                  roundTripMs: out.ms,
                },
              ].slice(-HISTORY),
            );
          }
        } catch (e) {
          probingRef.current = false;
          setProbing(false);
          setMessage({ tone: 'danger', text: selfTestErrorMessage(e) ?? 'The comparison failed.' });
          return;
        }
        if (i < PROBE_BURST - 1) await sleep(PROBE_BURST_SPACING_MS);
      }
      await sleep(Math.max(100, PROBE_EVERY_MS - (performance.now() - started)));
    }
  };

  const toggleProbe = () => {
    if (probingRef.current) {
      probingRef.current = false;
      setProbing(false);
      return;
    }
    probingRef.current = true;
    setProbing(true);
    setMessage(null);
    void probeLoop();
  };

  const reset = async () => {
    probingRef.current = false;
    setProbing(false);
    setBusy('reset');
    try {
      await api.identityTest(testId, 'reset');
    } catch {
      /* a fresh test id is used anyway */
    }
    setTestId(newTestId());
    setEnrolled(0);
    setLast(null);
    setHistory([]);
    setMessage({ tone: 'info', text: 'Reset. Enrol a person to start a new test.' });
    setBusy(null);
  };

  /* ------------------------------------------------------------ render */
  const q = last?.quality ?? null;
  const ev = last?.evidence ?? null;
  const summary = summarizeProbes(history);
  const band = similarityBand(last?.mode === 'probe' ? last.similarity : null, scale);
  const aspect = camInfo ? `${camInfo.width} / ${camInfo.height}` : '16 / 9';

  return (
    <div className="stack camera-test-page">
      <PageHeader title="Camera & identity test" subtitle="Check the identity pipeline with your own webcam — as an exam would see it." />
      <div className="guidance">
        <div className="guidance-title">How to use this page</div>
        <ol className="plain-list" style={{ listStyle: 'decimal', paddingLeft: 20 }}>
          <li>
            Person A sits in front of the camera in ordinary light and selects <strong>Enrol</strong> (about 3 seconds; move your head slightly while it captures).
          </li>
          <li>
            Select <strong>Start live comparison</strong>. Person A should stay “same person” with the evidence <em>consistent</em>.
          </li>
          <li>
            Person B sits down (quickly, without leaving a long gap): the evidence should move to <em>suspect</em> and then <em>confirmed</em> within a few seconds.
          </li>
          <li>With person A again, try lighting changes (lamp off, window behind you): expect “could not verify” with guidance — never a different person.</li>
        </ol>
        <p className="small muted" style={{ marginTop: 6 }}>
          Nothing is stored: frames are analysed and discarded, the enrolment lives in memory for 15 minutes and only for you. The audit log records that the
          tool was used, never images or scores.
        </p>
      </div>

      {camError && (
        <div className="banner banner-danger" role="alert">
          {camError}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void startCamera()}>
            Try again
          </button>
        </div>
      )}
      {message && (
        <div className={`banner banner-${message.tone}`} role="status" data-testid="camera-test-message">
          {message.text}
        </div>
      )}

      <div className="grid-2">
        <section className="card stack">
          <h2>Camera</h2>
          <div className="camtest-preview" style={{ aspectRatio: aspect }}>
            <div className="camtest-mirror">
              <video ref={videoRef} muted playsInline autoPlay aria-label="Your camera preview (mirrored)" />
              {live.box && (
                <div
                  className={`camtest-box${live.faces === 1 ? '' : ' camtest-box-warn'}`}
                  style={{ left: `${live.box.x * 100}%`, top: `${live.box.y * 100}%`, width: `${live.box.w * 100}%`, height: `${live.box.h * 100}%` }}
                  aria-hidden="true"
                />
              )}
            </div>
          </div>
          <div className="small" data-testid="camera-test-camera">
            {camInfo ? (
              <>
                {camInfo.width}×{camInfo.height} {camInfo.label ? `· ${camInfo.label}` : ''} · faces in view: <strong>{live.faces}</strong>
                {live.yaw != null && <> · yaw {live.yaw.toFixed(0)}°</>}
                {!vision?.face && vision && ' · live face box unavailable in this browser'}
              </>
            ) : (
              'Starting the camera…'
            )}
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void enrol()} disabled={!camInfo || busy !== null || probing} data-testid="camera-test-enrol">
              {busy === 'enrol' ? 'Enrolling…' : enrolled > 0 ? 'Enrol more frames' : 'Enrol'}
            </button>
            <button type="button" className="btn" onClick={toggleProbe} disabled={!camInfo || enrolled === 0 || busy !== null} data-testid="camera-test-probe">
              {probing ? 'Stop live comparison' : 'Start live comparison'}
            </button>
            <button type="button" className="btn" onClick={() => void reset()} disabled={busy !== null} data-testid="camera-test-reset">
              Reset
            </button>
          </div>
          <div className="small muted">Enrolled frames: {enrolled}</div>
        </section>

        <section className="card stack" data-testid="camera-test-result">
          <h2>Result</h2>
          {!last ? (
            <p className="muted">Enrol a person to see the image quality; start the live comparison to see similarity and evidence.</p>
          ) : (
            <>
              {last.mode === 'probe' && (
                <>
                  <div className="stats-row">
                    <div className={`stat stat-${band === 'match' ? 'success' : band === 'mismatch' ? 'danger' : 'warning'}`}>
                      <div className="stat-value" data-testid="camera-test-similarity">
                        {formatSimilarity(last.similarity)}
                      </div>
                      <div className="stat-label">Similarity</div>
                    </div>
                    <div className="stat">
                      <div className="stat-value">{last.decision ? DECISION_LABELS[last.decision] : '—'}</div>
                      <div className="stat-label">Decision (this sample)</div>
                    </div>
                    <div className="stat">
                      <div className="stat-value">{last.llr != null ? (last.llr >= 0 ? '+' : '') + last.llr.toFixed(2) : '—'}</div>
                      <div className="stat-label">LLR (+ = different person)</div>
                    </div>
                  </div>
                  <div className="sim-scale" aria-label="Similarity scale">
                    <div className="sim-zone zone-mismatch" style={{ left: 0, width: `${barPercent(scale.mismatch, scale)}%` }}>
                      <span>Different person</span>
                    </div>
                    <div className="sim-zone zone-inconclusive" style={{ left: `${barPercent(scale.mismatch, scale)}%`, width: `${barPercent(scale.match, scale) - barPercent(scale.mismatch, scale)}%` }}>
                      <span>Inconclusive</span>
                    </div>
                    <div className="sim-zone zone-match" style={{ left: `${barPercent(scale.match, scale)}%`, width: `${100 - barPercent(scale.match, scale)}%` }}>
                      <span>Same person</span>
                    </div>
                    <div className="sim-threshold" style={{ left: `${barPercent(scale.mismatch, scale)}%` }}>
                      <span>{scale.mismatch.toFixed(2)}</span>
                    </div>
                    <div className="sim-threshold" style={{ left: `${barPercent(scale.match, scale)}%` }}>
                      <span>{scale.match.toFixed(2)}</span>
                    </div>
                    {history.slice(-12).map((h, i) =>
                      h.similarity != null ? <div key={i} className={`sim-point point-${h.decision ?? 'unable_to_verify'}`} style={{ left: `${barPercent(h.similarity, scale)}%`, opacity: 0.35 + (0.65 * (i + 1)) / 12 }} /> : null,
                    )}
                  </div>
                  <div className="sim-axis small muted">
                    <span>{scale.min.toFixed(2)}</span>
                    <span>{scale.max.toFixed(2)}</span>
                  </div>
                  {ev && (
                    <div className={`banner banner-${evidenceTone(ev.state)}`} data-testid="camera-test-evidence" data-state={ev.state}>
                      <strong>{EVIDENCE_STATE_LABELS[ev.state]}</strong> — probability of a different person {(ev.swapProbability * 100).toFixed(1)} % over {ev.samples} sample
                      {ev.samples === 1 ? '' : 's'}.
                    </div>
                  )}
                </>
              )}
              <h3>Image quality</h3>
              {q ? (
                <table className="kv-table">
                  <tbody>
                    <tr>
                      <th scope="row">Usable</th>
                      <td>{q.usable ? 'Yes' : 'No'}</td>
                    </tr>
                    <tr>
                      <th scope="row">Issues</th>
                      <td>{q.issues.length ? q.issues.map(qualityIssueLabel).join(', ') : 'None'}</td>
                    </tr>
                    <tr>
                      <th scope="row">Faces / detector score</th>
                      <td>
                        {q.faceCount} / {q.detectionScore.toFixed(2)}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Eye distance</th>
                      <td>{q.interEyePx.toFixed(0)} px</td>
                    </tr>
                    <tr>
                      <th scope="row">Brightness / contrast</th>
                      <td>
                        {q.brightness.toFixed(0)} / {q.contrast.toFixed(1)}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Sharpness{q.detail != null ? ' / detail' : ''}</th>
                      <td>
                        {q.sharpness.toFixed(0)}
                        {q.detail != null ? ` / ${q.detail.toFixed(2)}` : ''}
                        {q.noise != null ? ` (noise ${q.noise.toFixed(1)})` : ''}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Head pose</th>
                      <td>
                        yaw {q.yawDeg.toFixed(0)}°, pitch {q.pitchDeg.toFixed(0)}°
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="muted">No face analysed in the last frame.</p>
              )}
              {last.guidance.length > 0 && (
                <ul className="guidance-list" data-testid="camera-test-guidance">
                  {last.guidance.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              )}
              <p className="small muted">
                Server analysis {last.timingsMs?.analyze ?? '—'} ms · round trip {lastRoundTrip ?? '—'} ms
              </p>
            </>
          )}
        </section>
      </div>

      {history.length > 0 && (
        <section className="card stack">
          <h2>Recent probes</h2>
          <p className="small muted">
            {summary.count} probes · similarity mean {formatSimilarity(summary.meanSimilarity)} (min {formatSimilarity(summary.minSimilarity)}, max {formatSimilarity(summary.maxSimilarity)}) ·{' '}
            {Object.entries(summary.byDecision)
              .map(([k, n]) => `${k in DECISION_LABELS ? DECISION_LABELS[k as keyof typeof DECISION_LABELS] : k}: ${n}`)
              .join(' · ')}{' '}
            · median round trip {summary.medianRoundTripMs ?? '—'} ms
          </p>
          <table className="events-table" data-testid="camera-test-history">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Similarity</th>
                <th scope="col">Decision</th>
                <th scope="col">LLR</th>
                <th scope="col">Evidence</th>
                <th scope="col">Quality issues</th>
                <th scope="col">Timing</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().slice(0, 15).map((h, i) => (
                <tr key={i}>
                  <td>{new Date(h.at).toLocaleTimeString()}</td>
                  <td>{formatSimilarity(h.similarity)}</td>
                  <td>{h.decision ? DECISION_LABELS[h.decision] : '—'}</td>
                  <td>{h.llr != null ? h.llr.toFixed(2) : '—'}</td>
                  <td>{h.evidence ? `${h.evidence.state} (${(h.evidence.swapProbability * 100).toFixed(0)} %)` : '—'}</td>
                  <td>{h.issues.length ? h.issues.map(qualityIssueLabel).join(', ') : '—'}</td>
                  <td>
                    {h.analyzeMs} / {h.roundTripMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
