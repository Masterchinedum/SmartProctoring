import { FaceLandmarker, FilesetResolver, ObjectDetector, type FaceLandmarkerResult, type ObjectDetectorResult } from '@mediapipe/tasks-vision';

/**
 * Loads the in-browser vision models (self-hosted — never from a CDN):
 *   WASM fileset       /mediapipe/
 *   Face Landmarker    /models/face_landmarker.task      (Apache-2.0)
 *   Object detector    /models/efficientdet_lite0.tflite  (Apache-2.0, COCO labels)
 *
 * GPU delegate first, CPU fallback. Loading failures are reported (not thrown) so the exam can
 * continue with degraded monitoring.
 */

export const MEDIAPIPE_WASM_PATH = '/mediapipe';
export const FACE_MODEL_URL = '/models/face_landmarker.task';
export const OBJECT_MODEL_URL = '/models/efficientdet_lite0.tflite';

export type Delegate = 'GPU' | 'CPU';

export interface Vision {
  face: FaceLandmarker | null;
  objects: ObjectDetector | null;
  faceError: string | null;
  objectsError: string | null;
  faceDelegate: Delegate | null;
  objectsDelegate: Delegate | null;
  loadMs: number;
  /** Runs the face landmarker (VIDEO mode) — null if unavailable or it failed. */
  detectFaces(source: TexImageSource, nowMs?: number): FaceLandmarkerResult | null;
  detectObjects(source: TexImageSource, nowMs?: number): ObjectDetectorResult | null;
}

function preferredDelegates(): Delegate[] {
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(window.location.search).get('delegate') ?? localStorage.getItem('sp:delegate');
  } catch {
    /* ignore */
  }
  if (forced?.toLowerCase() === 'cpu') return ['CPU'];
  if (forced?.toLowerCase() === 'gpu') return ['GPU', 'CPU'];
  return ['GPU', 'CPU'];
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'unknown error';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

let visionPromise: Promise<Vision> | null = null;

/** Shared, lazily loaded vision models (one instance per page). */
export function loadVision(): Promise<Vision> {
  if (!visionPromise) visionPromise = createVision();
  return visionPromise;
}

async function createVision(): Promise<Vision> {
  const t0 = performance.now();
  let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  let faceError: string | null = null;
  let objectsError: string | null = null;
  try {
    fileset = await withTimeout(FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH), 30_000, 'vision runtime');
  } catch (e) {
    faceError = objectsError = `vision runtime failed to load: ${errMessage(e)}`;
  }

  let face: FaceLandmarker | null = null;
  let faceDelegate: Delegate | null = null;
  let objects: ObjectDetector | null = null;
  let objectsDelegate: Delegate | null = null;

  if (fileset) {
    for (const delegate of preferredDelegates()) {
      try {
        face = await withTimeout(
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
            runningMode: 'VIDEO',
            numFaces: 4,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
          60_000,
          'face model',
        );
        faceDelegate = delegate;
        faceError = null;
        break;
      } catch (e) {
        faceError = `face model failed to load (${delegate}): ${errMessage(e)}`;
      }
    }
    for (const delegate of preferredDelegates()) {
      try {
        objects = await withTimeout(
          ObjectDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: OBJECT_MODEL_URL, delegate },
            runningMode: 'VIDEO',
            scoreThreshold: 0.3,
            maxResults: 8,
          }),
          60_000,
          'object model',
        );
        objectsDelegate = delegate;
        objectsError = null;
        break;
      } catch (e) {
        objectsError = `object model failed to load (${delegate}): ${errMessage(e)}`;
      }
    }
  }

  // MediaPipe VIDEO mode requires strictly increasing timestamps per task.
  let lastFaceTs = 0;
  let lastObjTs = 0;
  const vision: Vision = {
    face,
    objects,
    faceError,
    objectsError,
    faceDelegate,
    objectsDelegate,
    loadMs: Math.round(performance.now() - t0),
    detectFaces(source, nowMs = performance.now()) {
      if (!vision.face) return null;
      const ts = Math.max(Math.round(nowMs), lastFaceTs + 1);
      lastFaceTs = ts;
      try {
        return vision.face.detectForVideo(source, ts);
      } catch (e) {
        console.warn('[vision] face detection failed', e);
        return null;
      }
    },
    detectObjects(source, nowMs = performance.now()) {
      if (!vision.objects) return null;
      const ts = Math.max(Math.round(nowMs), lastObjTs + 1);
      lastObjTs = ts;
      try {
        return vision.objects.detectForVideo(source, ts);
      } catch (e) {
        console.warn('[vision] object detection failed', e);
        return null;
      }
    },
  };
  return vision;
}
