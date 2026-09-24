import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnswerValue,
  EventBatchResponse,
  EventUpsert,
  EvidenceUploadResponse,
  IdentityCheckTrigger,
  IdentitySampleResponse,
  SaveAnswerRequest,
  SaveAnswerResponse,
} from '@sp/shared';
import { classifyApiError, type EvidenceUploadQuery, type IdentitySampleQuery, type JpegBody } from './api';

/**
 * Offline-safe outbox.
 *
 * Everything the candidate page reports (answers, event upserts, evidence screenshots, identity
 * samples) is written here FIRST and delivered by a flush worker. All endpoints are idempotent
 * (answers: highest clientSeq wins; events: highest version wins; evidence/samples: keyed by uuid),
 * so re-sending after an ambiguous failure never creates duplicates, and original timestamps travel
 * with each item.
 *
 * Storage: IndexedDB (one database per exam session) with an in-memory fallback when IndexedDB is
 * unavailable. Answers are ALSO the local mirror used to restore the candidate's work after a reload:
 * an answer record stays after delivery with `pending=false`.
 */

export type EvidenceReason = EvidenceUploadQuery['reason'];

export interface EventRecord {
  id: string;
  upsert: EventUpsert;
  /** When the earliest still-undelivered version of this event was queued. */
  enqueuedAt: number;
}

export interface EvidenceRecord {
  id: string;
  eventId: string;
  capturedAt: number;
  reason: EvidenceReason;
  bytes: number;
  enqueuedAt: number;
}

export interface SampleRecord {
  id: string;
  trigger: IdentityCheckTrigger;
  capturedAt: number;
  bytes: number;
  enqueuedAt: number;
}

export interface AnswerRecord {
  questionId: string;
  value: AnswerValue;
  clientSeq: number;
  answeredAt: number;
  /** Not yet acknowledged by the server. */
  pending: boolean;
  /** When this answer became pending (null once delivered). */
  enqueuedAt: number | null;
}

interface BlobRecord {
  id: string;
  data: ArrayBuffer;
}

interface OutboxDB extends DBSchema {
  events: { key: string; value: EventRecord };
  evidence: { key: string; value: EvidenceRecord };
  samples: { key: string; value: SampleRecord };
  answers: { key: string; value: AnswerRecord };
  blobs: { key: string; value: BlobRecord };
}

type StoreName = 'events' | 'evidence' | 'samples' | 'answers' | 'blobs';
type StoreValue<S extends StoreName> = OutboxDB[S]['value'];

/** Minimal storage abstraction so the same logic runs on IndexedDB and in memory. */
interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get<S extends StoreName>(store: S, key: string): Promise<StoreValue<S> | undefined>;
  put<S extends StoreName>(store: S, value: StoreValue<S>): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<S extends StoreName>(store: S): Promise<StoreValue<S>[]>;
  /** Atomic read-modify-write on one record. `fn` returns the new value, or null to leave it unchanged. */
  update<S extends StoreName>(store: S, key: string, fn: (cur: StoreValue<S> | undefined) => StoreValue<S> | null): Promise<StoreValue<S> | null>;
  close(): void;
}

const KEY_PATH: Record<StoreName, string> = { events: 'id', evidence: 'id', samples: 'id', answers: 'questionId', blobs: 'id' };

