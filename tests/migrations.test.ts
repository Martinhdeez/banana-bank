// INT2: versioned, append-only migrations. Old databases (starter, rounds 1–4) reach the same
// schema as a fresh one, re-opening changes nothing, and a newer database is refused.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setupEnv } from './helpers/bank';
const { temp } = await setupEnv('banana-migrations-');
const db = await import('../src/db');
const { appDb, closeAppDb } = db;
const file = path.join(temp, 'app.sqlite');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
// Round-4 DDL (dev before INT2) and starter DDL (main), as literals: what old .data/ files contain.
const ROUND4 = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,started_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
  CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,run_id TEXT,payload TEXT NOT NULL,status TEXT NOT NULL,bank_reference TEXT,operation_id TEXT,error TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
  CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,user_id TEXT NOT NULL,conversation_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,text TEXT NOT NULL,title TEXT,version INTEGER,valid_from TEXT,valid_to TEXT,audience TEXT NOT NULL,vector BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,sources TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS embedding_cache(key TEXT PRIMARY KEY,vector BLOB NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
  CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,created_at);
  CREATE INDEX IF NOT EXISTS approvals_intent ON approvals(intent_id);
  CREATE INDEX IF NOT EXISTS intents_user ON intents(user_id,created_at);
  CREATE INDEX IF NOT EXISTS intents_conversation ON intents(conversation_id,created_at);
  CREATE INDEX IF NOT EXISTS incidents_conversation ON incidents(conversation_id,status);
  CREATE INDEX IF NOT EXISTS events_intent ON events(json_extract(data,'$.intentId'));
  INSERT OR IGNORE INTO meta VALUES('index-version',lower(hex(randomblob(16))));
  DROP INDEX IF EXISTS incidents_user;`;
const STARTER = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,started_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
  CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,run_id TEXT,payload TEXT NOT NULL,status TEXT NOT NULL,bank_reference TEXT,operation_id TEXT,error TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
  CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,user_id TEXT NOT NULL,conversation_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,text TEXT NOT NULL,title TEXT,version INTEGER,valid_from TEXT,valid_to TEXT,audience TEXT NOT NULL,vector BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS embedding_cache(key TEXT PRIMARY KEY,vector BLOB NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
  CREATE INDEX IF NOT EXISTS incidents_user ON incidents(user_id);
  CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,created_at);`;
const ROWS = `
  INSERT INTO conversations VALUES('c1','lucia','T','2026-09-01T00:00:00.000Z');
  INSERT INTO messages VALUES('m1','c1','user','hi','2026-09-01T00:00:01.000Z',NULL);
  INSERT INTO intents VALUES('i1','lucia','c1','r1','{}','failed',NULL,NULL,NULL,'2026-09-01T00:00:02.000Z');
  INSERT INTO events VALUES('e1','r1','lucia','c1','tool.started','{"intentId":"i1"}','2026-09-01T00:00:03.000Z');
  INSERT INTO events VALUES('e2','r1','lucia','c1','tool.completed','{"intentId":"i1"}','2026-09-01T00:00:04.000Z');
  INSERT INTO events VALUES('e3','r1','lucia','c1','transfer.failed','{"intentId":"i1"}','2026-09-01T00:00:05.000Z');`;
// Starts over with no file, or with an old database built from `ddl`.
function reopen(ddl?: string) {
  closeAppDb();
  for (const f of fs.readdirSync(temp))
    if (f.startsWith('app.sqlite')) fs.rmSync(path.join(temp, f));
  if (ddl) {
    const old = new Database(file);
    old.exec(ddl + ROWS);
    old.close();
  }
  return appDb();
}
const schema = () =>
  appDb()
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
const applied = () =>
  appDb()
    .prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version')
    .all() as {
    version: number;
    name: string;
    applied_at: string;
  }[];
const counts = () =>
  Object.fromEntries(
    ['conversations', 'messages', 'intents', 'events'].map((t) => [
      t,
      appDb().prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get(),
    ]),
  );
reopen();
const freshSchema = schema();

test('INT2 a fresh database records every migration once, in order', () => {
  reopen();
  const rows = applied();
  assert.deepEqual(
    rows.slice(0, 2).map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: 'baseline' },
      { version: 2, name: 'events-audit-chain' },
    ],
  );
  assert.equal(rows.length, db.SCHEMA_VERSION);
  assert.deepEqual(
    rows.map((r) => r.version),
    Array.from({ length: db.SCHEMA_VERSION }, (_, i) => i + 1),
  );
});

