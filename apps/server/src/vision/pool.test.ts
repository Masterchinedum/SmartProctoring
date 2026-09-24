/**
 * Worker-pool mechanics with a scripted stand-in worker (no models needed): the "image" bytes tell the fake
 * worker what to do (`sleep:<ms>`, `bad`, `crash`), and the result echoes the image so order can be checked.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VisionInputError } from './image';
import { BACKGROUND_MAX_WAIT_MS, resolveWorkerScript, VisionBusyError, VisionClosedError, VisionWorkerPool, type WorkerScript } from './pool';

const FAKE_WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
parentPort.on('message', async (msg) => {
  if (msg.type === 'close') { parentPort.close(); return; }
  const cmd = Buffer.from(msg.image).toString();
  if (cmd === 'crash') process.exit(3);
  if (cmd === 'bad') { parentPort.postMessage({ type: 'result', id: msg.id, ok: false, error: { name: 'VisionInputError', message: 'Unsupported or corrupt image' } }); return; }
  if (cmd.startsWith('sleep:')) await sleep(Number(cmd.slice(6)));
  parentPort.postMessage({ type: 'result', id: msg.id, ok: true, analysis: { dhash: cmd, faceCropJpeg: new Uint8Array([1, 2, 3]), embedding: new Float32Array([0.5]), faces: [], primary: null } });
});
if (workerData.engine.modelsDir === 'fail') parentPort.postMessage({ type: 'init_error', error: { name: 'VisionModelsNotFoundError', message: 'no models' } });
else setTimeout(() => parentPort.postMessage({ type: 'ready' }), 5);
`;

const dir = mkdtempSync(join(tmpdir(), 'sp-vision-pool-'));
const script: WorkerScript = { kind: 'js', file: join(dir, 'fake-worker.mjs') };
writeFileSync(script.file, FAKE_WORKER);

const pools: VisionWorkerPool[] = [];
async function start(size: number, maxQueue = 16, modelsDir = 'ok', onWorkerExit?: () => void, backgroundMaxWaitMs?: number) {
  const pool = await VisionWorkerPool.start({ size, maxQueue, script, onWorkerExit, backgroundMaxWaitMs, workerData: { engine: { modelsDir, threads: 1 }, nice: 0 } });
  pools.push(pool);
  return pool;
}
const img = (s: string) => Buffer.from(s);
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe('VisionWorkerPool', () => {
  it('runs work on workers and restores the ImageAnalysis contract (Buffers)', async () => {
    const pool = await start(2);
    expect(pool.size).toBe(2);
    const a = await pool.analyze(img('hello'), { embed: true });
    expect(a.dhash).toBe('hello');
    expect(Buffer.isBuffer(a.faceCropJpeg)).toBe(true);
    expect(a.embedding).toBeInstanceOf(Float32Array);
  });

  it('maps worker errors back to their classes (VisionInputError -> HTTP 400)', async () => {
    const pool = await start(1);
    await expect(pool.analyze(img('bad'), {})).rejects.toBeInstanceOf(VisionInputError);
    expect((await pool.analyze(img('after'), {})).dhash).toBe('after');
  });

  it('serves interactive work before queued background work, and never starves background work', async () => {
    const pool = await start(1);
    const order: string[] = [];
    const run = (name: string, priority: 'interactive' | 'background', ms = 20) => pool.analyze(img(`sleep:${ms}`), { priority }).then(() => order.push(name));
    const all = [run('first', 'interactive', 60), run('bg1', 'background'), run('bg2', 'background'), run('int1', 'interactive'), run('int2', 'interactive')];
    await Promise.all(all);
    expect(order).toEqual(['first', 'int1', 'int2', 'bg1', 'bg2']);
    expect(BACKGROUND_MAX_WAIT_MS).toBeGreaterThan(0);
  });

  it('alternates overdue background work with interactive work (no starvation under saturation)', async () => {
    const pool = await start(1, 16, 'ok', undefined, 30);
    const order: string[] = [];
    const run = (name: string, priority: 'interactive' | 'background', ms = 5) => pool.analyze(img(`sleep:${ms}`), { priority }).then(() => order.push(name));
    const busy = run('busy', 'interactive', 120);
    const bgs = [run('bg1', 'background'), run('bg2', 'background')];
    await new Promise((r) => setTimeout(r, 60)); // background now overdue
    await Promise.all([busy, ...bgs, run('int1', 'interactive'), run('int2', 'interactive')]);
    expect(order).toEqual(['busy', 'bg1', 'int1', 'bg2', 'int2']);
  });

  it('refuses work beyond maxQueue per priority with VisionBusyError', async () => {
    const pool = await start(1, 2);
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => pool.analyze(img('sleep:30'), {})));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(3); // 1 running + 2 queued
    expect(settled.filter((s) => s.status === 'rejected' && s.reason instanceof VisionBusyError)).toHaveLength(2);
    // The background queue has its own budget.
    const bg = await Promise.allSettled([pool.analyze(img('sleep:30'), {}), ...Array.from({ length: 3 }, () => pool.analyze(img('x'), { priority: 'background' }))]);
    expect(bg.filter((s) => s.status === 'rejected')).toHaveLength(1);
  });

  it('fails only the analysis of a crashed worker and replaces the worker', async () => {
    let exits = 0;
    const pool = await start(1, 16, 'ok', () => exits++);
    const crashed = pool.analyze(img('crash'), {});
    const queued = pool.analyze(img('next'), {});
    await expect(crashed).rejects.toThrow(/exited/);
    expect((await queued).dhash).toBe('next');
    expect(exits).toBe(1);
    expect(pool.size).toBe(1);
  });

  it('reports a worker that cannot start (e.g. models missing)', async () => {
    await expect(start(2, 16, 'fail')).rejects.toThrow(/no models/);
  });

  it('close() lets in-flight work finish, fails queued work and refuses new work', async () => {
    const pool = await start(1);
    const inFlight = pool.analyze(img('sleep:50'), {});
    const queued = pool.analyze(img('later'), {});
    await new Promise((r) => setTimeout(r, 10));
    const closing = pool.close();
    await expect(queued).rejects.toBeInstanceOf(VisionClosedError);
    expect((await inFlight).dhash).toBe('sleep:50');
    await closing;
    await expect(pool.analyze(img('x'), {})).rejects.toBeInstanceOf(VisionClosedError);
  });

  it('finds the bundled worker next to the bundle, else the TypeScript source', () => {
    const bundle = mkdtempSync(join(tmpdir(), 'sp-dist-'));
    writeFileSync(join(bundle, 'vision-worker.js'), '');
    expect(resolveWorkerScript(bundle)).toEqual({ kind: 'js', file: join(bundle, 'vision-worker.js') });
    const src = resolveWorkerScript(__dirname);
    expect(src.kind).toBe('ts');
    expect(src.file).toBe(join(__dirname, 'worker.ts'));
    expect(() => resolveWorkerScript(dir)).toThrow(/not found/);
  });
});