function keyOf(store: StoreName, value: unknown): string {
  return (value as Record<string, string>)[KEY_PATH[store]];
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private stores = new Map<StoreName, Map<string, unknown>>();

  private s(store: StoreName): Map<string, unknown> {
    let m = this.stores.get(store);
    if (!m) this.stores.set(store, (m = new Map()));
    return m;
  }

  async get<S extends StoreName>(store: S, key: string) {
    return this.s(store).get(key) as StoreValue<S> | undefined;
  }
  async put<S extends StoreName>(store: S, value: StoreValue<S>) {
    this.s(store).set(keyOf(store, value), value);
  }
  async delete(store: StoreName, key: string) {
    this.s(store).delete(key);
  }
  async getAll<S extends StoreName>(store: S) {
    return [...this.s(store).values()] as StoreValue<S>[];
  }
  async update<S extends StoreName>(store: S, key: string, fn: (cur: StoreValue<S> | undefined) => StoreValue<S> | null) {
    const next = fn(this.s(store).get(key) as StoreValue<S> | undefined);
    if (next) this.s(store).set(key, next);
    return next;
  }
  close() {}
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBPDatabase<OutboxDB>) {}

  async get<S extends StoreName>(store: S, key: string) {
    return (await this.db.get(store, key)) as StoreValue<S> | undefined;
  }
  async put<S extends StoreName>(store: S, value: StoreValue<S>) {
    await this.db.put(store, value as never);
  }
  async delete(store: StoreName, key: string) {
    await this.db.delete(store, key);
  }
  async getAll<S extends StoreName>(store: S) {
    return (await this.db.getAll(store)) as StoreValue<S>[];
  }
  async update<S extends StoreName>(store: S, key: string, fn: (cur: StoreValue<S> | undefined) => StoreValue<S> | null) {
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const cur = (await os.get(key)) as StoreValue<S> | undefined;
    const next = fn(cur);
    if (next) await os.put(next as never);
    await tx.done;
    return next;
  }
  close() {
    this.db.close();
  }
}

async function openBackend(namespace: string, preferMemory: boolean): Promise<Backend> {
  if (preferMemory || typeof indexedDB === 'undefined') return new MemoryBackend();
  try {
    const db = await Promise.race([
      openDB<OutboxDB>(`sp-candidate-${namespace}`, 1, {
        upgrade(db) {
          db.createObjectStore('events', { keyPath: 'id' });
          db.createObjectStore('evidence', { keyPath: 'id' });
          db.createObjectStore('samples', { keyPath: 'id' });
          db.createObjectStore('answers', { keyPath: 'questionId' });
          db.createObjectStore('blobs', { keyPath: 'id' });
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('indexeddb open timeout')), 4000)),
    ]);
    return new IdbBackend(db);
  } catch {
    return new MemoryBackend();
  }
}

/* ------------------------------------------------------------------ public API */

export interface OutboxSender {
  saveAnswer(questionId: string, req: SaveAnswerRequest): Promise<SaveAnswerResponse>;
  sendEvents(events: EventUpsert[]): Promise<EventBatchResponse>;
  uploadEvidence(evidenceId: string, jpeg: JpegBody, q: EvidenceUploadQuery): Promise<EvidenceUploadResponse>;
  identitySample(sampleId: string, jpeg: JpegBody, q: IdentitySampleQuery): Promise<IdentitySampleResponse>;
}

export interface OutboxStats {
  /** Undelivered items (answers + events + evidence + identity samples). */
  size: number;
  /** Queue time of the oldest undelivered item. */
  oldestAt: number | null;
  pendingAnswers: number;
  /** Since when delivery attempts have been failing (null when healthy). */
  failingSince: number | null;
  lastError: string | null;
  lastDeliveredAt: number | null;
  storage: 'indexeddb' | 'memory';
}

export interface OutboxOptions {
  /** Namespace (one database per session). */
  namespace: string;
  /** Force the in-memory backend (tests / private mode). */
  memory?: boolean;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Delay before a flush triggered by new items while healthy (coalesces bursts). */
  kickDelayMs?: number;
  maxEvidence?: number;
  maxEvidenceBytes?: number;
  maxSamples?: number;
  /** Called with the server's answer to an identity sample delivered from the queue. */
  onSampleResult?: (sample: SampleRecord, res: IdentitySampleResponse) => void;
  /** Delivery hit an error that ends this page's ability to report (invalid link / superseded). */
  onFatal?: (kind: 'invalid_link' | 'superseded') => void;
  /** Permanently rejected items (for diagnostics). */
  onDropped?: (kind: 'answer' | 'event' | 'evidence' | 'sample', id: string, reason: string) => void;
}

type Listener = (s: OutboxStats) => void;

class FatalDeliveryError extends Error {
  constructor(readonly kind: 'invalid_link' | 'superseded') {
    super(kind);
  }
}

const EVENT_BATCH = 200;

async function toArrayBuffer(body: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof Uint8Array) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  if (typeof body.arrayBuffer === 'function') return body.arrayBuffer();
  return new Response(body).arrayBuffer();
}

