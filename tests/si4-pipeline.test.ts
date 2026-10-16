// SI4: the classification pipeline behind classifyMovements, and the spending summary. Fake
// deciders and an injected clock: no bank, no network, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';
import type { CategoryId, MovementInput } from '../src/insights/taxonomy';
import type { Decider, Decision, DecisionItem } from '../src/insights/decider';
const { temp } = await setupEnv('banana-si4-');
const { appDb, closeAppDb } = await import('../src/db');
const store = await import('../src/insights/store');
const { DeciderError } = await import('../src/insights/decider');
const { classifyMovements, resolveDecision, merchantProfile } =
  await import('../src/insights/classify');
const { spendingSummary } = await import('../src/insights/summary');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const OWN = new Set(['acc-a', 'acc-a-savings']);
let seq = 0;
const movement = (description: string, over: Partial<MovementInput> = {}): MovementInput => ({
  id: `m-${++seq}`,
  accountId: 'acc-a',
  amountCents: -1250,
  description,
  createdAt: '2026-09-16T10:00:00.000Z', // a Wednesday, 12:00 in Madrid
  ...over,
});
let users = 0;
const user = () => `user-${++users}`; // each test has its own customer, so its own stored rows
const answer = (category: CategoryId, confidence: number, rest: CategoryId[] = []): Decision => ({
  candidates: [
    { category, p: confidence },
    ...rest.map((c) => ({ category: c, p: (1 - confidence) / (rest.length || 1) })),
  ],
  confidence,
  model: 'fake-1',
});
function fake(
  reply: (item: DecisionItem) => Decision | Promise<Decision>,
  over: Partial<Decider> = {},
) {
  const calls: DecisionItem[] = [];
  const decider: Decider = {
    id: 'systemone',
    threshold: 0.8,
    classify: async (item) => {
      calls.push(item);
      return reply(item);
    },
    ...over,
  };
  return { decider, calls };
}
// A decider that does not answer until released. Each test releases its own: an answer that
// never comes would keep one of the 8 in-flight slots for the rest of the file.
function hang() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    ...fake(async () => {
      await gate;
      return answer('health', 0.9);
    }),
    release,
  };
}
const failing = () =>
  fake(() => {
    throw new DeciderError(true, 529);
  });
const classify = (
  userId: string,
  movements: MovementInput[],
  deciders: Decider[],
  rest: { wait?: boolean; profile?: boolean } = { wait: true },
  now?: () => Date,
) => classifyMovements({ userId, movements, ownAccountIds: OWN, deciders, ...rest }, now);

