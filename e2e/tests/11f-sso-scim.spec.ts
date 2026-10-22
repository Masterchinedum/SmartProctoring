import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { FakeOidcProvider } from '../../apps/server/test/sso/fake-oidc';
import { expectNoA11yIssues } from '../lib/a11y';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { localhostCert } from '../lib/integrations';
import { artifactLog, resetDatabase, siblingDatabaseUrl, startServer, type ServerHandle } from '../lib/server';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { AuditLogEntryDTO, Paged, SsoOverviewDTO, StaffUserDTO } from '../../packages/shared/src';

/**
 * Scenario 11f — single sign-on (OpenID Connect) and SCIM provisioning, on a dedicated server instance (identity
 * providers, email domains and "require single sign-on" are organisation-wide), against a fake OpenID Connect provider
 * started by the spec (https with the suite's self-signed certificate, trusted by the server through
 * NODE_EXTRA_CA_CERTS; SSO_ALLOW_PRIVATE_NETWORKS=true because it listens on 127.0.0.1).
 *  a) The owner adds the provider in Settings → Single sign-on (redirect URI shown, test connection, accounts created
 *     at first sign-in as reviewers) and creates a SCIM token (shown once).
 *  b) A new staff member signs in with "Sign in with your organisation" (email → provider → back, signed in, no local
 *     second step); a refused sign-in at the provider returns to the sign-in page with a plain message.
 *  c) SCIM creates an administrator, who signs in with single sign-on; SCIM deactivates them and their open page is
 *     signed out; the Users page shows it.
 *  d) The owner requires single sign-on: password sign-in of an administrator is refused with guidance, the owner keeps
 *     password sign-in (break-glass).
 */
