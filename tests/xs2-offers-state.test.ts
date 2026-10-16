// XS2: offer state from events, the gate, interest as a support case (plan 24 §3, §5).
// REQ-XS-6 (one case per reason code), REQ-XS-7 (restart and reset), REQ-XS-8 (interest → case).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-xs2-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { config } = await import('../src/config');
const { caseDetail, filterInbox, inbox } = await import('../src/operator/view');
const { insightsTools } = await import('../src/agent/insights');
const { recordEvent } = await import('../src/telemetry');
const { offerGate, offerHistory, recordOffer, setOffersEnabled } =
  await import('../src/offers/state');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const USER = 'hugo';
const now = () => new Date().toISOString();
const ctx = (conversationId: string) => ({
  userId: USER,
  conversationId,
  runId: `run-${conversationId}`,
  intentId: '',
});
// A conversation that already has an answer: the gate's "second turn".
function conversation(id: string) {
  insert('conversations', { id, user_id: USER, title: 'Test', created_at: now() });
  for (const role of ['user', 'assistant'])
    insert('messages', {
      id: `${id}-${role}`,
      conversation_id: id,
      role,
      content: 'x',
      created_at: now(),
    });
  return id;
}
const intent = (status: 'failed' | 'processing', conversation_id: string) =>
  insert('intents', {
    id: `intent-${status}`,
    user_id: USER,
    conversation_id,
    payload: '{}',
    status,
    created_at: now(),
  });
type Turn = Parameters<typeof offerGate>[0];
// Each cause is applied to a clean second turn that the gate accepts; it may change the turn.
const CAUSES: Record<string, (c: string, turn: Turn) => unknown> = {
  off: () => (config.offers = 'off'),
  disabled: (c) => setOffersEnabled(ctx(c), false),
  first_turn: (c) =>
    appDb().prepare("DELETE FROM messages WHERE conversation_id=? AND role='assistant'").run(c),
  conversation_done: (c) => recordOffer(ctx(c), 'shown', 'offer-savings-pot', { basis: 'b' }),
  cooldown: (c, turn) => {
    recordOffer(ctx(conversation('conv-earlier')), 'shown', 'offer-savings-pot', { basis: 'b' });
    assert.deepEqual(offerGate(turn), { ok: true }, 'no cool-down with 0 days');
    config.offersCooldownDays = 7;
  },
  open_case: (c) =>
    insert('incidents', {
      id: 'case-xs2',
      user_id: USER,
      conversation_id: c,
      summary: 's',
      status: 'open',
      created_at: now(),
    }),
  'transfer_trouble (failed in this conversation)': (c) => intent('failed', c),
  'transfer_trouble (unsettled anywhere)': () => intent('processing', conversation('conv-other')),
  pending_approval: () =>
    insert('approvals', {
      id: 'approval-xs2',
      user_id: USER,
      intent_id: 'intent-x',
      payload: '{}',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  // Started before the turn's own run, which is the newest row and still running.
  failed_run: (c) =>
    appDb()
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)')
      .run('run-x', USER, c, '2026-10-01T00:00:00.000Z', 'failed', 'e'),
  'mid_flow (awaiting)': (_, turn) => (turn.awaiting = true),
  'mid_flow (attached)': (_, turn) => (turn.attached = true),
  problem: (_, turn) => (turn.content = 'There is an error with my card'),
};
for (const [name, cause] of Object.entries(CAUSES))
  test(`REQ-XS-6: offerGate refuses with ${name}, and accepts the same turn without it`, () => {
    seedApp();
    const c = conversation('conv-gate');
    // The turn's own run, still running: it never counts as the previous run.
    appDb()
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)')
      .run('run-now', USER, c, now(), 'running', null);
    const turn = {
      userId: USER,
      conversationId: c,
      content: 'What is my balance?',
      attached: false,
      awaiting: false,
    };
    try {
      assert.deepEqual(offerGate(turn), { ok: true });
      cause(c, turn);
      assert.deepEqual(offerGate(turn), { ok: false, reason: name.split(' ')[0] });
    } finally {
      Object.assign(config, { offers: 'on', offersCooldownDays: 0 });
    }
  });

