/**
 * Concurrent-use detection for a copied browser instance id (security review #7, detection only).
 *
 * Only the browser instance that passed the camera/identity check (`verifiedInstanceId`) may read questions and
 * send exam data, and it is identified by the `X-Client-Instance` header. A colluding candidate can copy that id
 * to a second device. We cannot tell the copy apart by its id, but we can see the same instance being used from
 * two places at once. For the verified instance of a ready/active session we keep (hashes only, never raw IPs or
 * user agents — exam_sessions.instance_usage):
 *
 *   - the User-Agent it was first seen with            -> a different UA for the same instance: `ua_changed`
 *   - runs of consecutive requests per network          -> two networks alternating A→B→A→B within 60 s:
 *     (IPv4 /24, IPv6 /64; per address family, so a       `ip_alternating`. A single change (Wi-Fi → mobile,
 *     dual-stack browser switching v4/v6 is not a signal)  a new mobile address) is never a signal on its own.
 *   - heartbeat `seq` streams                           -> two interleaved monotonic sequences (a second copy of
 *                                                           the page counting on its own): `seq_interleaved`. A
 *                                                           restart of the counter (seq drops and continues from
 *                                                           there) or a duplicate/late heartbeat is not a signal.
 *
 * On a signal the session gets a `multiple_instances` integrity event (details: signal, ipHashes, uaChanged), the
 * verified instance id is cleared — the next request of either device needs a reconnect check — and a
 * `require_check` command is queued. A plain page reload is a NEW instance id (fresh record), never a signal; the
 * camera deviceId hash is not used (incognito re-randomises it on every load).
 */
import { isIP } from 'node:net';
import type { Ctx } from '../context.js';
import type { ExamSession, InstanceUsage } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { instanceInControl } from './candidate-state.js';
import { withSession, type SessionMutation } from './session-state.js';

/** Window in which two networks must alternate / two seq streams must interleave. */
export const CONCURRENT_USE_WINDOW_MS = 60_000;
/** Network transitions (within one address family) inside the window that make an alternation, e.g. A→B→A→B. */
export const ALTERNATION_MIN_SWITCHES = 3;
/** A heartbeat this far below the current stream's last seq is a duplicate / late delivery, not a second stream. */
export const SEQ_REORDER_TOLERANCE = 2;
const MAX_NETS = 12;
const MAX_IPS = 6;
const MAX_STREAMS = 4;
const NET_HISTORY_MS = 10 * 60_000;
/** Non-heartbeat requests refresh the current network run at most this often (heartbeats always do). */
const REFRESH_MS = 15_000;
const TRACKED_STATUSES: ExamSession['status'][] = ['ready', 'active'];

export type ConcurrentUseSignal = 'ua_changed' | 'seq_interleaved' | 'ip_alternating';

export interface UsageObservation {
  ip: string;
  userAgent: string;
  /** Heartbeat sequence number (heartbeats only). */
  seq?: number | null;
  at: number;
  /** Always write the refreshed record (the caller writes the session row anyway, e.g. a heartbeat). */
  refresh?: boolean;
}

export interface UsageVerdict {
  usage: InstanceUsage;
  /** The record differs from the stored one and should be written. */
  changed: boolean;
  signal: ConcurrentUseSignal | null;
  uaChanged: boolean;
}

const h16 = (kind: string, v: string) => sha256Hex(`${kind}:${v}`).slice(0, 16);

/** Network of an address: IPv4 /24 or IPv6 /64 (IPv4-mapped IPv6 counts as IPv4). */
export function networkOf(ip: string): { family: 4 | 6; net: string } {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  const addr = mapped ? mapped[1] : v;
  if (isIP(addr) === 4) return { family: 4, net: `v4:${addr.split('.').slice(0, 3).join('.')}` };
  if (isIP(addr) === 6) return { family: 6, net: `v6:${expandIPv6(addr).slice(0, 4).join(':')}` };
  return { family: 4, net: `other:${addr}` };
}

function expandIPv6(addr: string): string[] {
  const noZone = addr.split('%')[0];
  const [head, tail] = noZone.includes('::') ? noZone.split('::') : [noZone, null];
  const h = head ? head.split(':') : [];
  const t = tail != null && tail !== '' ? tail.split(':') : [];
  const fill = tail != null ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0'));
}

