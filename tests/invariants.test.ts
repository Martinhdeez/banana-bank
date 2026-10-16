import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-tests-'));
process.env.DATA_DIR = temp;
process.env.BANK_DATA_DIR = temp;
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { transfer, listAccounts, setScenario, operationByReference } =
  await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { actor, sessionToken, sameOrigin } = await import('../src/auth');
const { documents, readDocument } = await import('../src/ingestion/pipeline');
const { allChunks } = await import('../src/retrieval/store');
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 1000,
  concept: 'Test',
};
function snapshot() {
  return {
    accounts: bankDb().prepare('SELECT * FROM accounts ORDER BY id').all(),
    movements: bankDb().prepare('SELECT * FROM movements ORDER BY id').all(),
    operations: bankDb().prepare('SELECT * FROM operations ORDER BY id').all(),
  };
}
test('reset reproduces consistent accounts and transactions', () => {
  seedBank();
  const before = snapshot();
  setScenario('normal');
  transfer('lucia', 'test-reset', input);
  seedBank();
  assert.deepEqual(snapshot(), before);
  for (const a of before.accounts as any[]) {
    const sum = (
      bankDb()
        .prepare('SELECT SUM(amountCents) AS total FROM movements WHERE accountId=?')
        .get(a.id) as { total: number }
    ).total;
    assert.equal(sum, a.balanceCents);
  }
});
test('a transfer debits and credits without creating money', () => {
  seedBank();
  setScenario('normal');
  const total = () => bankDb().prepare('SELECT SUM(balanceCents) AS total FROM accounts').get();
  const before = total(),
    balance = listAccounts('lucia')[0].balanceCents;
  const result = transfer('lucia', 'test-normal', input);
  assert.equal(result.operation.status, 'completed');
  assert.deepEqual(total(), before);
  assert.equal(listAccounts('lucia')[0].balanceCents, balance - 1000);
});
test('the bank guarantees idempotency by actor and reference', () => {
  seedBank();
  setScenario('normal');
  const first = transfer('lucia', 'stable', input),
    before = snapshot();
  const second = transfer('lucia', 'stable', input);
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.replay, true);
  assert.deepEqual(snapshot(), before);
  assert.throws(
    () => transfer('lucia', 'stable', { ...input, amountCents: 1200 }),
    /different operation/,
  );
});
test('different intents with the same payload remain separate transfers', () => {
  seedBank();
  setScenario('normal');
  const a = transfer('lucia', 'one', input),
    b = transfer('lucia', 'two', input);
  assert.notEqual(a.operation.id, b.operation.id);
});
test("insufficient funds and another holder's account leave the ledger unchanged", () => {
  seedBank();
  setScenario('normal');
  const before = snapshot();
  assert.throws(() => transfer('bruno', 'foreign', input), /not authorized/);
  assert.throws(
    () => transfer('diego', 'low', { ...input, fromAccountId: 'acc-diego', amountCents: 10000 }),
    /Insufficient/,
  );
  assert.throws(() => transfer('marta', 'operator', input), /account holder/);
  assert.deepEqual(snapshot(), before);
});
test('non-integer amounts, negative amounts, and invalid destinations are rejected', () => {
  seedBank();
  setScenario('normal');
  const before = snapshot();
  for (const amountCents of [-1, 0, 0.5, Infinity, 10000001])
    assert.throws(() => transfer('lucia', 'invalid', { ...input, amountCents }));
  assert.throws(() => transfer('lucia', 'same', { ...input, toAccountId: 'acc-lucia' }));
  assert.deepEqual(snapshot(), before);
});
test('a failure before commit does not move money', () => {
  seedBank();
  setScenario('reject-before');
  const before = snapshot();
  assert.equal(transfer('lucia', 'reject', input).fault, 'reject-before');
  assert.deepEqual(snapshot(), before);
});
test('a lost response preserves a single queryable effect', () => {
  seedBank();
  setScenario('lost-response');
  const first = transfer('lucia', 'lost', input);
  assert.equal(first.fault, 'lost-response');
  assert.equal(operationByReference('lucia', 'lost')?.id, first.operation.id);
  assert.equal(operationByReference('bruno', 'lost'), undefined);
  assert.equal(transfer('lucia', 'lost', input).replay, true);
});
test('intermittent scenarios repeat with the same seed', () => {
  const run = () => {
    seedBank();
    setScenario('intermittent', 17);
    return Array.from({ length: 8 }, (_, i) => transfer('lucia', `sequence-${i}`, input).fault);
  };
  assert.deepEqual(run(), run());
  assert.ok(run().includes('lost-response'));
});
test('the application seed preserves reproducible histories and index', () => {
  const first = seedApp();
  assert.equal(first.indexLoaded, true);
  assert.equal(
    (appDb().prepare('SELECT COUNT(*) n FROM conversations').get() as { n: number }).n,
    47,
  );
  const histories = appDb().prepare('SELECT * FROM conversations ORDER BY id').all();
  const messages = appDb().prepare('SELECT * FROM messages ORDER BY id').all();
  assert.equal(first.incidents, 17);
  assert.equal(
    (
      appDb().prepare("SELECT COUNT(*) n FROM incidents WHERE status='closed'").get() as {
        n: number;
      }
    ).n,
    8,
  );
  assert.equal(
    (
      appDb()
        .prepare(
          'SELECT COUNT(*) n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id)',
        )
        .get() as { n: number }
    ).n,
    0,
  );
  const chunks = allChunks();
  assert.ok(chunks.length > 300);
  assert.ok(chunks.every((c) => c.vector?.length === 1536));
  seedApp();
  assert.deepEqual(allChunks(), chunks);
  assert.deepEqual(appDb().prepare('SELECT * FROM conversations ORDER BY id').all(), histories);
  assert.deepEqual(appDb().prepare('SELECT * FROM messages ORDER BY id').all(), messages);
});
test('the signed session determines the actor and rejects forged identities', () => {
  const req = (cookie: string) =>
    new Request('http://localhost/api', { headers: { cookie, 'x-user-id': 'bruno' } });
  assert.equal(actor(req(`banana_actor=${sessionToken('lucia')}`)).id, 'lucia');
  assert.throws(() => actor(req('banana_actor=bruno.invalid')));
  assert.throws(() => actor(req('')));
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request('http://localhost/api', {
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      }),
    ),
  );
  assert.throws(() =>
    sameOrigin(
      new Request('http://localhost/api', {
        headers: { host: '127.0.0.1:3000', origin: 'https://example.com' },
      }),
    ),
  );
});
test('corpus originals exist and have unique sources', () => {
  const docs = documents();
  assert.equal(docs.length, 80);
  assert.equal(new Set(docs.map((d) => d.id)).size, 80);
  assert.ok(docs.some((d) => d.audience === 'internal'));
  assert.ok(docs.some((d) => d.validTo));
  assert.ok(docs.every((d) => readDocument(d).length > 1000));
});
test('search without an API key returns actionable configuration guidance', async () => {
  seedApp();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ' ';
  try {
    const { POST } = await import('../app/api/[...path]/route');
    const response = await POST(
      new Request('http://localhost/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: `banana_actor=${sessionToken('lucia')}`,
        },
        body: JSON.stringify({ query: `configuration-check-${Date.now()}` }),
      }),
      { params: Promise.resolve({ path: ['search'] }) },
    );
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, 'missing_openai_api_key');
    assert.match(result.error, /OPENAI_API_KEY/);
    assert.match(result.error, /restart/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
after(() => {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
