import type { Ctx } from '../context.js';

export interface Sweeper {
  stop(): Promise<void>;
  tick(): Promise<void>;
}

export function startSweeper(_ctx: Ctx): Sweeper {
  return { async stop() {}, async tick() {} };
}