/** sha256 prefix of a client IP (event details and the usage record never hold raw addresses). */
export const hashIp = (ip: string) => h16('ip', ip.trim().toLowerCase());
const hashNet = (family: 4 | 6, net: string) => `${family}:${h16('net', net)}`;
const hashUa = (ua: string) => h16('ua', ua);

function familyOf(hashedNet: string): string {
  return hashedNet.slice(0, 1);
}

/** Network transitions within one address family among the runs active in the window; true if a network repeats. */
function alternation(nets: InstanceUsage['nets'], family: string, since: number): { switches: number; repeats: boolean } {
  const seq: string[] = [];
  for (const r of nets) {
    if (r.lastAt < since || familyOf(r.net) !== family) continue;
    if (seq[seq.length - 1] !== r.net) seq.push(r.net);
  }
  return { switches: Math.max(0, seq.length - 1), repeats: new Set(seq).size < seq.length };
}

/**
 * Pure: fold one request of `instanceId` into its usage record and decide whether it shows concurrent use.
 * A record of another instance is replaced by a fresh one.
 */
export function observeInstanceUsage(prev: InstanceUsage | null | undefined, instanceId: string, o: UsageObservation): UsageVerdict {
  const { family, net } = networkOf(o.ip);
  const netH = hashNet(family, net);
  const ipH = hashIp(o.ip);
  const uaH = hashUa(o.userAgent ?? '');
  const fresh = !prev || prev.instanceId !== instanceId;
  const u: InstanceUsage = fresh
    ? { instanceId, uaHash: uaH, nets: [{ net: netH, firstAt: o.at, lastAt: o.at }], ipHashes: [ipH], seq: null }
    : { ...prev, nets: prev.nets.map((r) => ({ ...r })), ipHashes: [...prev.ipHashes], seq: prev.seq ? { cur: prev.seq.cur, streams: prev.seq.streams.map((s) => ({ ...s })) } : null };
  let changed = fresh || !!o.refresh;
  let signal: ConcurrentUseSignal | null = null;

  // --- user agent: one browser instance never changes it.
  const uaChanged = !fresh && u.uaHash !== uaH;
  if (uaChanged) signal = 'ua_changed';

  // --- addresses
  if (!u.ipHashes.includes(ipH)) {
    u.ipHashes = [...u.ipHashes, ipH].slice(-MAX_IPS);
    changed = true;
  }
  if (!fresh) {
    const cur = u.nets[u.nets.length - 1];
    if (cur && cur.net === netH) {
      if (o.refresh || o.at - cur.lastAt >= REFRESH_MS) {
        cur.lastAt = Math.max(cur.lastAt, o.at);
        changed = true;
      }
    } else {
      u.nets.push({ net: netH, firstAt: o.at, lastAt: o.at });
      changed = true;
      const alt = alternation(u.nets, familyOf(netH), o.at - CONCURRENT_USE_WINDOW_MS);
      if (!signal && alt.repeats && alt.switches >= ALTERNATION_MIN_SWITCHES) signal = 'ip_alternating';
    }
    u.nets = u.nets.filter((r, i) => i === u.nets.length - 1 || r.lastAt >= o.at - NET_HISTORY_MS).slice(-MAX_NETS);
  }

  // --- heartbeat sequence numbers
  if (o.seq != null && Number.isFinite(o.seq)) {
    const seq = o.seq;
    const st = u.seq ?? { streams: [], cur: -1 };
    const cur = st.streams[st.cur];
    if (!cur) {
      st.streams = [{ last: seq, at: o.at }];
      st.cur = 0;
    } else if (seq > cur.last && !betterStream(st, seq, o.at)) {
      cur.last = seq;
      cur.at = o.at;
    } else if (seq <= cur.last && seq >= cur.last - SEQ_REORDER_TOLERANCE) {
      // duplicate or a late heartbeat of the current stream
    } else {
      // Another sequence: continue the active stream that fits best (largest last < seq), else start one.
      const idx = bestStream(st, seq, o.at);
      if (idx >= 0 && idx !== st.cur) {
        const prevActive = o.at - cur.at <= CONCURRENT_USE_WINDOW_MS;
        st.streams[idx] = { last: seq, at: o.at };
        st.cur = idx;
        if (prevActive && !signal) signal = 'seq_interleaved';
      } else {
        st.streams.push({ last: seq, at: o.at });
        if (st.streams.length > MAX_STREAMS) st.streams.splice(0, st.streams.length - MAX_STREAMS);
        st.cur = st.streams.length - 1;
      }
    }
    u.seq = st;
    changed = true;
  }
  return { usage: u, changed, signal, uaChanged };
}