test('SI4 resolveDecision: the threshold, `other`, the sign rule and unusable answers', () => {
  const at = resolveDecision(answer('health', 0.8, ['shopping']), 0.8, 'debit');
  assert.deepEqual(
    { id: at.id, state: at.state, reason: at.reason, confidence: at.confidence, bar: at.threshold },
    { id: 'health', state: 'estimated', reason: 'model', confidence: 0.8, bar: 0.8 },
  );
  assert.equal(at.candidates[0].category, 'health');

  const below = resolveDecision(answer('health', 0.79, ['shopping']), 0.8, 'debit');
  assert.deepEqual(
    [below.id, below.state, below.reason],
    ['other', 'needs_review', 'below_threshold'],
  );
  assert.deepEqual(
    below.candidates.map((c) => c.category),
    ['health', 'shopping'],
  );

  const other = resolveDecision(answer('other', 0.99, ['health']), 0.8, 'debit');
  assert.deepEqual(
    [other.id, other.state, other.reason],
    ['other', 'needs_review', 'below_threshold'],
  );

  // A credit answered transfer_person: to review, the forbidden candidate dropped.
  const credit = resolveDecision(answer('transfer_person', 0.95, ['shopping']), 0.8, 'credit');
  assert.deepEqual([credit.id, credit.state], ['other', 'needs_review']);
  assert.deepEqual(
    credit.candidates.map((c) => c.category),
    ['shopping'],
  );

  // candidates[0] is the provider's choice even when another p is higher.
  const contradicted = resolveDecision(
    {
      candidates: [
        { category: 'health', p: 0.3 },
        { category: 'shopping', p: 0.7 },
      ],
      confidence: 0.9,
      model: 'x',
    },
    0.8,
    'debit',
  );
  assert.equal(contradicted.id, 'health');

  // What the tables do not constrain: a confidence outside 0..1, a category no model may give.
  for (const confidence of [Number.NaN, 1.5, -1, Infinity])
    assert.equal(
      resolveDecision({ ...answer('health', 0.9), confidence }, 0.8, 'debit').state,
      'needs_review',
    );
  const income = resolveDecision(answer('income', 0.99, ['health']), 0.8, 'credit');
  assert.deepEqual([income.id, income.state], ['other', 'needs_review']);
  assert.deepEqual(
    income.candidates.map((c) => c.category),
    ['health'],
  );
  const many = resolveDecision(
    answer('health', 0.9, ['shopping', 'transport', 'groceries']),
    0.8,
    'debit',
  );
  assert.equal(many.candidates.length, 3);
  assert.equal(
    resolveDecision({ candidates: [], confidence: 1, model: 'x' }, 0.8, 'debit').id,
    'other',
  );
});

test('SI4 merchantProfile: majorities, occurrences, and a date a bank got wrong', () => {
  const at = (createdAt: string, amountCents = -1800) =>
    movement('LA ESQUINA', { createdAt, amountCents });
  // Saturday 01:30, Sunday 02:10, Saturday 00:45 in Madrid (UTC+2).
  assert.deepEqual(
    merchantProfile([
      at('2026-09-04T23:30:00.000Z', -1400),
      at('2026-09-06T00:10:00.000Z', -2100),
      at('2026-09-11T22:45:00.000Z', -1700),
    ]),
    {
      typical_time: 'late_night',
      typical_day: 'weekend',
      typical_amount: 'medium',
      occurrences: 'few',
    },
  );
  // 2 of 3 is a majority, 1 of 2 is not.
  const twoOfThree = merchantProfile([
    at('2026-09-16T10:00:00.000Z', -500),
    at('2026-09-17T10:30:00.000Z', -600),
    at('2026-09-19T19:00:00.000Z', -20000),
  ]);
  assert.deepEqual(
    [twoOfThree.typical_time, twoOfThree.typical_day, twoOfThree.typical_amount],
    ['midday', 'weekday', 'small'],
  );
  const oneOfTwo = merchantProfile([
    at('2026-09-16T10:00:00.000Z', -500),
    at('2026-09-19T19:00:00.000Z', -20000),
  ]);
  assert.deepEqual(oneOfTwo, {
    typical_time: 'mixed',
    typical_day: 'mixed',
    typical_amount: 'mixed',
    occurrences: 'few',
  });
  assert.equal(
    merchantProfile([at('2026-08-05T10:00:00.000Z'), at('2026-09-05T10:00:00.000Z')]).occurrences,
    'recurring_monthly',
  );
  assert.equal(
    merchantProfile(['01', '08', '15', '22'].map((day) => at(`2026-09-${day}T10:00:00.000Z`)))
      .occurrences,
    'frequent',
  );
  assert.equal(merchantProfile([at('2026-09-05T10:00:00.000Z')]).occurrences, 'once');
  // 31 August 23:30 UTC is 1 September in Madrid: two movements in one Madrid month are `few`.
  assert.equal(
    merchantProfile([at('2026-08-31T23:30:00.000Z'), at('2026-09-20T10:00:00.000Z')]).occurrences,
    'few',
  );
  assert.deepEqual(merchantProfile([at('not a date', -500)]), {
    typical_time: 'mixed',
    typical_day: 'mixed',
    typical_amount: 'small',
    occurrences: 'once',
  });
});

