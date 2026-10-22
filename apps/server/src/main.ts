import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/** Node 24 is the only supported runtime (package.json engines; pnpm install enforces it, this covers `node dist/main.js`). */
const MIN_NODE_MAJOR = 24;

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    console.error(`[runtime] Node ${MIN_NODE_MAJOR} or later is required; this is Node ${process.versions.node}.`);
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[config] ${(err as Error).message}`);
    process.exit(1);
  }
  let app;
  try {
    app = await buildApp({ config });
  } catch (err) {
    if ((err as Error).name === 'StorageLocationsConfigError') {
      // A storage location in use is not configured (data residency, docs/OPERATIONS.md §2).
      console.error(`[storage] ${(err as Error).message}`);
      process.exit(1);
    }
    if ((err as Error).name === 'VisionModelsNotFoundError') {
      console.error(`[vision] ${(err as Error).message}\nSet MODELS_DIR to the folder containing face_detection_yunet_2023mar.onnx and face_recognition_sface_2021dec.onnx.`);
      process.exit(1);
    }
    throw err;
  }
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
