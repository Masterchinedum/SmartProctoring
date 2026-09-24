import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** Self-host MediaPipe WASM (no third-party CDN at runtime). */
function copyMediapipeWasm() {
  const src = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const dest = join(__dirname, 'public', 'mediapipe');
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    if (!existsSync(join(dest, f))) copyFileSync(join(src, f), join(dest, f));
  }
}

export default defineConfig(() => {
  copyMediapipeWasm();
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
      },
    },
    build: { outDir: 'dist', sourcemap: process.env.WEB_SOURCEMAP === '1', chunkSizeWarningLimit: 1500 },
    test: { environment: 'jsdom' },
  };
});