test('SI4 sync part: rules answer before any decider does; only the unknown is pending', async () => {
  const userId = user();
  const hanging = hang();
  const rows = [
    movement('September salary', { amountCents: 250000 }),
    movement('Opening balance', { amountCents: 100000 }),
    movement('Groceries'),
    movement('Internet bill'),
    movement('Coffee shop'),
    movement('Transport'),
    movement('ZZQXV ALPHA'),
    movement('Card payment 12'),
  ];
  const result = await classify(userId, rows, [hanging.decider], { wait: false });
  assert.equal(result.size, rows.length);
  assert.deepEqual(
    rows.map(
      (m) => `${result.get(m.id)!.id}/${result.get(m.id)!.state}/${result.get(m.id)!.source}`,
    ),
    [
      'income/estimated/rule',
      'other/estimated/rule',
      'groceries/estimated/rule',
      'home_utilities/estimated/rule',
      'eating_out_leisure/estimated/rule',
      'transport/estimated/rule',
      'other/pending/none',
      'other/needs_review/none',
    ],
  );
  assert.deepEqual(result.get(rows[6].id), {
    id: 'other',
    state: 'pending',
    source: 'none',
    reason: 'pending',
    confidence: null,
    threshold: null,
    candidates: [],
    merchantKey: 'ZZQXV ALPHA',
    model: null,
  });
  assert.equal(result.get(rows[7].id)!.reason, 'no_merchant');
  assert.equal(result.get(rows[7].id)!.merchantKey, 'CARD PAYMENT'); // IT5 (A3): was ''
  // Stored at once, and never a pending row.
  const stored = store.storedCategories(userId, rows);
  assert.equal(stored.size, 7);
  assert.equal(stored.has(rows[6].id), false);
  hanging.release();
  assert.equal((await classify(userId, rows, [hanging.decider])).get(rows[6].id)!.id, 'health');
});

test('SI4 an empty chain sends the unknown to review at once; a chain that appears later decides it', async () => {
  const userId = user();
  const m = movement('ZZQXV BETA');
  const none = (await classify(userId, [m], [], { wait: false })).get(m.id)!;
  assert.deepEqual(
    [none.id, none.state, none.source, none.reason],
    ['other', 'needs_review', 'none', 'no_decider'],
  );
  const { decider, calls } = fake(() => answer('health', 0.9));
  assert.equal((await classify(userId, [m], [decider])).get(m.id)!.id, 'health');
  assert.equal(calls.length, 1);
});

test('SI4 both legs of one operation on two own accounts are savings_internal without an app record', async () => {
  const legs = [
    movement('Monthly saving', { operationId: 'op-1', amountCents: -20000 }),
    movement('Monthly saving', {
      operationId: 'op-1',
      amountCents: 20000,
      accountId: 'acc-a-savings',
    }),
  ];
  const result = await classify(user(), legs, []);
  for (const leg of legs) {
    assert.equal(result.get(leg.id)!.id, 'savings_internal');
    assert.equal(result.get(leg.id)!.reason, 'own_account');
  }
});

test('SI4 a model answer above the bar is an estimate; below it the movement goes to review', async () => {
  const userId = user();
  const high = movement('ZZQXV GAMMA');
  const low = movement('ZZQXV DELTA');
  const { decider } = fake((item) =>
    item.description === 'ZZQXV GAMMA'
      ? answer('health', 0.8, ['shopping'])
      : answer('shopping', 0.5, ['health']),
  );
  const result = await classify(userId, [high, low], [decider]);
  assert.deepEqual(result.get(high.id), {
    id: 'health',
    state: 'estimated',
    source: 'model',
    reason: 'model:midday,weekday',
    confidence: 0.8,
    threshold: 0.8,
    candidates: [
      { category: 'health', p: 0.8 },
      { category: 'shopping', p: 0.19999999999999996 },
    ],
    merchantKey: 'ZZQXV GAMMA',
    model: 'systemone:fake-1',
  });
  const review = result.get(low.id)!;
  assert.deepEqual(
    [review.id, review.state, review.source, review.reason, review.confidence, review.threshold],
    ['other', 'needs_review', 'model', 'below_threshold', 0.5, 0.8],
  );
  assert.equal(review.candidates[0].category, 'shopping');
  assert.equal(review.model, 'systemone:fake-1');
  // The same rows come back from the store.
  assert.deepEqual(await classify(userId, [high, low], []), result);
});

