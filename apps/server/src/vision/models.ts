/**
 * Locating the ONNX model files in development (tsx, src/vision/*.ts), tests (vitest) and the bundled
 * server (tsup, dist/*.js), or wherever MODELS_DIR points.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const YUNET_MODEL_FILE = 'face_detection_yunet_2023mar.onnx';
export const SFACE_MODEL_FILE = 'face_recognition_sface_2021dec.onnx';

export class VisionModelsNotFoundError extends Error {
  constructor(readonly searched: string[]) {
    super(
      `Vision models (${YUNET_MODEL_FILE}, ${SFACE_MODEL_FILE}) not found. Set MODELS_DIR or pass modelsDir. Searched: ${searched.join(', ')}`,
    );
    this.name = 'VisionModelsNotFoundError';
  }
}

function hasModels(dir: string): boolean {
  return existsSync(resolve(dir, YUNET_MODEL_FILE)) && existsSync(resolve(dir, SFACE_MODEL_FILE));
}

/** Candidate directories, most specific first. */
export function modelDirCandidates(explicit?: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const list: string[] = [];
  if (explicit) list.push(resolve(explicit));
  if (process.env.MODELS_DIR) list.push(resolve(process.env.MODELS_DIR));
  list.push(
    resolve(here, '../../models'), // apps/server/src/vision -> apps/server/models
    resolve(here, '../models'), // apps/server/dist -> apps/server/models
    resolve(here, 'models'), // models copied next to the bundle
    resolve(here, '../../../models'),
    resolve(process.cwd(), 'models'),
    resolve(process.cwd(), 'apps/server/models'),
  );
  return [...new Set(list)];
}

/**
 * Resolve the models directory: the explicit directory if it holds both files, else MODELS_DIR, else
 * the first well-known location that does (the files are identical wherever they are found).
 */
export function resolveModelsDir(explicit?: string): string {
  const candidates = modelDirCandidates(explicit);
  for (const dir of candidates) if (hasModels(dir)) return dir;
  throw new VisionModelsNotFoundError(candidates);
}
