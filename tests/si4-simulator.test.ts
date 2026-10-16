// SI4: account facts on the default bank (contracts.md 2.6: `savings_internal` comes only from
// facts, never from wording). The simulator, DECIDER=none (the setupEnv default), no model.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-si4-sim-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { classifyMovements } = await import('../src/insights/classify');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator('simulator');
  setScenario('normal');
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('SI4 simulator: a transfer to the own savings account is savings_internal on both legs', async () => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-lucia-savings',
      amountCents: 4200,
      concept: 'September salary groceries', // wording must not win over the account fact
    },
  });
  const done = await callApi('lucia', `approvals/${body.approval.id}/confirm`, {});
  assert.equal(done.body.status, 'completed');

  const dashboard = (await callApi('lucia', 'dashboard')).body;
  const legs = dashboard.movements.filter((m: any) => Math.abs(m.amountCents) === 4200);
  assert.deepEqual(legs.map((m: any) => m.accountId).sort(), ['acc-lucia', 'acc-lucia-savings']);
  for (const leg of legs)
    assert.deepEqual(
      [leg.category.id, leg.category.state, leg.category.source, leg.category.reason],
      ['savings_internal', 'estimated', 'rule', 'own_account'],
    );
  // Neither leg is spend or income.
  assert.equal(
    dashboard.insights.categories.some((c: any) => c.id === 'savings_internal'),
    false,
  );

  // The same two legs as a bank that is not this app's would show them: no app record, only the
  // shared operation id on two own accounts.
  const bare = legs.map(({ id, accountId, amountCents, createdAt, operationId }: any) => ({
    id,
    accountId,
    amountCents,
    description: 'Monthly saving',
    createdAt,
    operationId,
  }));
  const own = new Set<string>(dashboard.accounts.map((a: any) => a.id));
  const result = await classifyMovements({ userId: 'probe', movements: bare, ownAccountIds: own });
  for (const leg of bare) assert.equal(result.get(leg.id)!.reason, 'own_account');
  // One leg alone, same wording, no fact: not savings.
  const alone = await classifyMovements({
    userId: 'probe-2',
    movements: bare.slice(0, 1),
    ownAccountIds: own,
  });
  assert.notEqual(alone.get(bare[0].id)!.id, 'savings_internal');
});

test('SI4 simulator: `Transfer to external savings` is not decided by its wording', async () => {
  const { movements, insights } = (await callApi('diego', 'dashboard')).body;
  const row = movements.find((m: any) => m.description === 'Transfer to external savings');
  assert.deepEqual(
    [row.category.id, row.category.state, row.category.source, row.category.reason],
    ['other', 'needs_review', 'none', 'no_decider'],
  );
  assert.ok(row.category.candidates.length > 0);
  for (const c of row.category.candidates) assert.equal(c.p, null);
  assert.ok(insights.unresolved.groups.some((g: any) => g.movementIds.includes(row.id)));
  // Every other seed row of the customer is decided by a rule.
  for (const m of movements.filter((x: any) => x !== row))
    assert.deepEqual([m.category.state, m.category.source], ['estimated', 'rule'], m.description);
});
