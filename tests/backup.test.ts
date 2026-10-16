// INT4: `npm run backup` makes a consistent copy of the app database; `reset` saves one before
// wiping local activity (README used to say only "Save any evidence you need first").
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { freePort, setupEnv } from './helpers/bank';
const { temp } = await setupEnv('banana-backup-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { verifyAuditChain } = await import('../src/audit');
const { backupAppDb } = await import('../scripts/backup');
const ctx = {
  userId: 'lucia',
  conversationId: 'conv-lucia-welcome',
  runId: 'run-int4',
  intentId: '',
};
const backups = path.join(temp, 'backups');
const events = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
before(() => {
  seedBank();
  seedApp();
});
after(() => {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('INT4 backup copies the data and verifies its chain', async () => {
  for (let i = 0; i < 3; i++) recordEvent(ctx, 'tool.started', { i });
  const file = await backupAppDb();
  assert.ok(file && file.startsWith(backups), `backup under ${backups}: ${file}`);
  const copy = new Database(file, { readonly: true });
  try {
    assert.equal(events(copy), events(appDb()));
    for (const table of ['conversations', 'messages', 'incidents'])
      assert.deepEqual(
        copy.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        appDb().prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      );
    assert.equal(verifyAuditChain(copy).status, 'verified');
  } finally {
    copy.close();
  }
});

test('INT4 backup while a write transaction is open elsewhere holds committed rows only', async () => {
  const before = events(appDb());
  const other = new Database(path.join(temp, 'app.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  other
    .prepare(
      "INSERT INTO events(id,run_id,user_id,kind,data,created_at) VALUES('uncommitted','r','u','k','{}','t')",
    )
    .run();
  try {
    const copy = new Database((await backupAppDb())!, { readonly: true });
    assert.equal(events(copy), before);
    copy.close();
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});

test('INT4 reset keeps a backup of local activity', async () => {
  recordEvent(ctx, 'tool.started', { marker: 'before-reset' });
  // TR1 (plan 27 D11): a reset clears the usage rows too, and its backup keeps them.
  const usage = 'SELECT COUNT(*) FROM ai_usage';
  appDb().exec(
    "INSERT INTO ai_usage(created_at,actor,consumer,seq,attempt,outcome,model,host,tools,cost_basis) VALUES('t','system','embeddings',1,1,'ok','m','h','[]','unpriced')",
  );
  closeAppDb();
  fs.rmSync(backups, { recursive: true, force: true });
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reset.ts'], {
    env: { ...process.env, BANK_PORT: String(await freePort()) },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Backup saved: /);
  const files = fs.readdirSync(backups);
  assert.equal(files.length, 1);
  const copy = new Database(path.join(backups, files[0]), { readonly: true });
  const marked = "SELECT COUNT(*) n FROM events WHERE data LIKE '%before-reset%'";
  assert.equal((copy.prepare(marked).get() as { n: number }).n, 1);
  assert.equal(copy.prepare(usage).pluck().get(), 1);
  copy.close();
  assert.equal((appDb().prepare(marked).get() as { n: number }).n, 0);
  assert.equal(appDb().prepare(usage).pluck().get(), 0);
});

test('INT4 backups are gitignored', () => {
  // IT3: the delivery ZIP has no Git, so there the same fact is read from the shipped .gitignore.
  if (!fs.existsSync('.git')) {
    const rules = fs.readFileSync('.gitignore', 'utf8').split(/\r?\n/);
    for (const rule of ['.data/', '.data-*/']) assert.ok(rules.includes(rule), rule);
    return;
  }
  for (const file of ['.data/backups/app-x.sqlite', '.data-e2e/backups/app-x.sqlite'])
    assert.equal(spawnSync('git', ['check-ignore', '-q', file]).status, 0, file);
});
