import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnswerValue,
  CandidateAnswerDTO,
  EventBatchResponse,
  EventUpsert,
  EvidenceUploadResponse,
  IdentityCheckTrigger,
  IdentitySampleResponse,
  SaveAnswerRequest,
  SaveAnswerResponse,
} from '@sp/shared';
import { CandidateApiError, classifyApiError, isServerBusy, type EvidenceUploadQuery, type IdentitySampleQuery, type JpegBody } from './api';

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
 *
 * Two kinds of "waiting" are deliberately NOT delivery failures (they never count towards `oldestAt`,
 * which drives the "live reporting is interrupted" signal for the candidate and for staff):
 *  - a *parked* answer: the server refused it because the exam is paused / on hold right now (typed in the
 *    seconds before this page learnt about a staff-approved pause or a hold). It stays pending and is
 *    re-sent once the exam is active again (`resumeAnswers`); only a refusal because the exam has ENDED
 *    drops it (reported through `onAnswerRefusedAfterEnd`).
 *  - a *busy* identity sample: in flight in the server's vision queue, or answered 503/429 (server busy).
 *    Samples are delivered in their own lane, so a slow vision queue never holds back answers, events or
 *    screenshots either.
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
  /**
   * The server refused it because the exam is paused / on hold (not a delivery failure): kept pending and
   * re-sent once the exam is active again. Persisted so a reopened page still knows.
   */
  parked?: boolean;
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
  /**
   * Queue time of the oldest undelivered item that is waiting for delivery — parked answers and busy
   * identity samples are not (see the file comment). Drives the "reporting interrupted" signal.
   */
  oldestAt: number | null;
  /** Undelivered answers (including parked ones). */
  pendingAnswers: number;
  /** Answers refused while the exam is paused / on hold, waiting for it to be active again. */
  parkedAnswers: number;
  /** Identity samples in the server's (busy) vision queue: in flight, or answered 503/429 and waiting to retry. */
  busySamples: number;
  /** Since when delivery attempts (answers, events, screenshots) have been failing (null when healthy). */
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
  /** First / longest wait before re-sending an identity sample the server answered with 503/429 (busy). */
  sampleBusyMinMs?: number;
  sampleBusyMaxMs?: number;
  /** Called with the server's answer to an identity sample delivered from the queue. */
  onSampleResult?: (sample: SampleRecord, res: IdentitySampleResponse) => void;
  /** Delivery hit an error that ends this page's ability to report (invalid link / superseded). */
  onFatal?: (kind: 'invalid_link' | 'superseded') => void;
  /** Permanently rejected items (for diagnostics). */
  onDropped?: (kind: 'answer' | 'event' | 'evidence' | 'sample', id: string, reason: string) => void;
  /** An answer was finally refused because the exam has ended (submitted / terminated): it is not saved. */
  onAnswerRefusedAfterEnd?: (questionId: string) => void;
}

type Listener = (s: OutboxStats) => void;

class FatalDeliveryError extends Error {
  constructor(readonly kind: 'invalid_link' | 'superseded') {
    super(kind);
  }
}

const EVENT_BATCH = 200;
const TERMINAL_STATUSES = new Set(['submitted', 'terminated']);