test.describe('single sign-on and SCIM', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 9;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'sso');
  const DOMAIN = 'sso-e2e.example';
  let storageDir = '';
  let server: ServerHandle;
  let idp: FakeOidcProvider;
  let owner: StaffApi;
  let scimToken = '';
  let providerId = '';

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    const tls = localhostCert();
    idp = await FakeOidcProvider.start({ clientId: 'smartproctoring-e2e', clientSecret: 'e2e-client-secret-0123', tls: { cert: tls.cert, key: tls.key } });
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-sso-storage-'));
    server = await startServer({
      port,
      publicHost: '127.0.0.1',
      databaseUrl,
      storageDir,
      logFile: artifactLog('server-sso.log'),
      env: { SSO_ALLOW_PRIVATE_NETWORKS: 'true', NODE_EXTRA_CA_CERTS: tls.certPath, VISION_THREADS: '1' },
    });
    owner = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
  });

  test.afterAll(async () => {
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    await idp?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  /** A browser context of the staff app; the fake provider's certificate is self-signed. */
  const openPage = async (browser: Browser, signedInAs?: StaffApi): Promise<Page> =>
    (await browser.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true, ...(signedInAs ? { storageState: await signedInAs.storageState() } : {}) })).newPage();

  async function signInWithOrganisation(page: Page, email: string) {
    await page.goto('/admin/login');
    await page.getByRole('button', { name: 'Sign in with your organisation' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in with your organisation' })).toBeVisible();
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  const scim = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${scimToken}`, ...(body ? { 'content-type': 'application/scim+json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  test('the owner sets up an OpenID Connect provider and a SCIM token in Settings', async ({ browser }) => {
    const page = await openPage(browser, owner);
    await page.goto('/admin/settings');
    const section = page.getByTestId('settings-sso');
    await expect(section).toContainText('No identity provider is set up.');
    await expect(section).toContainText('your identity provider is responsible for the second step');
    await section.getByRole('button', { name: 'Add identity provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add identity provider' });
    await dialog.getByLabel('Name shown to staff').fill('E2E University login');
    await dialog.getByLabel('Email domains').fill(DOMAIN);
    await dialog.getByLabel('Issuer URL').fill(idp.issuer);
    await dialog.getByLabel('Client (application) ID').fill('smartproctoring-e2e');
    await dialog.getByLabel('Client secret').fill('e2e-client-secret-0123');
    await dialog.getByLabel('Create an account at the first sign-in of someone with one of these domains').check();
    await dialog.getByLabel('Enabled (staff can sign in with it)').check();
    await expectNoA11yIssues(page, 'the identity provider dialog');
    await dialog.getByRole('button', { name: 'Add provider' }).click();
    await expect(dialog).toBeHidden();

    const provider = section.getByTestId('sso-provider');
    await expect(provider).toContainText('E2E University login');
    await expect(provider).toContainText('Enabled');
    await expect(provider).toContainText(DOMAIN);
    const overview = await owner.json<SsoOverviewDTO>('get', '/api/admin/sso');
    providerId = overview.providers[0].id;
    await expect(provider.getByTestId('sso-redirect-uri')).toHaveText(`${server.url}/api/auth/sso/oidc/${providerId}/callback`);
    expect(JSON.stringify(overview)).not.toContain('e2e-client-secret-0123');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await expect(provider.getByTestId('sso-test-result')).toContainText('Connection works.');

    // SCIM token, shown once.
    const scimCard = page.getByTestId('settings-scim');
    await expect(scimCard.getByTestId('scim-base-url')).toHaveText(`${server.url}/scim/v2`);
    await scimCard.getByRole('button', { name: 'Create SCIM token' }).click();
    const secretDialog = page.getByRole('dialog', { name: 'SCIM token created' });
    scimToken = (await secretDialog.getByTestId('secret-value').innerText()).trim();
    expect(scimToken).toMatch(/^sp_scim_[\w-]{43}$/);
    await secretDialog.getByRole('button', { name: 'I have stored it' }).click();
    await expect(scimCard.getByTestId('scim-token-status')).toContainText(scimToken.slice(0, 14));
    await expectNoA11yIssues(page, 'Settings with single sign-on and SCIM');
    await page.context().close();
  });

  test('a new staff member signs in with their organisation; a refused sign-in explains itself', async ({ browser }) => {
    const page = await openPage(browser);
    idp.nextUser = { sub: 'idp-user-pat', email: `pat@${DOMAIN}`, email_verified: true, name: 'Pat Proctor' };
    await page.goto('/admin/login');
    await page.getByRole('button', { name: 'Sign in with your organisation' }).click();
    await expectNoA11yIssues(page, 'the single sign-on step of the sign-in page');
    await page.getByLabel('Work email').fill(`pat@${DOMAIN}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
    // The provider received PKCE, state and nonce; no local second step was asked.
    const authz = idp.authorizeRequests.at(-1)!;
    expect(authz.get('code_challenge_method')).toBe('S256');
    expect(authz.get('login_hint')).toBe(`pat@${DOMAIN}`);
    await page.goto('/admin/account');
    await expect(page.getByTestId('signed-in-with-sso')).toContainText('You signed in with single sign-on');
    const users = await owner.json<{ items: StaffUserDTO[] }>('get', '/api/admin/users');
    expect(users.items.find((u) => u.email === `pat@${DOMAIN}`)).toMatchObject({ role: 'reviewer', ssoLinked: true, provisionedVia: 'sso' });
    await page.context().close();

    // Refused at the provider: back on the sign-in page with a plain message.
    const page2 = await openPage(browser);
    idp.nextError = 'access_denied';
    await signInWithOrganisation(page2, `pat@${DOMAIN}`);
    await expect(page2.getByRole('alert')).toContainText('Your organisation’s sign-in was cancelled or refused.');
    // An address no provider signs in.
    await page2.getByLabel('Work email').fill('someone@elsewhere.example');
    await page2.getByRole('button', { name: 'Continue' }).click();
    await expect(page2.getByRole('alert')).toContainText('Single sign-on is not set up for this email address');
    await page2.context().close();
  });

  test('SCIM provisions an administrator who signs in with single sign-on, then deactivates them', async ({ browser }) => {
    const created = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `sam@${DOMAIN}`, displayName: 'Sam Admin', roles: [{ value: 'admin', primary: true }], active: true });
    expect(created.status).toBe(201);
    const sam = (await created.json()) as { id: string };

    const page = await openPage(browser);
    idp.nextUser = { sub: 'idp-user-sam', email: `sam@${DOMAIN}`, email_verified: true, name: 'Sam Admin' };
    await signInWithOrganisation(page, `sam@${DOMAIN}`);
    await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible(); // administrator

    // Deactivated at the identity provider (Microsoft Entra ID sends this PATCH): signed out everywhere.
    const patched = await scim('PATCH', `/Users/${sam.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    expect(patched.status).toBe(200);
    await page.goto('/admin/sessions');
    await expect(page.getByRole('heading', { name: 'SmartProctoring' })).toBeVisible();
    await expect(page.getByText('Staff sign in')).toBeVisible();
    // A disabled account cannot sign in again with single sign-on.
    idp.nextUser = { sub: 'idp-user-sam', email: `sam@${DOMAIN}`, email_verified: true };
    await signInWithOrganisation(page, `sam@${DOMAIN}`);
    await expect(page.getByRole('alert')).toContainText('This account is disabled');
    await page.context().close();

    const ownerPage = await openPage(browser, owner);
    await ownerPage.goto('/admin/users');
    const row = ownerPage.getByRole('row', { name: /Sam Admin/ });
    await expect(row).toContainText('Disabled');
    await expect(row).toContainText('Linked');
    await expect(row).toContainText('SCIM');
    const audit = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?action=user.updated&limit=5');
    expect(audit.items.find((e) => e.targetId === sam.id)).toMatchObject({ actorType: 'scim', actorName: 'SCIM provisioning', meta: expect.objectContaining({ disabled: true }) });
    await ownerPage.context().close();
  });

  test('the owner requires single sign-on; owners keep password sign-in as break-glass', async ({ browser }) => {
    const admin = await owner.createUser('admin');
    const page = await openPage(browser, owner);
    await page.goto('/admin/settings');
    const require = page.getByTestId('sso-require');
    await require.getByLabel('Everyone except owners must sign in with single sign-on').check();
    await require.getByRole('button', { name: 'Save' }).click();
    const confirm = page.getByRole('dialog', { name: 'Require single sign-on?' });
    await expect(confirm).toContainText('signed out now');
    await confirm.getByRole('button', { name: 'Require single sign-on' }).click();
    await expect(confirm).toBeHidden();
    await expect(require.getByLabel('Everyone except owners must sign in with single sign-on')).toBeChecked();
    await page.context().close();

    // An administrator's password sign-in is refused with guidance and offered single sign-on instead.
    const adminPage = await openPage(browser);
    await adminPage.goto('/admin/login');
    await adminPage.getByLabel('Email').fill(admin.email);
    await adminPage.getByLabel('Password').fill(admin.password);
    await adminPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(adminPage.getByRole('heading', { name: 'Sign in with your organisation' })).toBeVisible();
    await expect(adminPage.getByRole('alert')).toContainText('Your organisation signs in with single sign-on');
    await adminPage.context().close();

    // The owner still signs in with a password.
    const again = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    expect(again.user.role).toBe('owner');
    await again.dispose();
  });
});
