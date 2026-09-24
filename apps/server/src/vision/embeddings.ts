/**
 * Versioned binary format for identity-reference embeddings (stored encrypted by the server).
 *
 *   offset size  field
 *   0      4     magic "SPEM"
 *   4      1     format version (1)
 *   5      1     model id (1 = SFace 2021dec, 128-d, L2-normalised)
 *   6      2     dimension (uint16 LE)
 *   8      2     count (uint16 LE)
 *   10     2     reserved (0)
 *   12     4*dim*count  float32 LE, row-major
 *
 * Embeddings from different models are not comparable; deserialisation refuses an unknown model id
 * unless `allowAnyModel` is set.
 */
import { RECIPE_V1, type EmbeddingRecipe } from './embed-prep';

export const EMBEDDING_MAGIC = 'SPEM';
export const EMBEDDING_FORMAT_VERSION = 1;
export const EMBEDDING_MODEL_SFACE_2021DEC = 1;

/** How the engine computes `ImageAnalysis.embedding` (embed-prep.ts). */
export const DEFAULT_EMBEDDING_RECIPE: Readonly<EmbeddingRecipe> = RECIPE_V1;
export const EMBEDDING_DIM = 128;
const HEADER = 12;
const MAX_COUNT = 1024;

export class EmbeddingFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingFormatError';
  }
}

export function serializeEmbeddings(embeddings: readonly Float32Array[], modelId = EMBEDDING_MODEL_SFACE_2021DEC): Buffer {
  if (embeddings.length > MAX_COUNT) throw new EmbeddingFormatError(`Too many embeddings (${embeddings.length})`);
  const dim = embeddings.length ? embeddings[0].length : EMBEDDING_DIM;
  if (dim < 1 || dim > 0xffff) throw new EmbeddingFormatError(`Bad embedding dimension ${dim}`);
  const buf = Buffer.alloc(HEADER + 4 * dim * embeddings.length);
  buf.write(EMBEDDING_MAGIC, 0, 'ascii');
  buf.writeUInt8(EMBEDDING_FORMAT_VERSION, 4);
  buf.writeUInt8(modelId, 5);
  buf.writeUInt16LE(dim, 6);
  buf.writeUInt16LE(embeddings.length, 8);
  buf.writeUInt16LE(0, 10);
  let off = HEADER;
  for (const e of embeddings) {
    if (e.length !== dim) throw new EmbeddingFormatError('All embeddings must have the same dimension');
    for (let i = 0; i < dim; i++) {
      if (!Number.isFinite(e[i])) throw new EmbeddingFormatError('Embedding contains a non-finite value');
      buf.writeFloatLE(e[i], off);
      off += 4;
    }
  }
  return buf;
}

export interface EmbeddingHeader {
  version: number;
  modelId: number;
  dim: number;
  count: number;
}

export function readEmbeddingHeader(buf: Buffer): EmbeddingHeader {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER) throw new EmbeddingFormatError('Embedding blob too short');
  if (buf.toString('ascii', 0, 4) !== EMBEDDING_MAGIC) throw new EmbeddingFormatError('Not an embedding blob (bad magic)');
  const version = buf.readUInt8(4);
  if (version !== EMBEDDING_FORMAT_VERSION) throw new EmbeddingFormatError(`Unsupported embedding format version ${version}`);
  return { version, modelId: buf.readUInt8(5), dim: buf.readUInt16LE(6), count: buf.readUInt16LE(8) };
}

export function deserializeEmbeddings(buf: Buffer, opts: { allowAnyModel?: boolean } = {}): Float32Array[] {
  const h = readEmbeddingHeader(buf);
  if (!opts.allowAnyModel && h.modelId !== EMBEDDING_MODEL_SFACE_2021DEC) throw new EmbeddingFormatError(`Embeddings were produced by an unknown model (${h.modelId})`);
  if (h.dim < 1) throw new EmbeddingFormatError('Bad embedding dimension');
  if (buf.length !== HEADER + 4 * h.dim * h.count) throw new EmbeddingFormatError('Embedding blob length does not match its header');
  const out: Float32Array[] = [];
  let off = HEADER;
  for (let k = 0; k < h.count; k++) {
    const e = new Float32Array(h.dim);
    for (let i = 0; i < h.dim; i++, off += 4) {
      const v = buf.readFloatLE(off);
      if (!Number.isFinite(v)) throw new EmbeddingFormatError('Embedding contains a non-finite value');
      e[i] = v;
    }
    out.push(e);
  }
  return out;
}
