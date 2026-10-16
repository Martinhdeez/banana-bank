// INT1: tamper-evident audit log. Every event write goes through insert('events'), which chains
// it; verifyAuditChain() reports edits, inserted rows, deletions and forks, and the case detail
// shows the result. Contract: "Historical evidence that was never recorded must not be invented."
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-audit-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { verifyAuditChain } = await import('../src/audit');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
beforeEach(() => appDb().exec("DELETE FROM events; DELETE FROM meta WHERE key LIKE 'audit-%';"));
const ctx = {
  userId: 'lucia',
  conversationId: 'conv-lucia-welcome',
  runId: 'run-int1',
  intentId: '',
};
const record = (n: number) => {
  for (let i = 0; i < n; i++) recordEvent(ctx, 'tool.started', { i });
  return appDb().prepare('SELECT * FROM events ORDER BY rowid').all() as Record<string, string>[];
};
const broken = () => {
  const { brokenAt } = verifyAuditChain();
  return [brokenAt?.reason, brokenAt?.eventId];
};

test('INT1 events written through recordEvent form a verified chain', () => {
  assert.equal(verifyAuditChain().status, 'empty');
  const rows = record(5);
  assert.deepEqual(verifyAuditChain(), {
    status: 'verified',
    checked: 5,
    legacy: null,
    brokenAt: null,
  });
  assert.equal(rows[0].prev_hash, '');
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
});

test('INT1 hashes a caller passes are ignored', () => {
  record(1);
  insert('events', {
    id: 'e-forged',
    run_id: 'r',
    user_id: 'lucia',
    kind: 'k',
    data: '{}',
    created_at: new Date().toISOString(),
    prev_hash: 'x',
    hash: 'y',
  } as any);
  assert.deepEqual([verifyAuditChain().status, verifyAuditChain().checked], ['verified', 2]);
});

test('INT1 an edited event is reported at that event', () => {
  const rows = record(5);
  appDb().prepare("UPDATE events SET data='{}' WHERE id=?").run(rows[2].id);
  const audit = verifyAuditChain();
  assert.equal(audit.status, 'broken');
  assert.deepEqual(broken(), ['hash_mismatch', rows[2].id]);
  assert.equal(audit.checked, 2);
});

test('INT1 an event inserted outside the log is reported', () => {
  record(3);
  appDb()
    .prepare(
      "INSERT INTO events(id,run_id,user_id,kind,data,created_at) VALUES('e-raw','r','lucia','k','{}',?)",
    )
    .run(new Date().toISOString());
  assert.deepEqual(broken(), ['unlinked_rows', 'e-raw']);
});

test('INT1 deleting the newest event is reported', () => {
  const rows = record(3);
  appDb().prepare('DELETE FROM events WHERE id=?').run(rows[2].id);
  assert.deepEqual(broken(), ['head_mismatch', rows[2].id]);
});

test('INT1 deleting a middle event is reported', () => {
  const rows = record(4);
  appDb().prepare('DELETE FROM events WHERE id=?').run(rows[1].id);
  assert.deepEqual(broken(), ['unlinked_rows', rows[2].id]);
});

test('INT1 a forked chain (two rows on one link) is reported', () => {
  const rows = record(2);
  appDb()
    .prepare(
      "INSERT INTO events(id,run_id,user_id,kind,data,created_at,prev_hash,hash) VALUES('e-fork','r','lucia','k','{}','x',?,'h')",
    )
    .run(rows[1].prev_hash);
  assert.deepEqual(broken(), ['fork', 'e-fork']);
});

test('INT1 a rolled-back event leaves the chain verified', () => {
  record(2);
  assert.throws(() =>
    appDb().transaction(() => {
      recordEvent(ctx, 'tool.started', {});
      throw new Error('rollback');
    })(),
  );
  assert.deepEqual([verifyAuditChain().status, verifyAuditChain().checked], ['verified', 2]);
  record(1);
  assert.deepEqual([verifyAuditChain().status, verifyAuditChain().checked], ['verified', 3]);
});

test('INT1 agent tool events are chained without editing src/agent', async () => {
  const { runTool } = await import('../src/agent/tools');
  await runTool('list_accounts', {}, ctx);
  const rows = appDb().prepare('SELECT kind,hash FROM events ORDER BY rowid').all() as any[];
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['tool.started', 'tool.completed'],
  );
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash)));
  assert.equal(verifyAuditChain().status, 'verified');
  const files = fs.readdirSync('src/agent', { recursive: true }) as string[];
  for (const f of files.filter((f) => f.endsWith('.ts')))
    assert.doesNotMatch(fs.readFileSync(path.join('src/agent', f), 'utf8'), /INTO\s+events/i, f);
});

test('INT1 case detail shows the audit status, and a gap when the log is broken', async () => {
  const { caseDetail, resolveCase } = await import('../src/operator/view');
  const caseId = 'case-lucia';
  const { conversation_id } = appDb()
    .prepare('SELECT conversation_id FROM incidents WHERE id=?')
    .get(caseId) as { conversation_id: string };
  recordEvent({ ...ctx, conversationId: conversation_id }, 'tool.started', { step: 1 });
  let detail = await caseDetail('marta', caseId);
  assert.equal(detail.audit.status, 'verified');
  assert.ok(detail.events.every((e) => typeof e.hash === 'string'));
  assert.ok(!detail.gaps.some((g) => /Audit log/.test(g)));
  // resolveCase writes its event inside its own transaction (a savepoint here): still verified.
  detail = await resolveCase('marta', caseId, true);
  assert.deepEqual([detail.audit.status, detail.audit.checked], ['verified', 2]);
  appDb().prepare(`UPDATE events SET data='{"step":2}' WHERE kind='tool.started'`).run();
  detail = await caseDetail('marta', caseId);
  assert.equal(detail.audit.status, 'broken');
  assert.equal(detail.audit.brokenAt?.reason, 'hash_mismatch');
  assert.ok(
    detail.gaps.some((g) => /^Audit log: a recorded step was changed after it was written/.test(g)),
    detail.gaps.join('\n'),
  );
});