test('SI4 the chain falls through to the OpenAI decider, with its id and its own threshold', async () => {
  const first = failing();
  const second = fake(() => ({ ...answer('shopping', 0.86), model: 'gpt-x' }), {
    id: 'openai',
    threshold: 0.85,
  });
  const strict = fake(() => ({ ...answer('shopping', 0.86), model: 'gpt-x' }), {
    id: 'openai',
    threshold: 0.9,
  });
  const m = movement('ZZQXV EPSILON');
  const decided = (await classify(user(), [m], [first.decider, second.decider])).get(m.id)!;
  assert.deepEqual(
    [decided.id, decided.state, decided.model, decided.threshold],
    ['shopping', 'estimated', 'openai:gpt-x', 0.85],
  );
  assert.equal(first.calls.length, 1);
  // The same answer under a higher bar is not shown as a category.
  const review = (await classify(user(), [m], [first.decider, strict.decider])).get(m.id)!;
  assert.deepEqual([review.id, review.state, review.threshold], ['other', 'needs_review', 0.9]);
  // An error that is not a DeciderError also falls through.
  const broken = fake(() => {
    throw new TypeError('boom');
  });
  assert.equal(
    (await classify(user(), [m], [broken.decider, second.decider])).get(m.id)!.id,
    'shopping',
  );
});

test('SI4 every decider failed: stored decider_unavailable, sent again only after 24 hours', async () => {
  const userId = user();
  const m = movement('ZZQXV ZETA');
  const a = failing();
  const b = failing();
  let clock = Date.parse('2026-10-01T08:00:00.000Z');
  const now = () => new Date(clock);
  const chain = [a.decider, b.decider];
  const row = (await classify(userId, [m], chain, { wait: true }, now)).get(m.id)!;
  assert.deepEqual(row, {
    id: 'other',
    state: 'needs_review',
    source: 'none',
    reason: 'decider_unavailable',
    confidence: null,
    threshold: null,
    candidates: [],
    merchantKey: 'ZZQXV ZETA',
    model: null,
  });
  assert.deepEqual([a.calls.length, b.calls.length], [1, 1]);
  clock += 23 * 3600_000;
  assert.equal(
    (await classify(userId, [m], chain, { wait: true }, now)).get(m.id)!.reason,
    'decider_unavailable',
  );
  assert.equal(
    (await classify(userId, [m], chain, { wait: false }, now)).get(m.id)!.state,
    'needs_review',
  );
  assert.deepEqual([a.calls.length, b.calls.length], [1, 1], 'no call inside 24 hours');
  clock += 2 * 3600_000;
  await classify(userId, [m], chain, { wait: true }, now);
  assert.deepEqual([a.calls.length, b.calls.length], [2, 2], 'one more attempt after 24 hours');
  await classify(userId, [m], chain, { wait: true }, now);
  assert.deepEqual([a.calls.length, b.calls.length], [2, 2], 'and the 24 hours start again');
  // Deleting the row (the reclassify route, SI5) makes it classifiable at once.
  store.deleteCategories(userId, [m.id]);
  const working = fake(() => answer('health', 0.9));
  assert.equal(
    (await classify(userId, [m], [working.decider], { wait: true }, now)).get(m.id)!.id,
    'health',
  );
});

