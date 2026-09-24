/**
 * Default episode id factory: RFC 4122 v4 UUID (the server validates event ids with z.string().uuid()).
 * Uses globalThis.crypto.randomUUID when available (all evergreen browsers in secure contexts, Node ≥ 19),
 * then crypto.getRandomValues, then Math.random as a last resort (still a syntactically valid v4 UUID).
 */
export function defaultIdFactory(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic UUID-shaped ids for tests / offline evaluation. */
export function sequentialIdFactory(prefix = 0): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = (prefix * 1_000_000 + n).toString(16).padStart(12, '0').slice(-12);
    return `00000000-0000-4000-8000-${hex}`;
  };
}
