/**
 * Client/server clock alignment and the exam countdown mirror.
 *
 * Offset estimate (NTP-style): the server stamped `serverTime` somewhere between our send and
 * receive, so we assume the midpoint:  offset = serverTime − (sentAt + rtt/2).
 * The sample with the smallest round-trip among the most recent ones is the most precise, so the
 * offset follows the best recent sample rather than the latest one.
 */

export interface ClockSample {
  offset: number;
  rtt: number;
  at: number;
}

export class ClockSync {
  private samples: ClockSample[] = [];
  private _offset = 0;
  private _synced = false;

  constructor(private readonly window = 8) {}

  /** Add a measurement. Returns the (possibly updated) offset in ms (server − client). */
  addSample(serverTime: number, sentAt: number, receivedAt: number): number {
    if (!Number.isFinite(serverTime) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return this._offset;
    const rtt = Math.max(0, receivedAt - sentAt);
    const offset = serverTime - (sentAt + rtt / 2);
    this.samples.push({ offset, rtt, at: receivedAt });
    if (this.samples.length > this.window) this.samples.splice(0, this.samples.length - this.window);
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this._offset = best.offset;
    this._synced = true;
    return this._offset;
  }

  get offsetMs(): number {
    return this._offset;
  }

  get synced(): boolean {
    return this._synced;
  }

  /** Best estimate of the current server time. */
  now(localNow: number = Date.now()): number {
    return localNow + this._offset;
  }

  /** Converts a server timestamp to the local clock. */
  toLocal(serverTs: number): number {
    return serverTs - this._offset;
  }
}

/**
 * Mirror of the server-authoritative exam clock for display. The server reports `remainingMs` and
 * whether the timer is running at `serverTime`; we extrapolate locally between syncs.
 */
export class Countdown {
  private remainingAtAnchor = 0;
  private anchorServer = 0;
  private _running = false;
  private _initialised = false;

  /**
   * @param toleranceMs re-syncs that differ from the local prediction by less than this are ignored
   *   so the display does not jitter back and forth by a second on every heartbeat.
   */
  constructor(private readonly toleranceMs = 900) {}

  /**
   * Apply a server report. `serverTime` is the server timestamp the report refers to; `serverNow`
   * is the current best estimate of server time (from ClockSync) used to judge drift.
   */
  sync(remainingMs: number, running: boolean, serverTime: number, serverNow: number = serverTime): void {
    const reported = Math.max(0, remainingMs);
    if (this._initialised && running === this._running && running) {
      const predicted = this.remaining(serverNow);
      const reportedNow = Math.max(0, reported - Math.max(0, serverNow - serverTime));
      if (Math.abs(predicted - reportedNow) < this.toleranceMs) return;
    }
    this.remainingAtAnchor = reported;
    this.anchorServer = serverTime;
    this._running = running;
    this._initialised = true;
  }

  /** Remaining exam time at the given server time. Stopped clocks do not count down. */
  remaining(serverNow: number): number {
    if (!this._initialised) return 0;
    if (!this._running) return this.remainingAtAnchor;
    return Math.max(0, this.remainingAtAnchor - Math.max(0, serverNow - this.anchorServer));
  }

  get running(): boolean {
    return this._running;
  }

  get initialised(): boolean {
    return this._initialised;
  }

  /** Stop the local mirror immediately (e.g. when we know the server stopped the clock). */
  freeze(serverNow: number): void {
    this.remainingAtAnchor = this.remaining(serverNow);
    this.anchorServer = serverNow;
    this._running = false;
  }
}
