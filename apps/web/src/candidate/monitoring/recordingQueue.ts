import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RecordingSegmentUploadResponse, RecordingStream } from '@sp/shared';
import { classifyApiError } from '../api';

/**
 * Offline-safe queue of finished recording segments (exam recording, policy.recording).
 *
 * Every segment is written to IndexedDB first (its own database per session, apart from the answers / events outbox so
 * big media never delays them) and uploaded oldest first, one at a time, with back-off on failures (1 s doubling to
 * 30 s; at once when the browser comes back online). Upload is idempotent on the server (session, stream, recording
 * instance, seq), so a re-send after an ambiguous failure is harmless. A reopened page finds what the previous one
 * queued and uploads it (as that page: the segment keeps the instance that recorded it).
 *
 * Bounded: above `maxBytes` (500 MB) the OLDEST segments are dropped and reported (`onDropped(…, 'device_storage_full')`
 * → a recording_interrupted event, so reviewers see the gap). The server's refusals are final: a part it will never
 * take (recording closed, not allowed, invalid) is dropped; the session cap (413 recording_limit) also calls
 * `onLimit` so recording stops. Waiting for a check in this browser ("check_required") is not a failure: the gate
 * keeps uploads back until the page may deliver again.
 */

export interface QueuedSegment {
  id: string;
  stream: RecordingStream;
  seq: number;
  startedAt: number;
  durationMs: number;
  mimeType: string;
  /** The browser instance that recorded it. */
  instanceId: string;
  bytes: number;
  enqueuedAt: number;
}

interface BlobRecord {
  id: string;
  data: Blob | ArrayBuffer;
}

interface RecordingDB extends DBSchema {
  segments: { key: string; value: QueuedSegment };
  blobs: { key: string; value: BlobRecord };
}

/** Storage behind the queue: IndexedDB, or memory where IndexedDB is unavailable (private windows, tests). */
interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  put(seg: QueuedSegment, data: Blob | ArrayBuffer): Promise<void>;
  all(): Promise<QueuedSegment[]>;
  blob(id: string): Promise<Blob | ArrayBuffer | undefined>;
  remove(id: string): Promise<void>;
  close(): void;
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private readonly segs = new Map<string, QueuedSegment>();
  private readonly blobs = new Map<string, Blob | ArrayBuffer>();
  async put(seg: QueuedSegment, data: Blob | ArrayBuffer) {
    this.blobs.set(seg.id, data);
    this.segs.set(seg.id, seg);
  }
  async all() {
    return [...this.segs.values()];
  }
  async blob(id: string) {
    return this.blobs.get(id);
  }
  async remove(id: string) {
    this.segs.delete(id);
    this.blobs.delete(id);
  }
  close() {}
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBPDatabase<RecordingDB>) {}
  async put(seg: QueuedSegment, data: Blob | ArrayBuffer) {
    // ArrayBuffers: Safari's IndexedDB has stored Blobs unreliably (the outbox does the same). Read before the
    // transaction opens: awaiting anything else inside it would let it commit early.
    const stored = await toArrayBuffer(data);
    const tx = this.db.transaction(['segments', 'blobs'], 'readwrite');
    await Promise.all([tx.objectStore('blobs').put({ id: seg.id, data: stored }), tx.objectStore('segments').put(seg), tx.done]);
  }
  async all() {
    return this.db.getAll('segments');
  }
  async blob(id: string) {
    return (await this.db.get('blobs', id))?.data;
  }
  async remove(id: string) {
    const tx = this.db.transaction(['segments', 'blobs'], 'readwrite');
    await Promise.all([tx.objectStore('segments').delete(id), tx.objectStore('blobs').delete(id), tx.done]);
  }
  close() {
    this.db.close();
  }
}

async function toArrayBuffer(data: Blob | ArrayBuffer): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  if (typeof data.arrayBuffer === 'function') return data.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(data);
  });
}

async function openBackend(namespace: string, memory: boolean): Promise<Backend> {
  if (memory || typeof indexedDB === 'undefined') return new MemoryBackend();
  try {
    const db = await Promise.race([
      openDB<RecordingDB>(`sp-recording-${namespace}`, 1, {
        upgrade(d) {
          d.createObjectStore('segments', { keyPath: 'id' });
          d.createObjectStore('blobs', { keyPath: 'id' });
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('indexeddb open timeout')), 4000)),
    ]);
    return new IdbBackend(db);
  } catch {
    return new MemoryBackend();
  }
}

