// K5: named-column inserts. K7: resolveCase writes its three rows in one transaction.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';
const { temp } = await setupEnv('banana-insert-');
const { appDb, closeAppDb, insert } = await import('../src/db');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('K5 insert maps each key to its column whatever the key order; omitted columns are NULL', () => {
  insert('intents', {
    created_at: '2026-09-30T10:00:00.000Z',
    status: 'failed',
    error: 'e',
    payload: '{"p":1}',
    bank_reference: 'ref-k5',
    user_id: 'lucia',
    id: 'intent-k5',
  });
  assert.deepEqual(appDb().prepare('SELECT * FROM intents WHERE id=?').get('intent-k5'), {
    id: 'intent-k5',
    user_id: 'lucia',
    conversation_id: null,
    run_id: null,
    payload: '{"p":1}',
    status: 'failed',
    bank_reference: 'ref-k5',
    operation_id: null,
    error: 'e',
    created_at: '2026-09-30T10:00:00.000Z',
  });
});

test('K5 orIgnore keeps the first row; a plain insert of the same id throws', () => {
  const row = {
    id: 'appr-k5',
    user_id: 'lucia',
    intent_id: 'intent-k5',
    payload: 'first',
    expires_at: 'x',
  };
  insert('approvals', row);
  insert('approvals', { ...row, payload: 'second' }, { orIgnore: true });
  assert.equal(
    (appDb().prepare('SELECT payload FROM approvals WHERE id=?').get('appr-k5') as any).payload,
    'first',
  );
  assert.throws(() => insert('approvals', row), /UNIQUE/);
});

test('K5 an unknown column is refused, not written elsewhere', () => {
  assert.throws(
    () =>
      insert('events', {
        id: 'e',
        run_id: 'r',
        user_id: 'u',
        kind: 'k',
        data: '{}',
        created_at: 'x',
        nope: 1,
      } as any),
    /no column nope/,
  );
  // A key is an identifier in the SQL text: one that is not a real column never reaches it.
  const key = 'id,user_id,run_id,kind,data,created_at) SELECT id,user_id,1,2,3,4 FROM intents--';
  assert.throws(() => insert('events', { [key]: 'x' } as any), /no column/);
});

test('K7 a failed resolve rolls back the close, its audit event and the customer note', async () => {
  const { resolveCase } = await import('../src/operator/view');
  // The case's conversation does not exist, so the customer note (a foreign key) cannot be written.
  insert('incidents', {
    id: 'case-k7',
    user_id: 'lucia',
    conversation_id: 'conv-k7-missing',
    summary: 'K7',
    status: 'open',
    created_at: new Date().toISOString(),
  });
  await assert.rejects(resolveCase('marta', 'case-k7', true), /FOREIGN KEY/);
  const db = appDb();
  assert.equal(
    (db.prepare('SELECT status FROM incidents WHERE id=?').get('case-k7') as any).status,
    'open',
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM events WHERE kind='case.resolved' AND conversation_id=?")
      .pluck()
      .get('conv-k7-missing'),
    0,
  );
  // INT1: the rolled-back event also rolled back its audit head.
  const { verifyAuditChain } = await import('../src/audit');
  assert.notEqual(verifyAuditChain().status, 'broken');
});
