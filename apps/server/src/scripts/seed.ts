/**
 * Demo data for development: `pnpm --filter @sp/server seed`
 *   organisation "Demo University", owner admin@example.com / ChangeMe123!, reviewer reviewer@example.com,
 *   a published sample exam (10 mixed questions, default policy), 3 candidates with assignments.
 * Idempotent: re-running prints the existing candidate links. Refuses to run with NODE_ENV=production
 * unless SEED_ALLOW_PRODUCTION=1.
 */
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { createDatabase, migrate } from '../db/index.js';
import { candidates, examSessions, exams, organizations, staffUsers } from '../db/schema.js';
import { createKeyring, hashPassword } from '../lib/crypto.js';
import { accessLinkFor } from '../services/dto.js';
import { createExam } from '../services/exams.js';
import { createOrganization } from '../services/org.js';
import { createExamSession } from '../services/session-actions.js';

const ORG_NAME = 'Demo University';
const PASSWORD = 'ChangeMe123!';

const config = loadConfig();
if (config.isProduction && process.env.SEED_ALLOW_PRODUCTION !== '1') {
  console.error('Refusing to seed demo data (with a known password) in production. Set SEED_ALLOW_PRODUCTION=1 to override.');
  process.exit(1);
}
const database = createDatabase(config.databaseUrl, { max: 4, applicationName: 'smartproctoring-seed' });
const keyring = createKeyring(config.evidenceKey, config.evidenceKeysOld);
const ctx = { config, database, db: database.db, keyring, now: () => Date.now() } as unknown as Ctx;

try {
  await migrate(database);
  const db = database.db;
  let [org] = await db.select().from(organizations).where(eq(organizations.name, ORG_NAME));
  if (!org) {
    org = await createOrganization(db, ORG_NAME, { privacyContact: 'privacy@demo-university.example', evidenceRetentionDays: 30, eventRetentionDays: 365 });
    const hash = await hashPassword(PASSWORD);
    const [owner] = await db
      .insert(staffUsers)
      .values([
        { orgId: org.id, email: 'admin@example.com', name: 'Dana Admin', role: 'owner', passwordHash: hash },
        { orgId: org.id, email: 'reviewer@example.com', name: 'Riley Reviewer', role: 'reviewer', passwordHash: hash },
      ])
      .returning();

    const { exam } = await createExam(
      db,
      org.id,
      {
        title: 'Introduction to Statistics — Midterm',
        description: 'Covers descriptive statistics, probability basics and sampling.',
        instructions:
          'You have 60 minutes. Keep your face visible to the camera and stay in fullscreen. You may pause the exam; the timer stops while paused and you will repeat the identity check when you return. Calculators are allowed; phones and other people are not.',
        durationSec: 3600,
        policy: {},
        questions: [
          { type: 'single_choice', prompt: 'Which measure of central tendency is most affected by outliers?', options: [{ id: 'a', text: 'Median' }, { id: 'b', text: 'Mean' }, { id: 'c', text: 'Mode' }], correct: ['b'], points: 1 },
          { type: 'single_choice', prompt: 'A fair die is rolled once. What is the probability of rolling a number greater than 4?', options: [{ id: 'a', text: '1/6' }, { id: 'b', text: '1/3' }, { id: 'c', text: '1/2' }, { id: 'd', text: '2/3' }], correct: ['b'], points: 1 },
          { type: 'multiple_choice', prompt: 'Which of the following are measures of spread? (Select all that apply.)', options: [{ id: 'a', text: 'Variance' }, { id: 'b', text: 'Interquartile range' }, { id: 'c', text: 'Median' }, { id: 'd', text: 'Standard deviation' }], correct: ['a', 'b', 'd'], points: 2 },
          { type: 'numeric', prompt: 'What is the mean of 2, 4, 4, 5, 10?', options: [], correct: ['5'], points: 1 },
          { type: 'numeric', prompt: 'Give the sample variance of 1, 2, 3 (to 2 decimals).', options: [], correct: ['1.00|0.005'], points: 2 },
          { type: 'short_text', prompt: 'What is the name of the distribution with the bell-shaped density curve?', options: [], correct: ['normal', 'normal distribution', 'gaussian', 'gaussian distribution'], points: 1 },
          { type: 'single_choice', prompt: 'A 95% confidence interval means…', options: [{ id: 'a', text: 'There is a 95% chance the parameter is in this particular interval' }, { id: 'b', text: '95% of intervals built this way contain the parameter' }, { id: 'c', text: '95% of the data lie in the interval' }], correct: ['b'], points: 1 },
          { type: 'multiple_choice', prompt: 'Which sampling methods are probability samples?', options: [{ id: 'a', text: 'Simple random sample' }, { id: 'b', text: 'Convenience sample' }, { id: 'c', text: 'Stratified sample' }, { id: 'd', text: 'Voluntary response' }], correct: ['a', 'c'], points: 2 },
          { type: 'short_text', prompt: 'The middle value of an ordered data set is called the …', options: [], correct: ['median'], points: 1 },
          { type: 'long_text', prompt: 'Explain the difference between correlation and causation, with an example.', options: [], correct: [], points: 5 },
        ],
      },
      { status: 'published', createdBy: owner.id },
    );

    const people = [
      { name: 'Alex Morgan', email: 'alex.morgan@student.example', externalId: 'S-1001' },
      { name: 'Priya Natarajan', email: 'priya.natarajan@student.example', externalId: 'S-1002' },
      { name: 'Sam Okafor', email: 'sam.okafor@student.example', externalId: 'S-1003' },
    ];
    for (const p of people) {
      const [c] = await db.insert(candidates).values({ orgId: org.id, ...p }).returning();
      await createExamSession(ctx, db, { orgId: org.id, examId: exam.id, candidateId: c.id });
    }
    console.log(`Created organisation "${ORG_NAME}".`);
  } else {
    console.log(`Organisation "${ORG_NAME}" already exists; listing its data.`);
  }

  const rows = await db
    .select({ session: examSessions, name: candidates.name, exam: exams.title })
    .from(examSessions)
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .where(eq(examSessions.orgId, org.id));
  console.log('\nStaff logins (development only):');
  console.log(`  owner     admin@example.com     ${PASSWORD}`);
  console.log(`  reviewer  reviewer@example.com  ${PASSWORD}`);
  console.log(`\nCandidate access links (PUBLIC_URL=${config.publicUrl}):`);
  for (const r of rows) console.log(`  ${r.name.padEnd(18)} [${r.session.status}] ${accessLinkFor(ctx, r.session) ?? '(link unavailable: evidence key changed)'}`);
  console.log(`\nAdmin: ${config.publicUrl}/admin`);
} finally {
  await database.close();
}
