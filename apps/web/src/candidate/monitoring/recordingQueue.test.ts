import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingSegmentUploadResponse } from '@sp/shared';
import { CandidateApiError } from '../api';
import { flush } from '../test/mediaFakes';
import { RecordingQueue, type QueuedSegment } from './recordingQueue';

let ns = 0;
const nextNs = () => `rec-${Date.now()}-${++ns}`;
const OK: RecordingSegmentUploadResponse = { stored: true, duplicate: false, segmentId: 's' };

const blob = (n = 100) => new Blob([new Uint8Array(n)], { type: 'video/webm' });
const meta = (stream: 'camera' | 'screen', seq: number, startedAt: number) => ({ stream, seq, startedAt, durationMs: 30_000, mimeType: 'video/webm;codecs=vp8', instanceId: 'inst-a' });

describe('recording upload queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    await flush(10);
  }

  it('uploads oldest first, one at a time, and forgets what the server took', async () => {
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true });
    const sent: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    q.start(async (seg) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      sent.push(`${seg.stream}:${seg.seq}`);
      inFlight--;
      return OK;
    });
    await q.put(blob(), meta('screen', 0, 1010));
    await q.put(blob(), meta('camera', 1, 31_000));
    await q.put(blob(), meta('camera', 0, 1000));
    expect(q.stats()).toMatchObject({ pending: 3, bytes: 300, storage: 'memory' });
    await settle(100);
    expect(sent).toEqual(['camera:0', 'screen:0', 'camera:1']);
    expect(maxInFlight).toBe(1);
    expect(q.stats().pending).toBe(0);
    q.close();
  });

  it('retries with back-off while the connection is down, and at once when it comes back', async () => {
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true, minBackoffMs: 1000, maxBackoffMs: 8000 });
    let fail = true;
    let calls = 0;
    q.start(async () => {
      calls++;
      if (fail) throw new CandidateApiError(0, 'network_error', 'Could not reach the server.');
      return OK;
    });
    await q.put(blob(), meta('camera', 0, 1000));
    await settle(0);
    expect(calls).toBe(1);
    expect(q.stats()).toMatchObject({ pending: 1, lastError: expect.stringContaining('network_error') });
    expect(q.stats().failingSince).not.toBeNull();
    await settle(1000);
    expect(calls).toBe(2);
    await settle(1999);
    expect(calls).toBe(2);
    await settle(1);
    expect(calls).toBe(3);
    fail = false;
    window.dispatchEvent(new Event('online'));
    await settle(0);
    expect(calls).toBe(4);
    expect(q.stats()).toMatchObject({ pending: 0, failingSince: null, lastError: null });
    q.close();
  });

  it('drops what the server will never take; stops recording at the session cap', async () => {
    const dropped: [string, string][] = [];
    let limit = 0;
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true, onDropped: (s, reason) => dropped.push([`${s.stream}:${s.seq}`, reason]), onLimit: () => limit++ });
    const answers = [new CandidateApiError(409, 'recording_closed', 'closed'), new CandidateApiError(413, 'recording_limit', 'limit'), new CandidateApiError(415, 'invalid_recording', 'bad')];
    q.start(async () => {
      throw answers.shift();
    });
    await q.put(blob(), meta('camera', 0, 1000));
    await q.put(blob(), meta('camera', 1, 2000));
    await q.put(blob(), meta('camera', 2, 3000));
    await settle(0);
    expect(dropped).toEqual([
      ['camera:0', 'refused'],
      ['camera:1', 'refused'],
      ['camera:2', 'refused'],
    ]);
    expect(limit).toBe(1);
    expect(q.stats().pending).toBe(0);
    q.close();
  });

  it('waits (keeps everything) while this page may not deliver, or must pass a check first', async () => {
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true });
    let allowed = false;
    let verified = false;
    let calls = 0;
    q.start(
      async () => {
        calls++;
        if (!verified) throw new CandidateApiError(409, 'check_required', 'Complete the check');
        return OK;
      },
      () => allowed,
    );
    await q.put(blob(), meta('screen', 0, 1000));
    await settle(5000);
    expect(calls).toBe(0);
    allowed = true;
    await settle(2000);
    expect(calls).toBe(1);
    expect(q.stats().pending).toBe(1);
    verified = true;
    await settle(5000);
    expect(calls).toBe(2);
    expect(q.stats().pending).toBe(0);
    q.close();
  });

  it('keeps at most maxBytes on the device: the oldest parts are dropped and reported', async () => {
    const dropped: QueuedSegment[] = [];
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true, maxBytes: 250, onDropped: (s, reason) => reason === 'device_storage_full' && dropped.push(s) });
    for (let i = 0; i < 4; i++) await q.put(blob(100), meta('camera', i, 1000 + i));
    expect(dropped.map((s) => s.seq)).toEqual([0, 1]);
    expect(q.stats()).toMatchObject({ pending: 2, bytes: 200 });
    q.close();
  });

  it('survives a reload: a new page finds the queued parts in IndexedDB and uploads them as the page that recorded them', async () => {
    // fake-indexeddb schedules its work on real timers.
    vi.useRealTimers();
    const namespace = nextNs();
    const first = await RecordingQueue.open({ namespace });
    expect(first.stats().storage).toBe('indexeddb');
    await first.put(blob(64), meta('camera', 3, 5000));
    first.close();
    const second = await RecordingQueue.open({ namespace });
    expect(second.stats()).toMatchObject({ pending: 1, bytes: 64 });
    const sent: { seg: QueuedSegment; size: number; type: string }[] = [];
    second.start(async (seg, body) => {
      sent.push({ seg, size: body.size, type: body.type });
      return OK;
    });
    expect(await second.flushNow(5000)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].seg).toMatchObject({ stream: 'camera', seq: 3, instanceId: 'inst-a', mimeType: 'video/webm;codecs=vp8' });
    expect(sent[0].size).toBe(64);
    second.close();
    const third = await RecordingQueue.open({ namespace });
    expect(third.stats().pending).toBe(0);
    third.close();
  });

  it('deletes everything still queued without sending it (consent withdrawn)', async () => {
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true });
    await q.put(blob(), meta('camera', 0, 1000));
    await q.put(blob(), meta('screen', 0, 1000));
    expect(await q.discardAll()).toBe(2);
    expect(q.stats().pending).toBe(0);
    q.close();
  });

  it('stops for good when the page can no longer deliver anything', async () => {
    const fatal: string[] = [];
    const q = await RecordingQueue.open({ namespace: nextNs(), memory: true, onFatal: (k) => fatal.push(k) });
    let calls = 0;
    q.start(async () => {
      calls++;
      throw new CandidateApiError(409, 'superseded', 'Opened elsewhere');
    });
    await q.put(blob(), meta('camera', 0, 1000));
    await settle(60_000);
    expect(calls).toBe(1);
    expect(fatal).toEqual(['superseded']);
    expect(q.stats().pending).toBe(1);
    q.close();
  });
});
