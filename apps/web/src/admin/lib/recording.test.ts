import { describe, expect, it } from 'vitest';
import { resolvePolicy, type RecordingSegmentDTO } from '@sp/shared';
import { clockLabel, describeRecording, describeRecordingSummary, locate, notRecorded, recordingSpan, seekTimeForEvent, streamSegments, timelineFraction } from './recording';

const T = 1_790_000_000_000;
let n = 0;
function seg(stream: 'camera' | 'screen', startOffset: number, durationMs: number, available = true): RecordingSegmentDTO {
  return {
    id: `seg-${n++}`,
    stream,
    seq: n,
    startedAt: T + startOffset,
    durationMs,
    endedAt: T + startOffset + durationMs,
    mimeType: 'video/webm',
    byteSize: 1000,
    clientInstanceId: 'inst-1',
    available,
    deletedAt: available ? null : T,
    deletedBecause: available ? null : 'retention',
  };
}

describe('recording in the staff app', () => {
  it('describes what an exam records', () => {
    expect(describeRecording(resolvePolicy({}))).toBe('Off');
    expect(describeRecording(resolvePolicy({ recording: { enabled: true } }))).toBe('Webcam, microphone and screen');
    expect(describeRecording(resolvePolicy({ recording: { enabled: true, audio: false } }))).toBe('Webcam and screen');
    expect(describeRecording(resolvePolicy({ recording: { enabled: true }, camera: { enabled: false } }))).toBe('Screen');
    expect(describeRecordingSummary({ segments: 4, available: 4, cameraMs: 61_000, screenMs: 0, bytes: 1, deletedAt: null, deletedBecause: null })).toBe('1m 01s of webcam');
  });

  it('plays a stream in time order, locating a time in a segment or in a gap before the next playable one', () => {
    const segments = [seg('camera', 30_000, 30_000), seg('camera', 0, 30_000), seg('camera', 70_000, 30_000, false), seg('camera', 100_000, 30_000), seg('screen', 0, 30_000)];
    const cam = streamSegments({ segments }, 'camera');
    expect(cam.map((s) => s.startedAt - T)).toEqual([0, 30_000, 70_000, 100_000]);
    expect(locate(cam, T + 45_000)).toEqual({ kind: 'segment', index: 1, offsetMs: 15_000 });
    expect(locate(cam, T)).toEqual({ kind: 'segment', index: 0, offsetMs: 0 });
    // 60–70 s: nothing recorded; 70–100 s: deleted — both wait for the segment at 100 s.
    expect(locate(cam, T + 65_000)).toEqual({ kind: 'gap', nextIndex: 3, until: T + 100_000 });
    expect(locate(cam, T + 80_000)).toEqual({ kind: 'gap', nextIndex: 3, until: T + 100_000 });
    expect(locate(cam, T + 130_000)).toEqual({ kind: 'gap', nextIndex: null, until: null });
    expect(locate(cam, T - 5000)).toEqual({ kind: 'gap', nextIndex: 0, until: T });
    // Just before a segment (the streams start a little apart): that segment, from its start.
    expect(locate(cam, T - 500)).toEqual({ kind: 'segment', index: 0, offsetMs: 0 });
    expect(locate(cam, T + 99_500)).toEqual({ kind: 'segment', index: 3, offsetMs: 0 });
    expect(locate(cam, T + 69_500)).toEqual({ kind: 'gap', nextIndex: 3, until: T + 100_000 });
    const span = recordingSpan({ segments })!;
    expect(span).toEqual({ start: T, end: T + 130_000 });
    expect(notRecorded(cam, span)).toEqual([{ from: T + 60_000, to: T + 100_000 }]);
    expect(notRecorded(streamSegments({ segments }, 'screen'), span)).toEqual([{ from: T + 30_000, to: T + 130_000 }]);
    expect(recordingSpan({ segments: [] })).toBeNull();
  });

  it('seeks a little before an event, within the recording; places markers on the bar', () => {
    const span = { start: T, end: T + 100_000 };
    expect(seekTimeForEvent(T + 50_000, span)).toBe(T + 40_000);
    expect(seekTimeForEvent(T + 5000, span)).toBe(T);
    expect(seekTimeForEvent(T + 500_000, span)).toBe(T + 100_000);
    expect(seekTimeForEvent(T, null)).toBeNull();
    expect(timelineFraction(T + 25_000, span)).toBe(0.25);
    expect(timelineFraction(T - 1, span)).toBe(0);
    expect(timelineFraction(T, { start: T, end: T })).toBe(0);
    expect(clockLabel(3_725_000)).toBe('01:02:05');
  });
});
