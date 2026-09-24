/**
 * Live smoke test for the AWS Rekognition verifier — needs real AWS credentials, so it is never run in CI
 * (the automated tests use a mocked client: test/verifiers/). docs/EXTERNAL_VERIFIER.md §8.
 *
 *   cd apps/server
 *   AWS_PROFILE=proctoring-verifier npx tsx src/verifiers/smoke-cli.ts --region eu-west-1 ref.jpg same-person.jpg other-person.jpg
 *   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npx tsx src/verifiers/smoke-cli.ts --region eu-west-1 photo.jpg   # photo vs itself
 *
 * The first image is the reference; every further image is compared with it (a single image is compared with
 * itself). Credentials come from the default AWS credential chain (AWS_PROFILE, AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY, an IAM role). Prints similarity, face count and latency per probe; never prints secrets.
 * Exit code 0 = every call answered, 1 = a call failed, 2 = usage error.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { AwsRekognitionVerifier } from './aws-rekognition.js';
import { ExternalVerifierError } from './types.js';

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('Usage: smoke-cli.ts --region <aws-region> [--timeout <ms>] <reference.jpg> [probe.jpg ...]');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let region = process.env.AWS_REGION ?? '';
  let timeoutMs = 8000;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--region') region = args[++i] ?? '';
    else if (a === '--timeout') timeoutMs = Number(args[++i]);
    else if (a === '--help' || a === '-h') usage();
    else files.push(a);
  }
  if (!region) usage('--region (or AWS_REGION) is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage('--timeout must be a positive number of milliseconds');
  if (files.length === 0) usage('Give at least one JPEG file');
  const [refPath, ...probePaths] = files;
  const reference = readFileSync(refPath);
  const verifier = new AwsRekognitionVerifier({ region, credentials: null, defaultTimeoutMs: timeoutMs });
  let failed = false;
  try {
    for (const probePath of probePaths.length ? probePaths : [refPath]) {
      const probe = readFileSync(probePath);
      try {
        const r = await verifier.compare({ reference: [reference], probe });
        console.log(
          `${basename(refPath)} vs ${basename(probePath)}: similarity ${r.similarity.toFixed(4)}  faceFound ${r.faceFound}  faces ${r.faceCount ?? '?'}  ${r.latencyMs} ms  ${JSON.stringify(r.raw)}`,
        );
      } catch (err) {
        failed = true;
        const e = err instanceof ExternalVerifierError ? err : new ExternalVerifierError('provider_error', String(err));
        console.log(`${basename(refPath)} vs ${basename(probePath)}: ERROR ${e.code} after ${e.latencyMs} ms — ${e.message}`);
      }
    }
  } finally {
    verifier.close();
  }
  process.exit(failed ? 1 : 0);
}

void main();
