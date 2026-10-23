import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, recordingPlan, resolvePolicy } from './policy';
import { buildPrivacyNotice, consentCoversRecording, noticeVersionFor, PRIVACY_NOTICE_VERSION, RECORDING_NOTICE_VERSION, recordedThings } from './privacy';
import { recordingContainerType, recordingFileExtension, recordingSegmentQuerySchema } from './recording';

const notice = (recording?: ReturnType<typeof recordingPlan>, camera = true) =>
  buildPrivacyNotice({ retentionDays: 30, contact: 'privacy@uni.example', orgName: 'Uni', idPhotoComparison: false, camera, recording });

describe('exam recording policy', () => {
  it('is off by default; camera video only with a camera, the microphone only with the camera video', () => {
    expect(DEFAULT_POLICY.recording).toEqual({ enabled: false, audio: true, screen: true });
    expect(recordingPlan(DEFAULT_POLICY)).toEqual({ any: false, camera: false, audio: false, screen: false });
    expect(recordingPlan(resolvePolicy({ recording: { enabled: true } }))).toEqual({ any: true, camera: true, audio: true, screen: true });
    expect(recordingPlan(resolvePolicy({ recording: { enabled: true, audio: false, screen: false } }))).toEqual({ any: true, camera: true, audio: false, screen: false });
    // No camera (an accommodation): no webcam video or microphone; the screen is still recorded if the exam records it.
    expect(recordingPlan(resolvePolicy({ recording: { enabled: true }, camera: { enabled: false } }))).toEqual({ any: true, camera: false, audio: false, screen: true });
    expect(recordingPlan(resolvePolicy({ recording: { enabled: true, screen: false }, camera: { enabled: false } }))).toEqual({ any: false, camera: false, audio: false, screen: false });
    expect(recordingPlan({})).toMatchObject({ any: false });
  });

  it('parses the upload query and names container types', () => {
    expect(recordingSegmentQuerySchema.parse({ stream: 'screen', seq: '3', startedAt: '1790000000000', durationMs: '30012' })).toEqual({ stream: 'screen', seq: 3, startedAt: 1790000000000, durationMs: 30012 });
    expect(() => recordingSegmentQuerySchema.parse({ stream: 'mic', seq: '0', startedAt: '1', durationMs: '1' })).toThrow();
    expect(() => recordingSegmentQuerySchema.parse({ stream: 'camera', seq: '-1', startedAt: '1', durationMs: '1' })).toThrow();
    expect(() => recordingSegmentQuerySchema.parse({ stream: 'camera', seq: '0', startedAt: '1', durationMs: String(11 * 60_000) })).toThrow();
    expect(() => recordingSegmentQuerySchema.parse({ stream: 'camera', seq: '0', startedAt: '1', durationMs: '1', instance: 'a b' })).toThrow();
    expect(recordingContainerType('video/webm;codecs=vp9,opus')).toBe('video/webm');
    expect(recordingContainerType('VIDEO/MP4; codecs="avc1.42E01E"')).toBe('video/mp4');
    expect(recordingContainerType('image/jpeg')).toBeNull();
    expect(recordingFileExtension('video/mp4')).toBe('mp4');
    expect(recordingFileExtension('video/webm;codecs=vp8')).toBe('webm');
  });
});

describe('privacy notice with recording', () => {
  it('keeps the notice of an exam without recording exactly as it was', () => {
    const n = notice(recordingPlan(DEFAULT_POLICY));
    expect(n.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(n).not.toHaveProperty('recording');
    expect(n.notStored).toEqual([
      'No continuous video or audio recording.',
      'No screen recording, and no monitoring of other applications, other monitors or other devices.',
      'No clipboard contents.',
      'No keystroke logging: which keys you press and where your mouse pointer is are never recorded.',
    ]);
    expect(n).toEqual(notice(undefined));
    expect(JSON.stringify(n)).not.toMatch(/recording of your exam/);
  });

  it('says what is recorded, how long it is kept and who can watch it, under its own version', () => {
    const n = notice(recordingPlan(resolvePolicy({ recording: { enabled: true } })));
    expect(n.version).toBe(RECORDING_NOTICE_VERSION);
    expect(n.recording).toEqual({ camera: true, audio: true, screen: true });
    expect(n.monitored[0]).toBe('The whole exam is recorded: your webcam video, the sound from your microphone and your entire screen, from the moment you start the exam until it ends. Recording stops while the exam is paused or on hold.');
    expect(n.monitored[1]).toMatch(/share your entire screen \(not just a window or a tab\)/);
    expect(n.stored[0]).toMatch(/^The recording of your exam \(.+\), stored in short parts and encrypted at rest\./);
    expect(n.notStored[0]).toBe('Nothing is recorded before you start the exam, while it is paused or on hold, or after it ends.');
    expect(n.notStored).not.toContain('No continuous video or audio recording.');
    const body = (h: string) => n.sections.find((s) => s.heading === h)!.body;
    expect(body('How long it is kept')).toMatch(/recording of your exam is kept in the same place as these images and deleted at the same time: 30 days after your exam ends/);
    expect(body('Who can see your data')).toMatch(/watch the recording of your exam; every time they open part of it is logged/);
    expect(body('Pausing')).toMatch(/monitoring and recording stop completely/);
    expect(body('Your choices')).toMatch(/the images, the recording and identity data recorded for it are deleted straight away/);
  });

  it('names only what is recorded', () => {
    const screenOnly = notice(recordingPlan(resolvePolicy({ recording: { enabled: true }, camera: { enabled: false } })), false);
    expect(screenOnly.monitored[0]).toMatch(/^The whole exam is recorded: your entire screen,/);
    expect(screenOnly.notStored).toEqual(expect.arrayContaining(['No video of you from your webcam.', 'No sound from your microphone.']));
    const silent = notice(recordingPlan(resolvePolicy({ recording: { enabled: true, audio: false, screen: false } })));
    expect(silent.monitored[0]).toMatch(/^The whole exam is recorded: your webcam video,/);
    expect(silent.notStored).toEqual(expect.arrayContaining(['No sound from your microphone.', 'No screen recording, and no monitoring of other applications, other monitors or other devices.']));
    expect(recordedThings({ camera: true, audio: false, screen: true })).toBe('your webcam video and your entire screen');
  });

  it('a consent covers a recording only when it was given to the recording notice', () => {
    const on = { any: true };
    expect(noticeVersionFor(on)).toBe(RECORDING_NOTICE_VERSION);
    expect(noticeVersionFor({ any: false })).toBe(PRIVACY_NOTICE_VERSION);
    expect(consentCoversRecording(PRIVACY_NOTICE_VERSION, on)).toBe(false);
    expect(consentCoversRecording(RECORDING_NOTICE_VERSION, on)).toBe(true);
    expect(consentCoversRecording(null, { any: false })).toBe(true);
    expect(consentCoversRecording(PRIVACY_NOTICE_VERSION, null)).toBe(true);
  });
});
