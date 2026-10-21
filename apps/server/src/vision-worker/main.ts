/**
 * Dedicated vision worker process: `pnpm --filter @sp/server vision-worker` (source) or `node dist/vision-server.js`
 * (bundle; the Docker image runs it with that command). Loads the face models into the worker-thread pool and serves
 * them over HTTP to servers running with VISION_DRIVER=remote (server.ts; docs/OPERATIONS.md §2).
 */
import pino from 'pino';
import { appLoggerOptions } from '../lib/log-redact.js';
import { createVisionService } from '../vision/service.js';
import { loadVisionWorkerConfig } from './config.js';
import { buildVisionWorker } from './server.js';

const MIN_NODE_MAJOR = 24;

async function main() {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    console.error(`[runtime] Node ${MIN_NODE_MAJOR} or later is required; this is Node ${process.versions.node}.`);
    process.exit(1);
  }
  let config;
  try {
    config = loadVisionWorkerConfig();
  } catch (err) {
    console.error(`[config] ${(err as Error).message}`);
    process.exit(1);
  }
  const log = pino(appLoggerOptions(config.logLevel));
  let vision;
  try {
    vision = await createVisionService({
      modelsDir: config.modelsDir,
      ...(config.threads ? { threads: config.threads } : {}),
      onWorkerExit: ({ code, error }) => log.error({ err: error, code }, 'vision thread exited unexpectedly; restarting it'),
    });
  } catch (err) {
    if ((err as Error).name === 'VisionModelsNotFoundError') {
      console.error(`[vision] ${(err as Error).message}\nSet MODELS_DIR to the folder containing face_detection_yunet_2023mar.onnx and face_recognition_sface_2021dec.onnx.`);
      process.exit(1);
    }
    throw err;
  }
  const app = await buildVisionWorker({ vision, token: config.tokens, loggerInstance: log });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close(); // stop accepting; answers in progress are completed
      await vision.close();
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ port: config.port, host: config.host });
  log.info({ threads: vision.threading, modelsDir: vision.modelsDir }, `vision worker ready on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