export type DropReason = 'device_storage_full' | 'refused' | 'missing';

export interface RecordingQueueStats {
  /** Segments waiting for upload (also while delivery is not allowed yet). */
  pending: number;
  bytes: number;
  /** Since when uploads have been failing (null when healthy). */
  failingSince: number | null;
  lastError: string | null;
  storage: 'indexeddb' | 'memory';
}

export type SegmentSender = (seg: QueuedSegment, body: Blob) => Promise<RecordingSegmentUploadResponse>;

export interface RecordingQueueOptions {
  namespace: string;
  memory?: boolean;
  /** Largest amount kept on the device (default 500 MB). */
  maxBytes?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  uuid?: () => string;
  /** A segment was dropped without being stored on the server. */
  onDropped?: (seg: QueuedSegment, reason: DropReason, detail?: string) => void;
  /** The server's per-session recording cap was reached (413 recording_limit). */
  onLimit?: () => void;
  /** The page can no longer deliver anything (link invalid / superseded): uploads stop. */
  onFatal?: (kind: 'invalid_link' | 'superseded') => void;
}

export const DEFAULT_MAX_QUEUE_BYTES = 500 * 1024 * 1024;

export class RecordingQueue {
  private readonly listeners = new Set<(s: RecordingQueueStats) => void>();
  /** Index of queued segments (oldest first by start time), kept in memory. */
  private index: QueuedSegment[] = [];
  private sender: SegmentSender | null = null;
  private gate: () => boolean = () => true;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private task: Promise<void> | null = null;
  private backoffMs = 0;
  private failingSince: number | null = null;
  private lastError: string | null = null;
  private readonly onlineHandler = () => this.onOnline();

  private constructor(
    private readonly backend: Backend,
    private readonly opts: RecordingQueueOptions,
  ) {}

