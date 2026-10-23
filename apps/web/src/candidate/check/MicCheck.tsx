import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMicError, MIC_CONSTRAINTS, MicLevelMeter, micVerdict, webAudioSupported } from '../monitoring/micLevel';

/**
 * "Microphone is working" on the camera check, for exams that record sound (policy.recording.audio). The candidate
 * says a few words; the item turns green once their voice is heard. Silence is a warning (they can continue); only a
 * microphone that is clearly absent (none connected, access refused) blocks, with a "Try again".
 */

export type MicCheckState = 'starting' | 'listening' | 'ok' | 'quiet' | 'unavailable' | 'blocked';

export function useMicCheck(enabled: boolean): { state: MicCheckState | null; message: string | null; retry: () => void } {
  const [state, setState] = useState<MicCheckState | null>(enabled ? 'starting' : null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const verdictRef = useRef<MicCheckState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let meter: MicLevelMeter | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const set = (s: MicCheckState, m: string | null = null) => {
      if (cancelled) return;
      verdictRef.current = s;
      setState(s);
      setMessage(m);
    };
    set('starting');
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        set('blocked', 'This browser cannot use a microphone. Use a current version of Chrome, Edge or Firefox.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
      } catch (err) {
        const d = describeMicError(err);
        set(d.blocking ? 'blocked' : 'unavailable', d.message);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!webAudioSupported()) {
        // The microphone opened; its level cannot be measured here.
        set('ok');
        return;
      }
      try {
        meter = new MicLevelMeter(stream);
      } catch {
        set('ok');
        return;
      }
      const levels: number[] = [];
      const started = Date.now();
      set('listening');
      timer = setInterval(() => {
        if (!meter) return;
        levels.push(meter.level());
        const v = micVerdict(levels, Date.now() - started);
        if (v !== verdictRef.current) set(v);
        if (v === 'ok' && timer) {
          // Heard: nothing more to measure (and the microphone is released below).
          clearInterval(timer);
          timer = null;
          meter.close();
          meter = null;
          stream?.getTracks().forEach((t) => t.stop());
        }
      }, 250);
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      meter?.close();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, message, retry };
}

const LABEL = 'Microphone is working';

export function MicCheckItem({ state, message, onRetry }: { state: MicCheckState; message: string | null; onRetry: () => void }) {
  const ok = state === 'ok';
  const blocking = state === 'blocked';
  const guidance =
    state === 'starting'
      ? 'Starting the microphone…'
      : state === 'listening'
        ? 'This exam records sound. Say a few words — for example your name — so we can check your microphone.'
        : state === 'quiet'
          ? 'We could not hear anything from your microphone yet. Check that it is not muted and say a few words. You can continue: if your microphone works, the recording will have sound.'
          : (message ?? '');
  return (
    <ul className="cand-checklist" data-testid="mic-check">
      <li className={ok ? 'ok' : blocking ? 'fail' : 'warn'} data-item="microphone" data-state={state} data-ok={ok ? '1' : '0'}>
        <span className="cand-check-icon" aria-hidden="true">
          {ok ? '✓' : blocking ? '•' : '!'}
        </span>
        <div>
          <div>
            {LABEL}
            <span className="sr-only">{ok ? ' — OK' : blocking ? ' — not yet' : ' — warning'}</span>
          </div>
          {!ok && <div className="muted small">{guidance}</div>}
          {(blocking || state === 'unavailable') && (
            <div style={{ marginTop: 6 }}>
              <button type="button" className="btn btn-sm" onClick={onRetry} data-testid="mic-retry">
                Try again
              </button>
            </div>
          )}
        </div>
      </li>
    </ul>
  );
}
