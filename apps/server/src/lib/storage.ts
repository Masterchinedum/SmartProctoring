import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';

/**
 * Blob storage for (already encrypted) evidence. Keys are relative paths made of [A-Za-z0-9._-/] segments.
 * Implementations: local filesystem (single host / shared volume) and S3-compatible object storage.
 */
export interface BlobStorage {
  readonly driver: 'fs' | 's3' | 'memory';
  put(key: string, data: Buffer): Promise<void>;
  /** null when the blob does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  close?(): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.length > 512) throw new Error(`Invalid storage key: ${key}`);
}

export class FsStorage implements BlobStorage {
  readonly driver = 'fs' as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    assertValidKey(key);
    const p = resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + sep)) throw new Error('Storage key escapes storage root');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  /** Test helper: remove everything. */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
  /** Absolute path of a key (tests / diagnostics). */
  resolveKey(key: string): string {
    return this.path(key);
  }
}

export class MemoryStorage implements BlobStorage {
  readonly driver = 'memory' as const;
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    assertValidKey(key);
    this.blobs.set(key, Buffer.from(data));
  }
  async get(key: string) {
    return this.blobs.get(key) ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

type S3Config = Extract<Config['storage'], { driver: 's3' }>;

export class S3Storage implements BlobStorage {
  readonly driver = 's3' as const;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;
  constructor(private readonly cfg: S3Config) {}

  private async client() {
    this.clientPromise ??= import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: this.cfg.region,
          endpoint: this.cfg.endpoint ?? undefined,
          forcePathStyle: this.cfg.forcePathStyle,
          credentials:
            this.cfg.accessKeyId && this.cfg.secretAccessKey ? { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } : undefined,
        }),
    );
    return this.clientPromise;
  }
  private objectKey(key: string): string {
    assertValidKey(key);
    return this.cfg.prefix ? `${this.cfg.prefix}/${key}` : key;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key), Body: data, ContentType: 'application/octet-stream', ServerSideEncryption: undefined }),
    );
  }
  async get(key: string): Promise<Buffer | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    try {
      const res = await c.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
  }
  async close(): Promise<void> {
    if (this.clientPromise) (await this.clientPromise).destroy();
  }
}

export function createStorage(cfg: Config['storage']): BlobStorage {
  return cfg.driver === 's3' ? new S3Storage(cfg) : new FsStorage(cfg.dir);
}

/** Storage key layout: org/<orgId>/<scope>/<id>.bin */
export function evidenceStorageKey(orgId: string, sessionId: string | null, candidateId: string | null, evidenceId: string): string {
  const scope = sessionId ? `s/${sessionId}` : candidateId ? `c/${candidateId}` : 'misc';
  return join('o', orgId, scope, `${evidenceId}.bin`).split(sep).join('/');
}