test('SI4 one decider call per merchant key and sign; none for an empty key; none the second time', async () => {
  const userId = user();
  const { decider, calls } = fake(() => answer('eating_out_leisure', 0.9));
  const rows = [
    ...Array.from({ length: 10 }, (_, i) =>
      movement(`ZZQXV ETA 04${i}2 TARJ *77${10 + i} MADRID ES`, {
        id: `eta-${i}`,
        amountCents: -1000 - i,
      }),
    ),
    movement('Card payment 12'),
    movement('7781 0412'),
  ];
  const result = await classify(userId, rows, [decider]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key.startsWith('ZZQXV ETA'), true);
  for (const m of rows.slice(0, 10)) assert.equal(result.get(m.id)!.id, 'eating_out_leisure');
  for (const m of rows.slice(10)) assert.equal(result.get(m.id)!.reason, 'no_merchant');
  await classify(userId, rows, [decider]);
  assert.equal(calls.length, 1);
});

test('SI4 the decider gets the cleaned description, the direction and the profile labels, nothing else', async () => {
  const { decider, calls } = fake(() => answer('eating_out_leisure', 0.9));
  const nights = [
    '2026-09-04T23:30:00.000Z',
    '2026-09-06T00:10:00.000Z',
    '2026-09-11T22:45:00.000Z',
  ];
  const rows = nights.map((createdAt, i) =>
    movement('ZZQXV Théta 0412 Tarj *7781', { createdAt, amountCents: [-2000, -2100, -500][i] }),
  );
  const userId = user();
  await classify(userId, rows.slice(0, 1), [decider]);
  assert.equal(calls[0].profile.occurrences, 'once');
  // The first movement is decided now; it still counts for the merchant's profile.
  const result = await classify(userId, rows, [decider]);
  const item = calls[1];
  assert.deepEqual(Object.keys(item).sort(), ['description', 'direction', 'key', 'profile']);
  assert.match(item.description, /^[A-Z0-9& ]{1,80}$/);
  assert.equal(item.direction, 'debit');
  assert.deepEqual(item.profile, {
    typical_time: 'late_night',
    typical_day: 'weekend',
    typical_amount: 'medium',
    occurrences: 'few',
  });
  const sent = JSON.stringify(item);
  for (const raw of ['2100', '500', '2026', '22:45', rows[1].id, 'acc-a'])
    assert.equal(sent.includes(raw), false, raw);
  assert.equal(result.get(rows[1].id)!.reason, 'model:late_night,weekend');
  // Ablation: neutral labels, and a plain reason.
  const ablated = await classify(user(), rows, [decider], { wait: true, profile: false });
  assert.deepEqual(calls[2].profile, {
    typical_time: 'mixed',
    typical_day: 'mixed',
    typical_amount: 'mixed',
    occurrences: 'once',
  });
  assert.equal(ablated.get(rows[0].id)!.reason, 'model');
  // A debit and a credit of one merchant are two decisions.
  const signs = [movement('ZZQXV IOTA'), movement('ZZQXV IOTA', { amountCents: 500 })];
  const before = calls.length;
  await classify(user(), signs, [decider]);
  assert.deepEqual(
    calls
      .slice(before)
      .map((c) => c.direction)
      .sort(),
    ['credit', 'debit'],
  );
});

test('SI4 a ZZQXV credit reaches the decider, and a forbidden answer goes to review', async () => {
  const { decider, calls } = fake(() => answer('transfer_person', 0.95, ['shopping']));
  const credit = movement('ZZQXV KAPPA', { amountCents: 900 });
  const row = (await classify(user(), [credit], [decider])).get(credit.id)!;
  assert.equal(calls[0].direction, 'credit');
  assert.deepEqual([row.id, row.state, row.reason], ['other', 'needs_review', 'below_threshold']);
  assert.deepEqual(
    row.candidates.map((c) => c.category),
    ['shopping'],
  );
});

