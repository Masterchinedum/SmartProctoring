import type { AnswerValue, CandidateAnswerDTO, QuestionType } from '@sp/shared';
import type { AnswerRecord } from './outbox';

/**
 * Candidate answers: local state + debounced autosave through the outbox.
 *
 * Every save carries a strictly increasing `clientSeq` (one counter per session, seeded from the
 * highest sequence known locally or on the server), so the server can always keep the newest value
 * even when requests arrive out of order or are replayed after an outage.
 */

export interface AnswerSink {
  putAnswer(a: { questionId: string; value: AnswerValue; clientSeq: number; answeredAt: number }): Promise<boolean>;
  rememberDeliveredAnswer(a: { questionId: string; value: AnswerValue; clientSeq: number; answeredAt: number }): Promise<void>;
  getAnswers(): Promise<AnswerRecord[]>;
}

export interface AnswerStoreOptions {
  debounceMs?: number;
  now?: () => number;
}

export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Number.isFinite(value);
}

/** Normalises raw input into the value stored for a question type. */
export function normaliseAnswer(type: QuestionType, raw: unknown): AnswerValue {
  switch (type) {
    case 'single_choice':
      return typeof raw === 'string' && raw ? raw : null;
    case 'multiple_choice':
      return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string'))].sort() : [];
    case 'numeric': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
      if (typeof raw !== 'string') return null;
      const t = raw.trim().replace(',', '.');
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    default:
      return typeof raw === 'string' ? raw : raw == null ? null : String(raw);
  }
}

type Listener = () => void;

export class AnswerStore {
  private readonly values = new Map<string, AnswerValue>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirty = new Map<string, { value: AnswerValue; at: number }>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private writes: Promise<unknown> = Promise.resolve();
  private version = 0;

  constructor(
    private readonly sink: AnswerSink,
    opts: AnswerStoreOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 600;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Merge server answers with the local mirror. The higher clientSeq wins per question; a newer local
   * answer that the server has not acknowledged is re-queued.
   */
  async restore(server: CandidateAnswerDTO[] | null): Promise<void> {
    const local = await this.sink.getAnswers();
    const localById = new Map(local.map((a) => [a.questionId, a] as const));
    let maxSeq = this.seq;
    for (const a of local) maxSeq = Math.max(maxSeq, a.clientSeq);
    for (const a of server ?? []) maxSeq = Math.max(maxSeq, a.clientSeq);
    this.seq = maxSeq;

    const seen = new Set<string>();
    for (const s of server ?? []) {
      seen.add(s.questionId);
      const l = localById.get(s.questionId);
      if (l && l.clientSeq > s.clientSeq) {
        this.values.set(s.questionId, l.value);
        if (!l.pending) await this.sink.putAnswer({ questionId: l.questionId, value: l.value, clientSeq: ++this.seq, answeredAt: l.answeredAt });
      } else {
        this.values.set(s.questionId, s.value);
        await this.sink.rememberDeliveredAnswer({ questionId: s.questionId, value: s.value, clientSeq: s.clientSeq, answeredAt: s.savedAt });
      }
    }
    for (const l of local) {
      if (seen.has(l.questionId)) continue;
      this.values.set(l.questionId, l.value);
      // Local answer the server has never seen: make sure it is queued.
      if (!l.pending) await this.sink.putAnswer({ questionId: l.questionId, value: l.value, clientSeq: ++this.seq, answeredAt: l.answeredAt });
    }
    this.notify();
  }

  get(questionId: string): AnswerValue {
    return this.values.has(questionId) ? (this.values.get(questionId) as AnswerValue) : null;
  }

  isAnswered(questionId: string): boolean {
    return isAnswered(this.get(questionId));
  }

  answeredCount(questionIds: string[]): number {
    return questionIds.filter((id) => this.isAnswered(id)).length;
  }

  /** Current highest sequence number used. */
  get currentSeq(): number {
    return this.seq;
  }

  /** Monotonic change counter for React subscriptions. */
  get snapshotVersion(): number {
    return this.version;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Update an answer. The UI updates immediately; persistence is debounced per question. */
  set(questionId: string, value: AnswerValue): void {
    this.values.set(questionId, value);
    this.dirty.set(questionId, { value, at: this.now() });
    const prev = this.timers.get(questionId);
    if (prev) clearTimeout(prev);
    this.timers.set(
      questionId,
      setTimeout(() => {
        this.timers.delete(questionId);
        void this.persist(questionId);
      }, this.debounceMs),
    );
    this.notify();
  }

  private persist(questionId: string): Promise<unknown> {
    const d = this.dirty.get(questionId);
    if (!d) return this.writes;
    this.dirty.delete(questionId);
    const clientSeq = ++this.seq;
    // Serialise writes so sequence numbers reach storage in order.
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => this.sink.putAnswer({ questionId, value: d.value, clientSeq, answeredAt: d.at }));
    return this.writes;
  }

  /** Persist all debounced edits immediately (before pause/submit/unload). */
  async flushPending(): Promise<void> {
    for (const [qid, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(qid);
    }
    for (const qid of [...this.dirty.keys()]) void this.persist(qid);
    await this.writes.catch(() => undefined);
  }

  hasUnsavedEdits(): boolean {
    return this.dirty.size > 0;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }
}
