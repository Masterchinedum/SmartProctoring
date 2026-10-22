/**
 * Break-glass staff account recovery, for an operator with server access, when nobody in the organisation can do
 * it in the staff app (the only owner lost their phone and recovery codes, or forgot their password).
 *
 *   pnpm --filter @sp/server staff-access --email <address> (--reset-mfa | --reset-password)... --reason "<text>" [--json]
 *   node apps/server/dist/scripts/staff-access.js --email <address> --reset-mfa --reason "<text>"
 *
 * Uses the same environment as the server (DATABASE_URL, SESSION_SECRET, SMTP_*). Verify the person's identity out
 * of band first, and record how in --reason (it is written to the organisation's audit log, actor `system`). Ends
 * every signed-in session of the account; the person is emailed about each change when SMTP is configured. A
 * temporary password is printed once — hand it over through a trusted channel; it is never stored in clear.
 *
 * Exit codes: 0 done, 1 error, 2 bad arguments, 4 no staff account with that address.
 */
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase } from '../db/index.js';
import { createSmtpMailer } from '../lib/mailer.js';
import { recoverStaffAccess } from '../services/staff-recovery.js';

const USAGE = 'Usage: staff-access --email <address> [--reset-mfa] [--reset-password] --reason "<who asked, how their identity was checked, ticket>" [--json]';

async function main(): Promise<number> {
  let values: { email?: string; 'reset-mfa'?: boolean; 'reset-password'?: boolean; reason?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      // `pnpm … staff-access -- --email …` passes the `--` through: ignore a leading one.
      args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
      options: {
        email: { type: 'string' },
        'reset-mfa': { type: 'boolean', default: false },
        'reset-password': { type: 'boolean', default: false },
        reason: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const email = values.email?.trim() ?? '';
  const reason = values.reason?.trim() ?? '';
  const problems = [
    !/^[^\s@]+@[^\s@]+$/.test(email) ? '--email <address> is required' : '',
    !values['reset-mfa'] && !values['reset-password'] ? 'choose --reset-mfa and/or --reset-password' : '',
    reason.length < 10 ? '--reason is required (at least 10 characters: who asked, how their identity was checked)' : '',
    reason.length > 500 ? '--reason must be at most 500 characters' : '',
  ].filter(Boolean);
  if (problems.length) {
    console.error(`${problems.join('\n')}\n${USAGE}`);
    return 2;
  }

  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn', base: { app: 'staff-access-cli' } });
  const database = createDatabase(config.databaseUrl, { max: 2, applicationName: 'smartproctoring-staff-access' });
  const mailer = config.smtp ? createSmtpMailer(config.smtp) : null;
  try {
    const r = await recoverStaffAccess(
      { db: database.db, mailer, config, log: log as unknown as Ctx['log'], now: () => Date.now() },
      { email, resetMfa: !!values['reset-mfa'], resetPassword: !!values['reset-password'], reason },
    );
    if (!r) {
      console.error(`No staff account has the address ${email}.`);
      return 4;
    }
    if (values.json) {
      console.log(JSON.stringify({ user: r.user, mfa: r.mfa, temporaryPassword: r.temporaryPassword }, null, 2));
      return 0;
    }
    const lines = [`${r.user.name} <${r.user.email}> (${r.user.role}${r.user.disabled ? ', DISABLED — enable the account in the staff app or ask an owner' : ''})`];
    if (r.mfa === 'reset') lines.push('  two-step sign-in: reset (set it up again at the next sign-in when the organisation requires it)');
    if (r.mfa === 'not_enabled') lines.push('  two-step sign-in: was not on — nothing to reset');
    if (r.temporaryPassword) lines.push(`  temporary password: ${r.temporaryPassword}`, '    (shown once — hand it over through a trusted channel; they change it on their account page)');
    lines.push('  signed-in sessions ended; sign-in backoff lifted; recorded in the audit log', mailer ? '  the person was emailed about the change' : '  SMTP is not configured: tell the person yourself');
    console.log(lines.join('\n'));
    return 0;
  } finally {
    await mailer?.close?.();
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Staff access recovery failed:', err);
    process.exit(1);
  },
);