test('SI4 single flight: two concurrent calls for one customer make one decider call', async () => {
  const userId = user();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { decider, calls } = fake(async () => {
    await gate;
    return answer('health', 0.9);
  });
  const m = movement('ZZQXV LAMBDA');
  const first = classify(userId, [m], [decider], { wait: false });
  const second = classify(userId, [m], [decider], { wait: true });
  const third = classify(userId, [m], [decider], { wait: true });
  assert.equal((await first).get(m.id)!.state, 'pending');
  release();
  assert.equal((await second).get(m.id)!.id, 'health');
  assert.equal((await third).get(m.id)!.id, 'health');
  assert.equal(calls.length, 1);
  // A later call returns the decision without another call.
  assert.equal((await classify(userId, [m], [decider], { wait: false })).get(m.id)!.id, 'health');
  assert.equal(calls.length, 1);
});

test('SI4 wait: true also covers movements a run already in flight did not know', async () => {
  const userId = user();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { decider, calls } = fake(async () => {
    await gate;
    return answer('health', 0.9);
  });
  const early = movement('ZZQXV MU');
  const late = movement('ZZQXV NU');
  const first = classify(userId, [early], [decider], { wait: false });
  const second = classify(userId, [early, late], [decider], { wait: true });
  await first;
  release();
  const result = await second;
  assert.deepEqual([result.get(early.id)!.id, result.get(late.id)!.id], ['health', 'health']);
  assert.equal(calls.length, 2);
});

test('SI4 at most 8 decider requests in flight', async () => {
  let active = 0;
  let peak = 0;
  const { decider, calls } = fake(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return answer('health', 0.9);
  });
  const rows = Array.from({ length: 30 }, (_, i) =>
    movement(`ZZQXV XI${String.fromCharCode(65 + (i % 26))}${i < 26 ? '' : 'B'}`),
  );
  const result = await classify(user(), rows, [decider]);
  assert.equal(calls.length, 30);
  assert.equal(peak, 8);
  assert.equal(
    [...result.values()].every((r) => r.id === 'health'),
    true,
  );
});

test('SI4 a category confirmed by hand during a run is not overwritten by the model', async () => {
  const userId = user();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { decider } = fake(async () => {
    await gate;
    return answer('health', 0.99);
  });
  const m = movement('ZZQXV OMICRON');
  const run = classify(userId, [m], [decider]);
  store.saveCategories(userId, [
    {
      movementId: m.id,
      fingerprint: store.fingerprint(m),
      id: 'shopping',
      state: 'confirmed',
      source: 'user',
      reason: 'user',
      confidence: null,
      threshold: null,
      candidates: [],
      merchantKey: 'ZZQXV OMICRON',
      model: null,
      updatedAt: new Date().toISOString(),
    },
  ]);
  release();
  const row = (await run).get(m.id)!;
  assert.deepEqual([row.id, row.state, row.source], ['shopping', 'confirmed', 'user']);
  // Nor by a rule the customer makes later for that merchant: one hand confirmation stays.
  store.setUserRule(userId, 'ZZQXV OMICRON', 'transport');
  const again = (await classify(userId, [m], [decider])).get(m.id)!;
  assert.deepEqual([again.id, again.source], ['shopping', 'user']);
  // A new movement of the merchant takes the rule: confirmed, no decider.
  const next = movement('ZZQXV OMICRON');
  const ruled = (await classify(userId, [next], [])).get(next.id)!;
  assert.deepEqual(
    [ruled.id, ruled.state, ruled.source, ruled.reason],
    ['transport', 'confirmed', 'user_rule', 'user_rule:ZZQXV OMICRON'],
  );
});

