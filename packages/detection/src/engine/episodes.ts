import type { EpisodeUpdate, EventType } from '@sp/shared';
import { clamp01 } from '../util/math';

/**
 * Episode lifecycle bookkeeping shared by all detectors.
 *
 * One "slot" per (detector, key) — e.g. 'phone_detected' or 'unauthorized_object:book'. A slot holds at
 * most one open episode. Rules:
 *  - begin(): emits phase 'open' (version 1, captureSnapshot 'onset'), or — when the previous episode in
 *    the same slot closed less than `mergeGapMs` before the new start — re-opens it: same episodeId,
 *    phase 'update', version+1, original startedAt, endedAt=null.
 *  - touch(): emits phase 'update' only when useful: a material change (throttled to one per
 *    `minUpdateMs`), a requested 'peak' snapshot (≥ `peakSpacingMs` apart), or a periodic snapshot every
 *    `periodicShotMs`. Snapshots are capped at `maxShots` per episode (onset included).
 *  - end(): emits phase 'close' with the real end time.
 *  - marker(): instantaneous neutral markers (phase 'close', startedAt = endedAt, version 1).
 * `version` increases by one on every emitted update of an episode.
 */
export interface BookConfig {
  idFactory: () => string;
  mergeGapMs: number;
  maxShots: number;
  periodicShotMs: number;
  minUpdateMs: number;
  peakSpacingMs: number;
}

export interface EpisodeData {
  confidence: number;
  details: Record<string, unknown>;
  observation?: string;
}

interface Slot {
  key: string;
  type: EventType;
  id: string;
  version: number;
  startedAt: number;
  endedAt: number | null;
  open: boolean;
  shots: number;
  lastShotAt: number;
  lastEmitAt: number;
  lastMaterial: string;
  segments: number;
}

export class EpisodeBook {
  private slots = new Map<string, Slot>();

  constructor(public cfg: BookConfig) {}

  isOpen(key: string): boolean {
    return this.slots.get(key)?.open === true;
  }

  /** Start time of the open episode in `key` (null if none). */
  startedAt(key: string): number | null {
    const s = this.slots.get(key);
    return s && s.open ? s.startedAt : null;
  }

  /** Number of separate occurrences merged into the current/last episode of `key`. */
  segments(key: string): number {
    return this.slots.get(key)?.segments ?? 0;
  }

  openTypes(): EventType[] {
    const out: EventType[] = [];
    for (const s of this.slots.values()) if (s.open && !out.includes(s.type)) out.push(s.type);
    return out;
  }

  openKeys(): string[] {
    const out: string[] = [];
    for (const s of this.slots.values()) if (s.open) out.push(s.key);
    return out;
  }

  /** Would a new episode starting at `startedAt` merge into the previous one in this slot? */
  wouldMerge(key: string, startedAt: number): boolean {
    const s = this.slots.get(key);
    return !!s && !s.open && s.endedAt !== null && startedAt - s.endedAt <= this.cfg.mergeGapMs;
  }

  begin(key: string, type: EventType, startedAt: number, t: number, data: EpisodeData, material = ''): { update: EpisodeUpdate; merged: boolean } {
    const prev = this.slots.get(key);
    if (prev && prev.open) {
      // Defensive: already open — treat as a touch that must emit.
      prev.version++;
      prev.lastEmitAt = t;
      prev.lastMaterial = material;
      return { update: this.emit(prev, 'update', t, data, undefined), merged: true };
    }
    if (prev && prev.type === type && prev.endedAt !== null && startedAt - prev.endedAt <= this.cfg.mergeGapMs) {
      prev.open = true;
      prev.endedAt = null;
      prev.version++;
      prev.segments++;
      prev.lastEmitAt = t;
      prev.lastMaterial = material;
      let shot: EpisodeUpdate['captureSnapshot'];
      if (prev.shots < this.cfg.maxShots) {
        shot = 'peak';
        prev.shots++;
        prev.lastShotAt = t;
      }
      return { update: this.emit(prev, 'update', t, data, shot), merged: true };
    }
    const slot: Slot = {
      key,
      type,
      id: this.cfg.idFactory(),
      version: 1,
      startedAt,
      endedAt: null,
      open: true,
      shots: 1,
      lastShotAt: t,
      lastEmitAt: t,
      lastMaterial: material,
      segments: 1,
    };
    this.slots.set(key, slot);
    return { update: this.emit(slot, 'open', t, data, 'onset'), merged: false };
  }

  /**
   * Possibly emit an 'update' for an open episode. `make` is only evaluated when an update is emitted.
   * `peak` asks for an evidence snapshot now (e.g. more people appeared, another glance happened).
   */
  touch(key: string, t: number, material: string, make: () => EpisodeData, opts?: { peak?: boolean }): EpisodeUpdate | null {
    const s = this.slots.get(key);
    if (!s || !s.open) return null;
    const canShoot = s.shots < this.cfg.maxShots;
    const peakDue = !!opts?.peak && canShoot && t - s.lastShotAt >= this.cfg.peakSpacingMs;
    const periodicDue = canShoot && t - s.lastShotAt >= this.cfg.periodicShotMs;
    const materialDue = material !== s.lastMaterial && t - s.lastEmitAt >= this.cfg.minUpdateMs;
    if (!peakDue && !periodicDue && !materialDue) return null;
    let shot: EpisodeUpdate['captureSnapshot'];
    if (peakDue || periodicDue) {
      shot = peakDue ? 'peak' : 'periodic';
      s.shots++;
      s.lastShotAt = t;
    }
    s.version++;
    s.lastEmitAt = t;
    s.lastMaterial = material;
    return this.emit(s, 'update', t, make(), shot);
  }

  end(key: string, endedAt: number, t: number, data: EpisodeData): EpisodeUpdate | null {
    const s = this.slots.get(key);
    if (!s || !s.open) return null;
    s.open = false;
    s.endedAt = Math.max(s.startedAt, Math.min(endedAt, t));
    s.version++;
    s.lastEmitAt = t;
    return this.emit(s, 'close', t, data, undefined);
  }

  /** Instantaneous marker (neutral change): a single 'close' update with startedAt = endedAt = t. */
  marker(type: EventType, t: number, data: EpisodeData): EpisodeUpdate {
    const u: EpisodeUpdate = {
      episodeId: this.cfg.idFactory(),
      type,
      phase: 'close',
      startedAt: t,
      endedAt: t,
      confidence: round3(clamp01(data.confidence)),
      details: { ...data.details },
      version: 1,
    };
    if (data.observation) u.observation = clip(data.observation);
    return u;
  }

  /** Forget closed episodes so nothing merges across a pause/stop. */
  forgetClosed(): void {
    for (const [k, s] of this.slots) if (!s.open) this.slots.delete(k);
  }

  private emit(s: Slot, phase: EpisodeUpdate['phase'], _t: number, data: EpisodeData, shot: EpisodeUpdate['captureSnapshot']): EpisodeUpdate {
    const u: EpisodeUpdate = {
      episodeId: s.id,
      type: s.type,
      phase,
      startedAt: s.startedAt,
      endedAt: s.open ? null : s.endedAt,
      confidence: round3(clamp01(data.confidence)),
      details: { ...data.details, occurrences: s.segments },
      version: s.version,
    };
    if (data.observation) u.observation = clip(data.observation);
    if (shot) u.captureSnapshot = shot;
    return u;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Server schema caps observation at 500 chars. */
function clip(s: string): string {
  return s.length > 480 ? `${s.slice(0, 477)}…` : s;
}
