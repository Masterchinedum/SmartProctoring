import { existsSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Production bundle: dist/main.js (+ CLI scripts). Everything is bundled (incl. the workspace
 * @sp/shared TS sources) except native / platform-specific modules, which stay in node_modules.
 * Migrations are read at runtime from apps/server/drizzle (found by walking up from dist/).
 */
const candidates: Record<string, string> = {
  main: 'src/main.ts',
  'scripts/seed': 'src/scripts/seed.ts',
  'scripts/migrate': 'src/db/migrate-cli.ts',
  'scripts/retention': 'src/scripts/retention-cli.ts',
  'scripts/identity-eval': 'src/eval/identity-eval-cli.ts',
};
const NATIVE = ['onnxruntime-node', 'sharp', 'pg-native', 'bufferutil', 'utf-8-validate', 'pino-pretty'];
const entry = Object.fromEntries(Object.entries(candidates).filter(([, p]) => existsSync(p)));

export default defineConfig({
  entry,
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  shims: false,
  // Bundle everything except native modules (they must be resolved from node_modules at runtime).
  noExternal: [new RegExp(`^(?!(${NATIVE.map((n) => n.replace(/[/.]/g, '\\$&')).join('|')})(/|$))`)],
  external: NATIVE,
  banner: {
    // Bundled CommonJS dependencies may call require(); give ESM output a real one.
    js: "import { createRequire as __spCreateRequire } from 'node:module'; const require = __spCreateRequire(import.meta.url);",
  },
});
