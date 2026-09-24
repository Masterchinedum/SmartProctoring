import { formatClock, formatDuration } from '@sp/shared';

export { formatClock, formatDuration };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function valid(ms: number | null | undefined): ms is number {
  return ms != null && Number.isFinite(ms);
}

/** "14:03:27" (local time, 24 h). */
export function formatTime(ms: number | null | undefined): string {
  if (!valid(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "24 Sep 2026" */
export function formatDate(ms: number | null | undefined): string {
  if (!valid(ms)) return '—';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "24 Sep 2026, 14:03:27" */
export function formatDateTime(ms: number | null | undefined): string {
  if (!valid(ms)) return '—';
  return `${formatDate(ms)}, ${formatTime(ms)}`;
}

/** Time only when on the same local day as `now`, otherwise "24 Sep, 14:03". */
export function formatSmartTime(ms: number | null | undefined, now: number): string {
  if (!valid(ms)) return '—';
  const d = new Date(ms);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return formatTime(ms);
  const sameYear = d.getFullYear() === n.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function formatRelative(at: number | null | undefined, now: number): string {
  if (!valid(at)) return '—';
  const diff = now - at;
  if (diff < -5000) return `in ${formatDuration(-diff)}`;
  if (diff < 5000) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** 0.873 -> "87%" */
export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (!valid(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** Cosine similarity, 2 decimals. */
export function formatSimilarity(v: number | null | undefined): string {
  if (!valid(v)) return '—';
  return v.toFixed(2);
}

export function formatNumber(v: number | null | undefined, maxDigits = 2): string {
  if (!valid(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(maxDigits)));
}

/** "lookDirection" / "look_direction" -> "Look direction" */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Readable rendering of an arbitrary details/context value, using key-name conventions for units. */
export function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (/(At|Time|Timestamp|Since|Until)$/.test(key) && value > 1e11) return formatDateTime(value);
    if (/Ms$/.test(key)) return formatDuration(value);
    if (/(Sec|Seconds)$/.test(key)) return `${formatNumber(value, 1)} s`;
    if (/Deg$/.test(key) || /(yaw|pitch|roll)$/i.test(key)) return `${formatNumber(value, 0)}°`;
    if (/similarity/i.test(key)) return formatSimilarity(value);
    if (/(confidence|score|ratio|fraction)/i.test(key) && value >= 0 && value <= 1) return formatPercent(value);
    return formatNumber(value);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      return value.map((v) => (typeof v === 'number' ? formatNumber(v) : String(v))).join(', ');
    }
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Remaining exam time given a summary snapshot received at `receivedAt`. */
export function remainingAt(remainingMs: number, timerRunning: boolean, receivedAt: number, now: number): number {
  if (!timerRunning) return Math.max(0, remainingMs);
  return Math.max(0, remainingMs - Math.max(0, now - receivedAt));
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
