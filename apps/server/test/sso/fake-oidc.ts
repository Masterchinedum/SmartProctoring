/**
 * An in-process OpenID Connect provider for tests (server tests and e2e scenario 11f): discovery, an authorization
 * endpoint that signs in `nextUser` at once (302 back with a code), a token endpoint (client authentication, code,
 * redirect_uri and PKCE checked) and a JWKS. ID tokens are signed with jose (RS256); `tokenOverrides` / `idTokenHook`
 * produce the bad cases (wrong audience, nonce, issuer, expired, other key).
 *
 *   const idp = await FakeOidcProvider.start({ clientId: 'sp', clientSecret: 's3cret', now: () => clock.t });
 *   idp.nextUser = { sub: 'u1', email: 'a@example.edu', email_verified: true, name: 'A' };
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface FakeOidcUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
  [claim: string]: unknown;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  codeChallenge: string | null;
  user: FakeOidcUser;
  used: boolean;
}

export interface FakeOidcOptions {
  clientId: string;
  clientSecret?: string;
  /** Clock for iat / exp (default Date.now). */
  now?: () => number;
  /** Serve https with this certificate (e2e: production mode only allows https issuers). */
  tls?: { cert: string; key: string };
  /** Host name in the issuer URL (default 127.0.0.1). */
  host?: string;
}

export class FakeOidcProvider {
  nextUser: FakeOidcUser | null = null;
  /** Extra / replaced ID-token claims for the next token (e.g. { aud: 'other' }); cleared after use. */
  tokenOverrides: Record<string, unknown> | null = null;
  /** Sign the next ID token with another key (signature check). */
  signWithForeignKey = false;
  /** Answer the next authorization request with this OAuth error (e.g. access_denied). */
  nextError: string | null = null;
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: { auth: string | null; body: URLSearchParams }[] = [];
  private readonly codes = new Map<string, IssuedCode>();

  private constructor(
    private readonly server: http.Server | https.Server,
    readonly issuer: string,
    private readonly opts: FakeOidcOptions,
    private readonly key: CryptoKey,
    private readonly jwk: JWK,
    private readonly foreignKey: CryptoKey,
  ) {}

  static async start(opts: FakeOidcOptions): Promise<FakeOidcProvider> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const foreign = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: `k-${randomBytes(4).toString('hex')}`, alg: 'RS256', use: 'sig' };
    let self: FakeOidcProvider | null = null;
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      void self!.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    };
    const server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const issuer = `${opts.tls ? 'https' : 'http'}://${opts.host ?? '127.0.0.1'}:${port}/oidc`;
    self = new FakeOidcProvider(server, issuer, opts, privateKey, jwk, foreign.privateKey);
    return self;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    const path = url.pathname;
    if (path === '/oidc/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (path === '/oidc/jwks') return this.json(res, 200, { keys: [this.jwk] });
    if (path === '/oidc/authorize') {
      this.authorizeRequests.push(url.searchParams);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const back = new URL(redirectUri);
      if (this.nextError) {
        back.searchParams.set('error', this.nextError);
        back.searchParams.set('state', state);
        this.nextError = null;
      } else {
        if (!this.nextUser) return this.json(res, 400, { error: 'no test user' });
        const code = randomBytes(16).toString('base64url');
        this.codes.set(code, {
          clientId: url.searchParams.get('client_id') ?? '',
          redirectUri,
          nonce: url.searchParams.get('nonce'),
          codeChallenge: url.searchParams.get('code_challenge'),
          user: this.nextUser,
          used: false,
        });
        back.searchParams.set('code', code);
        back.searchParams.set('state', state);
      }
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (path === '/oidc/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const auth = req.headers.authorization ?? null;
      this.tokenRequests.push({ auth, body });
      let clientId = body.get('client_id');
      let secret = body.get('client_secret');
      if (auth?.startsWith('Basic ')) {
        const [id, s] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
        clientId = decodeURIComponent(id);
        secret = decodeURIComponent(s ?? '');
      }
      if (clientId !== this.opts.clientId || (this.opts.clientSecret !== undefined && secret !== this.opts.clientSecret)) return this.json(res, 401, { error: 'invalid_client' });
      const issued = this.codes.get(body.get('code') ?? '');
      if (!issued || issued.used || issued.clientId !== clientId || issued.redirectUri !== body.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
      issued.used = true;
      const verifier = body.get('code_verifier') ?? '';
      if (issued.codeChallenge && createHash('sha256').update(verifier).digest('base64url') !== issued.codeChallenge) return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const nowSec = Math.floor(this.now() / 1000);
      const claims: Record<string, unknown> = { ...issued.user, ...(issued.nonce ? { nonce: issued.nonce } : {}), ...(this.tokenOverrides ?? {}) };
      const { iss, aud, exp, iat, ...rest } = claims as { iss?: string; aud?: string; exp?: number; iat?: number };
      const jwt = await new SignJWT(rest)
        .setProtectedHeader({ alg: 'RS256', kid: this.jwk.kid! })
        .setIssuer(iss ?? this.issuer)
        .setAudience(aud ?? clientId)
        .setIssuedAt(iat ?? nowSec)
        .setExpirationTime(exp ?? nowSec + 300)
        .sign(this.signWithForeignKey ? this.foreignKey : this.key);
      this.tokenOverrides = null;
      this.signWithForeignKey = false;
      return this.json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: jwt });
    }
    res.statusCode = 404;
    res.end('not found');
  }
}
