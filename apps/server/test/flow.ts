/** Candidate-flow helpers for integration tests (drive the real HTTP API with fake camera frames). */
import { PRIVACY_NOTICE_VERSION, type CheckFrameResponse, type CheckProgressDTO, type CheckPurpose, type CompleteCheckResponse, type StartCheckResponse } from '@sp/shared';
import { expect } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { identityChecks, identitySampleFrames, type IdentityCheck } from '../src/db/schema.js';
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
  /** Do not send the extra frontal frames the server asks for (progress.frontalNeeded). */
  ignoreProgress?: boolean;
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

/**
 * Drive a check like the web client: the required frontal frames, one frame per liveness step, then extra frontal
 * frames while the server's progress asks for them (frontalNeeded, up to maxFrontalFrames), then /complete.
 */
export async function runCheck(
  env: TestEnv,
  c: CandidateClient,
  purpose: CheckPurpose,
  o: CheckOptions = {},
): Promise<{
  start: StartCheckResponse;
  complete: CompleteCheckResponse | null;
  progress: CheckProgressDTO | null;
  frontalSent: number;
  /** Staff side (never sent to the candidate): the check's identity decision against the reference ... */
  identity: IdentityCheck | null;
  /** ... and its ID-photo comparison (initial checks). */
  idPhoto: IdentityCheck | null;
}> {
  const r = await startCheck(c, purpose, o.device ?? DEVICE);
  expect(r.statusCode, r.body).toBe(200);
  const start = r.json() as StartCheckResponse;
  const spec = o.spec ?? { person: 'alice' };
  const nonce = start.liveness?.nonce ?? '';
  let t = env.clock.t;
  const url = `/api/candidate/checks/${start.checkId}/frames`;
  let progress: CheckProgressDTO | null = null;
  let frontalSent = 0;
  const sendFrontal = async () => {
    const fs = { ...spec, yawDeg: 0, pitchDeg: 0, ...(o.frontal?.[frontalSent] ?? {}) };
    const fr = await c.jpeg(url, fs, { step: 'frontal', capturedAt: (t += 200), nonce });
    expect(fr.statusCode, fr.body).toBe(200);
    frontalSent++;
    progress = (fr.json() as CheckFrameResponse).progress ?? progress;
  };
  for (let i = 0; i < start.frontalFramesRequired; i++) await sendFrontal();
  for (const step of start.liveness?.steps ?? []) {
    let pose = POSE[step.action];
    if (o.wrongTurns && step.action !== 'center') pose = { yawDeg: 0, pitchDeg: 0 };
    const fr = await c.jpeg(url, { ...spec, ...pose }, { step: step.index, capturedAt: (t += 300), nonce, clientYaw: pose.yawDeg, clientPitch: pose.pitchDeg });
    expect(fr.statusCode, fr.body).toBe(200);
    progress = (fr.json() as CheckFrameResponse).progress ?? progress;
  }
  const max = start.maxFrontalFrames ?? start.frontalFramesRequired;
  while (!o.ignoreProgress && progress && (progress as CheckProgressDTO).frontalNeeded > 0 && frontalSent < max) await sendFrontal();
  env.clock.advance(Math.max(0, t - env.clock.t) + 100);
  if (o.noComplete) return { start, complete: null, progress, frontalSent, identity: null, idPhoto: null };
  const cr = await c.req('POST', `/api/candidate/checks/${start.checkId}/complete`);
  expect(cr.statusCode, cr.body).toBe(200);
  const complete = cr.json() as CompleteCheckResponse;
  // The candidate is never told the identity decision / similarity; tests read them staff-side.
  expect(complete).not.toHaveProperty('identity');
  expect(complete).not.toHaveProperty('idPhoto');
  const rows = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.checkId, start.checkId)).orderBy(desc(identityChecks.receivedAt));
  return { start, complete, progress, frontalSent, identity: rows.find((x) => x.trigger !== 'id_photo') ?? null, idPhoto: rows.find((x) => x.trigger === 'id_photo') ?? null };
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

/**
 * Send a burst (one request per frame sharing burstId). `order` sends the frames in another order (indexes);
 * `omit` leaves frames out (an incomplete burst). Returns every response in send order.
 */
export async function burst(
  env: TestEnv,
  c: CandidateClient,
  specs: FakeImageSpec[],
  o: { trigger?: string; burstId?: string; order?: number[]; omit?: number[]; size?: number } = {},
) {
  const burstId = o.burstId ?? crypto.randomUUID();
  const size = o.size ?? specs.length;
  const order = (o.order ?? specs.map((_, i) => i)).filter((i) => !(o.omit ?? []).includes(i));
  const out = [];
  for (const i of order) {
    const r = await c.jpeg('/api/candidate/identity/sample', specs[i], {
      sampleId: crypto.randomUUID(),
      trigger: o.trigger ?? 'periodic',
      capturedAt: env.clock.t + i * 200,
      burstId,
      burstIndex: i,
      burstSize: size,
    });
    expect(r.statusCode, r.body).toBe(200);
    out.push(r.json());
  }
  return { burstId, responses: out, last: out[out.length - 1] };
}

/**
 * The staff-side decision behind a candidate's sample receipt (IdentitySampleResponse.result.id: the identity check,
 * or the burst frame of an intermediate frame). The candidate is never told it.
 */
export async function sampleDecision(env: TestEnv, res: { result: { id: string } }): Promise<string | undefined> {
  const [row] = await env.ctx.db.select({ decision: identityChecks.decision }).from(identityChecks).where(eq(identityChecks.id, res.result.id));
  if (row) return row.decision;
  const [f] = await env.ctx.db.select({ decision: identitySampleFrames.decision }).from(identitySampleFrames).where(eq(identitySampleFrames.id, res.result.id));
  return f?.decision;
}
