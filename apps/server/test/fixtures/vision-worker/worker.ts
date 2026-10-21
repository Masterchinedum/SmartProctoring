/**
 * A face-analysis worker for the worker-pool resilience test (test/chaos.test.ts): the real pool protocol, with
 * FakeVisionService doing the "analysis". A frame of the person CRASH_PERSON makes the worker thread die mid-analysis
 * (as an onnxruntime abort or an out-of-memory kill would).
 */
import { parentPort } from 'node:worker_threads';
import { FakeVisionService } from '../../../src/vision/fake.js';
import { asBuffer, serializeError, type WorkerRequest, type WorkerResponse } from '../../../src/vision/worker-protocol.js';

/** Also in test/chaos.test.ts (importing this module would run it). */
const CRASH_PERSON = 'crash-the-worker';

const port = parentPort;
if (!port) throw new Error('must run in a worker thread');
const fake = new FakeVisionService({ defaultSpec: { person: 'alice' } });
const post = (msg: WorkerResponse) => port.postMessage(msg);

port.on('message', async (msg: WorkerRequest) => {
  if (msg.type === 'close') {
    port.close();
    return;
  }
  const image = asBuffer(msg.image);
  if (FakeVisionService.decode(image)?.person === CRASH_PERSON) process.exit(3);
  try {
    if (msg.type === 'analyze') post({ type: 'result', id: msg.id, ok: true, analysis: await fake.analyze(image, msg.opts) });
    else post({ type: 'result', id: msg.id, ok: false, error: { name: 'Error', message: 'detect is not supported by this test worker' } });
  } catch (err) {
    post({ type: 'result', id: msg.id, ok: false, error: serializeError(err) });
  }
});
post({ type: 'ready' });
