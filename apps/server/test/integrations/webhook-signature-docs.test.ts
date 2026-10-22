/**
 * The webhook signature verifiers customers copy from docs/INTEGRATION_API.md §3 (Node.js and Python, between the
 * verify-snippet markers) are run verbatim against signatures made by the server's own signing code
 * (services/webhooks.ts signWebhookBody), so the documentation cannot drift from the implementation. e2e scenario 18
 * runs the Node.js snippet against real deliveries over HTTPS as well.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { generateWebhookSecret, signWebhookBody } from '../../src/services/webhooks.js';

const DOC = readFileSync(new URL('../../../../docs/INTEGRATION_API.md', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'sp-verify-snippets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function snippet(marker: string, lang: string): string {
  const m = new RegExp(`<!-- ${marker}:start -->\\s*\`\`\`${lang}\\n([\\s\\S]*?)\`\`\`\\s*<!-- ${marker}:end -->`).exec(DOC);
  if (!m) throw new Error(`${marker} markers not found in docs/INTEGRATION_API.md`);
  return m[1];
}

interface Case {
  name: string;
  body: string;
  header: string | null;
  secret: string;
  tolerance?: number;
  now: number;
  expected: boolean;
}

const secret = generateWebhookSecret();
const now = 1_790_244_123;
const body = JSON.stringify({ id: crypto.randomUUID(), type: 'event.created', createdAt: now * 1000, orgId: crypto.randomUUID(), data: { title: 'More than one person in view', observation: 'Ünïcödé — “quotes”' } });
const header = signWebhookBody(secret, body, now);
const [tPart, vPart] = header.split(',');
const cases: Case[] = [
  { name: 'genuine', body, header, secret, now, expected: true },
  { name: 'genuine, parts reordered with spaces', body, header: ` ${vPart} , ${tPart} `, secret, now, expected: true },
  { name: 'within tolerance', body, header, secret, now: now + 299, expected: true },
  { name: 'stale', body, header, secret, now: now + 301, expected: false },
  { name: 'from the future', body, header, secret, now: now - 301, expected: false },
  { name: 'custom tolerance', body, header, secret, tolerance: 600, now: now + 500, expected: true },
  { name: 'wrong secret', body, header, secret: `${secret}x`, now, expected: false },
  { name: 'altered body', body: body.replace('person', 'persons'), header, secret, now, expected: false },
  { name: 're-serialised body', body: JSON.stringify(JSON.parse(body), null, 1), header, secret, now, expected: false },
  { name: 'missing header', body, header: null, secret, now, expected: false },
  { name: 'no v1', body, header: tPart, secret, now, expected: false },
  { name: 'uppercase hex', body, header: `${tPart},${vPart.toUpperCase().replace('V1=', 'v1=')}`, secret, now, expected: false },
  { name: 'non-numeric t', body, header: `t=abc,${vPart}`, secret, now, expected: false },
  { name: 'empty secret', body, header, secret: '', now, expected: false },
];

describe('documented webhook signature verifiers', () => {
  it('the server signs as documented: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>', () => {
    expect(header).toMatch(/^t=1790244123,v1=[0-9a-f]{64}$/);
  });

  it('Node.js snippet', async () => {
    const file = join(dir, 'verify-smartproctoring.mjs');
    writeFileSync(file, snippet('verify-snippet', 'js'));
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      verifySmartProctoringSignature: (raw: string | Buffer, header: string | undefined, secret: string, tolerance?: number, now?: number) => boolean;
    };
    for (const c of cases) {
      const got = mod.verifySmartProctoringSignature(Buffer.from(c.body, 'utf8'), c.header ?? undefined, c.secret, c.tolerance ?? 300, c.now);
      expect(got, c.name).toBe(c.expected);
    }
    expect(mod.verifySmartProctoringSignature(body, header, secret, 300, now), 'string body').toBe(true);
  });

  it('Python snippet (python3, standard library only)', () => {
    const harness = `
import base64, json, sys
results = []
for c in json.load(sys.stdin):
    raw = base64.b64decode(c["body"])
    results.append(verify_smartproctoring_signature(raw, c["header"], c["secret"], c.get("tolerance", 300), c["now"]))
body_as_str = base64.b64decode("${Buffer.from(body).toString('base64')}").decode("utf-8")
results.append(verify_smartproctoring_signature(body_as_str, "${header}", "${secret}", 300, ${now}))
print(json.dumps(results))
`;
    const input = JSON.stringify(cases.map((c) => ({ ...c, body: Buffer.from(c.body, 'utf8').toString('base64') })));
    let out: string;
    try {
      out = execFileSync('python3', ['-I', '-c', `${snippet('verify-snippet-python', 'python')}\n${harness}`], { input, encoding: 'utf8' });
    } catch (err) {
      throw new Error(`python3 is required to test the documented Python verifier: ${(err as Error).message}`);
    }
    const results = JSON.parse(out) as boolean[];
    cases.forEach((c, i) => expect(results[i], c.name).toBe(c.expected));
    expect(results[cases.length], 'str body').toBe(true);
  });
});
