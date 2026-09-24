/**
 * Vision worker thread entry (spawned by pool.ts). Owns one VisionEngine (its own onnxruntime sessions) and
 * analyses one image at a time, so the synchronous inference never blocks the server's event loop.
 *
 * Bundled as its own entry (tsup: dist/vision-worker.js); in development / tests the .ts file is loaded
 * through the tsx loader (see pool.ts `resolveWorkerScript`).
 */
import { getPriority, setPriority } from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';
import { VisionEngine } from './engine';
import { asBuffer, serializeError, type VisionWorkerData, type WorkerRequest, type WorkerResponse } from './worker-protocol';

const port = parentPort;
if (!port) throw new Error('vision worker must run in a worker thread');
const data = workerData as VisionWorkerData;
const post = (msg: WorkerResponse) => port.postMessage(msg);

// Lower the priority of this thread (Linux: per-thread nice; threads created afterwards — the onnxruntime
// intra-op pool — inherit it), so request handling on the main thread wins when the CPU is saturated.
if (data.nice > 0 && process.platform === 'linux') {
  try {
    setPriority(Math.min(19, getPriority() + data.nice));
  } catch {
    // not permitted: keep the default priority
  }
}

let engine: VisionEngine | null = null;
let chain: Promise<void> = Promise.resolve();

async function handle(msg: WorkerRequest): Promise<void> {
  if (msg.type === 'close') {
    await engine?.close();
    engine = null;
    port!.close();
    return;
  }
  if (!engine) {
    post({ type: 'result', id: msg.id, ok: false, error: { name: 'VisionClosedError', message: 'Vision worker is closed' } });
    return;
  }
  try {
    if (msg.type === 'analyze') {
      const analysis = await engine.analyze(asBuffer(msg.image), msg.opts);
      post({ type: 'result', id: msg.id, ok: true, analysis });
    } else {
      const faces = await engine.detect(asBuffer(msg.image));
      post({ type: 'result', id: msg.id, ok: true, faces });
    }
  } catch (err) {
    post({ type: 'result', id: msg.id, ok: false, error: serializeError(err) });
  }
}

port.on('message', (msg: WorkerRequest) => {
  // One image at a time (the pool sends one task per worker anyway).
  chain = chain.then(() => handle(msg));
});

VisionEngine.create(data.engine).then(
  (e) => {
    engine = e;
    post({ type: 'ready' });
  },
  (err) => {
    post({ type: 'init_error', error: serializeError(err) });
    port.close();
  },
);
