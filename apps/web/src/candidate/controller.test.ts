import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POLICY,
  type CandidateAnswerDTO,
  type CandidateSessionState,
  type CheckPurpose,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type SaveAnswerRequest,
  type SessionStatus,
} from '@sp/shared';
import { CandidateApiError, getPageInstanceId, type CandidateApi } from './api';
import { Outbox } from './outbox';

/* ------------------------------------------------------------------ mocks */

const h = vi.hoisted(() => ({
  api: null as unknown,
  runtimes: [] as { started: boolean; stopped: boolean; deps: { attentionState?: unknown }; learned: unknown }[],
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, createCandidateApi: () => h.api };
});

vi.mock('./monitoring/runtime', () => ({
  MonitoringRuntime: class {
    started = false;
    stopped = false;
    /** What the engine "learned" this period (the working region handed to the next period). */
    learned: unknown = null;
    constructor(readonly deps: { attentionState?: unknown }) {
      h.runtimes.push(this);
    }
    attentionState() {
      return this.learned;
    }
    async start() {
      this.started = true;
    }
    async stop() {
      this.stopped = true;
    }
    heartbeatMonitoring() {
      return { state: 'ok', faces: 1, label: 'Monitoring active', open: [], cameraState: 'live' };
    }
  },
}));

const { CandidateController, unsavedAnswersNotice } = await import('./controller');

/* ------------------------------------------------------------------ fake server */

const ME = getPageInstanceId();
const OTHER = 'other-browser-instance';
const QUESTIONS = [
  { id: 'q1', index: 0, type: 'short_text' as const, prompt: 'One', options: [], points: 1 },
  { id: 'q2', index: 1, type: 'short_text' as const, prompt: 'Two', options: [], points: 1 },
];

let sessionSeq = 0;

