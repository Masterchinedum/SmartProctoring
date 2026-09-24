/**
 * Staff API: organisation settings (validation, audit), staff user management rules, audit log.
 */
import type { AuditLogEntryDTO, OrgSettingsDTO, StaffUserDTO } from '@sp/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, staffUsers } from '../../src/db/schema.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { json, staffApi, userRow, type Api } from './fixtures.js';

let env: TestEnv;
let owner: Api;
let admin: Api;
let reviewer: Api;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await staffApi(env, 'owner');
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
});
afterAll(async () => env?.close());

describe('settings', () => {
  it('returns the settings with defaults filled', async () => {
    const s = json<OrgSettingsDTO>(await admin.get('/settings'));
    expect(s).toMatchObject({ name: 'Test University', evidenceRetentionDays: 30, eventRetentionDays: 365, privacyContact: 'privacy@test.example' });
    expect(s.identityThresholds.mismatch).toBeLessThan(s.identityThresholds.match);
    expect(s.defaultPolicy.pause.timerBehavior).toBe('stop');
  });

  it('validates thresholds, retention and the default policy', async () => {
    const bad1 = await admin.put('/settings', { identityThresholds: { match: 0.3, mismatch: 0.35 } });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json().details).toEqual([{ path: 'identityThresholds.mismatch', message: expect.stringMatching(/lower than the match threshold/) }]);
    const bad2 = await admin.put('/settings', { identityThresholds: { idPhotoMismatch: 0.5 } });
    expect(bad2.json().details[0].path).toBe('identityThresholds.idPhotoMismatch');
    // mismatch alone raised above the stored match threshold is also caught (merged with current values)
    expect((await admin.put('/settings', { identityThresholds: { mismatch: 0.9 } })).statusCode).toBe(400);
    expect((await admin.put('/settings', { identityThresholds: { match: 1.5 } })).statusCode).toBe(400);
    expect((await admin.put('/settings', { evidenceRetentionDays: 0 })).statusCode).toBe(400);
    expect((await admin.put('/settings', { evidenceRetentionDays: 400 })).json().details[0].path).toBe('eventRetentionDays');
    const badPolicy = await admin.put('/settings', { defaultPolicy: { pause: { timerBehavior: 'sometimes' } } });
    expect(badPolicy.statusCode).toBe(400);
    expect(JSON.stringify(badPolicy.json().details)).toContain('pause.timerBehavior');
    expect((await admin.put('/settings', { name: '   ' })).statusCode).toBe(400);
    // nothing was changed by the rejected requests
    const [org] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(org.settings.evidenceRetentionDays).toBe(30);
  });

  it('updates settings, keeps unknown policy keys out, and audits the change', async () => {
    const s = json<OrgSettingsDTO>(
      await admin.put('/settings', {
        name: 'Test University (Main)',
        evidenceRetentionDays: 14,
        eventRetentionDays: 180,
        privacyContact: 'dpo@test.example',
        identityThresholds: { match: 0.5, mismatch: 0.3, mismatchConfirmations: 3 },
        defaultPolicy: { pause: { requireReason: true }, bogus: 1 },
      }),
    );
    expect(s).toMatchObject({ name: 'Test University (Main)', evidenceRetentionDays: 14, eventRetentionDays: 180, privacyContact: 'dpo@test.example' });
    expect(s.identityThresholds).toMatchObject({ match: 0.5, mismatch: 0.3, mismatchConfirmations: 3 });
    expect(s.defaultPolicy.pause.requireReason).toBe(true);
    const [org] = await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id));
    expect(org.name).toBe('Test University (Main)');
    expect(org.settings.defaultPolicy).toEqual({ pause: { requireReason: true } });
    // exams inherit the org default policy
    const exam = json(await reviewer.get(`/exams/${env.exam.id}`));
    expect(exam.policy.pause.requireReason).toBe(true);

    const log = json(await admin.get('/audit-log', { action: 'settings.' }));
    expect(log.total).toBe(1);
    expect(log.items[0]).toMatchObject({ action: 'settings.updated', actorName: 'Test admin', targetType: 'organization' });
    expect(log.items[0].meta.fields).toEqual(expect.arrayContaining(['name', 'evidenceRetentionDays', 'identityThresholds', 'defaultPolicy']));
    expect(log.items[0].meta.identityThresholds.to).toMatchObject({ match: 0.5 });
  });
});

