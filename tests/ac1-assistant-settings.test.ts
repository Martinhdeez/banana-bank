// AC1: "What the assistant may do". GET / POST /api/assistant-settings, and the customer's
// product-suggestions switch held by the chat (src/agent/offers.ts). Scripted turns on the fake
// OpenAI server: no call reaches a provider. One check per risk.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-ac1-');
const { server, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { GET, POST, DELETE } = await import('../app/api/[...path]/route');
const { sessionToken } = await import('../src/auth');
const { config } = await import('../src/config');
const { offers } = await import('../src/offers/catalogue');
const { recordOffer } = await import('../src/offers/state');
const { prepareTransfer } = await import('../src/banking/prepared');
const { latestExtras } = await import('../src/agent/extras');
const { newConversation } = await import('./helpers/data');
seedApp();
const bank = await startSimulator();
after(() => {
  bank.kill();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Any = Record<string, any>;
// `user` null: no session.
async function api(
  user: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  route: string,
  body?: unknown,
) {
  const request = new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user && { cookie: `banana_actor=${sessionToken(user)}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await { GET, POST, DELETE }[method](request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
  return { status: response.status, body: (await response.json()) as Any };
}
const count = (sql: string, ...params: unknown[]) =>
  (
    appDb()
      .prepare(`SELECT COUNT(*) n FROM ${sql}`)
      .get(...params) as { n: number }
  ).n;
const ctx = (userId: string) => ({ userId, conversationId: null, runId: 'ac1', intentId: 'ac1' });
const POT = offers().find((o) => o.id === 'offer-savings-pot')!;
const KEY = 'COFFEE SHOP';

test('AC1: a customer reads their own rules and records, never another customer’s; a hand-set category survives the rule delete', async () => {
  // Lucía sets a movement by hand and asks for a rule; she declines a product and dismisses an
  // observation.
  const set = await api('lucia', 'POST', 'insights/categories', {
    movementIds: ['movement-lucia-3'],
    category: 'shopping',
    applyToSimilar: true,
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  recordOffer(ctx('lucia'), 'declined', POT.id, { name: POT.name });
  await api('lucia', 'POST', 'observations', { dismiss: 'category_up:groceries:2026-09' });

  const own = (await api('lucia', 'GET', 'assistant-settings')).body;
  assert.deepEqual(
    own.rules.map(({ createdAt, ...r }: Any) => (assert.ok(Date.parse(createdAt)), r)),
    [{ merchantKey: KEY, name: KEY, category: 'shopping', categoryLabel: 'Shopping' }],
  );
  assert.deepEqual(
    own.recorded.map(({ at, ...r }: Any) => (assert.ok(Date.parse(at)), r)),
    [
      { kind: 'observation_dismissed', text: 'You dismissed: Groceries is up' },
      { kind: 'suggestion_declined', text: `You declined: ${POT.name}` },
    ],
    'newest first, server text',
  );
  assert.deepEqual(own.suggestions, { enabled: true, changedAt: null, available: true });
  // The deployment has suggestions off (OFFERS=off): the body says so, the switch is unchanged.
  config.offers = 'off';
  try {
    const { suggestions, observations } = (await api('lucia', 'GET', 'assistant-settings')).body;
    assert.deepEqual(suggestions, { enabled: true, changedAt: null, available: false });
    assert.equal(observations.available, true);
  } finally {
    config.offers = 'on';
  }

  const other = (await api('bruno', 'GET', 'assistant-settings')).body;
  assert.deepEqual([other.rules, other.recorded], [[], []]);
  const foreign = await api('bruno', 'DELETE', `insights/rules/${encodeURIComponent(KEY)}`);
  assert.deepEqual(foreign.body, { removed: false, reclassified: 0 });
  assert.equal((await api('lucia', 'GET', 'assistant-settings')).body.rules.length, 1);

  // Her own delete removes the rule; the category she set by hand stays.
  const removed = await api('lucia', 'DELETE', `insights/rules/${encodeURIComponent(KEY)}`);
  assert.equal(removed.body.removed, true);
  const { movements } = (await api('lucia', 'GET', 'dashboard')).body;
  const { id, state, source } = movements.find((m: Any) => m.id === 'movement-lucia-3').category;
  assert.deepEqual({ id, state, source }, { id: 'shopping', state: 'confirmed', source: 'user' });
  assert.deepEqual((await api('lucia', 'GET', 'assistant-settings')).body.rules, []);
});

test('AC1: operator 403, no session 401, malformed body 400', async () => {
  for (const [method, body] of [['GET'], ['POST', { suggestions: false }]] as const) {
    assert.equal((await api('marta', method, 'assistant-settings', body)).status, 403);
    assert.equal((await api(null, method, 'assistant-settings', body)).status, 401);
  }
  for (const body of [{}, { suggestions: 'no' }, { observations: false, other: true }, []])
    assert.equal((await api('lucia', 'POST', 'assistant-settings', body)).status, 400);
  assert.equal(count("events WHERE kind LIKE 'offers.%' OR kind LIKE 'observations.%'"), 0);
});

test('AC1: observations off: the dashboard shows none; the switch answers its new state', async () => {
  // A prepared transfer of Hugo's for more than his balance: `prepared_uncovered`.
  const prepared = await prepareTransfer(ctx('hugo'), {
    fromAccountId: null,
    recipient: 'Lucia',
    toAccountId: null,
    amountCents: 5_000_000,
    concept: 'deposit',
    note: null,
    when: 'manual',
    date: null,
    inDays: null,
    day: null,
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  const shown = (await api('hugo', 'GET', 'dashboard')).body.observation;
  assert.equal(shown?.kind, 'prepared_uncovered');

  const off = await api('hugo', 'POST', 'assistant-settings', { observations: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.observations.enabled, false);
  assert.ok(Date.parse(off.body.observations.changedAt));
  assert.equal(off.body.suggestions.enabled, true);
  assert.equal((await api('hugo', 'GET', 'dashboard')).body.observation, null);

  const on = await api('hugo', 'POST', 'assistant-settings', { observations: true });
  assert.equal(on.body.observations.enabled, true);
  assert.equal((await api('hugo', 'GET', 'dashboard')).body.observation?.key, shown.key);
});

test('AC1: suggestions off: the sheet is still answered, but no interest is recorded, by tool or by a stale click', async () => {
  const conversationId = newConversation('hugo');
  const outputs = (b: ModelBody) =>
    b.input.filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output!));
  let seen: Any[] = [];
  const last = (b: ModelBody) => ((seen = outputs(b)), say('Done.'));
  async function turn(content: string, calls: ((b: ModelBody) => object)[]) {
    script.push(...calls, last);
    const post = await api('hugo', 'POST', `conversations/${conversationId}/messages`, { content });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    // The stored extras: `awaitingOffer` is server state and is not sent to the page.
    return latestExtras(conversationId) as Any | null;
  }
  const details = () => call('get_offer_details', { offerId: POT.id });
  const respond = (response: string) => () => call('offer_response', { offerId: POT.id, response });
  const interest = () => count("events WHERE user_id='hugo' AND kind='offer.interest'");
  const cases = () => count("incidents WHERE user_id='hugo' AND status='open'");
  const casesBefore = cases();

  // Suggestions on: the sheet leaves "Note my interest".
  const asked = await turn('Tell me about the Savings Pot', [details]);
  assert.equal(asked?.awaitingOffer?.offerId, POT.id);
  assert.ok(asked?.quickReplies.some((r: Any) => r.value === 'Note my interest'));

  // Turned off on the page; the reply of the older answer is clicked.
  const off = await api('hugo', 'POST', 'assistant-settings', { suggestions: false });
  assert.equal(off.body.suggestions.enabled, false);
  await turn('Note my interest', []);
  assert.deepEqual([interest(), cases()], [0, casesBefore], 'a stale click records nothing');

  // The model asks for the sheet and then tries to record interest.
  const extras = await turn('I want the Savings Pot', [details, respond('interested')]);
  assert.equal(seen[0].status, 'ok', 'the sheet is still answered (plan 24 D7)');
  assert.deepEqual(seen[1], { status: 'refused', reason: 'suggestions_off' });
  assert.deepEqual([interest(), cases()], [0, casesBefore]);
  assert.equal(extras?.awaitingOffer, undefined);
  assert.ok(!extras?.quickReplies?.some((r: Any) => r.value === 'Note my interest'));

  // A decline is still taken, and shows in what was recorded.
  await turn('Not for me', [respond('declined')]);
  assert.equal(seen[0].status, 'ok');
  const { recorded } = (await api('hugo', 'GET', 'assistant-settings')).body;
  assert.deepEqual(
    recorded.map((r: Any) => [r.kind, r.text]),
    [['suggestion_declined', `You declined: ${POT.name}`]],
  );
});
