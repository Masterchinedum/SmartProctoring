/**
 * Microphone check for exams that record sound (policy.recording.audio): the readiness checklist asks the candidate
 * to say a few words and shows "Microphone is working" once their voice is heard. A quiet room is a WARNING, never a
 * block — the candidate can continue (the recording still has the sound); only a microphone that is clearly absent
 * (no device, access refused) blocks, with what to do.
 *
 * The level is measured with a WebAudio AnalyserNode over a long window (its largest buffer, ~0.7 s), read every
 * 250 ms, so a short sound between two reads is not missed.
 */

/** RMS level (0..1) at or above which the microphone counts as hearing something (≈ −40 dBFS: speech at a desk). */
export const MIC_HEARD_RMS = 0.01;
/** Without a sound this long, the check turns into a warning ("we could not hear you"). */
export const MIC_QUIET_AFTER_MS = 8_000;

export type MicVerdict = 'listening' | 'ok' | 'quiet';

/** Root mean square of time-domain samples (-1..1). */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * The check's state from the levels measured so far: `ok` once any level reached MIC_HEARD_RMS (it stays ok),
 * `quiet` when MIC_QUIET_AFTER_MS passed without that, `listening` before.
 */
export function micVerdict(levels: readonly number[], elapsedMs: number, opts: { heardRms?: number; quietAfterMs?: number } = {}): MicVerdict {
  const heard = opts.heardRms ?? MIC_HEARD_RMS;
  if (levels.some((l) => l >= heard)) return 'ok';
  return elapsedMs >= (opts.quietAfterMs ?? MIC_QUIET_AFTER_MS) ? 'quiet' : 'listening';
}

/** getUserMedia({audio}) failed: whether that blocks (no microphone, access refused) and what to tell the candidate. */
export function describeMicError(err: unknown): { blocking: boolean; message: string } {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        blocking: true,
        message:
          'Microphone access is blocked. This exam records sound: allow the microphone for this page (use the icon in the address bar or your browser’s site settings), then select Try again.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { blocking: true, message: 'No microphone was found. This exam records sound: connect a microphone (most webcams and headsets have one), then select Try again.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { blocking: false, message: 'The microphone could not be started. It may be in use by another application. You can continue; close other apps that use the microphone if you can.' };
    default:
      return { blocking: false, message: 'The microphone could not be checked. You can continue.' };
  }
}

/** Audio constraints for the recording microphone: the browser's echo cancellation and noise suppression on. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** Reads the level of an audio stream (WebAudio). `close()` releases the audio graph (not the stream). */
export class MicLevelMeter {
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly buf: Float32Array<ArrayBuffer>;

  constructor(stream: MediaStream, AudioContextCtor: typeof AudioContext = globalThis.AudioContext) {
    this.ctx = new AudioContextCtor();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 32768;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    // Created without a user gesture the context may start suspended: resuming is allowed once the page had one.
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** RMS level of the last ~0.7 s. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    return rms(this.buf);
  }

  close(): void {
    try {
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    void this.ctx.close().catch(() => undefined);
  }
}

/** WebAudio is available (the level check needs it; without it the microphone item only checks access). */
export function webAudioSupported(): boolean {
  return typeof globalThis.AudioContext === 'function';
}
