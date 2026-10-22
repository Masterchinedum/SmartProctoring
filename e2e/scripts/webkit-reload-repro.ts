/**
 * Diagnostic (temporary): does a reload after same-document history navigation crash WebKit?
 * Runs a set of minimal sequences against a tiny local page in Playwright's WebKit and, when a
 * safaridriver is listening on SAFARIDRIVER_URL, in the system Safari.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, type Page } from '@playwright/test';

// REPRO_ENGINE=chromium checks the script itself where WebKit is not installed.
const engine = process.env.REPRO_ENGINE === 'chromium' ? chromium : webkit;

const PAGE = `<!doctype html><meta charset="utf-8"><title>repro</title>
<a id="cross" href="/cross-doc">cross</a>
<script>
  window.addEventListener('popstate', () => { window.__pops = (window.__pops || 0) + 1; });
  window.navState = () => ({
    url: location.pathname,
    historyLength: history.length,
    nav: typeof navigation === 'undefined' ? 'no navigation API'
      : { entries: navigation.entries().map((e) => new URL(e.url).pathname + '#' + e.index), current: navigation.currentEntry && navigation.currentEntry.index },
  });
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Step = { js?: string; back?: true; reload?: true; click?: string; wait?: number };
const push = (p: string) => ({ js: `history.pushState({ p: ${JSON.stringify(p)} }, '', ${JSON.stringify(p)})` });
const replace = (p: string) => ({ js: `history.replaceState({ p: ${JSON.stringify(p)} }, '', ${JSON.stringify(p)})` });
const jsBack = { js: `new Promise((r) => { addEventListener('popstate', () => r(), { once: true }); history.back(); })` };
const routerInit = { js: `history.replaceState({ usr: null, key: 'default', idx: 0 }, '')` };

const SEQUENCES: Record<string, Step[]> = {
  'reload': [{ reload: true }],
  'push, reload': [push('/b'), { reload: true }],
  'push, history.back(), reload': [push('/b'), jsBack, { reload: true }],
  'push, push, history.back(), reload': [push('/b'), push('/c'), jsBack, { reload: true }],
  'push, push, goBack(), reload': [push('/b'), push('/c'), { back: true }, { reload: true }],
  'router replaceState, push, push, history.back(), reload': [routerInit, push('/b'), push('/c'), jsBack, { reload: true }],
  'push, history.back(), wait 3 s, reload': [push('/b'), jsBack, { wait: 3000 }, { reload: true }],
  // The staff app in scenario 04: session page, tab change (replace), compare page (push), back, reload.
  'push, replace, push, history.back(), reload': [push('/b'), replace('/b?tab=identity'), push('/c'), jsBack, { reload: true }],
  'push, replace, push, goBack(), reload': [push('/b'), replace('/b?tab=identity'), push('/c'), { back: true }, { reload: true }],
  'router replaceState, push, replace, push, goBack(), reload': [routerInit, push('/b'), replace('/b?tab=identity'), push('/c'), { back: true }, { reload: true }],
  'replace, reload': [replace('/a?x=1'), { reload: true }],
  'push, replace, reload': [push('/b'), replace('/b?tab=identity'), { reload: true }],
  'cross-document link, goBack(), reload': [{ click: '#cross' }, { back: true }, { reload: true }],
};

async function inPlaywright(headless: boolean) {
  const browser = await engine.launch({ headless });
  console.log(`\n## Playwright ${engine.name()} ${browser.version()} (${headless ? 'headless' : 'headed'})`);
  for (const [name, steps] of Object.entries(SEQUENCES)) {
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    const states: unknown[] = [];
    let outcome = 'ok';
    try {
      await page.goto(`${base}/a`);
      for (const s of steps) {
        if (s.reload) states.push(await page.evaluate('navState()'));
        if (s.js) await page.evaluate(s.js);
        if (s.back) await page.goBack();
        if (s.reload) await page.reload();
        if (s.click) await Promise.all([page.waitForURL('**/cross-doc'), page.click(s.click)]);
        if (s.wait) await page.waitForTimeout(s.wait);
      }
      states.push(await page.evaluate('navState()'));
    } catch (e) {
      outcome = `${crashed ? 'CRASHED' : 'error'}: ${String((e as Error).message).split('\n')[0]}`;
    }
    console.log(`- ${name}: ${outcome}  ${JSON.stringify(states)}`);
    await context.close().catch(() => {});
  }
  await browser.close();
}

/** W3C WebDriver against safaridriver: same sequences, via navigate / back / refresh. */
async function inSafari(url: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json()) as { value: any };
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j.value).slice(0, 300)}`);
    return j.value;
  };
  const created = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const sid = created.sessionId as string;
  console.log(`\n## Safari ${created.capabilities?.browserVersion ?? '?'} (safaridriver)`);
  const exec = (script: string) => call('POST', `/session/${sid}/execute/async`, { script: `const done = arguments[arguments.length - 1]; Promise.resolve(eval(${JSON.stringify(script)})).then(done, (e) => done(String(e)));`, args: [] });
  try {
    for (const [name, steps] of Object.entries(SEQUENCES)) {
      const states: unknown[] = [];
      let outcome = 'ok';
      try {
        await call('POST', `/session/${sid}/url`, { url: `${base}/a` });
        for (const s of steps) {
          if (s.reload) states.push(await exec('navState()'));
          if (s.js) await exec(s.js);
          if (s.back) await call('POST', `/session/${sid}/back`, {});
          if (s.reload) await call('POST', `/session/${sid}/refresh`, {});
          if (s.click) { await exec(`document.querySelector('${s.click}').click()`); await new Promise((r) => setTimeout(r, 1500)); }
          if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
        }
        states.push(await exec('navState()'));
      } catch (e) {
        outcome = `error: ${String((e as Error).message).split('\n')[0]}`;
      }
      console.log(`- ${name}: ${outcome}  ${JSON.stringify(states)}`);
    }
  } finally {
    await call('DELETE', `/session/${sid}`).catch(() => {});
  }
}

try {
  await inPlaywright(true);
  if (process.platform === 'darwin') await inPlaywright(false);
  if (process.env.SAFARIDRIVER_URL) await inSafari(process.env.SAFARIDRIVER_URL).catch((e) => console.log(`Safari: ${e}`));
} finally {
  server.close();
}
