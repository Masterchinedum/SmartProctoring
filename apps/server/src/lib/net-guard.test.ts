import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPublicAddress, postJson, validateWebhookUrl, WebhookUrlError } from './net-guard.js';

describe('isPublicAddress (fail-closed SSRF classification)', () => {
  it('accepts global unicast addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '[2a00:1450:4001:82a::200e]', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });

  it('rejects loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges', () => {
    for (const a of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '240.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '203.0.113.9',
      '::1',
      '::',
      '[::1]',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1%eth0',
      'ff02::1',
      '2001:db8::1',
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:7f00:1', // same, hex form
      '::ffff:169.254.169.254',
      '::127.0.0.1', // IPv4-compatible
      '2002:c0a8:0101::1', // 6to4 of 192.168.1.1
      '2001::1', // Teredo
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('treats garbage as not public', () => {
    for (const a of ['', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', ':::1', '1::2::3', 'gggg::1']) expect(isPublicAddress(a), a).toBe(false);
  });
});

describe('validateWebhookUrl', () => {
  const strict = { requireHttps: true, allowPrivateNetworks: false };
  const expectCode = async (p: Promise<unknown>, code: string) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookUrlError);
    expect((err as WebhookUrlError).code).toBe(code);
  };

  it('enforces https, forbids credentials and private destinations', async () => {
    await expectCode(validateWebhookUrl('not a url', strict), 'invalid_url');
    await expectCode(validateWebhookUrl('ftp://example.com/x', strict), 'invalid_url');
    await expectCode(validateWebhookUrl('http://93.184.216.34/hook', strict), 'https_required');
    await expectCode(validateWebhookUrl('https://user:pw@93.184.216.34/hook', strict), 'credentials_not_allowed');
    await expectCode(validateWebhookUrl('https://127.0.0.1/hook', strict), 'private_address');
    await expectCode(validateWebhookUrl('https://[::1]:8443/hook', strict), 'private_address');
    await expectCode(validateWebhookUrl('https://169.254.169.254/latest/meta-data', strict), 'private_address');
    await expectCode(validateWebhookUrl('https://10.1.2.3/hook', strict), 'private_address');
    // A host name that resolves to loopback (via /etc/hosts, no network needed).
    await expectCode(validateWebhookUrl('https://localhost/hook', strict), 'private_address');
    await expect(validateWebhookUrl('https://93.184.216.34/hook', strict)).resolves.toBeInstanceOf(URL);
  });

  it('allows http and private destinations when configured for development', async () => {
    await expect(validateWebhookUrl('http://127.0.0.1:9/hook', { requireHttps: false, allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  });
});

describe('postJson', () => {
  it('refuses private destinations at connect time, including host names that resolve to them', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const direct = await postJson(new URL(`http://127.0.0.1:${port}/x`), '{}', {}, { timeoutMs: 2000, allowPrivateNetworks: false });
      expect(direct.ok).toBe(false);
      expect(direct.error).toMatch(/not a public address/);
      const viaName = await postJson(new URL(`http://localhost:${port}/x`), '{}', {}, { timeoutMs: 2000, allowPrivateNetworks: false });
      expect(viaName.ok).toBe(false);
      expect(viaName.error).toMatch(/not a public address|blocked/);
      expect(hits).toBe(0);
      const allowed = await postJson(new URL(`http://127.0.0.1:${port}/x`), '{}', {}, { timeoutMs: 2000, allowPrivateNetworks: true });
      expect(allowed).toMatchObject({ ok: true, statusCode: 200 });
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });

  it('times out slow receivers and does not follow redirects', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/slow') return void setTimeout(() => res.end('late'), 2000);
      res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const slow = await postJson(new URL(`http://127.0.0.1:${port}/slow`), '{}', {}, { timeoutMs: 300, allowPrivateNetworks: true });
      expect(slow.ok).toBe(false);
      expect(slow.statusCode).toBeNull();
      expect(slow.error).toMatch(/Timed out/);
      const redirect = await postJson(new URL(`http://127.0.0.1:${port}/r`), '{}', {}, { timeoutMs: 2000, allowPrivateNetworks: true });
      expect(redirect).toMatchObject({ ok: false, statusCode: 302 });
      expect(redirect.error).toMatch(/redirects are not followed/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