describe('users', () => {
  let rev2: StaffUserDTO;

  it('lets admins create reviewers; only owners create admins/owners; emails are unique', async () => {
    rev2 = json(await admin.post('/users', { email: 'New.Reviewer@Test.Example', name: 'New Reviewer', role: 'reviewer', password: 'correct horse battery' }));
    expect(rev2).toMatchObject({ email: 'new.reviewer@test.example', role: 'reviewer', disabled: false });
    expect((await admin.post('/users', { email: 'x@test.example', name: 'X', role: 'admin', password: 'correct horse battery' })).statusCode).toBe(403);
    expect((await admin.post('/users', { email: 'x@test.example', name: 'X', role: 'owner', password: 'correct horse battery' })).statusCode).toBe(403);
    const newAdmin = json(await owner.post('/users', { email: 'admin2@test.example', name: 'Admin Two', role: 'admin', password: 'correct horse battery' }));
    expect(newAdmin.role).toBe('admin');
    expect((await owner.post('/users', { email: 'ADMIN2@test.example', name: 'Dup', role: 'reviewer', password: 'correct horse battery' })).json().error).toBe('email_taken');
    expect((await owner.post('/users', { email: 'short@test.example', name: 'Short', role: 'reviewer', password: 'short' })).statusCode).toBe(400);
    const list = json(await admin.get('/users')).items as StaffUserDTO[];
    expect(list.map((u) => u.email)).toEqual(expect.arrayContaining(['owner@test.example', 'admin2@test.example', 'new.reviewer@test.example']));
    expect(JSON.stringify(list)).not.toMatch(/password|scrypt/i);
    // the new user can log in
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new.reviewer@test.example', password: 'correct horse battery' } });
    expect(login.statusCode).toBe(200);
  });

  it('enforces who may change whom', async () => {
    expect((await admin.put(`/users/${env.users.owner.id}`, { name: 'Pwned' })).statusCode).toBe(403);
    expect((await admin.put(`/users/${rev2.id}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await admin.put(`/users/${env.users.admin.id}`, { role: 'reviewer' })).statusCode).toBe(403);
    expect(json(await admin.put(`/users/${env.users.admin.id}`, { name: 'Test admin (renamed)' })).name).toBe('Test admin (renamed)');
    expect(json(await admin.put(`/users/${rev2.id}`, { name: 'Reviewer Two' })).name).toBe('Reviewer Two');
    expect(json(await owner.put(`/users/${rev2.id}`, { role: 'admin' })).role).toBe('admin');
    expect(json(await owner.put(`/users/${rev2.id}`, { role: 'reviewer' })).role).toBe('reviewer');
  });

  it('never lets you disable yourself or remove the last owner', async () => {
    expect((await admin.put(`/users/${env.users.admin.id}`, { disabled: true })).json().error).toBe('cannot_disable_self');
    expect((await owner.put(`/users/${env.users.owner.id}`, { role: 'admin' })).json().error).toBe('last_owner');
    expect((await owner.put(`/users/${env.users.owner.id}`, { password: 'another long password' })).json().error).toBe('use_password_change');
    // with a second owner, the first may step down
    const o2 = json(await owner.post('/users', { email: 'owner2@test.example', name: 'Owner Two', role: 'owner', password: 'correct horse battery' }));
    const owner2 = await staffApi(env, await userRow(env, o2.id));
    expect(json(await owner2.put(`/users/${env.users.owner.id}`, { role: 'admin' })).role).toBe('admin');
    expect((await owner2.put(`/users/${o2.id}`, { role: 'admin' })).json().error).toBe('last_owner');
    expect(json(await owner2.put(`/users/${env.users.owner.id}`, { role: 'owner' })).role).toBe('owner');
    expect((await owner2.put(`/users/${env.users.owner.id}`, { disabled: true })).statusCode).toBe(200);
    expect((await owner2.put(`/users/${o2.id}`, { disabled: true })).json().error).toBe('cannot_disable_self');
    json(await owner2.put(`/users/${env.users.owner.id}`, { disabled: false }));
  });

  it('disabling a user or resetting their password signs them out everywhere', async () => {
    const r2 = await staffApi(env, await userRow(env, rev2.id));
    expect((await r2.get('/dashboard')).statusCode).toBe(200);
    json(await admin.put(`/users/${rev2.id}`, { disabled: true }));
    expect((await r2.get('/dashboard')).statusCode).toBe(401);
    const denied = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new.reviewer@test.example', password: 'correct horse battery' } });
    expect(denied.statusCode).toBe(401);
    json(await admin.put(`/users/${rev2.id}`, { disabled: false, password: 'a brand new password' }));
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new.reviewer@test.example', password: 'a brand new password' } });
    expect(ok.statusCode).toBe(200);
    const [row] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, rev2.id));
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
    const log = json(await admin.get('/audit-log', { action: 'user.', targetId: rev2.id }));
    const fields = log.items.map((i: AuditLogEntryDTO) => (i.meta as { fields?: string[] }).fields ?? []);
    expect(fields.flat()).toEqual(expect.arrayContaining(['disabled', 'password', 'role', 'name']));
    expect(JSON.stringify(log.items)).not.toContain('a brand new password');
  });
});

describe('audit log', () => {
  it('is paged, newest first, filterable by action prefix, admin-only', async () => {
    const page = json(await admin.get('/audit-log', { limit: 3, offset: 0 }));
    expect(page.items).toHaveLength(3);
    expect(page.total).toBeGreaterThan(3);
    const ats = page.items.map((i: AuditLogEntryDTO) => i.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    const next = json(await admin.get('/audit-log', { limit: 3, offset: 3 }));
    expect(next.items.map((i: AuditLogEntryDTO) => i.id)).not.toContain(page.items[0].id);
    const users = json(await admin.get('/audit-log', { action: 'user.created' }));
    expect(users.items.every((i: AuditLogEntryDTO) => i.action === 'user.created')).toBe(true);
    expect(users.total).toBe(3);
    // LIKE wildcards in the filter are literal
    expect(json(await admin.get('/audit-log', { action: '%' })).total).toBe(0);
    expect((await reviewer.get('/audit-log')).statusCode).toBe(403);
  });
});