test('REQ-XS-7: history survives a restart; seedApp leaves it empty and enabled', () => {
  seedApp();
  const c = ctx(conversation('conv-history'));
  recordOffer(c, 'shown', 'offer-savings-pot', { basis: 'b' });
  recordOffer(c, 'shown', 'offer-savings-pot', { basis: 'b' }); // once per customer, ever
  recordOffer(c, 'shown', 'offer-cloud-account', { basis: 'b' });
  setOffersEnabled(c, false);
  closeAppDb();
  const kept = offerHistory(USER);
  assert.deepEqual(kept.shown, ['offer-savings-pot', 'offer-cloud-account']);
  assert.match(kept.lastShownAt!, /^\d{4}-\d\d-\d\dT/);
  assert.equal(kept.disabled, true);
  setOffersEnabled(c, true);
  assert.equal(offerHistory(USER).disabled, false);
  seedApp();
  assert.deepEqual(offerHistory(USER), { shown: [], lastShownAt: null, disabled: false });
});

test('REQ-XS-8: interest opens one case, reuses the open one, is idempotent, and reads in words', async () => {
  seedApp();
  const c = ctx(conversation('conv-interest'));
  const cases = () =>
    appDb()
      .prepare('SELECT id,summary,status FROM incidents WHERE conversation_id=?')
      .all(c.conversationId);
  recordOffer(c, 'shown', 'offer-savings-pot', {
    name: 'Savings Pot',
    basis: 'No savings account.',
  });
  const first = recordOffer(c, 'interest', 'offer-savings-pot', { name: 'Savings Pot' });
  assert.deepEqual(cases(), [
    {
      id: first.incidentId,
      summary:
        'Product interest: Savings Pot. The customer asked to be contacted by a manager. Nothing was contracted.',
      status: 'open',
    },
  ]);
  // Idempotent: same result, no second case, no second event.
  assert.deepEqual(recordOffer(c, 'interest', 'offer-savings-pot', { name: 'Savings Pot' }), first);
  // Another offer in the same conversation joins the open case.
  const second = recordOffer(c, 'interest', 'offer-cloud-account', { name: 'Cloud account' });
  assert.equal(second.incidentId, first.incidentId);
  assert.equal(cases().length, 1);
  recordOffer(c, 'declined', 'offer-round-ups', { name: 'Round-ups' });
  setOffersEnabled(c, false);
  setOffersEnabled(c, false); // already off: nothing recorded
  setOffersEnabled(c, true);

  // What GET /api/incidents?q=product interest lists (the route's filter, OPX3).
  const found = filterInbox(inbox(), { q: 'product interest' });
  assert.deepEqual(
    found.map((i) => i.id),
    [first.incidentId],
  );
  const detail = (await caseDetail('marta', first.incidentId!)) as any;
  assert.deepEqual(
    detail.events.map((e: { description: string }) => e.description),
    [
      'Product suggestion shown: Savings Pot — No savings account.',
      'Interest noted for Savings Pot; nothing was contracted',
      'Interest noted for Cloud account; nothing was contracted',
      'Suggestion declined: Round-ups',
      'Customer turned product suggestions off',
      'Customer turned product suggestions on',
    ],
  );
  // XS5: the operator reads every spending tool in words, never its raw name.
  for (const tool of Object.keys(insightsTools)) recordEvent(c, 'tool.started', { tool });
  const steps = ((await caseDetail('marta', first.incidentId!)) as any).events
    .slice(-Object.keys(insightsTools).length)
    .map((e: { description: string }) => e.description);
  assert.equal(steps[0], 'Spending summary started');
  for (const step of steps) assert.doesNotMatch(step, /_/);
});
