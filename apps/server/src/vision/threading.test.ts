import { describe, expect, it } from 'vitest';
import { resolveVisionThreading } from './service';

describe('resolveVisionThreading', () => {
  it('defaults to single-threaded workers on all cores but one (max 8)', () => {
    expect(resolveVisionThreading({}, {}, 4)).toEqual({ workers: 3, threadsPerWorker: 1, concurrency: 3 });
    expect(resolveVisionThreading({}, {}, 1)).toEqual({ workers: 1, threadsPerWorker: 1, concurrency: 1 });
    expect(resolveVisionThreading({}, {}, 32)).toEqual({ workers: 8, threadsPerWorker: 1, concurrency: 8 });
  });

  it('splits VISION_THREADS into workers of VISION_THREADS_PER_WORKER threads', () => {
    expect(resolveVisionThreading({}, { VISION_THREADS: '6' }, 4).workers).toBe(6);
    expect(resolveVisionThreading({}, { VISION_THREADS: '6', VISION_THREADS_PER_WORKER: '2' }, 4)).toEqual({ workers: 3, threadsPerWorker: 2, concurrency: 3 });
    expect(resolveVisionThreading({}, { VISION_WORKERS: '2' }, 8).workers).toBe(2);
    // options win over the environment; `concurrency` means workers in pool mode
    expect(resolveVisionThreading({ workers: 5 }, { VISION_WORKERS: '2' }, 8).workers).toBe(5);
    expect(resolveVisionThreading({ concurrency: 1 }, {}, 8).workers).toBe(1);
  });

  it('VISION_WORKERS=0 analyses in-process with intra-op threads', () => {
    expect(resolveVisionThreading({}, { VISION_WORKERS: '0' }, 8)).toEqual({ workers: 0, threadsPerWorker: 4, concurrency: 2 });
    expect(resolveVisionThreading({ workers: 0, threads: 2, concurrency: 3 }, {}, 8)).toEqual({ workers: 0, threadsPerWorker: 2, concurrency: 3 });
  });
});
