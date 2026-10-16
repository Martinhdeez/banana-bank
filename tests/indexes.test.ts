// K1: the hot lookups use an index instead of a full scan. Each query is copied verbatim from its
// source file (asserted below), so a reworded query that no longer matches its index fails here.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-indexes-'));
process.env.DATA_DIR = temp;
const { appDb, closeAppDb } = await import('../src/db');
const queries: [file: string, sql: string, index: string][] = [
  ['src/banking/actions.ts', 'SELECT * FROM approvals WHERE intent_id=?', 'approvals_intent'],
  [
    'src/operator/view.ts',
    'SELECT * FROM approvals WHERE intent_id=? ORDER BY rowid DESC LIMIT 1',
    'approvals_intent',
  ],
  [
    'src/banking/actions.ts',
    'SELECT * FROM intents WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    'intents_user',
  ],
  [
    'src/banking/actions.ts',
    "SELECT kind,data,created_at FROM events WHERE kind LIKE 'transfer.%' AND kind<>'transfer.proposed' AND json_extract(data,'$.intentId')=? ORDER BY created_at,rowid",
    'events_intent',
  ],
  [
    'src/banking/actions.ts',
    "SELECT MAX(created_at) at FROM events WHERE kind='transfer.retry' AND json_extract(data,'$.intentId')=?",
    'events_intent',
  ],
  [
    'src/operator/view.ts',
    'SELECT * FROM intents WHERE conversation_id=? ORDER BY created_at,rowid',
    'intents_conversation',
  ],
  [
    'src/operator/view.ts',
    'SELECT id,status,bank_reference FROM intents WHERE conversation_id=?',
    'intents_conversation',
  ],
  [
    'src/agent/tools.ts',
    'SELECT id FROM incidents WHERE conversation_id=? AND status=?',
    'incidents_conversation',
  ],
  // OPX4: migration 4.
  [
    'src/operator/view.ts',
    "SELECT * FROM events WHERE json_extract(data,'$.incidentId')=? AND kind IN ('case.viewed','case.resolved','case.exported') ORDER BY created_at DESC, rowid DESC",
    'events_incident',
  ],
  [
    'src/operator/view.ts',
    "SELECT max(created_at) FROM events WHERE kind='case.viewed' AND json_extract(data,'$.incidentId')=? AND json_extract(data,'$.operatorId')=?",
    'events_incident',
  ],
  [
    'src/operator/view.ts',
    "SELECT max(created_at) AS at FROM events WHERE kind='case.resolved' AND json_extract(data,'$.incidentId')=?",
    'events_incident',
  ],
];
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
for (const [file, sql, index] of queries)
  test(`K1: ${index} serves ${sql.slice(0, 60)}…`, () => {
    assert.ok(fs.readFileSync(file, 'utf8').includes(sql), `query text not found in ${file}`);
    const params = sql.split('?').length - 1;
    const plan = (
      appDb()
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array(params).fill('x')) as { detail: string }[]
    ).map((p) => p.detail);
    assert.ok(
      plan.some((d) => d.includes(`USING INDEX ${index}`)),
      plan.join(' | '),
    );
    assert.ok(!plan.some((d) => /^SCAN (approvals|intents|events|incidents)\b/.test(d)));
  });
test('K1: the unused incidents_user index is dropped from existing databases', async () => {
  // INT2: a pre-migrations database (no schema_migrations) that still has the starter's index.
  closeAppDb();
  for (const f of fs.readdirSync(temp)) fs.rmSync(path.join(temp, f));
  const { default: Database } = await import('better-sqlite3');
  const old = new Database(path.join(temp, 'app.sqlite'));
  old.exec(
    'CREATE TABLE incidents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX incidents_user ON incidents(user_id);',
  );
  old.close();
  const names = (
    appDb().prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(!names.includes('incidents_user'));
});