class FakeServer {
  readonly sessionId = `sess-${Date.now()}-${++sessionSeq}`;
  status: SessionStatus = 'active';
  verifiedInstanceId: string | null = ME;
  requiredCheck: CheckPurpose | null = null;
  requireFullscreen = true;
  pauseStartedAt: number | null = null;
  readonly answers = new Map<string, CandidateAnswerDTO>();
  readonly saveCalls: { questionId: string; req: SaveAnswerRequest }[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  /** When set, getState waits for this promise (a slow poll). */
  stateGate: Promise<void> | null = null;

  state(overrides: Partial<CandidateSessionState['session']> = {}): CandidateSessionState {
    const status = overrides.status ?? this.status;
    const verified = overrides.verifiedInstanceId !== undefined ? overrides.verifiedInstanceId : this.verifiedInstanceId;
    const inControl = verified === ME && (overrides.requiredCheck ?? this.requiredCheck) == null;
    const show = (status === 'active' && inControl) || status === 'submitted';
    return {
      serverTime: Date.now(),
      session: {
        id: this.sessionId,
        status,
        endReason: null,
        remainingMs: 30 * 60_000,
        timerRunning: status === 'active',
        durationMs: 30 * 60_000,
        currentQuestionIndex: 0,
        pauseCount: 0,
        requiredCheck: this.requiredCheck,
        verifiedInstanceId: verified,
        hold: null,
        pauseRequest: null,
        window: null,
        ...overrides,
      },
      exam: {
        id: 'exam',
        title: 'Exam',
        description: '',
        instructions: '',
        durationSec: 1800,
        questionCount: QUESTIONS.length,
        policy: { ...DEFAULT_POLICY, browser: { ...DEFAULT_POLICY.browser, requireFullscreen: this.requireFullscreen } },
      },
      candidate: { id: 'c', name: 'Candidate', hasIdPhoto: false },
      consent: { accepted: true, acceptedAt: 1, notice: { version: '1', sections: [], retentionDays: 30, monitored: [], stored: [], notStored: [], contact: '' } },
      questions: show ? QUESTIONS : null,
      answers: show ? [...this.answers.values()] : null,
    };
  }

  api(): CandidateApi {
    const timing = () => ({ sentAt: Date.now(), receivedAt: Date.now() });
    const fail = () => {
      throw new Error('not used in this test');
    };
    return {
      instanceId: ME,
      getState: async () => {
        const snapshot = this.state();
        if (this.stateGate) await this.stateGate;
        return { data: snapshot, timing: timing() };
      },
      heartbeat: async (req) => {
        this.heartbeats.push(req);
        const res: HeartbeatResponse = { serverTime: Date.now(), status: this.status, remainingMs: 30 * 60_000, timerRunning: this.status === 'active', requiredCheck: this.requiredCheck, commands: [] };
        return { data: res, timing: timing() };
      },
      saveAnswer: async (questionId, req) => {
        this.saveCalls.push({ questionId, req });
        if (this.verifiedInstanceId !== ME) throw new CandidateApiError(409, 'check_required', 'check first');
        if (this.status !== 'active') {
          // Server rule: while paused / on hold only answers from before the pause started are accepted.
          const late = (this.status === 'paused' || this.status === 'on_hold') && this.pauseStartedAt != null && req.answeredAt <= this.pauseStartedAt;
          if (!late) throw new CandidateApiError(409, this.status === 'submitted' || this.status === 'terminated' ? 'exam_ended' : 'invalid_state', 'Answers cannot be saved right now', { status: this.status });
        }
        const cur = this.answers.get(questionId);
        if (!cur || cur.clientSeq < req.clientSeq) this.answers.set(questionId, { questionId, value: req.value, clientSeq: req.clientSeq, savedAt: Date.now() });
        return { saved: true, applied: true, serverSeq: req.clientSeq };
      },
      sendEvents: async (events) => ({ results: events.map((e) => ({ id: e.id, result: 'created' as const })) }),
      uploadEvidence: async () => ({ stored: true, duplicate: false }),
      identitySample: fail,
      consent: fail,
      startCheck: fail,
      uploadCheckFrame: fail,
      completeCheck: fail,
      start: fail,
      pause: fail,
      cancelPause: fail,
      submit: fail,
      withdrawConsent: fail,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

type Controller = InstanceType<typeof CandidateController>;
let server: FakeServer;
let ctrl: Controller | null = null;

function newController(): Controller {
  h.api = server.api();
  ctrl = new CandidateController(`token-${server.sessionId}`);
  return ctrl;
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  h.runtimes.length = 0;
  server = new FakeServer();
});

afterEach(() => {
  ctrl?.dispose();
  ctrl = null;
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ tests */

describe('CandidateController — exam start deferred while the server is at capacity', () => {
  it('waits as long as the server asks (plus a spread), tells the screen, then starts by itself', async () => {
    server.status = 'ready';
    const c = newController();
    await c.load();
    let calls = 0;
    (h.api as CandidateApi).start = async () => {
      calls++;
      if (calls === 1) throw new CandidateApiError(503, 'start_deferred', 'Many candidates are starting at the same time.', undefined, 8_000);
      server.status = 'active';
      return { data: server.state(), timing: { sentAt: Date.now(), receivedAt: Date.now() } };
    };
    let told = 0;
    const started = c.startExam(() => told++);
    await tick(10);
    expect([calls, told]).toEqual([1, 1]);
    await tick(7_900);
    expect(calls).toBe(1); // never before the server's Retry-After
    await tick(4_200); // at most +50 %
    expect(calls).toBe(2);
    await started;
    expect(c.getSnapshot().state?.session.status).toBe('active');
  });

  it('throws any other failure as before', async () => {
    server.status = 'ready';
    const c = newController();
    await c.load();
    (h.api as CandidateApi).start = async () => {
      throw new CandidateApiError(409, 'invalid_state', 'The exam can only be started after the readiness check');
    };
    await expect(c.startExam()).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('CandidateController — answers typed just after a staff-approved pause (P1-1)', () => {
  it('keeps the answer, does not signal a reporting outage, and saves it once the exam is active again', async () => {
    server.answers.set('q1', { questionId: 'q1', value: 'before', clientSeq: 1, savedAt: 1 });
    const c = newController();
    await c.load();
    await tick(10);
    expect(c.answers?.get('q1')).toBe('before');
    expect(h.runtimes).toHaveLength(1);

    // Staff approve the pause; this page learns it only with its next heartbeat.
    server.status = 'paused';
    server.pauseStartedAt = Date.now();
    await tick(100);
    c.answers!.set('q1', 'typed after approval');
    await tick(1_200); // debounce + outbox kick → refused (409 invalid_state) → parked
    expect(server.saveCalls.at(-1)?.req.value).toBe('typed after approval');
    expect(server.answers.get('q1')?.value).toBe('before');
    expect(c.outbox!.stats()).toMatchObject({ pendingAnswers: 1, parkedAnswers: 1, oldestAt: null });
    expect(c.answers!.get('q1')).toBe('typed after approval');

    // Heartbeat → paused screen. Waiting there is not a reporting outage, and nothing is re-sent meanwhile.
    await tick(5_000);
    expect(c.getSnapshot().state?.session.status).toBe('paused');
    const refusals = server.saveCalls.length;
    await tick(40_000);
    expect(server.saveCalls.length).toBe(refusals);
    expect(c.getSnapshot().reportingInterrupted).toBe(false);

    // Resume check passes in the same page: the server serves its (older) answers again.
    server.status = 'active';
    server.pauseStartedAt = null;
    c.setAwaitingContinue({ key: 'resume', purpose: 'resume', from: 'paused' });
    await c.applyState(server.state());
    await tick(500);
    expect(server.answers.get('q1')).toMatchObject({ value: 'typed after approval', clientSeq: 2 });
    expect(c.answers!.get('q1')).toBe('typed after approval');
    expect(c.outbox!.stats()).toMatchObject({ size: 0, pendingAnswers: 0 });
    expect(c.getSnapshot().answerNotice).toBeNull();
  });

  it('re-syncs the answer store with the server on resume (the server wins unless a local answer is newer)', async () => {
    server.answers.set('q1', { questionId: 'q1', value: 'a', clientSeq: 1, savedAt: 1 });
    const c = newController();
    await c.load();
    await tick(10);
    // Paused (without approval) from this page; meanwhile the server got a newer value for q1 and a first q2
    // (e.g. answers delivered late from another device's queue).
    server.status = 'paused';
    await c.applyState(server.state());
    server.answers.set('q1', { questionId: 'q1', value: 'server newer', clientSeq: 5, savedAt: 2 });
    server.answers.set('q2', { questionId: 'q2', value: 'server only', clientSeq: 6, savedAt: 2 });
    server.status = 'active';
    c.setAwaitingContinue({ key: 'resume', purpose: 'resume', from: 'paused' });
    await c.applyState(server.state());
    expect(c.answers!.get('q1')).toBe('server newer');
    expect(c.answers!.get('q2')).toBe('server only');
    c.answers!.set('q2', 'edited');
    await tick(1_200);
    expect(server.answers.get('q2')).toMatchObject({ value: 'edited', clientSeq: 7 });
  });

  it('drops a parked answer with a calm notice when the exam ended during the pause', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    server.status = 'paused';
    server.pauseStartedAt = Date.now();
    await tick(100);
    c.answers!.set('q2', 'too late');
    await tick(1_200);
    expect(c.outbox!.stats().parkedAnswers).toBe(1);
    await tick(5_000); // heartbeat → paused
    server.status = 'terminated';
    await tick(15_000); // paused-state poll → terminated → the parked answer gets its final answer
    await tick(500);
    expect(c.getSnapshot().state?.session.status).toBe('terminated');
    expect(server.saveCalls.at(-1)?.req.value).toBe('too late');
    expect(c.outbox!.stats().pendingAnswers).toBe(0);
    expect(c.getSnapshot().answerNotice).toBe('One answer typed after the exam ended could not be saved.');
  });

  it('gives up on an answer left queued on this device when the exam ended before the page was reopened', async () => {
    // Previous page: an answer still queued (e.g. parked while paused), then the browser was closed.
    // (jsdom has no IndexedDB: hand the controller an outbox that already holds it.)
    const stored = await Outbox.open({ namespace: server.sessionId, memory: true });
    await stored.putAnswer({ questionId: 'q1', value: 'typed in the gap', clientSeq: 4, answeredAt: 1 });
    vi.spyOn(Outbox, 'open').mockResolvedValueOnce(stored);
    server.status = 'submitted'; // e.g. the clock ran out during the pause
    server.verifiedInstanceId = OTHER;
    const c = newController();
    await c.load();
    await tick(10);
    expect(c.outbox!.stats().pendingAnswers).toBe(0);
    expect(c.getSnapshot().answerNotice).toBe('One answer kept on this device could not be sent before the exam ended.');
  });

  it('formats the notice for several answers', () => {
    expect(unsavedAnswersNotice(0, 0)).toBeNull();
    expect(unsavedAnswersNotice(2, 0)).toBe('2 answers typed after the exam ended could not be saved.');
  });
});

describe('CandidateController — "Check complete" waits for the click (P1-2, P2-1)', () => {
  it('reconnect: heartbeats start as soon as the check passes; monitoring starts only after the click', async () => {
    server.verifiedInstanceId = OTHER; // reloaded page: a reconnect check is required
    server.requiredCheck = 'reconnect';
    const c = newController();
    await c.load();
    await tick(10_000);
    expect(server.heartbeats).toHaveLength(0);

    // The check passes: the server makes this browser the verified one.
    server.verifiedInstanceId = ME;
    server.requiredCheck = null;
    c.setAwaitingContinue({ key: 'reconnect', purpose: 'reconnect', from: 'active' });
    await c.applyState(server.state());
    await tick(25_000); // the candidate reads the "Check complete" screen
    expect(server.heartbeats.length).toBeGreaterThanOrEqual(5);
    expect(server.heartbeats[0].monitoring).toMatchObject({ state: 'off', label: 'Check passed — waiting for the candidate to continue' });
    expect(h.runtimes).toHaveLength(0);
    expect(c.getSnapshot().monitoringActive).toBe(false);

    // Click (fullscreen entered by the check flow), then monitoring starts.
    c.setAwaitingContinue(null);
    await tick(10);
    expect(h.runtimes).toHaveLength(1);
    expect(h.runtimes[0].started).toBe(true);
    await tick(5_000);
    expect(server.heartbeats.at(-1)?.monitoring.state).toBe('ok');
  });

  it('resume: a paused-state poll that reports the exam active does not start monitoring before the click', async () => {
    server.status = 'paused';
    const c = newController();
    await c.load();
    // The resume check passes while a poll is under way; the poll also reports "active".
    server.status = 'active';
    c.setAwaitingContinue({ key: 'resume', purpose: 'resume', from: 'paused' });
    await tick(15_000); // paused-state poll
    await c.applyState(server.state());
    await tick(15_000);
    expect(c.getSnapshot().state?.session.status).toBe('active');
    expect(h.runtimes).toHaveLength(0);
    expect(server.heartbeats.length).toBeGreaterThanOrEqual(3);
    c.setAwaitingContinue(null);
    await tick(10);
    expect(h.runtimes).toHaveLength(1);
  });

  it('discards a stale state load that was in flight when the passed check was applied', async () => {
    server.status = 'paused';
    const c = newController();
    await c.load();
    let release!: () => void;
    server.stateGate = new Promise((r) => (release = r));
    const poll = c.load(); // snapshot: paused
    server.stateGate = null;
    server.status = 'active';
    c.setAwaitingContinue({ key: 'resume', purpose: 'resume', from: 'paused' });
    await c.applyState(server.state());
    release();
    await poll;
    expect(c.getSnapshot().state?.session.status).toBe('active');
    expect(c.getSnapshot().awaitingContinue).not.toBeNull();
  });

  it('drops the waiting "Check complete" state when the exam is held meanwhile', async () => {
    server.status = 'paused';
    const c = newController();
    await c.load();
    server.status = 'active';
    c.setAwaitingContinue({ key: 'resume', purpose: 'resume', from: 'paused' });
    await c.applyState(server.state());
    server.status = 'on_hold';
    await tick(5_000); // heartbeat → reload
    expect(c.getSnapshot().state?.session.status).toBe('on_hold');
    expect(c.getSnapshot().awaitingContinue).toBeNull();
    expect(h.runtimes).toHaveLength(0);
  });
});

describe('CandidateController — withdrawing consent', () => {
  it('delivers the answers first, then ends the exam, stops monitoring and deletes images queued on this device', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    expect(h.runtimes).toHaveLength(1);
    const api = h.api as CandidateApi;
    api.uploadEvidence = async () => {
      throw new CandidateApiError(0, 'network_error', 'Could not reach the server.');
    };
    await c.outbox!.putEvidence({ id: 'e1', eventId: 'ev', capturedAt: Date.now(), reason: 'onset', jpeg: new Uint8Array([1, 2, 3]) });
    await c.outbox!.putSample({ id: 's1', trigger: 'periodic', capturedAt: Date.now(), jpeg: new Uint8Array([4, 5, 6]), busy: true });
    c.answers!.set('q1', 'my answer');
    const calls: { reason?: string; savedBefore: boolean }[] = [];
    api.withdrawConsent = async (req) => {
      calls.push({ reason: req.reason, savedBefore: server.answers.get('q1')?.value === 'my answer' });
      server.status = 'terminated';
      return { ...server.state(), session: { ...server.state().session, status: 'terminated', endReason: 'candidate_withdrew' } };
    };
    await c.withdrawConsent('  I prefer an exam centre.  ');
    expect(calls).toEqual([{ reason: 'I prefer an exam centre.', savedBefore: true }]);
    expect(h.runtimes[0].stopped).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ monitoringActive: false, state: { session: { status: 'terminated', endReason: 'candidate_withdrew' } } });
    expect(c.outbox!.stats()).toMatchObject({ pendingAnswers: 0 });
    expect(c.outbox!.stats().size).toBe(0);
  });

  it('keeps the exam going when the request cannot reach the server, and says so', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    (h.api as CandidateApi).withdrawConsent = async () => {
      throw new CandidateApiError(0, 'network_error', 'Could not reach the server.');
    };
    await expect(c.withdrawConsent()).rejects.toThrow(/could not reach the server/i);
    expect(h.runtimes[0].stopped).toBe(false);
    expect(c.getSnapshot().state?.session.status).toBe('active');
  });
});

describe('CandidateController — reporting interrupted (P2-4)', () => {
  it('is not signalled while identity samples wait in a busy server vision queue', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    let busy = true;
    const api = h.api as CandidateApi;
    api.identitySample = async () => {
      if (busy) throw new CandidateApiError(503, 'vision_busy', 'The server is busy analysing images.');
      return { result: { id: 'r', trigger: 'face_return', usable: true, guidance: [], at: 1 }, followUpInMs: null, status: 'active', hold: null };
    };
    await c.outbox!.putSample({ id: 's1', trigger: 'face_return', capturedAt: Date.now(), jpeg: new Uint8Array([1, 2, 3]) });
    await tick(30_000);
    expect(c.outbox!.stats()).toMatchObject({ size: 1, busySamples: 1, oldestAt: null });
    expect(c.getSnapshot().reportingInterrupted).toBe(false);
    expect(server.heartbeats.at(-1)).toMatchObject({ outboxSize: 1, outboxOldestAt: null });
    busy = false;
    await tick(40_000);
    expect(c.outbox!.stats().size).toBe(0);
  });

  it('is signalled when deliveries fail for more than 10 s', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    const api = h.api as CandidateApi;
    api.sendEvents = async () => {
      throw new CandidateApiError(0, 'network_error', 'Could not reach the server.');
    };
    await c.outbox!.putEvent({ id: 'afafafaf-afaf-4faf-8faf-afafafafafaf', type: 'tab_hidden', phase: 'open', startedAt: Date.now(), endedAt: null, confidence: 1, details: {}, version: 1 });
    await tick(5_000);
    expect(c.getSnapshot().reportingInterrupted).toBe(false);
    await tick(7_000);
    expect(c.getSnapshot().reportingInterrupted).toBe(true);
  });
});

describe('CandidateController — camera released on screens without monitoring (e2e 16: ID-photo hold at check-in)', () => {
  it('releases a camera that a check left on when the exam is on hold without monitoring', async () => {
    server.status = 'invited';
    server.verifiedInstanceId = null;
    const c = newController();
    await c.load();
    await c.camera.start(); // the check's camera (no camera in jsdom: wanted, but unavailable)
    expect(c.camera.state.wanted).toBe(true);
    // The check ends in a hold (e.g. required ID-photo comparison): the hold screen asks for the camera to go.
    server.status = 'on_hold';
    await c.applyState(server.state());
    expect(h.runtimes).toHaveLength(0);
    c.releaseIdleCamera();
    expect(c.camera.state.wanted).toBe(false);
  });

  it('leaves the camera of running monitoring alone (stopMonitoring releases it after closing episodes)', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    expect(h.runtimes).toHaveLength(1);
    await c.camera.start();
    c.releaseIdleCamera();
    expect(c.camera.state.wanted).toBe(true);
  });
});

describe('CandidateController — the working region across monitoring periods', () => {
  it('hands the engine state learned in one period to the next (pause / resume in this page)', async () => {
    const c = newController();
    await c.load();
    await tick(10);
    expect(h.runtimes).toHaveLength(1);
    expect(h.runtimes[0].deps.attentionState ?? null).toBeNull();
    const learned = { v: 1, cameraId: 'cam-a', prior: { yaw: 0, pitch: -5 }, pointer: [30, -5, 0, 0], typed: [], calm: [], keyboard: [] };
    h.runtimes[0].learned = learned;

    server.status = 'paused';
    await c.applyState(server.state());
    await tick(10);
    expect(h.runtimes[0].stopped).toBe(true);

    server.status = 'active';
    await c.applyState(server.state());
    await tick(10);
    expect(h.runtimes).toHaveLength(2);
    expect(h.runtimes[1].deps.attentionState).toEqual(learned);
  });
});
