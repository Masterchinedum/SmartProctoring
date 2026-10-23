import type { EventUpsert, RecordingPlan, RecordingStream } from '@sp/shared';
import { uuid } from '../api';
import type { CameraSnapshot } from './camera';
import { MIC_CONSTRAINTS, describeMicError } from './micLevel';
import {
  browserMediaRecorder,
  CAMERA_AUDIO_BPS,
  CAMERA_VIDEO_BPS,
  pickMimeType,
  recordingVideoTrack,
  SCREEN_VIDEO_BPS,
  SegmentedRecorder,
  type MediaRecorderCtor,
  type SegmentInfo,
} from './recorder';
import type { RecordingQueue } from './recordingQueue';
import type { ScreenSnapshot } from './screen';

/**
 * The exam recording of one monitoring run (policy.recording): runs exactly while monitoring runs — from the start
 * of the exam (after the check-in) until a pause, a hold, the end, or a camera release — and a new run starts after a
 * resume. Within a run:
 *
 *  - camera: the webcam (a scaled-down clone of the camera's track) plus the microphone (its own getUserMedia with
 *    echo cancellation / noise suppression; the camera's stream is never asked for audio) in one recording. A camera
 *    restart (new stream generation) ends the current segment and starts a new recording on the new tracks;
 *  - screen: the shared screen. When sharing stops (the browser's "Stop sharing", a sleeping computer) the exam is
 *    covered (ExamScreen) and a `screen_share_stopped` span opens; it closes when the candidate shares again.
 *
 * Failures that are not the candidate's choice (the browser cannot record, the microphone is unavailable, the device
 * runs out of space for queued parts) are `recording_interrupted` technical events and never block the exam; when
 * nothing at all can be recorded the candidate is told (onProblem) and staff decide.
 * Finished segments go to the offline-safe RecordingQueue.
 */

export interface ExamRecordingDeps {
  plan: RecordingPlan;
  camera: { readonly state: CameraSnapshot; subscribe(fn: (s: CameraSnapshot) => void): () => void };
  screen: { readonly state: ScreenSnapshot; subscribe(fn: (s: ScreenSnapshot) => void): () => void };
  queue: Pick<RecordingQueue, 'put'>;
  instanceId: string;
  /** Server-synced clock (epoch ms). */
  now: () => number;
  putEvent: (e: EventUpsert) => Promise<void>;
  /** Sequence numbers of this page, per stream (shared by every run of the page: the server keys segments by them). */
  sequence: Record<RecordingStream, number>;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: MediaRecorderCtor;
  /** Tell the candidate (null: clear) — only when nothing at all can be recorded. */
  onProblem?: (message: string | null) => void;
  /** Delay before trying again after a recorder failed (default 5 s; up to 3 tries in a row per stream). */
  retryMs?: number;
}

const MAX_RETRIES = 3;
/** A segment at least this long shows the stream records properly (resets its failure count). */
const HEALTHY_SEGMENT_MS = 5000;

interface OpenSpan {
  id: string;
  startedAt: number;
  version: number;
}