export class Outbox {
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  /** In-memory index of undelivered items: `${kind}:${id}` -> enqueuedAt. */
  private readonly pendingIndex = new Map<string, number>();
  private evidenceBytes = 0;
  private sender: OutboxSender | null = null;
  private gate: () => boolean = () => true;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private backoffMs = 0;
  private inflight: Promise<void> | null = null;
  private rerun = false;
  private failingSince: number | null = null;
  private lastError: string | null = null;
  private lastDeliveredAt: number | null = null;
  private fatal: 'invalid_link' | 'superseded' | null = null;
  private readonly onlineHandler = () => this.onOnline();

  private constructor(
    private readonly backend: Backend,
    private readonly opts: OutboxOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  static async open(opts: OutboxOptions): Promise<Outbox> {
    const backend = await openBackend(opts.namespace, !!opts.memory);
    const box = new Outbox(backend, opts);
    await box.loadIndex();
    return box;
  }

  get storage(): 'indexeddb' | 'memory' {
    return this.backend.kind;
  }

  private async loadIndex(): Promise<void> {
    for (const e of await this.backend.getAll('events')) this.pendingIndex.set(`event:${e.id}`, e.enqueuedAt);
    for (const e of await this.backend.getAll('evidence')) {
      this.pendingIndex.set(`evidence:${e.id}`, e.enqueuedAt);
      this.evidenceBytes += e.bytes;
    }
    for (const s of await this.backend.getAll('samples')) this.pendingIndex.set(`sample:${s.id}`, s.enqueuedAt);
    for (const a of await this.backend.getAll('answers')) if (a.pending) this.pendingIndex.set(`answer:${a.questionId}`, a.enqueuedAt ?? this.now());
  }

  /* ---------------------------------------------------------------- stats */

  stats(): OutboxStats {
    let oldest: number | null = null;
    let answers = 0;
    for (const [k, t] of this.pendingIndex) {
      if (oldest === null || t < oldest) oldest = t;
      if (k.startsWith('answer:')) answers++;
    }
    return {
      size: this.pendingIndex.size,
      oldestAt: oldest,
      pendingAnswers: answers,
      failingSince: this.failingSince,
      lastError: this.lastError,
      lastDeliveredAt: this.lastDeliveredAt,
      storage: this.backend.kind,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.stats();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* listener errors must not break delivery */
      }
    }
  }

  /* ---------------------------------------------------------------- enqueue */

  /** Queue an event upsert; an older or equal version never replaces a newer queued one. */
  async putEvent(upsert: EventUpsert): Promise<void> {
    const t = this.now();
    await this.backend.update('events', upsert.id, (cur) => {
      if (cur && cur.upsert.version >= upsert.version) return null;
      return { id: upsert.id, upsert, enqueuedAt: cur ? cur.enqueuedAt : t };
    });
    if (!this.pendingIndex.has(`event:${upsert.id}`)) this.pendingIndex.set(`event:${upsert.id}`, t);
    this.changed();
  }

  async putEvidence(rec: { id: string; eventId: string; capturedAt: number; reason: EvidenceReason; jpeg: Blob | ArrayBuffer | Uint8Array }): Promise<void> {
    const data = await toArrayBuffer(rec.jpeg);
    if (await this.backend.get('evidence', rec.id)) return; // idempotent
    const t = this.now();
    await this.backend.put('blobs', { id: rec.id, data });
    await this.backend.put('evidence', { id: rec.id, eventId: rec.eventId, capturedAt: rec.capturedAt, reason: rec.reason, bytes: data.byteLength, enqueuedAt: t });
    this.pendingIndex.set(`evidence:${rec.id}`, t);
    this.evidenceBytes += data.byteLength;
    await this.enforceEvidenceLimits();
    this.changed();
  }

  async putSample(rec: { id: string; trigger: IdentityCheckTrigger; capturedAt: number; jpeg: Blob | ArrayBuffer | Uint8Array }): Promise<void> {
    const data = await toArrayBuffer(rec.jpeg);
    if (await this.backend.get('samples', rec.id)) return;
    const t = this.now();
    await this.backend.put('blobs', { id: rec.id, data });
    await this.backend.put('samples', { id: rec.id, trigger: rec.trigger, capturedAt: rec.capturedAt, bytes: data.byteLength, enqueuedAt: t });
    this.pendingIndex.set(`sample:${rec.id}`, t);
    await this.enforceSampleLimit();
    this.changed();
  }