/** Index of the active stream (seen within the window) with the largest last seq below `seq`; -1 if none. */
function bestStream(st: NonNullable<InstanceUsage['seq']>, seq: number, at: number): number {
  let best = -1;
  for (let i = 0; i < st.streams.length; i++) {
    const s = st.streams[i];
    if (s.last >= seq || at - s.at > CONCURRENT_USE_WINDOW_MS) continue;
    if (best < 0 || s.last > st.streams[best].last || (s.last === st.streams[best].last && i === st.cur)) best = i;
  }
  return best;
}

/** True when `seq` continues another active stream better than the current one (interleaving). */
function betterStream(st: NonNullable<InstanceUsage['seq']>, seq: number, at: number): boolean {
  const idx = bestStream(st, seq, at);
  return idx >= 0 && idx !== st.cur && st.streams[idx].last > st.streams[st.cur].last;
}

export const RECHECK_MESSAGE = 'Please complete a quick camera and identity check to continue your exam.';

/**
 * Apply one observation inside a session mutation. On a signal: `multiple_instances` event, the verified
 * instance id is cleared (reconnect check required) and a require_check command is queued. Returns the signal.
 */
/** The verdict for a request of `instanceId` on this session, or null when the session/instance is not tracked. */
export function evaluateInstanceUsage(s: ExamSession, instanceId: string, o: UsageObservation): UsageVerdict | null {
  if (!TRACKED_STATUSES.includes(s.status) || !instanceInControl(s, instanceId)) return null;
  return observeInstanceUsage(s.instanceUsage, instanceId, o);
}

export async function applyInstanceUsage(m: SessionMutation, instanceId: string, o: UsageObservation): Promise<ConcurrentUseSignal | null> {
  const s = m.session;
  const v = evaluateInstanceUsage(s, instanceId, o);
  if (!v) return null;
  if (!v.signal) {
    if (v.changed) m.set({ instanceUsage: v.usage });
    return null;
  }
  await m.addEvent({
    type: 'multiple_instances',
    source: 'server_system',
    observation:
      v.signal === 'ua_changed'
        ? 'The verified browser’s requests started to come from a different browser or device while the exam was in progress. A new identity check was required.'
        : v.signal === 'seq_interleaved'
          ? 'Two copies of the verified exam page were reporting at the same time. A new identity check was required.'
          : 'The verified browser’s requests alternated between two different networks within a minute, as if used from two places at once. A new identity check was required.',
    details: { signal: v.signal, ipHashes: v.usage.ipHashes, uaChanged: v.uaChanged, instanceId, detectedBy: 'concurrent_use' },
  });
  m.set({ verifiedInstanceId: null, instanceUsage: null });
  await m.enqueueCommand({ kind: 'require_check', purpose: 'reconnect', message: RECHECK_MESSAGE });
  return v.signal;
}

/**
 * Candidate request of the verified instance (any route but the heartbeat, which calls applyInstanceUsage itself):
 * a cheap check against the loaded row; the row is locked and written only when the record changes.
 */
export async function trackInstanceRequest(ctx: Ctx, session: ExamSession, instanceId: string, meta: { ip: string; userAgent: string }): Promise<ConcurrentUseSignal | null> {
  if (!TRACKED_STATUSES.includes(session.status) || !instanceInControl(session, instanceId)) return null;
  const at = ctx.now();
  const quick = observeInstanceUsage(session.instanceUsage, instanceId, { ...meta, at });
  if (!quick.changed && !quick.signal) return null;
  return withSession(ctx, session.id, (m) => applyInstanceUsage(m, instanceId, { ...meta, at: m.now }));
}
