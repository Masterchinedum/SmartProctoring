/**
 * Time-stamped boolean ring buffer with a running count of true entries. Used by the debouncer to
 * compute "fraction of ticks in the last N seconds where the condition held" in O(1) amortized time.
 * Capacity grows geometrically if a burst of ticks exceeds it, so memory stays bounded by
 * (window length × tick rate).
 */
export class TickWindow {
  private times: Float64Array;
  private vals: Uint8Array;
  private head = 0; // index of oldest
  private len = 0;
  private trues = 0;

  constructor(capacity = 64) {
    this.times = new Float64Array(capacity);
    this.vals = new Uint8Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  get trueCount(): number {
    return this.trues;
  }

  fraction(): number {
    return this.len === 0 ? 0 : this.trues / this.len;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
    this.trues = 0;
  }

  push(t: number, v: boolean): void {
    if (this.len === this.times.length) this.grow();
    const idx = (this.head + this.len) % this.times.length;
    this.times[idx] = t;
    this.vals[idx] = v ? 1 : 0;
    this.len++;
    if (v) this.trues++;
  }

  /** Drop entries older than `minT` (strictly less). */
  prune(minT: number): void {
    while (this.len > 0 && this.times[this.head] < minT) {
      if (this.vals[this.head]) this.trues--;
      this.head = (this.head + 1) % this.times.length;
      this.len--;
    }
  }

  private grow(): void {
    const cap = this.times.length * 2;
    const t2 = new Float64Array(cap);
    const v2 = new Uint8Array(cap);
    for (let i = 0; i < this.len; i++) {
      const j = (this.head + i) % this.times.length;
      t2[i] = this.times[j];
      v2[i] = this.vals[j];
    }
    this.times = t2;
    this.vals = v2;
    this.head = 0;
  }
}

/** Fixed-capacity FIFO ring for arbitrary items (oldest overwritten). */
export class Ring<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  push(item: T): void {
    const idx = (this.head + this.len) % this.capacity;
    this.buf[idx] = item;
    if (this.len < this.capacity) this.len++;
    else this.head = (this.head + 1) % this.capacity;
  }

  /** i = 0 is the oldest item. */
  at(i: number): T {
    return this.buf[(this.head + i) % this.capacity] as T;
  }

  last(): T | undefined {
    return this.len === 0 ? undefined : this.at(this.len - 1);
  }

  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.len--;
    return v;
  }

  peekOldest(): T | undefined {
    return this.len === 0 ? undefined : this.at(0);
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.len = 0;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.len; i++) out.push(this.at(i));
    return out;
  }
}
