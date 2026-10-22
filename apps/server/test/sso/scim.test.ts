/**
 * SCIM 2.0 provisioning (/scim/v2): token management (owner only, shown once, hash stored, rotation, revocation,
 * audited), bearer authentication, discovery documents, Users CRUD with filters, Microsoft Entra ID style PATCH,
 * deactivation signing the person out everywhere, owners protected, organisation scoping, and the rate limit.
 */
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, scimTokens, staffUsers } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { createOrganization } from '../../src/services/org.js';
import { json, mintCookie, staffApi } from '../admin/fixtures.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
let token: string;
const SCIM = 'application/scim+json';

const scim = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, t: string | null = token) => {
  env.clock.advance(1000); // audit entries are ordered by time
  return env.app.inject({
    method,
    url: `/scim/v2${url}`,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { 'content-type': SCIM } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
};
const lastAudit = async (action: string) => (await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(1))[0];

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

describe('SCIM token', () => {
  it('is created by an owner, shown once, stored as a hash, and audited', async () => {
    const admin = await staffApi(env, 'admin');
    expect(json(await admin.post('/scim/token'), 403).error).toBe('owner_required');
    expect(json(await admin.get('/scim/token'))).toEqual({ baseUrl: 'http://exam.test/scim/v2', token: null });
    const owner = await staffApi(env, 'owner');
    const created = json(await owner.post('/scim/token'));
    token = created.secret;
    expect(token).toMatch(/^sp_scim_[\w-]{43}$/);
    expect(created.token.prefix).toBe(token.slice(0, 14));
    const [row] = await env.ctx.db.select().from(scimTokens).where(eq(scimTokens.orgId, env.org.id));
    expect(row.tokenHash).toBe(sha256Hex(token));
    const status = json(await admin.get('/scim/token'));
    expect(JSON.stringify(status)).not.toContain(token);
    expect(status.token).toMatchObject({ prefix: created.token.prefix, createdBy: { id: env.users.owner.id } });
    const a = await lastAudit('scim.token_created');
    expect(a.meta).toEqual({ prefix: created.token.prefix });
  });

  it('authenticates SCIM requests (401 without, with a wrong or another kind of token)', async () => {
    for (const t of [null, 'sp_scim_' + 'x'.repeat(43), 'sp_live_' + 'x'.repeat(43)]) {
      const r = await scim('GET', '/Users', undefined, t);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
      expect(r.headers['www-authenticate']).toContain('Bearer');
    }
    // A staff cookie is no SCIM credential.
    const cookie = await mintCookie(env, env.users.owner);
    expect((await env.app.inject({ method: 'GET', url: '/scim/v2/Users', headers: { cookie } })).statusCode).toBe(401);
  });

  it('serves the discovery documents', async () => {
    const spc = json(await scim('GET', '/ServiceProviderConfig'));
    expect(spc).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, authenticationSchemes: [{ type: 'oauthbearertoken' }] });
    const types = json(await scim('GET', '/ResourceTypes'));
    expect(types.Resources[0]).toMatchObject({ id: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' });
    const schemas = json(await scim('GET', '/Schemas'));
    expect(schemas.Resources[0].attributes.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['userName', 'active', 'roles']));
    expect((await scim('GET', '/Groups')).statusCode).toBe(404);
    expect((await scim('GET', '/Users')).headers['content-type']).toContain('application/scim+json');
  });
});

describe('SCIM Users', () => {
  let aliceId: string;

  it('creates a user (no password, provisioned by SCIM, audited) and refuses duplicates', async () => {
    const r = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Alice.Proctor@test.example',
      externalId: 'entra-123',
      name: { givenName: 'Alice', familyName: 'Proctor' },
      emails: [{ value: 'alice.proctor@test.example', type: 'work', primary: true }],
      active: true,
      password: 'ignored-by-smartproctoring',
    });
    const body = json(r, 201);
    aliceId = body.id;
    expect(r.headers.location).toBe(`http://exam.test/scim/v2/Users/${aliceId}`);
    expect(body).toMatchObject({ userName: 'alice.proctor@test.example', displayName: 'Alice Proctor', externalId: 'entra-123', active: true, roles: [{ value: 'reviewer', primary: true }], meta: { resourceType: 'User' } });
    const [u] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, aliceId));
    expect(u).toMatchObject({ orgId: env.org.id, role: 'reviewer', provisionedVia: 'scim', passwordHash: '!no-password' });
    const a = await lastAudit('user.created');
    expect(a).toMatchObject({ actorType: 'scim', targetId: aliceId, meta: { via: 'scim', email: 'alice.proctor@test.example', role: 'reviewer' } });
    // The audit log names the actor.
    const log = json(await (await staffApi(env, 'admin')).get('/audit-log', { action: 'user.created' }));
    expect(log.items[0].actorName).toBe('SCIM provisioning');

    expect(json(await scim('POST', '/Users', { userName: 'alice.proctor@test.example' }), 409)).toMatchObject({ scimType: 'uniqueness', status: '409' });
    // An address used in another organisation is also taken.
    const org2 = await createOrganization(env.ctx.db, 'Org 2', {}, env.clock.t);
    await env.ctx.db.insert(staffUsers).values({ orgId: org2.id, email: 'elsewhere@test.example', name: 'E', role: 'reviewer', passwordHash: 'x' });
    expect(json(await scim('POST', '/Users', { userName: 'elsewhere@test.example' }), 409).scimType).toBe('uniqueness');
    expect(json(await scim('POST', '/Users', { userName: 'not-an-email' }), 400).scimType).toBe('invalidValue');
    expect(json(await scim('POST', '/Users', { userName: 'x@test.example', roles: [{ value: 'owner' }] }), 400).scimType).toBe('invalidValue');
  });

  it('lists with filters and paging, scoped to the organisation', async () => {
    const all = json(await scim('GET', '/Users'));
    expect(all.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(all.totalResults).toBe(4); // owner, admin, reviewer, alice — not the other organisation's account
    expect(all.Resources.map((x: { userName: string }) => x.userName)).not.toContain('elsewhere@test.example');
    const byName = json(await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "ALICE.proctor@test.example"')}`));
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0].id).toBe(aliceId);
    expect(json(await scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "entra-123"')}`)).totalResults).toBe(1);
    expect(json(await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "elsewhere@test.example"')}`)).totalResults).toBe(0);
    expect(json(await scim('GET', `/Users?filter=${encodeURIComponent('displayName co "A"')}`), 400).scimType).toBe('invalidFilter');
    const page = json(await scim('GET', '/Users?startIndex=2&count=2'));
    expect(page).toMatchObject({ startIndex: 2, itemsPerPage: 2, totalResults: 4 });
    expect(json(await scim('GET', `/Users/${aliceId}`)).userName).toBe('alice.proctor@test.example');
  });

  it('replaces and patches (Entra ID style), never touching owners', async () => {
    const put = json(await scim('PUT', `/Users/${aliceId}`, { userName: 'alice.proctor@test.example', displayName: 'Alice P.', active: true, roles: [{ value: 'admin', primary: true }] }));
    expect(put).toMatchObject({ displayName: 'Alice P.', roles: [{ value: 'admin' }] });
    expect((await lastAudit('user.updated')).meta).toMatchObject({ via: 'scim', role: { from: 'reviewer', to: 'admin' } });
    const patched = json(
      await scim('PATCH', `/Users/${aliceId}`, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'Replace', path: 'name.givenName', value: 'Alicia' },
          { op: 'Replace', path: 'name.familyName', value: 'Proctor' },
          { op: 'Add', path: 'title', value: 'Ignored' },
          { op: 'replace', value: { externalId: 'entra-456' } },
        ],
      }),
    );
    expect(patched).toMatchObject({ displayName: 'Alicia Proctor', externalId: 'entra-456' });
    // Microsoft Entra ID's app-role mapping.
    const role = json(await scim('PATCH', `/Users/${aliceId}`, { Operations: [{ op: 'Add', path: 'roles[primary eq "True"].value', value: 'reviewer' }] }));
    expect(role.roles).toEqual([{ value: 'reviewer', primary: true }]);
    // Owners are break-glass accounts managed in SmartProctoring only.
    const ownerId = env.users.owner.id;
    expect(json(await scim('PATCH', `/Users/${ownerId}`, { Operations: [{ op: 'replace', path: 'active', value: false }] }), 403).scimType).toBe('mutability');
    expect((await scim('DELETE', `/Users/${ownerId}`)).statusCode).toBe(403);
    expect(json(await scim('PUT', `/Users/${ownerId}`, { userName: 'owner@test.example', active: false }), 403).scimType).toBe('mutability');
    expect(json(await scim('PATCH', `/Users/${aliceId}`, { Operations: [{ op: 'move', path: 'active' }] }), 400).scimType).toBe('invalidSyntax');
    expect((await scim('GET', '/Users/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('deactivation disables the account and signs it out everywhere', async () => {
    const reviewerCookie = await mintCookie(env, env.users.reviewer);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: reviewerCookie } })).statusCode).toBe(200);
    const r = json(await scim('PATCH', `/Users/${env.users.reviewer.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }));
    expect(r.active).toBe(false);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: reviewerCookie } })).statusCode).toBe(401);
    expect((await lastAudit('user.updated')).meta).toMatchObject({ via: 'scim', disabled: true, fields: ['disabled'] });
    // Reactivated through SCIM.
    expect(json(await scim('PATCH', `/Users/${env.users.reviewer.id}`, { Operations: [{ op: 'replace', value: { active: true } }] })).active).toBe(true);
  });

  it('DELETE disables and hides the account from SCIM; a new POST brings it back', async () => {
    const cookie = await mintCookie(env, (await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, aliceId)))[0]);
    expect((await scim('DELETE', `/Users/${aliceId}`)).statusCode).toBe(204);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await scim('GET', `/Users/${aliceId}`)).statusCode).toBe(404);
    expect((await scim('PATCH', `/Users/${aliceId}`, { Operations: [{ op: 'replace', path: 'active', value: true }] })).statusCode).toBe(404);
    expect(json(await scim('GET', '/Users')).totalResults).toBe(3);
    const [u] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, aliceId));
    expect(u.disabled).toBe(true);
    expect(u.scimDeletedAt).not.toBeNull();
    expect((await lastAudit('user.updated')).meta).toMatchObject({ deleted: true, disabled: true });
    const back = json(await scim('POST', '/Users', { userName: 'alice.proctor@test.example', displayName: 'Alice Again', active: true }), 201);
    expect(back).toMatchObject({ id: aliceId, active: true, displayName: 'Alice Again' });
  });

  it('a rotated or revoked token stops working at once', async () => {
    const owner = await staffApi(env, 'owner');
    const rotated = json(await owner.post('/scim/token'));
    expect((await lastAudit('scim.token_rotated')).meta).toMatchObject({ prefix: rotated.token.prefix });
    expect((await scim('GET', '/Users')).statusCode).toBe(401);
    token = rotated.secret;
    expect((await scim('GET', '/Users')).statusCode).toBe(200);
    json(await owner.del('/scim/token'));
    expect((await lastAudit('scim.token_revoked')).meta).toMatchObject({ prefix: rotated.token.prefix });
    expect((await scim('GET', '/Users')).statusCode).toBe(401);
    expect(json(await owner.del('/scim/token'), 404).error).toBe('scim_token_not_found');
  });
});

describe('SCIM rate limit', () => {
  it('limits requests per token (SCIM_RATE_LIMIT_PER_MINUTE)', async () => {
    const e = await createTestEnv({ env: { SCIM_RATE_LIMIT_PER_MINUTE: '3' } });
    try {
      const t = json(await (await staffApi(e, 'owner')).post('/scim/token')).secret;
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await e.app.inject({ method: 'GET', url: '/scim/v2/Users', headers: { authorization: `Bearer ${t}` } })).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await e.close();
    }
  });
});
