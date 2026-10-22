/**
 * Print or write the integration API's OpenAPI 3.1 document (generated from packages/shared/src/integrations.ts).
 *
 *   pnpm --filter @sp/server openapi -- --out ../../docs/openapi.json   # regenerate the committed copy
 *   pnpm --filter @sp/server openapi -- --check ../../docs/openapi.json # exit 1 when that file is out of date
 *   pnpm --silent --filter @sp/server openapi > openapi.json            # to stdout
 *   node apps/server/dist/scripts/openapi.js [--server-url https://proctor.example.com/api/v1]
 *
 * Paths are relative to the current directory (pnpm runs scripts in apps/server). `--server-url` sets `servers[0].url`
 * (default `/api/v1`, relative to where the document is served; the running server serves it with its PUBLIC_URL).
 * Exit codes: 0 ok, 1 out of date (--check), 2 bad arguments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { integrationOpenApiJson } from '@sp/shared';

function main(): number {
  let values: { out?: string; check?: string; 'server-url'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // `pnpm <script> -- --flag` forwards the separator; drop a leading '--'.
      args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
      options: { out: { type: 'string' }, check: { type: 'string' }, 'server-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (values.help) {
    console.log('Usage: openapi [--out <file>] [--check <file>] [--server-url <url>]');
    return 0;
  }
  const doc = integrationOpenApiJson(values['server-url'] ? { serverUrl: values['server-url'] } : {});
  if (values.check) {
    const path = resolve(values.check);
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current !== doc) {
      console.error(`${path} is out of date. Regenerate it: pnpm --filter @sp/server openapi -- --out ../../docs/openapi.json`);
      return 1;
    }
    console.error(`${path} is up to date.`);
    return 0;
  }
  if (values.out) {
    writeFileSync(resolve(values.out), doc);
    console.error(`Wrote ${resolve(values.out)}`);
    return 0;
  }
  process.stdout.write(doc);
  return 0;
}

process.exitCode = main();