  /**
   * Record the latest answer for a question (local mirror + delivery queue). A lower clientSeq than
   * the stored one is ignored, so late writes can never roll an answer back.
   */
  async putAnswer(a: { questionId: string; value: AnswerValue; clientSeq: number; answeredAt: number }): Promise<boolean> {
    const t = this.now();
    let queuedAt = t;
    const next = await this.backend.update('answers', a.questionId, (cur) => {
      if (cur && cur.clientSeq >= a.clientSeq) return null;
      queuedAt = cur?.pending && cur.enqueuedAt != null ? cur.enqueuedAt : t;
      return { questionId: a.questionId, value: a.value, clientSeq: a.clientSeq, answeredAt: a.answeredAt, pending: true, enqueuedAt: queuedAt };
    });
    if (!next) return false;
    this.pendingIndex.set(`answer:${a.questionId}`, queuedAt);
    this.changed();
    return true;
  }

  /** Store an answer known to be on the server already (e.g. restored from the server state). */
  async rememberDeliveredAnswer(a: { questionId: string; value: AnswerValue; clientSeq: number; answeredAt: number }): Promise<void> {
    await this.backend.update('answers', a.questionId, (cur) => {
      if (cur && cur.clientSeq >= a.clientSeq) return null;
      return { ...a, pending: false, enqueuedAt: null };
    });
    const cur = await this.backend.get('answers', a.questionId);
    if (cur && !cur.pending) this.pendingIndex.delete(`answer:${a.questionId}`);
    this.emit();
  }

  async getAnswers(): Promise<AnswerRecord[]> {
    return this.backend.getAll('answers');
  }

  async pendingEvents(): Promise<EventRecord[]> {
    return this.backend.getAll('events');
  }

  private async enforceEvidenceLimits(): Promise<void> {
    const maxN = this.opts.maxEvidence ?? 250;
    const maxBytes = this.opts.maxEvidenceBytes ?? 40 * 1024 * 1024;
    const keys = [...this.pendingIndex.entries()].filter(([k]) => k.startsWith('evidence:'));
    if (keys.length <= maxN && this.evidenceBytes <= maxBytes) return;
    // Drop the oldest screenshots first; the events themselves are always kept.
    keys.sort((a, b) => a[1] - b[1]);
    let n = keys.length;
    for (const [k] of keys) {
      if (n <= maxN && this.evidenceBytes <= maxBytes) break;
      const id = k.slice('evidence:'.length);
      await this.removeEvidence(id);
      this.opts.onDropped?.('evidence', id, 'outbox_full');
      n--;
    }
  }

