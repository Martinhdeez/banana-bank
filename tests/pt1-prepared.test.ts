// PT1 (plan 25): prepared transfers. One check per real risk of a money path: preparing and
// sending move no money (only confirmApproval does); one proposal per occurrence however often
// Send is tapped; a new attempt only after one that ended with no money moved; an unknown outcome
// locks everything; monthly never doubles and never skips silently; re-validation at send time;
// customer-only. Simulator bank (or BANK_IMPL=alt), no model.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-pt1-');
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { seedApp } = await import('../src/seed');
const { changePrepared, preparedList, prepareTransfer, sendPrepared } =
  await import('../src/banking/prepared');
const { notifications } = await import('../src/notifications');
const { caseDetail } = await import('../src/operator/view');
const { operations, newConversation } = await import('./helpers/data');
const route = await import('../app/api/[...path]/route');
const { sessionToken } = await import('../src/auth');
let bank: ChildProcess;
before(async () => {
  seedApp();
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
async function api(userId: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object) {
  const response = await route[method](
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie: `banana_actor=${sessionToken(userId)}`,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
const ctx = (userId: string) => ({ userId, conversationId: null, runId: 'run', intentId: 'x' });
const at = (iso: string) => new Date(iso);
const count = (sql: string, ...args: unknown[]) =>
  (
    appDb()
      .prepare(`SELECT COUNT(*) n FROM ${sql}`)
      .get(...args) as { n: number }
  ).n;
const intentsOf = (id: string) => count('intents WHERE id LIKE ?', `prepared:${id}:%`);
const transfer = (from: string, to: string, extra: object = {}) => ({
  fromAccountId: `acc-${from}`,
  toAccountId: `acc-${to}`,
  amountCents: 1250,
  concept: 'Rent',
  when: 'manual',
  ...extra,
});
const prepare = async (userId: string, to: string, extra: object = {}, now?: Date) => {
  const result = await prepareTransfer(ctx(userId), transfer(userId, to, extra), now);
  assert.equal(result.status, 'prepared', JSON.stringify(result));
  return result.prepared as any;
};
const confirm = async (userId: string, approvalId: string) => {
  const { body } = await api(userId, 'POST', `approvals/${approvalId}/confirm`);
  assert.equal(body.status, 'completed');
};
const one = (userId: string, id: string, now?: Date) =>
  preparedList(userId, now).find((p) => p.id === id);

test('PT1 nothing moves until the confirmation; any number of sends is one proposal; a one-shot leaves the list', async () => {
  const sent = operations(),
    intents = count('intents');
  const { status, body } = await api('lucia', 'POST', 'prepared', {
    ...transfer('lucia', 'carla', { amountCents: undefined, amount: '12.50' }),
    note: 'when I get the keys',
  });
  assert.equal(status, 200);
  const id = body.prepared.id;
  assert.deepEqual(
    { ...body.prepared, id: 0 },
    {
      id: 0,
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-carla',
      to: 'Carla Ríos · Aurora account',
      amountCents: 1250,
      concept: 'Rent',
      note: 'when I get the keys',
      when: { kind: 'manual' },
      nextDue: null,
      state: 'ready',
      approvalId: null,
      expiresAt: null,
      lastAttempt: null,
      lastSentAt: null,
    },
  );
  assert.equal(count('intents'), intents);
  assert.deepEqual((await api('lucia', 'GET', 'dashboard')).body.prepared, [body.prepared]);
  // A double tap and two parallel requests.
  const sends = await Promise.all([1, 2, 3].map(() => api('lucia', 'POST', `prepared/${id}/send`)));
  sends.push(await api('lucia', 'POST', `prepared/${id}/send`));
  const approvalId = sends[0].body.approval.id;
  for (const s of sends) {
    assert.equal(s.body.status, 'requires_confirmation');
    assert.equal(s.body.approval.id, approvalId);
  }
  assert.equal(intentsOf(id), 1);
  assert.equal(count('approvals WHERE intent_id LIKE ?', `prepared:${id}:%`), 1);
  assert.equal(one('lucia', id)!.state, 'awaiting_confirmation');
  assert.equal(one('lucia', id)!.approvalId, approvalId);
  // With a proposal waiting it cannot be deleted from under it.
  const refused = await api('lucia', 'DELETE', `prepared/${id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'prepared_in_progress');
  assert.equal(operations(), sent, 'preparing and sending reached no transfer at the bank');
  await confirm('lucia', approvalId);
  assert.equal(operations(), sent + 1);
  for (let i = 0; i < 2; i++)
    assert.deepEqual((await api('lucia', 'GET', 'dashboard')).body.prepared, []);
  assert.equal(count("events WHERE kind='prepared.sent'"), 1);
  const again = await api('lucia', 'POST', `prepared/${id}/send`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'not_active');
  assert.equal(operations(), sent + 1);
  assert.equal(intentsOf(id), 1);
});

test('PT1 attempts: a new proposal only after an expired, cancelled or failed one; an unknown outcome locks send, skip, pause and delete', async () => {
  const sent = operations();
  const { id } = await prepare('bruno', 'carla');
  const send = async () => (await api('bruno', 'POST', `prepared/${id}/send`)).body;
  const first = await send();
  assert.equal(first.intentId, `prepared:${id}:once:1`);
  appDb()
    .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() - 1000).toISOString(), first.approval.id);
  assert.equal(one('bruno', id)!.lastAttempt, 'expired');
  assert.equal(one('bruno', id)!.state, 'ready');
  const [second, twin] = await Promise.all([send(), send()]);
  assert.equal(second.intentId, `prepared:${id}:once:2`);
  assert.equal(twin.approval.id, second.approval.id);
  await api('bruno', 'POST', `approvals/${second.approval.id}/cancel`);
  assert.equal(one('bruno', id)!.lastAttempt, 'cancelled');
  const third = await send();
  assert.equal(third.intentId, `prepared:${id}:once:3`);
  // The bank rejected it at execution, or a verification proved it absent: no money moved.
  appDb().prepare("UPDATE intents SET status='failed' WHERE id=?").run(third.intentId);
  appDb().prepare('UPDATE approvals SET consumed_at=? WHERE id=?').run('x', third.approval.id);
  assert.equal(one('bruno', id)!.lastAttempt, 'failed');
  const fourth = await send();
  assert.equal(fourth.intentId, `prepared:${id}:once:4`);
  assert.equal(intentsOf(id), 4);
  assert.equal(operations(), sent);
  // The confirm is in flight (approval consumed, intent not yet processing), then its outcome is
  // unknown (the response was lost): nothing can be sent again or changed.
  const lock = (intent: string, consumed: string | null) => {
    appDb().prepare(`UPDATE intents SET ${intent} WHERE id=?`).run(fourth.intentId);
    appDb()
      .prepare('UPDATE approvals SET consumed_at=? WHERE id=?')
      .run(consumed, fourth.approval.id);
  };
  lock("status='awaiting_confirmation'", new Date().toISOString());
  assert.equal(one('bruno', id)!.state, 'verifying');
  assert.equal((await send()).status, 'processing');
  lock("status='awaiting_confirmation'", null);
  await confirm('bruno', fourth.approval.id);
  assert.equal(operations(), sent + 1);
  lock("status='pending_verification',operation_id=NULL", new Date().toISOString());
  assert.equal(one('bruno', id)!.state, 'verifying');
  for (const [method, path] of [
    ['POST', 'skip'],
    ['POST', 'pause'],
    ['DELETE', ''],
  ] as const) {
    const r = await api('bruno', method, `prepared/${id}${path && `/${path}`}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'prepared_in_progress');
  }
  // Send answers the verified outcome of that attempt and creates nothing.
  assert.equal((await send()).status, 'completed');
  assert.equal(intentsOf(id), 4);
  assert.equal(one('bruno', id), undefined);
  assert.equal(operations(), sent + 1);
});

test('PT1 a send is validated now: balance and destination; a refusal writes no intent and leaves it due', async () => {
  const sent = operations();
  // More than the balance is accepted when preparing (the money has to be there when it is sent).
  const { id, state } = await prepare('diego', 'carla', {
    amountCents: 900000,
    when: 'on_date',
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()),
  });
  assert.equal(state, 'due');
  const send = async () => (await api('diego', 'POST', `prepared/${id}/send`)).body;
  const poor = await send();
  assert.equal(poor.status, 'failed');
  assert.equal(poor.code, 'insufficient_funds');
  assert.equal(intentsOf(id), 0);
  assert.equal(one('diego', id)!.state, 'due');
  bankDb().prepare("UPDATE accounts SET balanceCents=1000000 WHERE id='acc-diego'").run();
  const funded = await send();
  assert.equal(funded.status, 'requires_confirmation');
  await api('diego', 'POST', `approvals/${funded.approval.id}/cancel`);
  // The destination is no longer among the customer's contacts.
  appDb().prepare("UPDATE prepared_transfers SET to_account_id='acc-gone' WHERE id=?").run(id);
  const gone = await send();
  assert.equal(gone.status, 'failed');
  assert.equal(gone.code, 'invalid_destination');
  assert.equal(intentsOf(id), 1);
  assert.equal(one('diego', id)!.state, 'due');
  assert.equal(operations(), sent);
});

test('PT1 due rule: dates in Europe/Madrid, month ends, year change', async () => {
  const now = at('2026-10-15T10:00:00Z');
  const refused = async (extra: object) => {
    const r = await prepareTransfer(ctx('carla'), transfer('carla', 'lucia', extra), now);
    return r.code;
  };
  assert.equal(
    (await prepare('carla', 'lucia', { when: 'on_date', date: '2026-10-15' }, now)).state,
    'due',
  );
  assert.equal(await refused({ when: 'on_date', date: '2026-10-14' }), 'invalid_date');
  assert.equal(await refused({ when: 'on_date', date: '2027-10-17' }), 'invalid_date');
  assert.equal(await refused({ when: 'on_date', date: '2026-02-30' }), 'invalid_date');
  assert.equal(await refused({ when: 'on_date', inDays: 0 }), 'invalid_date');
  const week = await prepare('carla', 'lucia', { when: 'on_date', inDays: 7 }, now);
  assert.deepEqual([week.nextDue, week.state], ['2026-10-22', 'scheduled']);
  // Day 31 keeps its anchor: skipping walks the month ends and the year change.
  const last = await prepare('carla', 'lucia', { when: 'monthly', day: 31 }, now);
  const walk = [last.nextDue];
  for (let i = 0; i < 5; i++)
    walk.push((changePrepared(ctx('carla'), last.id, 'skip', now).prepared as any).nextDue);
  assert.deepEqual(walk, [
    '2026-10-31',
    '2026-11-30',
    '2026-12-31',
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
  ]);
  const leap = await prepare(
    'carla',
    'lucia',
    { when: 'monthly', day: 30 },
    at('2028-02-10T10:00:00Z'),
  );
  assert.equal(leap.nextDue, '2028-02-29');
  // Day 1, prepared on the 15th: next month. It turns due at midnight in Madrid, not in UTC.
  const first = await prepare('carla', 'lucia', { when: 'monthly', day: 1 }, now);
  assert.deepEqual([first.nextDue, first.state], ['2026-11-01', 'scheduled']);
  assert.equal(one('carla', first.id, at('2026-10-31T22:30:00Z'))!.state, 'scheduled');
  assert.equal(one('carla', first.id, at('2026-10-31T23:30:00Z'))!.state, 'due');
});

test('PT1 monthly: one open occurrence, a missed one stays due, never doubled, never skipped silently', async () => {
  const sent = operations();
  const { id } = await prepare(
    'elena',
    'lucia',
    { when: 'monthly', day: 1 },
    at('2026-10-15T10:00:00Z'),
  );
  const late = at('2027-01-10T10:00:00Z');
  const due = (now: Date) => {
    const p = one('elena', id, now)!;
    return [p.nextDue, p.state];
  };
  const pay = async () => {
    const r = await sendPrepared(ctx('elena'), id);
    assert.equal(r.status, 'requires_confirmation', JSON.stringify(r));
    await confirm('elena', (r.approval as any).id);
    return r.intentId;
  };
  // Two months late: one occurrence, the oldest. Its notification is the only one.
  assert.deepEqual(due(late), ['2026-11-01', 'due']);
  const bell = notifications('elena', at('2026-11-05T10:00:00Z')).items;
  assert.deepEqual(
    bell.filter((n) => n.kind === 'prepared_due').map((n) => [n.id, n.at, n.amountCents, n.to]),
    [[`prepared-due:${id}:2026-11-01`, '2026-11-01', 1250, 'Lucía Martín · Aurora account']],
  );
  assert.equal(await pay(), `prepared:${id}:2026-11-01:1`);
  // Sending right after a confirm closes that occurrence first and proposes the next one.
  assert.equal(await pay(), `prepared:${id}:2026-12-01:1`);
  assert.deepEqual(due(late), ['2027-01-01', 'due']);
  assert.equal(operations(), sent + 2);
  // "Send now" before the date pays the coming occurrence, once.
  const early = at('2026-12-20T10:00:00Z');
  assert.deepEqual(due(early), ['2027-01-01', 'scheduled']);
  assert.equal(await pay(), `prepared:${id}:2027-01-01:1`);
  assert.deepEqual(due(early), ['2027-02-01', 'scheduled']);
  // A pause and resume does not reopen the month already paid.
  assert.equal((changePrepared(ctx('elena'), id, 'pause', early).prepared as any).state, 'paused');
  assert.equal((await sendPrepared(ctx('elena'), id)).code, 'paused');
  assert.equal(notifications('elena', at('2027-06-10T10:00:00Z')).items.length, 0);
  assert.equal(
    (changePrepared(ctx('elena'), id, 'resume', early).prepared as any).nextDue,
    '2027-02-01',
  );
  // A skip moves one month and sends nothing; months missed while paused are dropped on resume.
  assert.equal(
    (changePrepared(ctx('elena'), id, 'skip', early).prepared as any).nextDue,
    '2027-03-01',
  );
  changePrepared(ctx('elena'), id, 'pause', early);
  const summer = at('2027-06-10T10:00:00Z');
  assert.deepEqual(due(summer), ['2027-03-01', 'paused']);
  assert.equal(
    (changePrepared(ctx('elena'), id, 'resume', summer).prepared as any).nextDue,
    '2027-07-01',
  );
  assert.equal(operations(), sent + 3);
  assert.equal(count("events WHERE kind='prepared.sent' AND user_id='elena'"), 3);
  assert.equal(count("events WHERE kind='prepared.skipped' AND user_id='elena'"), 1);
  const references = appDb()
    .prepare('SELECT DISTINCT bank_reference FROM intents WHERE id LIKE ?')
    .all(`prepared:${id}:%`);
  assert.equal(references.length, 3);
});

test('PT1 customer-only: another customer is a 404, an operator is refused, refusals write nothing', async () => {
  const { id } = await prepare('hugo', 'lucia');
  const rows = count('prepared_transfers');
  for (const [method, path] of [
    ['POST', `${id}/send`],
    ['POST', `${id}/skip`],
    ['POST', `${id}/pause`],
    ['POST', `${id}/resume`],
    ['DELETE', id],
  ] as const) {
    assert.equal((await api('ines', method, `prepared/${path}`)).status, 404);
    assert.equal((await api('marta', method, `prepared/${path}`)).status, 403);
  }
  assert.equal((await api('marta', 'POST', 'prepared', transfer('hugo', 'lucia'))).status, 403);
  assert.equal((await api('hugo', 'GET', 'prepared')).status, 405);
  assert.equal((await api('hugo', 'POST', `prepared/${id}/skip`)).body.code, 'not_monthly');
  const refusals: [object, string][] = [
    [{ when: 'someday' }, 'invalid_request'],
    [{ when: 'monthly', day: 32 }, 'invalid_request'],
    [{ note: 'x'.repeat(141) }, 'invalid_request'],
    [{ amountCents: 0 }, 'invalid_request'],
    [{ concept: ' ' }, 'invalid_request'],
    [{ when: 'on_date' }, 'invalid_date'],
    [{ toAccountId: 'acc-nobody' }, 'invalid_destination'],
    [{ toAccountId: null, recipient: 'Nobody' }, 'invalid_destination'],
    [{ toAccountId: 'acc-hugo' }, 'same_account'],
  ];
  for (const [extra, code] of refusals) {
    const { status, body } = await api(
      'hugo',
      'POST',
      'prepared',
      transfer('hugo', 'lucia', extra),
    );
    assert.deepEqual(
      [status, body.status, body.code],
      [200, 'failed', code],
      JSON.stringify(extra),
    );
    assert.match(body.error, /(No money moved|Nothing was sent)\.( Choose .*)?$/);
  }
  // Ines has two accounts and named none: asked, never chosen for her.
  const asked = await api(
    'ines',
    'POST',
    'prepared',
    transfer('ines', 'lucia', { fromAccountId: null }),
  );
  assert.equal(asked.body.status, 'needs_source_account');
  assert.equal(count('prepared_transfers'), rows);
  // Deleting is recorded and idempotent; the 21st active one is refused.
  assert.deepEqual((await api('hugo', 'DELETE', `prepared/${id}`)).body, { status: 'deleted' });
  assert.deepEqual((await api('hugo', 'DELETE', `prepared/${id}`)).body, { status: 'deleted' });
  assert.equal(count("events WHERE kind='prepared.deleted'"), 1);
  for (let i = 0; i < 20; i++) await prepare('hugo', 'lucia');
  const extra = await api('hugo', 'POST', 'prepared', transfer('hugo', 'lucia'));
  assert.deepEqual([extra.status, extra.body.code], [409, 'too_many']);
});

test('PT1 the operator reads the steps in words; rows survive a restart; a reset empties them', async () => {
  const conversationId = newConversation('omar');
  appDb()
    .prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)')
    .run('case-pt1', 'omar', conversationId, 'Rent', 'open', new Date().toISOString());
  const post = async (path: string, body: object = {}) =>
    (await api('omar', 'POST', path, { ...body, conversationId })).body;
  const keys = await post('prepared', {
    ...transfer('omar', 'lucia'),
    note: 'when I get the keys',
  });
  const monthly = await post('prepared', transfer('omar', 'lucia', { when: 'monthly', day: 1 }));
  const proposal = await post(`prepared/${keys.prepared.id}/send`);
  await confirm('omar', proposal.approval.id);
  assert.deepEqual(
    preparedList('omar').map((p) => p.id),
    [monthly.prepared.id],
  );
  const steps = ((await caseDetail('marta', 'case-pt1')) as any).runs
    .flatMap((r: any) => r.events)
    .map((e: any) => e.description);
  assert.deepEqual(
    steps.filter((s: string) => /prepared/i.test(s)),
    [
      'Customer prepared a transfer: €12.50 to Lucía Martín · Aurora account, to send when they decide — note: "when I get the keys". Nothing was sent',
      'Customer prepared a transfer: €12.50 to Lucía Martín · Aurora account, due every month on day 1. Nothing was sent',
      'Prepared transfer sent by the customer (transfer completed)',
    ],
  );
  closeAppDb();
  assert.equal(preparedList('omar').length, 1);
  seedApp();
  assert.equal(count('prepared_transfers'), 0);
});
after(() => {
  setScenario('intermittent', 17);
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
