/** Candidate-flow helpers for integration tests (drive the real HTTP API with fake camera frames). */
import { PRIVACY_NOTICE_VERSION, type CheckPurpose, type CompleteCheckResponse, type StartCheckResponse } from '@sp/shared';
import { expect } from 'vitest';
import type { FakeImageSpec } from '../src/vision/fake.js';
import type { CandidateClient, TestEnv } from './helpers.js';

export const DEVICE = { cameraLabel: 'Integrated Camera', cameraIdHash: 'cam-hash-a', userAgent: 'vitest', screen: { width: 1920, height: 1080, isExtended: false } };

export async function consent(c: CandidateClient) {
  const r = await c.req('POST', '/api/candidate/consent', { noticeVersion: PRIVACY_NOTICE_VERSION, accepted: true });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

export interface CheckOptions {
  /** Spec used for every frame (person etc.). */
  spec?: FakeImageSpec;
  /** Override per frontal frame. */
  frontal?: FakeImageSpec[];
  device?: typeof DEVICE;
  /** Do the head turns in the wrong direction (liveness failure). */
  wrongTurns?: boolean;
  /** Skip the complete call. */
  noComplete?: boolean;
}

const POSE: Record<string, { yawDeg: number; pitchDeg: number }> = {
  center: { yawDeg: 0, pitchDeg: 0 },
  turn_left: { yawDeg: 22, pitchDeg: 0 },
  turn_right: { yawDeg: -22, pitchDeg: 0 },
  look_up: { yawDeg: 0, pitchDeg: 14 },
  look_down: { yawDeg: 0, pitchDeg: -14 },
};

export async function startCheck(c: CandidateClient, purpose: CheckPurpose, device = DEVICE) {
  const r = await c.req('POST', '/api/candidate/checks', { purpose, clientInstanceId: c.instanceId, device });
  return r;
}

export async function runCheck(env: TestEnv, c: CandidateClient, purpose: CheckPurpose, o: CheckOptions = {}): Promise<{ start: StartCheckResponse; complete: CompleteCheckResponse | null }> {
  const r = await startCheck(c, purpose, o.device ?? DEVICE);
  expect(r.statusCode, r.body).toBe(200);
  const start = r.json() as StartCheckResponse;
  const spec = o.spec ?? { person: 'alice' };
  const nonce = start.liveness?.nonce ?? '';
  let t = env.clock.t;
  const url = `/api/candidate/checks/${start.checkId}/frames`;
  for (let i = 0; i < start.frontalFramesRequired; i++) {
    const fs = { ...spec, yawDeg: 0, pitchDeg: 0, ...(o.frontal?.[i] ?? {}) };
    const fr = await c.jpeg(url, fs, { step: 'frontal', capturedAt: (t += 200), nonce });
    expect(fr.statusCode, fr.body).toBe(200);
  }
  for (const step of start.liveness?.steps ?? []) {
    let pose = POSE[step.action];
    if (o.wrongTurns && step.action !== 'center') pose = { yawDeg: 0, pitchDeg: 0 };
    const fr = await c.jpeg(url, { ...spec, ...pose }, { step: step.index, capturedAt: (t += 300), nonce, clientYaw: pose.yawDeg, clientPitch: pose.pitchDeg });
    expect(fr.statusCode, fr.body).toBe(200);
  }
  env.clock.advance(Math.max(0, t - env.clock.t) + 100);
  if (o.noComplete) return { start, complete: null };
  const cr = await c.req('POST', `/api/candidate/checks/${start.checkId}/complete`);
  expect(cr.statusCode, cr.body).toBe(200);
  return { start, complete: cr.json() as CompleteCheckResponse };
}

/** Invite -> consent -> initial check -> start. Returns the candidate client in control. */
export async function startedSession(env: TestEnv, c: CandidateClient = env.candidateClient(), person = 'alice') {
  await consent(c);
  const { complete } = await runCheck(env, c, 'initial', { spec: { person } });
  expect(complete!.outcome, JSON.stringify(complete)).toBe('passed');
  const s = await c.req('POST', '/api/candidate/start');
  expect(s.statusCode, s.body).toBe(200);
  expect(s.json().session.status).toBe('active');
  return c;
}

export function hb(c: CandidateClient, extra: Record<string, unknown> = {}) {
  return c.req('POST', '/api/candidate/heartbeat', {
    clientInstanceId: c.instanceId,
    clientTime: Date.now(),
    seq: 1,
    monitoring: { state: 'ok', faces: 1, label: 'Candidate in view', open: [] },
    outboxSize: 0,
    outboxOldestAt: null,
    ...extra,
  });
}

export async function sample(env: TestEnv, c: CandidateClient, spec: FakeImageSpec, trigger = 'periodic', sampleId: string = crypto.randomUUID()) {
  const r = await c.jpeg('/api/candidate/identity/sample', spec, { sampleId, trigger, capturedAt: env.clock.t });
  return r;
}
