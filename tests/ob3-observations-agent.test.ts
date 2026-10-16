// OB3 — plan 26 §5, REQ-OB-12…14: spending observations in a chat turn. Scripted turns on the
// fake OpenAI server (no paid call), the demo bank, DECIDER=none, and a date passed in (never the
// real one: `category_up` depends on it). Hugo holds one Horizon account with more than €3,000
// (the server would suggest offer-savings-pot on a second turn); Bruno has `category_up` for
// Eating out & leisure at 2026-10-04, a product signal and movements to review.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';
import { callApi, setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-ob3-');
Object.assign(process.env, {
  DECIDER: 'none',
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { bankView } = await import('../src/banking/view');
const { prepareTransfer } = await import('../src/banking/prepared');
const { saveExtras } = await import('../src/agent/extras');
const { reviewNudge } = await import('../src/agent/insights');
const { clock, observationInstructions } = await import('../src/agent/observations');
const { runTool, toolDefinitions } = await import('../src/agent/tools');
const { pickObservation } = await import('../src/observations/detect');
const { classifyMovements } = await import('../src/insights/classify');
const { fingerprint, saveCategories } = await import('../src/insights/store');
const { newConversation } = await import('./helpers/data');
const bank = await startSimulator('alt');
const TODAY = '2026-10-04';
clock.today = () => TODAY;
after(() => {
  bank.kill();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Any = Record<string, any>;
const bankPaths: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(process.env.BANK_URL!)) bankPaths.push(new URL(url).pathname);
  return realFetch(input, init);
};
const BLOCK = /SPENDING OBSERVATION/;
const events = (kind: string) =>
  (appDb().prepare('SELECT data FROM events WHERE kind=?').all(kind) as { data: string }[]).map(
    (e) => JSON.parse(e.data) as Any,
  );
const outputs = (b: ModelBody) =>
  b.input.filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output!));
const ctx = (userId: string, conversationId: string | null = null) => ({
  userId,
  conversationId,
  runId: 'run-ob3',
  intentId: `ob3-${Math.random()}`,
});
// One turn through the HTTP route: the stored assistant message, every model request of the turn
// and the bank paths it requested.
async function turn(
  user: string,
  conversationId: string,
  content: string,
  calls: ((b: ModelBody) => object)[] = [],
) {
  script.push(...calls);
  const before = modelRequests.length;
  bankPaths.length = 0;
  const post = await callApi(user, `conversations/${conversationId}/messages`, { content });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const { messages } = (await callApi(user, `conversations/${conversationId}`)).body;
  const requests = modelRequests.slice(before);
  return {
    message: messages.at(-1) as { content: string; extras: Any | null },
    requests,
    instructions: requests.at(-1)!.instructions,
    outputs: outputs(requests.at(-1)!),
    paths: [...bankPaths].sort(),
  };
}
// A prepared transfer of Hugo's for more than his balance: `prepared_uncovered`.
const AMOUNT = 5_000_000;
async function uncovered(concept = 'ZZCONCEPT deposit') {
  const result = await prepareTransfer(ctx('hugo'), {
    fromAccountId: null,
    recipient: 'Lucia',
    toAccountId: null,
    amountCents: AMOUNT,
    concept,
    note: 'ZZNOTE when the notary calls',
    when: 'manual',
    date: null,
    inDays: null,
    day: null,
  });
  assert.equal(result.status, 'prepared', JSON.stringify(result));
}
const observe = () => call('get_spending_observation', {});
const tell = (b: ModelBody) => say(outputs(b).at(-1).observation.basis);
const summary = () => call('get_spending_summary', { from: null, to: null });
const labels = (m: { extras: Any | null }) => m.extras?.quickReplies?.map((r: Any) => r.label);

test('REQ-OB-12, 13a, 13d prepared_uncovered: the block holds the kind only, wins over the suggestion, is told once', async () => {
  seedApp();
  const QUESTION = 'How am I doing?';
  const control = await turn('hugo', newConversation('hugo'), QUESTION);
  assert.doesNotMatch(control.instructions, BLOCK);
  await uncovered();

  // REQ-OB-12: the same turn with an observation pending differs by the block, and the block is
  // a function of the kind: no figure, balance, name, note or concept.
  const conversationId = newConversation('hugo');
  const first = await turn('hugo', conversationId, QUESTION);
  const block = observationInstructions('prepared_uncovered');
  assert.equal(
    first.instructions,
    control.instructions.slice(0, -reviewNudge.ask.length) + block,
    'the instructions gain the block and nothing else',
  );
  assert.match(block, /Kind: prepared_uncovered\./);
  assert.doesNotMatch(block, /\d/);
  assert.deepEqual(events('observation.told'), [], 'the model did not call the tool: not told');

  // REQ-OB-13a: on a second turn the server would choose a product for Hugo (xs3); not now.
  const told = await turn('hugo', conversationId, 'Which accounts do I have?', [observe, tell]);
  for (const r of told.requests) {
    assert.match(r.instructions, BLOCK);
    assert.doesNotMatch(r.instructions, /PRODUCT SUGGESTION|offer to review them/);
    assert.doesNotMatch(r.instructions, /50,000|ZZNOTE|ZZCONCEPT/);
  }
  const view = await bankView('hugo');
  const [account] = view.accounts as Any[];
  const balance = `€${(account.balanceCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const basis = `Your prepared transfer of €50,000.00 to Lucía Martín · Aurora account (ready to send) is more than the ${balance} in your Horizon account today.`;
  assert.deepEqual(told.outputs.at(-1).observation, {
    kind: 'prepared_uncovered',
    title: 'A prepared transfer is not covered',
    basis,
    movements: [],
  });
  assert.equal(told.message.content, basis, 'the figures of the answer are the tool result');
  assert.equal(told.message.extras, null, 'no suggestion, no replies');
  assert.deepEqual(
    events('observation.told').map((e) => [e.kind, e.basis]),
    [['prepared_uncovered', basis]],
  );

  // REQ-OB-13d: a second observation is pending, and the conversation was told one: no block.
  // The product suggestion is back in its place.
  await uncovered('second');
  const later = await turn('hugo', conversationId, 'And my accounts again?');
  assert.doesNotMatch(later.instructions, BLOCK);
  assert.match(later.instructions, /PRODUCT SUGGESTION/);
  // Asked for, the customer gets the one not yet told; then, with none left, a told one again.
  for (const expected of [2, 2]) {
    const asked = await turn('hugo', conversationId, 'Anything else worth a look?', [
      observe,
      tell,
    ]);
    assert.equal(asked.outputs.at(-1).observation.kind, 'prepared_uncovered');
    assert.equal(asked.message.extras, null);
    assert.equal(events('observation.told').length, expected);
  }
});

test('REQ-OB-12, 13b, 13c category_up: the suggestion wins on the second turn; asked for, it is told with its movements and no nudge', async () => {
  seedApp();
  const conversationId = newConversation('bruno');
  const b = (content: string, calls: ((b: ModelBody) => object)[] = []) =>
    turn('bruno', conversationId, content, calls);
  // Precedence 3: movements to review and the nudge not made yet: the observation waits.
  const first = await b('Hello');
  assert.doesNotMatch(first.instructions, BLOCK);
  assert.match(first.instructions, /offer to review them/);

  // REQ-OB-13b: the suggestion as in REQ-XS-26, and no observation block.
  const SPENT = 'You spent €99.10 on restaurants and leisure.';
  const card = '[offer-cashback-card] A suggestion: the Cashback debit card may fit your spending.';
  const second = await b('How much did I spend on restaurants and leisure?', [
    summary,
    () => say(`${SPENT}\n\n${card}`),
  ]);
  assert.match(second.instructions, /PRODUCT SUGGESTION/);
  assert.doesNotMatch(second.instructions, BLOCK);
  assert.equal(second.message.extras?.offer?.id, 'offer-cashback-card');
  assert.deepEqual(events('observation.told'), []);

  // REQ-OB-13c, 12: the customer asks; the turn also read a summary with movements to review.
  const asked = await b('What stands out?', [
    summary,
    observe,
    (body) => {
      const o = outputs(body).at(-1).observation;
      return say(`${o.basis} [${o.movements.map((m: Any) => m.ref).join(', ')}]`);
    },
  ]);
  const o = asked.outputs.at(-1).observation;
  assert.equal(o.kind, 'category_up');
  assert.match(
    o.basis,
    /^Eating out & leisure: €59\.90 in September \(3 payments\), €39\.20 in August \(2\)\./,
  );
  assert.equal(asked.message.content, o.basis, 'the figures are the tool result; refs are cut');
  assert.equal(o.movements.length, 5);
  assert.deepEqual(
    asked.message.extras!.citedMovements.map((m: Any) => m.amountCents),
    o.movements.map((m: Any) => m.amountCents),
    'the cited movements are the ones behind the figure',
  );
  assert.equal(
    o.movements.reduce((sum: number, m: Any) => sum - m.amountCents, 0),
    5990 + 3920,
  );
  assert.equal(asked.message.extras!.offer, undefined);
  assert.equal(asked.message.extras!.quickReplies, undefined, 'no review nudge on this turn');
  for (const r of asked.requests) assert.doesNotMatch(r.instructions, /59\.90|39\.20/);
  assert.deepEqual(
    events('observation.told').map((e) => e.kind),
    ['category_up'],
  );
  // The nudge was not used up: the next spending turn carries it.
  const next = await b('And in total?', [summary]);
  assert.deepEqual(labels(next.message), ['Review them', 'Not now']);
});

test('REQ-OB-13 the review nudge comes before category_up; once it was made, the block follows it', async () => {
  config.offers = 'off';
  try {
    seedApp();
    const conversationId = newConversation('bruno');
    const nudge = await turn('bruno', conversationId, 'How much did I spend?', [summary]);
    for (const r of nudge.requests) assert.doesNotMatch(r.instructions, BLOCK);
    assert.deepEqual(labels(nudge.message), ['Review them', 'Not now']);
    const next = await turn('bruno', conversationId, 'And on groceries?', [summary]);
    assert.ok(
      next.instructions.endsWith(reviewNudge.done + observationInstructions('category_up')),
    );
    assert.equal(next.message.extras?.quickReplies, undefined);
    // The date decides: in November the seeded months are no longer the last two full ones.
    clock.today = () => '2026-11-04';
    const november = await turn('bruno', newConversation('bruno'), 'And on transport?', [summary]);
    for (const r of november.requests) assert.doesNotMatch(r.instructions, BLOCK);
  } finally {
    clock.today = () => TODAY;
    config.offers = 'on';
  }
});

test('REQ-OB-14 no block in a turn in trouble; the tool returns null when the gate refuses; a plain turn makes 2 bank requests', async () => {
  const db = appDb();
  const lastMessage = (conversationId: string) =>
    db
      .prepare("SELECT id FROM messages WHERE conversation_id=? AND role='assistant'")
      .pluck()
      .get(conversationId) as string;
  const openCase = (conversationId: string) =>
    db
      .prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)')
      .run(
        `inc-${conversationId}`,
        'hugo',
        conversationId,
        'OB3',
        'open',
        new Date().toISOString(),
      );
  const cases: Record<string, [(conversationId: string) => unknown, string]> = {
    'an open case': [openCase, 'Which accounts do I have?'],
    'a failed previous run': [
      (c) => db.prepare("UPDATE runs SET status='failed' WHERE conversation_id=?").run(c),
      'Which accounts do I have?',
    ],
    'an awaited answer': [
      (c) => saveExtras(lastMessage(c), { awaiting: { movementIds: ['x'], merchantKey: 'X' } }),
      'Which accounts do I have?',
    ],
    'a problem word': [() => {}, 'There is an error with my accounts'],
  };
  for (const [name, [cause, content]] of Object.entries(cases)) {
    seedApp();
    await uncovered();
    const conversationId = newConversation('hugo');
    const calm = await turn('hugo', conversationId, 'Hello');
    assert.match(calm.instructions, BLOCK, `${name}: the block is there before the cause`);
    cause(conversationId);
    const t = await turn('hugo', conversationId, content);
    assert.doesNotMatch(t.instructions, BLOCK, name);
    assert.equal(t.message.content, 'OK.', name);
  }

  // The gate: a case opened now, then the customer's own switch (chat only, through the tool).
  seedApp();
  await uncovered();
  const conversationId = newConversation('hugo');
  const get = async () =>
    (await runTool('get_spending_observation', {}, ctx('hugo', conversationId))) as Any;
  assert.equal((await get()).observation.kind, 'prepared_uncovered');
  openCase('elsewhere');
  assert.deepEqual([(await get()).status, (await get()).observation], ['ok', null]);
  db.prepare('DELETE FROM incidents').run();
  const off = await turn('hugo', conversationId, 'Stop telling me these', [
    () => call('set_spending_observations', { enabled: false }),
  ]);
  assert.deepEqual(off.outputs.at(-1), { status: 'ok', enabled: false });
  assert.equal(events('observations.disabled').length, 1);
  assert.equal((await get()).observation, null);
  assert.doesNotMatch((await turn('hugo', conversationId, 'Hi')).instructions, BLOCK);
  await runTool('set_spending_observations', { enabled: true }, ctx('hugo', conversationId));
  assert.equal((await get()).observation.kind, 'prepared_uncovered');
  assert.deepEqual(
    events('observation.told'),
    [],
    'a tool call outside an answered turn tells nothing',
  );

  // A plain turn: the app holds no movement to review for Hugo, so the turn reads accounts and
  // contacts only, and the observation is still found (from the accounts and the app database).
  db.prepare("UPDATE movement_categories SET state='confirmed' WHERE user_id='hugo'").run();
  const plain = await turn('hugo', newConversation('hugo'), 'What does my account cost?');
  assert.deepEqual(plain.paths, ['/v1/accounts', '/v1/contacts']);
  assert.match(plain.instructions, /Kind: prepared_uncovered\./);
});

test('OB3 both tools are strict and chat only; an error in the observation path keeps the answer', async () => {
  seedApp();
  for (const name of ['get_spending_observation', 'set_spending_observations']) {
    assert.equal(toolDefinitions.find((t) => t.name === name)?.strict, true, name);
    const api = await callApi('hugo', 'actions', { name, arguments: { enabled: false } });
    assert.equal(api.status, 400, name);
  }
  assert.deepEqual(events('observations.disabled'), []);
  const bad = (await runTool('get_spending_observation', { key: 'x' }, ctx('hugo'))) as Any;
  assert.deepEqual([bad.status, bad.code], ['failed', 'invalid_request']);

  await uncovered();
  clock.today = () => {
    throw new Error('ZZ clock');
  };
  try {
    const t = await turn('hugo', newConversation('hugo'), 'How am I doing?', [
      observe,
      () => say('I could not look at that right now.'),
    ]);
    for (const r of t.requests) assert.doesNotMatch(r.instructions, BLOCK);
    assert.equal(t.outputs.at(-1).status, 'failed');
    assert.equal(t.message.content, 'I could not look at that right now.');
    assert.deepEqual(events('observation.told'), []);
  } finally {
    clock.today = () => TODAY;
  }
});

// Review of #140: `observed` was kept for the rest of the turn, so trouble that arose inside it
// (plan 26 D7) still left the block in the next model request, and a model that followed it told
// an observation right after a tool that failed.
test('OB3 trouble that arises inside the turn takes the block away from the next model request', async () => {
  const steps: Record<string, () => object> = {
    'a failed tool': () => call('get_spending_summary', { from: 'nonsense', to: null }),
    'a transfer tool': () =>
      call('transfer_money', {
        fromAccountId: null,
        recipient: 'Lucia',
        toAccountId: null,
        amountCents: 500,
        concept: 'Lunch',
        secondTransfer: null,
        replacesApprovalId: null,
      }),
    'a request for a person': () => call('request_human', { summary: 'Wants a person' }),
  };
  for (const [name, step] of Object.entries(steps)) {
    seedApp();
    await uncovered();
    // The model does what the block asks: it calls the tool only when it is given the block.
    const t = await turn('hugo', newConversation('hugo'), 'Which accounts do I have?', [
      step,
      (b) => (BLOCK.test(b.instructions) ? observe() : say('Done.')),
    ]);
    assert.match(t.requests[0].instructions, BLOCK, `${name}: the block is there before the tool`);
    assert.doesNotMatch(t.requests[1].instructions, BLOCK, name);
    assert.equal(t.message.content, 'Done.', name);
    assert.deepEqual(events('observation.told'), [], name);
  }
});

// OB4: measured live with a decider on, the Overview said "1 movement … still to review" and the
// chat said 9 for Bruno in the same minute. The states a decider leaves are built through the
// store and the pipeline: no model is called.
test('OB4 category_up: the chat tool and the dashboard state the same count of movements not in the figures, with a decider off, mid-run or done', async () => {
  seedApp();
  const first = await bankView('bruno'); // DECIDER=none: what no rule decides is in review
  const own = new Set(first.accounts.map((a) => a.id));
  // What GET /api/dashboard passes to currentObservation, with the day passed in.
  const dashboard = (categories: (typeof first)['categories']) =>
    pickObservation(
      {
        accounts: first.accounts as never,
        view: { movements: first.movements, categories },
        prepared: [],
        today: TODAY,
      },
      [],
    )!.basis;
  const tool = async () =>
    ((await runTool('get_spending_observation', {}, ctx('bruno'))) as Any).observation.basis;
  const off = dashboard(first.categories);
  assert.match(
    off,
    // CAT1: 5, not 9: ADOBE and CUOTA AUTONOMOS TGSS are Work & projects by rule.
    / 5 movements of those months are not classified by a rule or by you and are not in these figures\.$/,
  );
  assert.equal(await tool(), off, 'decider off');

  // What a decider is asked about (a movement with no merchant in its text stays in review).
  const asked = first.movements.filter((m) => first.categories.get(m.id)!.reason === 'no_decider');
  const [kept, ...rest] = asked;
  assert.ok(rest.length > 1);

  // Mid-run: a decider that has not answered yet. Every movement it was asked about is pending.
  const midRun = await classifyMovements({
    userId: 'bruno',
    movements: first.movements,
    ownAccountIds: own,
    deciders: [{ id: 'openai', threshold: 0.8, classify: () => new Promise(() => {}) }],
  });
  assert.equal([...midRun.values()].filter((c) => c.state === 'pending').length, asked.length);
  assert.equal(dashboard(midRun), off, 'mid-run');

  // Done: the decider estimated all of them but one, which stays in review.
  saveCategories(
    'bruno',
    rest.map((m) => ({
      ...first.categories.get(m.id)!,
      movementId: m.id,
      fingerprint: fingerprint(m),
      id: 'shopping' as const,
      state: 'estimated' as const,
      source: 'model' as const,
      reason: 'model',
      confidence: 0.9,
      threshold: 0.8,
      model: 'openai:made-up',
      updatedAt: new Date().toISOString(),
    })),
  );
  const done = (await bankView('bruno')).categories;
  assert.equal(done.get(kept.id)!.state, 'needs_review');
  assert.equal([...done.values()].filter((c) => c.source === 'model').length, rest.length);
  assert.equal(dashboard(done), off, 'done');
  assert.equal(await tool(), off, 'the chat tool after the decider');
});