test('SI4 a movement whose content changed under the same id is classified again', async () => {
  const userId = user();
  const m = movement('Groceries', { id: 'reused-1' });
  assert.equal((await classify(userId, [m], [])).get(m.id)!.id, 'groceries');
  const changed = { ...m, description: 'Internet bill' };
  assert.equal((await classify(userId, [changed], [])).get(m.id)!.id, 'home_utilities');
  // Another customer with the same id has their own row.
  assert.equal((await classify(user(), [m], [])).get(m.id)!.id, 'groceries');
});

test('SI4 spendingSummary: the totals of the contract', async () => {
  const userId = user();
  const rows = [
    movement('MERCADONA 0412 VALENCIA', { amountCents: -6000 }),
    movement('MERCADONA 0412 VALENCIA', { amountCents: -4000 }),
    movement('DEVOLUCION ZARA ESPANA', { amountCents: 2500 }),
    movement('ZARA ESPANA S.A. 3321 MADRID', { amountCents: -8000 }),
    movement('Monthly saving', { operationId: 'op-2', amountCents: -20000 }),
    movement('Monthly saving', {
      operationId: 'op-2',
      amountCents: 20000,
      accountId: 'acc-a-savings',
    }),
    movement('Opening balance', { amountCents: 100000, createdAt: '2026-08-01T08:00:00.000Z' }),
    movement('September salary', { amountCents: 250000 }),
    movement('ZZQXV PI', { amountCents: -1500 }),
    movement('ZZQXV PI', { amountCents: -500 }),
    movement('Card payment 12', { amountCents: -700 }),
    movement('To acc-bruno: dinner', { amountCents: -3000 }),
  ];
  const categories = await classify(userId, rows, []);
  // One grocery movement confirmed by hand.
  store.saveCategories(userId, [
    {
      ...categories.get(rows[1].id)!,
      movementId: rows[1].id,
      fingerprint: store.fingerprint(rows[1]),
      state: 'confirmed',
      source: 'user',
      reason: 'user',
      updatedAt: new Date().toISOString(),
    },
  ]);
  const view = { movements: rows, categories: await classify(userId, rows, []) };
  const s = spendingSummary(view, {}, 'none');
  assert.deepEqual(s.range, { from: null, to: null });
  assert.deepEqual(s.window, {
    returned: 12,
    oldestAt: '2026-08-01T08:00:00.000Z',
    mayBeTruncated: false,
  });
  assert.equal(s.partial, false);
  assert.equal(s.incomeCents, 250000);
  assert.equal(s.spentCents, 6000 + 4000 + 8000 - 2500 + 1500 + 500 + 700 + 3000);
  assert.deepEqual(
    s.categories.map((c) => [
      c.id,
      c.label,
      c.spentCents,
      c.count,
      c.confirmedCents,
      c.estimatedCents,
    ]),
    [
      ['groceries', 'Groceries', 10000, 2, 4000, 6000],
      ['shopping', 'Shopping', 5500, 2, 0, 5500],
      ['transfer_person', 'Transfers to people', 3000, 1, 0, 3000],
      ['other', 'Other', 2700, 3, 0, 2700],
    ],
  );
  assert.equal(
    s.spentCents,
    s.categories.reduce((sum, c) => sum + c.spentCents, 0),
  );
  assert.deepEqual([s.unresolved.count, s.unresolved.totalCents], [3, 2700]);
  assert.deepEqual(
    s.unresolved.groups.map((g) => [g.merchantKey, g.title, g.count, g.totalCents, g.reason]),
    [
      ['ZZQXV PI', 'ZZQXV PI', 2, 2000, 'no_decider'],
      ['CARD PAYMENT', 'CARD PAYMENT', 1, 700, 'no_merchant'], // IT5 (A3): was '', the raw text
    ],
  );
  assert.deepEqual(s.unresolved.groups[0].movementIds, [rows[8].id, rows[9].id]);
  // IT6: each group says its sign (groups are per merchant key and sign since IT5).
  assert.deepEqual(
    s.unresolved.groups.map((g) => g.direction),
    ['debit', 'debit'],
  );
  assert.deepEqual([s.pending, s.decider], [0, 'none']);

  // A range: September only leaves the opening row out of the window's rows, not of `window`.
  const from = Date.parse('2026-07-01T00:00:00.000Z');
  const ranged = spendingSummary(
    view,
    { from, to: Date.parse('2026-08-31T23:59:59.999Z') },
    'none',
  );
  assert.deepEqual(ranged.range, {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.deepEqual([ranged.partial, ranged.spentCents, ranged.incomeCents], [true, 0, 0]);
  assert.equal(ranged.window.returned, 12);

  // Pending movements are counted as pending and are in no total: nothing unknown shown as spend.
  const hanging = hang();
  const unknown = [movement('ZZQXV RHO', { amountCents: -9900 })];
  const waiting = user();
  const pending = spendingSummary(
    {
      movements: unknown,
      categories: await classify(waiting, unknown, [hanging.decider], { wait: false }),
    },
    {},
    'systemone',
  );
  assert.deepEqual(
    [
      pending.pending,
      pending.spentCents,
      pending.unresolved.count,
      pending.categories.length,
      pending.decider,
    ],
    [1, 0, 0, 0, 'systemone'],
  );
  hanging.release();
  const decided = {
    movements: unknown,
    categories: await classify(waiting, unknown, [hanging.decider]),
  };
  assert.equal(spendingSummary(decided, {}, 'systemone').spentCents, 9900);
});

test('SI4 a movement the rules abstain on goes to review with the rule candidates, unless a decider gave its own', async () => {
  const m = movement('TRASPASO A CUENTA AHORRO', { amountCents: -5000 });
  const suggested = [{ category: 'savings_internal', p: null }];
  const none = (await classify(user(), [m], [])).get(m.id)!;
  assert.deepEqual(
    [none.state, none.reason, none.candidates],
    ['needs_review', 'no_decider', suggested],
  );
  const failed = (await classify(user(), [m], [failing().decider])).get(m.id)!;
  assert.deepEqual([failed.reason, failed.candidates], ['decider_unavailable', suggested]);
  const low = (await classify(user(), [m], [fake(() => answer('shopping', 0.4)).decider])).get(
    m.id,
  )!;
  assert.deepEqual(
    [low.reason, low.candidates],
    ['below_threshold', [{ category: 'shopping', p: 0.4 }]],
  );
  // A model answer with nothing usable left falls back to the rule candidates.
  const empty = (await classify(user(), [m], [fake(() => answer('income', 0.9)).decider])).get(
    m.id,
  )!;
  assert.deepEqual([empty.reason, empty.candidates], ['below_threshold', suggested]);
});

// Last: it breaks the store on purpose.
test('SI4 a store failure does not throw: every movement comes back pending and no decider is called', async () => {
  const { decider, calls } = fake(() => answer('health', 0.9));
  const rows = [movement('Groceries'), movement('ZZQXV SIGMA')];
  appDb().exec('ALTER TABLE movement_categories RENAME TO movement_categories_off');
  try {
    for (const wait of [false, true]) {
      const result = await classify(user(), rows, [decider], { wait });
      assert.deepEqual(
        rows.map(
          (m) => `${result.get(m.id)!.id}/${result.get(m.id)!.state}/${result.get(m.id)!.reason}`,
        ),
        ['other/pending/pending', 'other/pending/pending'],
      );
    }
    assert.equal(calls.length, 0);
  } finally {
    appDb().exec('ALTER TABLE movement_categories_off RENAME TO movement_categories');
  }
  // A corrupted candidates cell degrades the same way.
  const userId = user();
  await classify(userId, rows, []);
  appDb().prepare("UPDATE movement_categories SET candidates='{' WHERE user_id=?").run(userId);
  assert.equal((await classify(userId, rows, [])).get(rows[0].id)!.state, 'pending');
});