/** The answer was refused because the exam has ended (not merely paused / on hold). */
function refusedAfterEnd(e: unknown): boolean {
  if (!(e instanceof CandidateApiError)) return false;
  if (e.code === 'exam_ended') return true;
  const status = (e.details as { status?: unknown } | undefined)?.status;
  return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) return `${String((e as { code: unknown }).code)}: ${String((e as { message?: unknown }).message ?? '')}`;
  return e instanceof Error ? e.message : String(e);
}

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
  /** Questions whose pending answer is parked (refused while the exam is paused / on hold). */
  private readonly parked = new Set<string>();
  /** Identity samples answered 503/429 (server busy): not re-sent before `until`. */
  private readonly sampleWait = new Map<string, { until: number; delayMs: number }>();
  /** The identity sample whose request is open right now (waiting in the server's vision queue). */
  private sampleInFlight: string | null = null;
  /** Identity-sample lane (see `pumpSamples`). */
  private samplesTask: Promise<void> | null = null;
  private samplesTimer: ReturnType<typeof setTimeout> | null = null;
  private samplesTimerAt = Number.POSITIVE_INFINITY;
  /** Back-off of the sample lane after a real delivery failure (network / 5xx other than busy). */
  private samplesBackoffMs = 0;
  private samplesRetryAt = 0;

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
    for (const a of await this.backend.getAll('answers')) {
      if (!a.pending) continue;
      this.pendingIndex.set(`answer:${a.questionId}`, a.enqueuedAt ?? this.now());
      if (a.parked) this.parked.add(a.questionId);
    }
  }

  /* ---------------------------------------------------------------- stats */

  stats(): OutboxStats {
    let oldest: number | null = null;
    let answers = 0;
    let parked = 0;
    let busy = 0;
    for (const [k, t] of this.pendingIndex) {
      if (k.startsWith('answer:')) {
        answers++;
        if (this.parked.has(k.slice('answer:'.length))) {
          parked++;
          continue; // waiting for the exam to be active again, not for the network
        }
      } else if (k.startsWith('sample:') && this.sampleBusy(k.slice('sample:'.length))) {
        busy++;
        continue; // waiting in the server's vision queue, not for the network
      }
      if (oldest === null || t < oldest) oldest = t;
    }
    return {
      size: this.pendingIndex.size,
      oldestAt: oldest,
      pendingAnswers: answers,
      parkedAnswers: parked,
      busySamples: busy,
      failingSince: this.failingSince,
      lastError: this.lastError,
      lastDeliveredAt: this.lastDeliveredAt,
      storage: this.backend.kind,
    };
  }

  private sampleBusy(id: string): boolean {
    return id === this.sampleInFlight || this.sampleWait.has(id);
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

  /**
   * Queue an identity sample whose direct request failed. `busy`: the server answered 503/429 (vision queue
   * full) — the sample waits before it is re-sent, and that wait is not a delivery delay.
   */
  async putSample(rec: { id: string; trigger: IdentityCheckTrigger; capturedAt: number; jpeg: Blob | ArrayBuffer | Uint8Array; busy?: boolean }): Promise<void> {
    const data = await toArrayBuffer(rec.jpeg);
    if (await this.backend.get('samples', rec.id)) return;
    const t = this.now();
    await this.backend.put('blobs', { id: rec.id, data });
    await this.backend.put('samples', { id: rec.id, trigger: rec.trigger, capturedAt: rec.capturedAt, bytes: data.byteLength, enqueuedAt: t });
    if (rec.busy) this.markSampleBusy(rec.id);
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
      // A parked answer was not waiting for the network: the new edit starts its own delivery clock.
      queuedAt = cur?.pending && !cur.parked && cur.enqueuedAt != null ? cur.enqueuedAt : t;
      return { questionId: a.questionId, value: a.value, clientSeq: a.clientSeq, answeredAt: a.answeredAt, pending: true, enqueuedAt: queuedAt };
    });
    if (!next) return false;
    this.parked.delete(a.questionId); // a new edit is tried (again) right away
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
    if (cur && !cur.pending) {
      this.pendingIndex.delete(`answer:${a.questionId}`);
      this.parked.delete(a.questionId);
    }
    this.emit();
  }

  /**
   * The exam is active again (or has ended): re-send the answers that were refused while it was paused /
   * on hold. The server accepts any answeredAt while the exam is active, and the clientSeq still keeps a
   * stale value from overwriting a newer one. Their delivery clock restarts now (the time spent parked was
   * not a delivery delay). In-memory state changes synchronously; the flag is persisted in the background.
   */
  resumeAnswers(): Promise<void> {
    if (this.parked.size === 0) return Promise.resolve();
    const t = this.now();
    const ids = [...this.parked];
    this.parked.clear();
    for (const qid of ids) if (this.pendingIndex.has(`answer:${qid}`)) this.pendingIndex.set(`answer:${qid}`, t);
    this.emit();
    if (this.running) this.schedule(0);
    return (async () => {
      for (const qid of ids) {
        await this.backend
          .update('answers', qid, (cur) => {
            if (!cur?.parked) return null;
            const { parked: _parked, ...rest } = cur;
            return { ...rest, enqueuedAt: rest.pending ? t : null };
          })
          .catch(() => null);
      }
    })();
  }

  /**
   * Give up on undelivered answers this page can no longer deliver because the exam has ended (e.g. the
   * browser was closed with an answer still queued, and the exam ended before it was reopened). An answer
   * the server already holds (same or newer clientSeq in `server`) simply counts as delivered.
   * Returns how many answers were NOT saved. The local copy is kept.
   */
  async abandonPendingAnswers(server: CandidateAnswerDTO[] | null): Promise<number> {
    const onServer = new Map((server ?? []).map((a) => [a.questionId, a.clientSeq] as const));
    let lost = 0;
    for (const a of await this.backend.getAll('answers')) {
      if (!a.pending) continue;
      if ((onServer.get(a.questionId) ?? -1) < a.clientSeq) {
        lost++;
        this.opts.onDropped?.('answer', a.questionId, 'exam_ended_before_delivery');
      }
      await this.settleAnswer(a.questionId, a.clientSeq);
    }
    this.emit();
    return lost;
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
    this.sampleWait.delete(id);
  }

  /* ---------------------------------------------------------------- delivery */

  /**
   * One delivery pass over everything queued. Each kind is delivered independently (a failing answer
   * never holds back events or screenshots, and vice versa): answers first (most important), then
   * events, then evidence (after events so the event exists server-side), then identity samples.
   * Within a kind the pass stops at the first transient failure; permanently rejected items are
   * dropped (reported via onDropped). The first transient error is rethrown at the end so the worker
   * backs off. Parked answers and identity samples waiting after a "server busy" answer are skipped and
   * are not failures.
   *
   * The background worker runs the identity samples in their own lane (`samples: false` here) because
   * a sample can wait many seconds in the server's vision queue.
   */
  async flushOnce(sender: OutboxSender, opts: { samples?: boolean } = {}): Promise<{ delivered: number; remaining: number }> {
    let delivered = 0;
    let transient: unknown = null;
    const run = async (deliver: () => Promise<number>) => {
      try {
        delivered += await deliver();
      } catch (e) {
        if (e instanceof FatalDeliveryError) throw e;
        transient ??= e;
      }
    };
    await run(() => this.flushAnswers(sender));
    await run(() => this.flushEvents(sender));
    await run(() => this.flushEvidence(sender));
    if (opts.samples !== false) await run(() => this.flushSamples(sender));
    if (delivered > 0) this.lastDeliveredAt = this.now();
    this.emit();
    if (transient) throw transient;
    return { delivered, remaining: this.pendingIndex.size };
  }

  private async flushAnswers(sender: OutboxSender): Promise<number> {
    let n = 0;
    const answers = (await this.backend.getAll('answers'))
      .filter((a) => a.pending && !this.parked.has(a.questionId))
      .sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
    for (const a of answers) {
      if (this.parked.has(a.questionId)) continue;
      try {
        await sender.saveAnswer(a.questionId, { value: a.value, clientSeq: a.clientSeq, answeredAt: a.answeredAt });
      } catch (e) {
        const verdict = this.answerRefusal(e);
        if (verdict === 'park') {
          // Paused / on hold on the server (this page may not know yet): keep it, re-send when active.
          await this.parkAnswer(a.questionId, a.clientSeq);
          continue;
        }
        if (verdict === 'ended' || verdict === 'drop') {
          // The exam has ended (or the value is invalid): it can never be saved. The local copy is kept.
          await this.settleAnswer(a.questionId, a.clientSeq);
          this.opts.onDropped?.('answer', a.questionId, errorText(e));
          if (verdict === 'ended') this.opts.onAnswerRefusedAfterEnd?.(a.questionId);
          continue;
        }
        throw e;
      }
      await this.markAnswerDelivered(a.questionId, a.clientSeq);
      n++;
    }
    return n;
  }

  private async parkAnswer(questionId: string, clientSeq: number): Promise<void> {
    const next = await this.backend.update('answers', questionId, (cur) => {
      if (!cur || !cur.pending || cur.clientSeq !== clientSeq) return null; // a newer edit was queued meanwhile: try that one
      return { ...cur, parked: true };
    });
    if (next) this.parked.add(questionId);
    this.emit();
  }

  private async flushEvents(sender: OutboxSender): Promise<number> {
    let n = 0;
    const events = (await this.backend.getAll('events')).sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.upsert.startedAt - b.upsert.startedAt);
    for (let i = 0; i < events.length; i += EVENT_BATCH) {
      const batch = events.slice(i, i + EVENT_BATCH);
      let res: EventBatchResponse | null = null;
      try {
        res = await sender.sendEvents(batch.map((r) => r.upsert));
      } catch (e) {
        if (!this.permanent(e, 'event')) throw e;
        // The batch as a whole was refused (e.g. one invalid item): isolate the bad item(s).
        for (const r of batch) {
          try {
            const single = await sender.sendEvents([r.upsert]);
            await this.applyEventResults([r], single);
            n++;
          } catch (e2) {
            if (!this.permanent(e2, 'event')) throw e2;
            await this.removeEventIfVersion(r.id, r.upsert.version);
            this.opts.onDropped?.('event', r.id, errorText(e2));
          }
        }
        continue;
      }
      n += await this.applyEventResults(batch, res);
    }
    return n;
  }

  private async flushEvidence(sender: OutboxSender): Promise<number> {
    let n = 0;
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
        if (this.permanent(e, 'evidence')) {
          await this.removeEvidence(ev.id);
          this.opts.onDropped?.('evidence', ev.id, errorText(e));
          continue;
        }
        throw e;
      }
      await this.removeEvidence(ev.id);
      n++;
      this.lastDeliveredAt = this.now();
      this.emit();
    }
    return n;
  }

  /**
   * Identity samples (oldest first). While a request is open the sample waits in the server's vision
   * queue — that is not a delivery delay. A 503/429 answer (server busy) makes it wait (2 s, doubling, up
   * to 60 s) without counting as a failure; the pass stops there, as the next ones would be refused too.
   */
  private async flushSamples(sender: OutboxSender): Promise<number> {
    let n = 0;
    const samples = (await this.backend.getAll('samples')).sort((a, b) => a.capturedAt - b.capturedAt);
    for (const s of samples) {
      if ((this.sampleWait.get(s.id)?.until ?? 0) > this.now()) continue;
      const blob = await this.backend.get('blobs', s.id);
      if (!blob) {
        await this.removeSample(s.id);
        continue;
      }
      let res: IdentitySampleResponse;
      this.sampleInFlight = s.id;
      this.emit();
      try {
        res = await sender.identitySample(s.id, blob.data, { trigger: s.trigger, capturedAt: s.capturedAt });
      } catch (e) {
        // A sample the server will not take in the current state (e.g. captured after a pause began)
        // is only meaningful in near real time: drop it rather than retry forever.
        if (this.permanent(e, 'sample')) {
          await this.removeSample(s.id);
          this.opts.onDropped?.('sample', s.id, errorText(e));
          continue;
        }
        if (isServerBusy(e)) {
          this.markSampleBusy(s.id);
          break;
        }
        this.sampleWait.delete(s.id); // a real delivery failure: it counts as delayed again
        throw e;
      } finally {
        this.sampleInFlight = null;
        this.emit();
      }
      await this.removeSample(s.id);
      n++;
      this.emit();
      try {
        this.opts.onSampleResult?.(s, res);
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  private markSampleBusy(id: string): void {
    const min = this.opts.sampleBusyMinMs ?? 2000;
    const max = this.opts.sampleBusyMaxMs ?? 60_000;
    const prev = this.sampleWait.get(id);
    const delayMs = prev ? Math.min(max, prev.delayMs * 2) : min;
    this.sampleWait.set(id, { until: this.now() + delayMs, delayMs });
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
    await this.settleAnswer(questionId, clientSeq);
    this.lastDeliveredAt = this.now();
    this.emit();
  }

  /** This version of the answer is no longer pending (delivered, or finally refused); the local copy stays. */
  private async settleAnswer(questionId: string, clientSeq: number): Promise<void> {
    const next = await this.backend.update('answers', questionId, (cur) => {
      if (!cur || cur.clientSeq !== clientSeq) return null; // newer edit pending
      const { parked: _parked, ...rest } = cur;
      return { ...rest, pending: false, enqueuedAt: null };
    });
    if (next) {
      this.pendingIndex.delete(`answer:${questionId}`);
      this.parked.delete(questionId);
    }
  }

  /**
   * Classify a delivery error: true => drop the item, false => keep & retry. Errors that end this
   * page's ability to report (invalid link, superseded) throw FatalDeliveryError.
   * `invalid_state` (409: exam paused/held/ended) is permanent for identity samples — the server applies
   * its own late-delivery rules and a late sample is meaningless. (Answers: see `answerRefusal`.)
   */
  private permanent(e: unknown, item: 'event' | 'evidence' | 'sample'): boolean {
    const kind = classifyApiError(e);
    if (kind === 'invalid_link' || kind === 'superseded') throw new FatalDeliveryError(kind);
    if (kind === 'client') return true;
    if (kind === 'invalid_state' && item === 'sample') return true;
    return false;
  }

  /**
   * What to do with an answer the server refused:
   *  - 'park'  — the exam is paused / on hold (409 invalid_state): keep it, re-send once it is active again;
   *  - 'ended' — the exam has ended (409 exam_ended / terminal status): it can never be saved;
   *  - 'drop'  — the value itself is invalid (4xx): it can never be saved;
   *  - 'retry' — transient (network, 5xx, this browser not verified yet): retry with back-off.
   */
  private answerRefusal(e: unknown): 'park' | 'ended' | 'drop' | 'retry' {
    const kind = classifyApiError(e);
    if (kind === 'invalid_link' || kind === 'superseded') throw new FatalDeliveryError(kind);
    if (kind === 'client') return 'drop';
    if (kind === 'invalid_state') return refusedAfterEnd(e) ? 'ended' : 'park';
    return 'retry';
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
    if (this.samplesTimer) clearTimeout(this.samplesTimer);
    this.samplesTimer = null;
    this.samplesTimerAt = Number.POSITIVE_INFINITY;
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
    this.pumpSamples();
  }

  private changed(): void {
    this.emit();
    this.kick();
  }

  private onOnline(): void {
    this.backoffMs = 0;
    this.samplesBackoffMs = 0;
    this.samplesRetryAt = 0;
    this.schedule(0);
    this.pumpSamples();
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

  /** Answers (not parked), events or screenshots to deliver — the work of the main lane. */
  private hasMainWork(): boolean {
    for (const k of this.pendingIndex.keys()) {
      if (k.startsWith('sample:')) continue;
      if (k.startsWith('answer:') && this.parked.has(k.slice('answer:'.length))) continue;
      return true;
    }
    return false;
  }

  private async runWorker(): Promise<void> {
    if (!this.running || !this.sender) return;
    this.pumpSamples();
    if (!this.hasMainWork()) return;
    if (!this.gate()) {
      this.schedule(2000);
      return;
    }
    try {
      await this.flush();
      this.backoffMs = 0;
      if (this.hasMainWork()) this.schedule(1000);
    } catch (e) {
      if (e instanceof FatalDeliveryError) return;
      const min = this.opts.minBackoffMs ?? 1000;
      const max = this.opts.maxBackoffMs ?? 30_000;
      this.backoffMs = this.backoffMs === 0 ? min : Math.min(max, this.backoffMs * 2);
      this.schedule(this.backoffMs);
    }
  }

  private setFatal(kind: 'invalid_link' | 'superseded'): void {
    if (this.fatal) return;
    this.fatal = kind;
    this.stop();
    this.opts.onFatal?.(kind);
  }

  /**
   * Single-flight flush of answers, events and screenshots; concurrent callers share the running pass
   * (and trigger one more pass). Also starts the identity-sample lane.
   */
  flush(): Promise<void> {
    if (this.fatal) return Promise.reject(new FatalDeliveryError(this.fatal));
    if (!this.sender) return Promise.resolve();
    this.pumpSamples();
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    const sender = this.sender;
    const run = async () => {
      do {
        this.rerun = false;
        try {
          await this.flushOnce(sender, { samples: false });
          this.failingSince = null;
          this.lastError = null;
        } catch (e) {
          if (e instanceof FatalDeliveryError) {
            this.setFatal(e.kind);
            throw e;
          }
          if (this.failingSince === null) this.failingSince = this.now();
          this.lastError = e instanceof Error ? e.message : String(e);
          this.emit();
          throw e;
        }
      } while (this.rerun && this.hasMainWork());
    };
    this.inflight = run().finally(() => {
      this.inflight = null;
      this.emit();
    });
    return this.inflight;
  }

  /* ---------------------------------------------------------------- identity-sample lane */

  /** Earliest time a queued identity sample may be sent (null: none queued). */
  private nextSampleDueAt(): number | null {
    let due: number | null = null;
    for (const k of this.pendingIndex.keys()) {
      if (!k.startsWith('sample:')) continue;
      const at = this.sampleWait.get(k.slice('sample:'.length))?.until ?? 0;
      if (due === null || at < due) due = at;
    }
    return due === null ? null : Math.max(due, this.samplesRetryAt);
  }

  private armSamples(delayMs: number): void {
    if (!this.running) return;
    const at = this.now() + delayMs;
    if (this.samplesTimer && this.samplesTimerAt <= at) return;
    if (this.samplesTimer) clearTimeout(this.samplesTimer);
    this.samplesTimerAt = at;
    this.samplesTimer = setTimeout(() => {
      this.samplesTimer = null;
      this.samplesTimerAt = Number.POSITIVE_INFINITY;
      this.pumpSamples();
    }, Math.max(0, delayMs));
  }

  /**
   * Identity samples are delivered in their own single-flight lane: a sample can wait many seconds in the
   * server's vision queue, and that must never hold back answers, events or screenshots.
   */
  private pumpSamples(): void {
    if (!this.running || !this.sender || this.fatal || this.samplesTask) return;
    const due = this.nextSampleDueAt();
    if (due === null) return;
    const wait = due - this.now();
    if (wait > 0) {
      this.armSamples(wait);
      return;
    }
    if (!this.gate()) {
      this.armSamples(2000);
      return;
    }
    const sender = this.sender;
    this.samplesTask = (async () => {
      try {
        await this.flushSamples(sender);
        this.samplesBackoffMs = 0;
        this.samplesRetryAt = 0;
      } catch (e) {
        if (e instanceof FatalDeliveryError) {
          this.setFatal(e.kind);
          return;
        }
        const min = this.opts.minBackoffMs ?? 1000;
        const max = this.opts.maxBackoffMs ?? 30_000;
        this.samplesBackoffMs = this.samplesBackoffMs === 0 ? min : Math.min(max, this.samplesBackoffMs * 2);
        this.samplesRetryAt = this.now() + this.samplesBackoffMs;
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    })().finally(() => {
      this.samplesTask = null;
      this.emit();
      this.pumpSamples();
    });
  }

  /**
   * Try to deliver everything now, waiting at most `timeoutMs`. Resolves true when the outbox is
   * empty (or only the given kinds remain undelivered = false). Never throws. Gives up at once when
   * everything that remains is parked answers (the exam is paused / on hold on the server: they cannot be
   * delivered now).
   */
  async flushNow(timeoutMs: number, only?: 'answers'): Promise<boolean> {
    const remaining = () => (only === 'answers' ? this.stats().pendingAnswers : this.pendingIndex.size);
    const done = () => remaining() === 0;
    const blocked = () => this.parked.size > 0 && remaining() === this.parked.size;
    if (done()) return true;
    if (!this.sender || this.fatal || blocked()) return false;
    const deadline = this.now() + timeoutMs;
    let delay = 250;
    while (this.now() < deadline) {
      try {
        await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
      } catch {
        /* retry until the deadline */
      }
      if (done()) return true;
      if (this.fatal || blocked()) return false;
      const wait = Math.min(delay, Math.max(0, deadline - this.now()));
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, 1000);
    }
    return done();
  }
}
