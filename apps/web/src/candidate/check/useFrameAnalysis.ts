import { useEffect, useRef, useState } from 'react';
import { createFrameMetricsTracker, facesFromMediapipe, regionStats } from '@sp/detection';
import type { FaceObservation, FrameObservation } from '@sp/shared';
import { useController } from '../context';
import { GraySampler, sameFrame, type GrayFrame } from '../monitoring/frames';
import { loadVision, type Vision } from '../monitoring/vision';

/**
 * Pre-exam camera analysis loop (readiness checklist, calibration, liveness guidance).
 * Uses the same models and conversion as the monitoring runtime, on the un-mirrored video.
 */

export interface FrameAnalysis {
  /** Server-corrected timestamp. */
  t: number;
  obs: FrameObservation;
  faces: FaceObservation[];
  gray: GrayFrame;
  /** Stats of the primary face region on the grayscale frame (brightness / contrast / sharpness). */
  faceRegion: { mean: number; std: number; sharpness: number } | null;
  videoWidth: number;
  videoHeight: number;
  /** New video frames arrived recently. */
  framesFlowing: boolean;
}

export interface VisionStatus {
  vision: Vision | null;
  loading: boolean;
  error: string | null;
}

/** Plausible face (same thresholds as the engine's people counting). */
export function plausibleFaces(faces: FaceObservation[]): FaceObservation[] {
  return faces.filter((f) => f.score >= 0.5 && f.box.w >= 0.035);
}

export function useVision(): VisionStatus {
  const [st, setSt] = useState<VisionStatus>({ vision: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    loadVision()
      .then((v) => alive && setSt({ vision: v, loading: false, error: v.face ? null : (v.faceError ?? 'Camera analysis is unavailable') }))
      .catch((e) => alive && setSt({ vision: null, loading: false, error: String((e as Error)?.message ?? e) }));
    return () => {
      alive = false;
    };
  }, []);
  return st;
}

export function useFrameAnalysis(enabled: boolean, onFrame: (a: FrameAnalysis) => void, intervalMs = 150): VisionStatus {
  const ctrl = useController();
  const vs = useVision();
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    if (!enabled || !vs.vision?.face) return;
    const vision = vs.vision;
    const sampler = new GraySampler();
    const metrics = createFrameMetricsTracker();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    let lastVideoTime = -1;
    let lastAdvance = 0;
    let generation = -1;
    let lastGray: Uint8Array | null = null;

    const step = () => {
      if (!alive) return;
      const t0 = performance.now();
      try {
        const cam = ctrl.camera;
        const video = cam.video;
        if (cam.state.generation !== generation) {
          generation = cam.state.generation;
          metrics.reset();
        }
        if (cam.isVideoReady()) {
          if (video.currentTime !== lastVideoTime) {
            lastVideoTime = video.currentTime;
            lastAdvance = performance.now();
          }
          let gray = sampler.sample(video);
          // Skip exact duplicates (camera slower than our sampling) so each frame is analysed once.
          if (gray && sameFrame(gray.data, lastGray)) gray = null;
          if (gray) lastGray = gray.data;
          const res = gray ? vision.detectFaces(video) : null;
          if (gray && res) {
            const frame = metrics.next(gray.data, gray.width, gray.height);
            const size = { width: video.videoWidth, height: video.videoHeight };
            const faces = facesFromMediapipe(res, gray, size);
            const primary = plausibleFaces(faces).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] ?? null;
            const t = ctrl.clock.now();
            cb.current({
              t,
              obs: { t, camera: 'live', frame, faces, objects: null },
              faces,
              gray,
              faceRegion: primary ? regionStats(gray.data, gray.width, gray.height, primary.box) : null,
              videoWidth: size.width,
              videoHeight: size.height,
              framesFlowing: performance.now() - lastAdvance < 1500,
            });
          }
        }
      } catch (e) {
        console.warn('[check] analysis failed', e);
      }
      const spent = performance.now() - t0;
      timer = setTimeout(step, Math.max(20, intervalMs - spent));
    };
    timer = setTimeout(step, 0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, vs.vision, ctrl, intervalMs]);

  return vs;
}