test('INT2 opening twice changes nothing', () => {
  reopen(ROUND4);
  const before = { schema: schema(), applied: applied(), counts: counts() };
  closeAppDb();
  assert.deepEqual({ schema: schema(), applied: applied(), counts: counts() }, before);
});

test('INT2 a round-4 database migrates to the fresh schema and keeps its rows', () => {
  reopen(ROUND4);
  assert.deepEqual(schema(), freshSchema);
  assert.deepEqual(counts(), { conversations: 1, messages: 1, intents: 1, events: 3 });
  assert.equal(applied().length, db.SCHEMA_VERSION);
});

test('INT2 a starter database migrates to the fresh schema and keeps its rows', () => {
  reopen(STARTER);
  assert.deepEqual(schema(), freshSchema);
  assert.deepEqual(counts(), { conversations: 1, messages: 1, intents: 1, events: 3 });
  assert.equal(applied().length, db.SCHEMA_VERSION);
});

test('INT2 a newer database is refused, and the next open retries', () => {
  reopen();
  appDb().prepare("INSERT INTO schema_migrations VALUES(99,'future','x')").run();
  closeAppDb();
  assert.throws(() => appDb(), /schema version 99/);
  assert.throws(() => appDb(), /schema version 99/, 'no half-open handle is reused');
  const raw = new Database(file);
  raw.prepare('DELETE FROM schema_migrations WHERE version=99').run();
  raw.close();
  assert.equal(applied().length, db.SCHEMA_VERSION);
});

test('INT2 npm run reset recovers a newer database, as the refusal says', async () => {
  reopen();
  appDb().prepare("INSERT INTO schema_migrations VALUES(99,'future','x')").run();
  closeAppDb();
  const code = await new Promise((resolve) =>
    spawn(process.execPath, ['--import', 'tsx', 'scripts/reset.ts'], {
      env: process.env,
      stdio: 'ignore',
    }).on('exit', resolve),
  );
  assert.equal(code, 0);
  assert.equal(applied().length, db.SCHEMA_VERSION);
});

test('INT2 concurrent processes on an old database migrate once and chain every event', async () => {
  reopen(ROUND4);
  closeAppDb();
  const perProcess = 150;
  const script = `
    const { appDb } = await import('./src/db.ts');
    const { recordEvent } = await import('./src/telemetry.ts');
    appDb();
    for (let i = 0; i < ${perProcess}; i++)
      recordEvent({ userId: 'lucia', conversationId: 'c1', runId: 'r-' + process.pid, intentId: '' }, 'tool.started', { i });
  `;
  const run = () =>
    new Promise<number | null>((resolve) =>
      spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        env: process.env,
        stdio: 'inherit',
      }).on('exit', resolve),
    );
  assert.deepEqual(await Promise.all([run(), run(), run(), run()]), [0, 0, 0, 0]);
  assert.equal(applied().length, db.SCHEMA_VERSION);
  const { verifyAuditChain } = await import('../src/audit');
  const audit = verifyAuditChain();
  assert.equal(audit.status, 'verified');
  assert.equal(audit.checked, 3 + 4 * perProcess);
  assert.equal(audit.legacy?.count, 3);
});

test('INT1 migration 2 backfills legacy rows; new events link to them; the case says so', async () => {
  reopen(ROUND4);
  const { verifyAuditChain } = await import('../src/audit');
  const { recordEvent } = await import('../src/telemetry');
  let audit = verifyAuditChain();
  assert.equal(audit.status, 'verified');
  assert.equal(audit.checked, 3);
  assert.equal(audit.legacy?.count, 3);
  assert.equal(audit.legacy?.through, 'e3');
  recordEvent(
    { userId: 'lucia', conversationId: 'c1', runId: 'r2', intentId: '' },
    'tool.started',
    {},
  );
  audit = verifyAuditChain();
  assert.deepEqual([audit.status, audit.checked], ['verified', 4]);
  db.insert('incidents', {
    id: 'case-int1-legacy',
    user_id: 'lucia',
    conversation_id: 'c1',
    summary: 'legacy',
    status: 'open',
    created_at: new Date().toISOString(),
  });
  // No bank is running: the case still loads, with the bank error as a gap.
  const { caseDetail } = await import('../src/operator/view');
  const detail = await caseDetail('marta', 'case-int1-legacy');
  assert.equal(detail.audit.status, 'verified');
  assert.ok(
    detail.gaps.some((g) => /recorded before the audit log existed/.test(g)),
    detail.gaps.join('\n'),
  );
});