  private async enforceSampleLimit(): Promise<void> {
    const max = this.opts.maxSamples ?? 40;
    const keys = [...this.pendingIndex.entries()].filter(([k]) => k.startsWith('sample:')).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < keys.length - max; i++) {
      const id = keys[i][0].slice('sample:'.length);
      await this.removeSample(id);
      this.opts.onDropped?.('sample', id, 'outbox_full');
    }
  }

  private async removeEvidence(id: string): Promise<void> {
    const rec = await this.backend.get('evidence', id);
    await this.backend.delete('evidence', id);
    await this.backend.delete('blobs', id);
    if (this.pendingIndex.delete(`evidence:${id}`) && rec) this.evidenceBytes = Math.max(0, this.evidenceBytes - rec.bytes);
  }

  private async removeSample(id: string): Promise<void> {
    await this.backend.delete('samples', id);
    await this.backend.delete('blobs', id);
    this.pendingIndex.delete(`sample:${id}`);
  }

  /* ---------------------------------------------------------------- delivery */

  /**
   * One delivery pass over everything queued. Answers first (most important), then events, then
   * evidence (after events so the event exists server-side), then identity samples.
   * Throws on the first transient failure; permanently rejected items are dropped.
   */
  async flushOnce(sender: OutboxSender): Promise<{ delivered: number; remaining: number }> {
    let delivered = 0;

    // Answers
    const answers = (await this.backend.getAll('answers')).filter((a) => a.pending).sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
    for (const a of answers) {
      try {
        await sender.saveAnswer(a.questionId, { value: a.value, clientSeq: a.clientSeq, answeredAt: a.answeredAt });
      } catch (e) {
        if (this.permanent(e)) {
          await this.markAnswerDelivered(a.questionId, a.clientSeq);
          this.opts.onDropped?.('answer', a.questionId, String((e as Error).message));
          continue;
        }
        throw e;
      }
      await this.markAnswerDelivered(a.questionId, a.clientSeq);
      delivered++;
    }

    // Events (batched)
    const events = (await this.backend.getAll('events')).sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.upsert.startedAt - b.upsert.startedAt);
    for (let i = 0; i < events.length; i += EVENT_BATCH) {
      const batch = events.slice(i, i + EVENT_BATCH);
      let res: EventBatchResponse | null = null;
      try {
        res = await sender.sendEvents(batch.map((r) => r.upsert));
      } catch (e) {
        if (!this.permanent(e)) throw e;
        // The batch as a whole was refused (e.g. one invalid item): isolate the bad item(s).
        for (const r of batch) {
          try {
            const single = await sender.sendEvents([r.upsert]);
            await this.applyEventResults([r], single);
            delivered++;
          } catch (e2) {
            if (!this.permanent(e2)) throw e2;
            await this.removeEventIfVersion(r.id, r.upsert.version);
            this.opts.onDropped?.('event', r.id, String((e2 as Error).message));
          }
        }
        continue;
      }
      delivered += await this.applyEventResults(batch, res);
    }

    // Evidence
    const evidence = (await this.backend.getAll('evidence')).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    for (const ev of evidence) {
      if (this.pendingIndex.has(`event:${ev.eventId}`)) continue; // its event has not been accepted yet
      const blob = await this.backend.get('blobs', ev.id);
      if (!blob) {
        await this.removeEvidence(ev.id);
        continue;
      }
      try {
        await sender.uploadEvidence(ev.id, blob.data, { eventId: ev.eventId, capturedAt: ev.capturedAt, reason: ev.reason });
      } catch (e) {
        if (this.permanent(e)) {
          await this.removeEvidence(ev.id);
          this.opts.onDropped?.('evidence', ev.id, String((e as Error).message));
          continue;
        }
        throw e;
      }
      await this.removeEvidence(ev.id);
      delivered++;
      this.lastDeliveredAt = this.now();
      this.emit();
    }

    // Identity samples
    const samples = (await this.backend.getAll('samples')).sort((a, b) => a.capturedAt - b.capturedAt);
    for (const s of samples) {
      const blob = await this.backend.get('blobs', s.id);
      if (!blob) {
        await this.removeSample(s.id);
        continue;
      }
      let res: IdentitySampleResponse;
      try {
        res = await sender.identitySample(s.id, blob.data, { trigger: s.trigger, capturedAt: s.capturedAt });
      } catch (e) {
        // A sample the server will not take in the current state (e.g. captured after a pause began)
        // is only meaningful in near real time: drop it rather than retry forever.
        if (this.permanent(e) || classifyApiError(e) === 'invalid_state') {
          await this.removeSample(s.id);
          this.opts.onDropped?.('sample', s.id, String((e as Error).message));
          continue;
        }
        throw e;
      }
      await this.removeSample(s.id);
      delivered++;
      this.emit();
      try {
        this.opts.onSampleResult?.(s, res);
      } catch {
        /* ignore */
      }
    }

    if (delivered > 0) this.lastDeliveredAt = this.now();
    this.emit();
    return { delivered, remaining: this.pendingIndex.size };
  }

  private async applyEventResults(batch: EventRecord[], res: EventBatchResponse | null): Promise<number> {
    const byId = new Map((res?.results ?? []).map((r) => [r.id, r] as const));
    let n = 0;
    for (const r of batch) {
      const result = byId.get(r.id);
      // Unknown result for an item => treat as accepted (the endpoint is idempotent either way).
      if (result?.result === 'rejected') this.opts.onDropped?.('event', r.id, result.reason ?? 'rejected');
      await this.removeEventIfVersion(r.id, r.upsert.version);
      n++;
    }
    this.lastDeliveredAt = this.now();
    this.emit();
    return n;
  }

  private async removeEventIfVersion(id: string, version: number): Promise<void> {
    const cur = await this.backend.get('events', id);
    if (cur && cur.upsert.version > version) return; // a newer version was queued meanwhile
    await this.backend.delete('events', id);
    this.pendingIndex.delete(`event:${id}`);
  }

  private async markAnswerDelivered(questionId: string, clientSeq: number): Promise<void> {
    const next = await this.backend.update('answers', questionId, (cur) => {
      if (!cur || cur.clientSeq !== clientSeq) return null; // newer edit pending
      return { ...cur, pending: false, enqueuedAt: null };
    });
    if (next) this.pendingIndex.delete(`answer:${questionId}`);
    this.lastDeliveredAt = this.now();
    this.emit();
  }

  /** Classify a delivery error: true => drop the item, false => keep & retry. Fatal errors throw. */
  private permanent(e: unknown): boolean {
    const kind = classifyApiError(e);
    if (kind === 'invalid_link' || kind === 'superseded') throw new FatalDeliveryError(kind);
    return kind === 'client';
  }

  /* ---------------------------------------------------------------- worker */

  /** Start background delivery. `gate` says whether delivery is currently allowed (instance verified). */
  start(sender: OutboxSender, gate: () => boolean = () => true): void {
    this.sender = sender;
    this.gate = gate;
    if (this.running) return;
    this.running = true;
    this.fatal = null;
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
  }

  close(): void {
    this.stop();
    this.backend.close();
  }

  /** New items were queued or the gate may have opened. */
  kick(): void {
    if (!this.running) return;
    // While healthy deliver promptly; while failing, wait for the backoff timer (or 'online').
    if (this.backoffMs === 0) this.schedule(this.opts.kickDelayMs ?? 400);
  }

  private changed(): void {
    this.emit();
    this.kick();
  }

  private onOnline(): void {
    this.backoffMs = 0;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    const at = this.now() + delayMs;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      void this.runWorker();
    }, Math.max(0, delayMs));
  }

  private async runWorker(): Promise<void> {
    if (!this.running || !this.sender) return;
    if (this.pendingIndex.size === 0) return;
    if (!this.gate()) {
      this.schedule(2000);
      return;
    }
    try {
      await this.flush();
      this.backoffMs = 0;
      if (this.pendingIndex.size > 0) this.schedule(1000);
    } catch (e) {
      if (e instanceof FatalDeliveryError) return;
      const min = this.opts.minBackoffMs ?? 1000;
      const max = this.opts.maxBackoffMs ?? 30_000;
      this.backoffMs = this.backoffMs === 0 ? min : Math.min(max, this.backoffMs * 2);
      this.schedule(this.backoffMs);
    }
  }

  /** Single-flight flush; concurrent callers share the running pass (and trigger one more pass). */
  flush(): Promise<void> {
    if (this.fatal) return Promise.reject(new FatalDeliveryError(this.fatal));
    if (!this.sender) return Promise.resolve();
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    const sender = this.sender;
    const run = async () => {
      do {
        this.rerun = false;
        try {
          await this.flushOnce(sender);
          this.failingSince = null;
          this.lastError = null;
        } catch (e) {
          if (e instanceof FatalDeliveryError) {
            this.fatal = e.kind;
            this.stop();
            this.opts.onFatal?.(e.kind);
            throw e;
          }
          if (this.failingSince === null) this.failingSince = this.now();
          this.lastError = e instanceof Error ? e.message : String(e);
          this.emit();
          throw e;
        }
      } while (this.rerun && this.pendingIndex.size > 0);
    };
    this.inflight = run().finally(() => {
      this.inflight = null;
      this.emit();
    });
    return this.inflight;
  }

  /**
   * Try to deliver everything now, waiting at most `timeoutMs`. Resolves true when the outbox is
   * empty (or only the given kinds remain undelivered = false). Never throws.
   */
  async flushNow(timeoutMs: number, only?: 'answers'): Promise<boolean> {
    const done = () => (only === 'answers' ? this.stats().pendingAnswers === 0 : this.pendingIndex.size === 0);
    if (done()) return true;
    if (!this.sender || this.fatal) return false;
    const deadline = this.now() + timeoutMs;
    let delay = 250;
    while (this.now() < deadline) {
      try {
        await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
      } catch {
        /* retry until the deadline */
      }
      if (done()) return true;
      if (this.fatal) return false;
      const wait = Math.min(delay, Math.max(0, deadline - this.now()));
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, 1000);
    }
    return done();
  }
}