  static async open(opts: RecordingQueueOptions): Promise<RecordingQueue> {
    const q = new RecordingQueue(await openBackend(opts.namespace, !!opts.memory), opts);
    q.index = (await q.backend.all()).sort(order);
    return q;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  stats(): RecordingQueueStats {
    return { pending: this.index.length, bytes: this.index.reduce((n, s) => n + s.bytes, 0), failingSince: this.failingSince, lastError: this.lastError, storage: this.backend.kind };
  }

  subscribe(fn: (s: RecordingQueueStats) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.stats();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /** Queue a finished segment (stored on the device first), then upload it when possible. */
  async put(body: Blob, meta: Omit<QueuedSegment, 'id' | 'bytes' | 'enqueuedAt'>): Promise<void> {
    const seg: QueuedSegment = { ...meta, id: this.opts.uuid?.() ?? randomId(), bytes: body.size, enqueuedAt: this.now() };
    try {
      await this.backend.put(seg, body);
    } catch (err) {
      // The device is out of space (quota): the segment is lost; say so.
      this.opts.onDropped?.(seg, 'device_storage_full', err instanceof Error ? err.message : String(err));
      return;
    }
    this.index.push(seg);
    this.index.sort(order);
    await this.enforceLimit();
    this.emit();
    this.kick();
  }

  private async enforceLimit(): Promise<void> {
    const max = this.opts.maxBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    let total = this.index.reduce((n, s) => n + s.bytes, 0);
    while (total > max && this.index.length > 1) {
      const oldest = this.index[0];
      await this.drop(oldest, 'device_storage_full');
      total -= oldest.bytes;
    }
  }

  private async drop(seg: QueuedSegment, reason: DropReason, detail?: string): Promise<void> {
    await this.remove(seg.id);
    this.opts.onDropped?.(seg, reason, detail);
  }

  private async remove(id: string): Promise<void> {
    this.index = this.index.filter((s) => s.id !== id);
    try {
      await this.backend.remove(id);
    } catch {
      /* gone already */
    }
  }

  /** Delete every queued segment without sending it (the candidate withdrew consent). Returns how many. */
  async discardAll(): Promise<number> {
    const n = this.index.length;
    for (const s of [...this.index]) await this.remove(s.id);
    this.emit();
    return n;
  }

  /* ---------------------------------------------------------------- delivery */

  /** Start uploading. `gate` says whether this page may deliver now (the verified browser of the session). */
  start(sender: SegmentSender, gate: () => boolean = () => true): void {
    this.sender = sender;
    this.gate = gate;
    if (this.running) return;
    this.running = true;
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
  }

  close(): void {
    this.stop();
    this.backend.close();
  }

  /** Something changed (a segment queued, the gate may have opened): upload soon unless backing off. */
  kick(): void {
    if (!this.running) return;
    if (this.backoffMs === 0) this.schedule(0);
  }

  private onOnline(): void {
    this.backoffMs = 0;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(0, delayMs));
  }

  private run(): Promise<void> {
    if (this.task) return this.task;
    this.task = this.drain().finally(() => {
      this.task = null;
    });
    return this.task;
  }

  /** Upload oldest first until the queue is empty, the gate closes or an upload fails (then back off). */
  private async drain(): Promise<void> {
    while (this.running && this.sender && this.index.length) {
      if (!this.gate()) {
        this.schedule(2000);
        return;
      }
      const seg = this.index[0];
      const data = await this.backend.blob(seg.id);
      if (!data) {
        await this.drop(seg, 'missing');
        this.emit();
        continue;
      }
      const body = data instanceof Blob ? data : new Blob([data], { type: seg.mimeType });
      try {
        await this.sender(seg, body);
      } catch (err) {
        const outcome = this.refusal(err);
        if (outcome === 'fatal') {
          this.stop();
          return;
        }
        if (outcome === 'drop' || outcome === 'limit') {
          await this.drop(seg, 'refused', errorText(err));
          if (outcome === 'limit') this.opts.onLimit?.();
          this.emit();
          continue;
        }
        if (outcome === 'wait') {
          this.schedule(5000);
          return;
        }
        this.failingSince ??= this.now();
        this.lastError = errorText(err);
        const min = this.opts.minBackoffMs ?? 1000;
        const max = this.opts.maxBackoffMs ?? 30_000;
        this.backoffMs = this.backoffMs === 0 ? min : Math.min(max, this.backoffMs * 2);
        this.emit();
        this.schedule(this.backoffMs);
        return;
      }
      // Stored (or a duplicate, or a part the server does not keep — e.g. it started during a pause): done with it.
      await this.remove(seg.id);
      this.backoffMs = 0;
      this.failingSince = null;
      this.lastError = null;
      this.emit();
    }
  }

  /**
   * What a failed upload means:
   *  - 'retry': network, server error, rate limited — back off and try again;
   *  - 'wait': this browser must pass a check first (not verified yet) — try again later, not a failure;
   *  - 'limit': the session's recording cap (413 recording_limit);
   *  - 'drop': the server will never take this part (closed, not enabled, consent, invalid, too large);
   *  - 'fatal': the page can no longer deliver anything.
   */
  private refusal(err: unknown): 'retry' | 'wait' | 'limit' | 'drop' | 'fatal' {
    const kind = classifyApiError(err);
    const code = (err as { code?: string } | null)?.code;
    if (kind === 'invalid_link' || kind === 'superseded') {
      this.opts.onFatal?.(kind);
      return 'fatal';
    }
    if (kind === 'not_verified') return 'wait';
    if (code === 'recording_limit') return 'limit';
    if (kind === 'client' || kind === 'invalid_state') return 'drop';
    return 'retry';
  }

  /** Try to upload everything now, waiting at most `timeoutMs`. Resolves true when the queue is empty. */
  async flushNow(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.index.length && this.now() < deadline && this.running) {
      this.backoffMs = 0;
      await Promise.race([this.run(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
      if (!this.index.length) break;
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - this.now()))));
    }
    return this.index.length === 0;
  }
}

/** Oldest first by start time; a stream's own order by sequence number. */
function order(a: QueuedSegment, b: QueuedSegment): number {
  return a.startedAt - b.startedAt || a.seq - b.seq || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0);
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) return `${String((e as { code: unknown }).code)}: ${String((e as { message?: unknown }).message ?? '')}`;
  return e instanceof Error ? e.message : String(e);
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