export class ExamRecording {
  private cameraRec: SegmentedRecorder | null = null;
  private screenRec: SegmentedRecorder | null = null;
  private mic: MediaStream | null = null;
  private video: { track: MediaStreamTrack; owned: boolean } | null = null;
  private cameraGen = -1;
  private screenGen = -1;
  private shareStopped: OpenSpan | null = null;
  private readonly failures: Record<RecordingStream, number> = { camera: 0, screen: 0 };
  private readonly gaveUp: Record<RecordingStream, boolean> = { camera: false, screen: false };
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private unsubs: (() => void)[] = [];
  private stopped = false;
  private started = false;
  /** Serialises camera (re)starts: generation changes can arrive while one is still starting. */
  private cameraChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ExamRecordingDeps) {}

  private get MediaRecorder(): MediaRecorderCtor | undefined {
    return this.deps.MediaRecorder ?? browserMediaRecorder();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    const { plan } = this.deps;
    if (!this.MediaRecorder) {
      for (const stream of [plan.camera ? 'camera' : null, plan.screen ? 'screen' : null] as const) {
        if (stream) await this.interrupted(stream, 'recorder_unavailable', 'This browser cannot record.');
      }
      this.deps.onProblem?.(NOTHING_RECORDED);
      return;
    }
    if (plan.audio) await this.openMic();
    if (this.stopped) return;
    if (plan.camera) {
      this.unsubs.push(this.deps.camera.subscribe((s) => this.onCamera(s)));
      this.onCamera(this.deps.camera.state);
    }
    if (plan.screen) {
      this.unsubs.push(this.deps.screen.subscribe((s) => this.onScreen(s)));
      this.onScreen(this.deps.screen.state);
    }
  }

  /* ------------------------------------------------------------------ microphone */

  private async openMic(): Promise<void> {
    const gum = this.deps.getUserMedia ?? (navigator.mediaDevices?.getUserMedia ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c) : undefined);
    if (!gum) {
      await this.interrupted('camera', 'microphone_unavailable', 'This browser cannot use a microphone.', 'microphone');
      return;
    }
    try {
      const s = await gum({ audio: MIC_CONSTRAINTS, video: false });
      if (this.stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mic = s;
      const track = s.getAudioTracks()[0];
      track?.addEventListener('ended', () => {
        if (this.stopped || this.mic !== s) return;
        this.mic = null;
        void this.interrupted('camera', 'microphone_ended', 'The microphone stopped; the webcam video continues without sound.', 'microphone');
        // Keep recording the webcam, without sound, in a new segment.
        this.restartCamera();
      });
    } catch (err) {
      await this.interrupted('camera', 'microphone_unavailable', describeMicError(err).message, 'microphone');
    }
  }

  /* ------------------------------------------------------------------ camera */

  private onCamera(s: CameraSnapshot): void {
    if (this.stopped || this.gaveUp.camera) return;
    if (s.state === 'live' && s.stream && s.generation !== this.cameraGen) {
      this.cameraGen = s.generation;
      this.restartCamera();
    } else if ((s.state !== 'live' || !s.stream) && this.cameraRec) {
      // The camera went away (unplugged, released): finish the current segment; a new stream restarts recording.
      const rec = this.cameraRec;
      this.cameraRec = null;
      this.cameraChain = this.cameraChain.then(async () => {
        await rec.stop();
        this.releaseVideo();
      });
      this.cameraGen = -1;
    }
  }

  private restartCamera(): void {
    this.cameraChain = this.cameraChain.then(() => this.startCamera()).catch((err) => console.warn('[recording] camera start failed', err));
  }

  private async startCamera(): Promise<void> {
    if (this.stopped) return;
    const old = this.cameraRec;
    this.cameraRec = null;
    if (old) await old.stop();
    this.releaseVideo();
    const cam = this.deps.camera.state;
    const source = cam.state === 'live' ? cam.stream?.getVideoTracks()[0] : undefined;
    if (!source || this.stopped) return;
    this.video = await recordingVideoTrack(source);
    if (this.stopped) {
      this.releaseVideo();
      return;
    }
    const audio = this.mic?.getAudioTracks().filter((t) => t.readyState === 'live') ?? [];
    const stream = new MediaStream([this.video.track, ...audio]);
    const rec = this.recorder('camera', stream, audio.length > 0);
    this.cameraRec = rec;
    rec.start();
  }

  private releaseVideo(): void {
    if (this.video?.owned) this.video.track.stop();
    this.video = null;
  }

  /* ------------------------------------------------------------------ screen */

  private onScreen(s: ScreenSnapshot): void {
    if (this.stopped) return;
    if (s.live && s.stream && s.generation !== this.screenGen) {
      this.screenGen = s.generation;
      void this.closeShareStopped(this.deps.now());
      void this.startScreen(s.stream);
    } else if (!s.live && this.screenGen !== -1) {
      this.screenGen = -1;
      const rec = this.screenRec;
      this.screenRec = null;
      void rec?.stop();
      // Stopped by the candidate or the system while the exam records the screen (not by us at a pause / the end).
      if (s.endedAt != null) void this.openShareStopped(s.endedAt);
    }
  }

  private async startScreen(stream: MediaStream): Promise<void> {
    const old = this.screenRec;
    this.screenRec = null;
    if (old) await old.stop();
    if (this.stopped || this.gaveUp.screen) return;
    const rec = this.recorder('screen', new MediaStream(stream.getVideoTracks()), false);
    this.screenRec = rec;
    rec.start();
  }

  private async openShareStopped(at: number): Promise<void> {
    if (this.shareStopped) return;
    const span: OpenSpan = { id: uuid(), startedAt: Math.round(at), version: 1 };
    this.shareStopped = span;
    await this.deps.putEvent({
      id: span.id,
      type: 'screen_share_stopped',
      phase: 'open',
      startedAt: span.startedAt,
      endedAt: null,
      confidence: 1,
      observation: 'The candidate’s screen stopped being shared; the exam was covered until it was shared again.',
      details: {},
      version: 1,
      clientInstanceId: this.deps.instanceId,
    });
  }

  private async closeShareStopped(at: number): Promise<void> {
    const span = this.shareStopped;
    if (!span) return;
    this.shareStopped = null;
    await this.deps.putEvent({
      id: span.id,
      type: 'screen_share_stopped',
      phase: 'close',
      startedAt: span.startedAt,
      endedAt: Math.max(span.startedAt, Math.round(at)),
      confidence: 1,
      details: {},
      version: span.version + 1,
      clientInstanceId: this.deps.instanceId,
    });
  }

  /* ------------------------------------------------------------------ recorders */

  private recorder(kind: RecordingStream, stream: MediaStream, withAudio: boolean): SegmentedRecorder {
    const Ctor = this.MediaRecorder;
    return new SegmentedRecorder({
      stream,
      kind,
      mimeType: pickMimeType(withAudio, Ctor?.isTypeSupported?.bind(Ctor)),
      videoBitsPerSecond: kind === 'screen' ? SCREEN_VIDEO_BPS : CAMERA_VIDEO_BPS,
      audioBitsPerSecond: withAudio ? CAMERA_AUDIO_BPS : undefined,
      firstSeq: this.deps.sequence[kind],
      env: { MediaRecorder: Ctor, now: this.deps.now },
      onSegment: (blob, info) => this.onSegment(blob, info),
      onError: (reason, err) => this.onRecorderError(kind, reason, err, stream),
    });
  }

  private onSegment(blob: Blob, info: SegmentInfo): void {
    this.deps.sequence[info.stream] = Math.max(this.deps.sequence[info.stream], info.seq + 1);
    // A part of a few seconds or more: recording this stream works (again); earlier failures no longer count.
    if (info.durationMs >= HEALTHY_SEGMENT_MS) this.failures[info.stream] = 0;
    void this.deps.queue
      .put(blob, { stream: info.stream, seq: info.seq, startedAt: info.startedAt, durationMs: info.durationMs, mimeType: info.mimeType, instanceId: this.deps.instanceId })
      .catch((err) => console.warn('[recording] could not queue a segment', err));
  }

  private onRecorderError(kind: RecordingStream, reason: string, err?: unknown, stream?: MediaStream): void {
    if (this.stopped) return;
    const rec = kind === 'camera' ? this.cameraRec : this.screenRec;
    // Sequence numbers handed out by the failed recorder are used up.
    if (rec) this.deps.sequence[kind] = Math.max(this.deps.sequence[kind], rec.nextSequence);
    // Its video ended (sharing stopped, the camera went away): not a recording failure. The share / camera handlers
    // record that (screen_share_stopped, camera events) and start recording again when it is back.
    if (stream && stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      if (kind === 'camera') this.cameraRec = null;
      else this.screenRec = null;
      return;
    }
    console.warn(`[recording] ${kind} recorder: ${reason}`, err);
    void this.interrupted(kind, reason, kind === 'screen' ? 'The screen recording stopped in the browser.' : 'The webcam recording stopped in the browser.');
    this.failures[kind]++;
    if (this.failures[kind] > MAX_RETRIES) {
      this.gaveUp[kind] = true;
      if (this.nothingRecording()) this.deps.onProblem?.(NOTHING_RECORDED);
      return;
    }
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      if (this.stopped) return;
      if (kind === 'camera') this.restartCamera();
      else if (this.deps.screen.state.live && this.deps.screen.state.stream) void this.startScreen(this.deps.screen.state.stream);
    }, this.deps.retryMs ?? 5000);
    this.retryTimers.add(t);
  }

  private nothingRecording(): boolean {
    const { plan } = this.deps;
    return (!plan.camera || this.gaveUp.camera) && (!plan.screen || this.gaveUp.screen);
  }

  /** A `recording_interrupted` marker (the recording has a gap here). `stream` in its details: camera / screen / microphone. */
  private async interrupted(kind: RecordingStream, reason: string, observation: string, detailStream: RecordingStream | 'microphone' = kind): Promise<void> {
    const t = Math.round(this.deps.now());
    await this.deps
      .putEvent({
        id: uuid(),
        type: 'recording_interrupted',
        phase: 'close',
        startedAt: t,
        endedAt: t,
        confidence: 1,
        observation: observation.slice(0, 500),
        details: { stream: detailStream, reason },
        version: 1,
        clientInstanceId: this.deps.instanceId,
      })
      .catch((err) => console.warn('[recording] could not record an interruption', err));
  }

  /* ------------------------------------------------------------------ stop */

  /** Stop recording (pause, hold, end, camera release): the last segments are finished and queued. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    for (const u of this.unsubs.splice(0)) u();
    await this.cameraChain.catch(() => undefined);
    const recs = [this.cameraRec, this.screenRec];
    this.cameraRec = null;
    this.screenRec = null;
    await Promise.allSettled(recs.map((r) => r?.stop()));
    this.releaseVideo();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    await this.closeShareStopped(this.deps.now());
    this.deps.onProblem?.(null);
  }

  /** Whether screen sharing has stopped and the exam must be covered until it is shared again. */
  get screenShareStopped(): boolean {
    return this.shareStopped != null;
  }
}

const NOTHING_RECORDED = 'The recording of your exam is not working in this browser. Your exam continues; the exam administrator can see this and will decide what happens. If you can, use a current version of Chrome, Edge or Firefox next time.';
