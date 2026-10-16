// SI5: the insights API (plan 23, contracts.md §3) on the alt bank with the demo seed and
// DECIDER=none: categories on rows, the summary route, set category with "apply to similar",
// rules, reclassify, audit events and the refusals. No model is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';

// Everything the app logs during the run, for the last test.
const logged: string[] = [];
for (const level of ['info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    if (process.env.SI5_SHOW_LOGS) original(...args);
  };
}

const { temp } = await setupEnv('banana-si5-api-');
Object.assign(process.env, {
  DECIDER: 'none',
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { verifyAuditChain } = await import('../src/audit');
const { routeLabel } = await import('../src/http');
const { activityRows } = await import('../src/ui-helpers');
const { classifyMovements } = await import('../src/insights/classify');
const { bankView } = await import('../src/banking/view');
const { deleteCategories, saveCategories } = await import('../src/insights/store');
const api = (await import('../app/api/[...path]/route')) as Record<string, any>;
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'DELETE';
async function call(
  userId: string | null,
  method: Method,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const request = new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId && { cookie: `banana_actor=${sessionToken(userId)}` }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await api[method](request, {
    params: Promise.resolve({ path: route.split('?')[0].split('/') }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const get = (userId: string | null, route: string) => call(userId, 'GET', route);
const set = (userId: string, body: unknown) => call(userId, 'POST', 'insights/categories', body);
const inject = async (accountId: string, amountCents: number, description: string) => {
  const response = await fetch(`${process.env.BANK_URL}/_control/movement`, {
    method: 'POST',
    headers: { 'x-alt-control': 'alt-control' },
    body: JSON.stringify({ accountId, amountCents, description }),
  });
  assert.equal(response.status, 200);
};
const movements = async (userId: string) => (await get(userId, 'dashboard')).body.movements;
const ofMerchant = async (userId: string, key: string) =>
  (await movements(userId)).filter((m: any) => m.category.merchantKey === key);
const byDescription = async (userId: string, description: string) =>
  (await movements(userId)).find((m: any) => m.description === description);
const events = () =>
  (
    appDb()
      .prepare(
        "SELECT kind,user_id,conversation_id,data FROM events WHERE kind IN ('category.set','rule.created','rule.removed') ORDER BY rowid",
      )
      .all() as any[]
  ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
const shape = (c: any) => [c.id, c.state, c.source, c.reason];
const INVALID = { error: 'Invalid request data.' };

test('SI5 rows (pure): a row copies its movement category; a merged pair lists both legs', () => {
  const category = (id: string, movementId: string) => ({ id, movementIds: [movementId] }) as any;
  const source = {
    accounts: [
      { id: 'a1', name: 'Main' },
      { id: 'a2', name: 'Savings' },
    ],
    movements: [
      { id: 'm-credit', accountId: 'a2', amountCents: 500, operationId: 'op1' },
      { id: 'm-debit', accountId: 'a1', amountCents: -500, operationId: 'op1' },
      { id: 'm-shop', accountId: 'a1', amountCents: -900 },
      { id: 'm-bare', accountId: 'a1', amountCents: -100 },
    ].map((m, i) => ({
      ...m,
      description: m.id,
      createdAt: `2026-09-0${i + 1}T10:00:00.000Z`,
      ...(m.id !== 'm-bare' && {
        category: category(m.operationId ? 'savings_internal' : 'shopping', m.id),
      }),
    })),
    approvals: [
      {
        id: 'ap1',
        expires_at: '2026-09-09T10:00:00.000Z',
        payload: { fromAccountId: 'a1', toAccountId: 'x', amountCents: 100, concept: 'c' },
      },
    ],
  } as any;
  const rows = activityRows(source, Infinity);
  const row = (id: string) => rows.find((r) => r.id === id)!;
  assert.deepEqual(row('op1').category, {
    id: 'savings_internal',
    movementIds: ['m-debit', 'm-credit'],
  });
  assert.deepEqual(row('m-shop').category, { id: 'shopping', movementIds: ['m-shop'] });
  // A proposal row and a movement without a category have no `category` key at all.
  assert.equal('category' in row('ap1'), false);
  assert.equal('category' in row('m-bare'), false);
  // One account's view of the internal move: that leg only.
  assert.deepEqual(activityRows(source, Infinity, 'a2')[0].category, {
    id: 'savings_internal',
    movementIds: ['m-credit'],
  });
});

test('SI5 rows: /api/movements rows carry the category; a merged internal row has both legs', async () => {
  const { status, body } = await get('lucia', 'movements');
  assert.equal(status, 200);
  const dash = await movements('lucia');
  for (const row of body.rows) {
    assert.ok(row.category, row.id);
    assert.ok(row.category.movementIds.length >= 1);
  }
  const internal = body.rows.filter((r: any) => r.kind === 'internal');
  assert.ok(internal.length >= 2, 'the two monthly savings transfers');
  for (const row of internal) {
    assert.deepEqual(shape(row.category).slice(0, 2), ['savings_internal', 'estimated']);
    assert.equal(row.category.movementIds.length, 2);
    const legs = dash.filter((m: any) => m.operationId === row.id);
    assert.deepEqual(
      row.category.movementIds,
      [legs.find((m: any) => m.amountCents < 0).id, legs.find((m: any) => m.amountCents > 0).id],
      'debit leg first',
    );
  }
  const single = await get('lucia', 'movements?account=acc-lucia-savings');
  const leg = single.body.rows.find((r: any) => r.direction === 'internal');
  assert.deepEqual(leg.category.movementIds, [leg.id]);
  // The window keeps its shape (CF3).
  assert.deepEqual(Object.keys(body.window), ['limit', 'returned', 'oldestAt', 'mayBeTruncated']);
  // Posting the merged row's ids changes both legs.
  const ids = internal[0].category.movementIds;
  const changed = await set('lucia', { movementIds: ids, category: 'other' });
  assert.deepEqual([changed.status, changed.body.updated], [200, 2]);
  for (const m of (await movements('lucia')).filter((x: any) => ids.includes(x.id)))
    assert.deepEqual(shape(m.category), ['other', 'confirmed', 'user', 'user']);
  // A debit leg cannot be income: the pair is refused as a whole.
  const refused = await set('lucia', { movementIds: ids, category: 'income' });
  assert.equal(refused.status, 400);
  await set('lucia', { movementIds: ids, category: 'savings_internal' });
});

test('SI5 summary: the route equals dashboard.insights; from, to, partial and the 400s', async () => {
  const dash = await get('lucia', 'dashboard');
  const all = await get('lucia', 'insights/spending');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, dash.body.insights);
  assert.deepEqual(all.body.range, { from: null, to: null });
  assert.equal(all.body.partial, false);
  for (const c of all.body.categories)
    assert.equal(c.confirmedCents + c.estimatedCents, c.spentCents);

  const september = await get('lucia', 'insights/spending?from=2026-09-01&to=2026-09-30');
  assert.deepEqual(september.body.range, {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T23:59:59.999Z',
  });
  assert.equal(september.body.partial, false);
  assert.ok(september.body.spentCents > 0 && september.body.spentCents < all.body.spentCents);
  assert.deepEqual(september.body.window, all.body.window);
  const early = await get('lucia', 'insights/spending?from=2020-01-01');
  assert.equal(early.body.partial, true);
  assert.equal(early.body.spentCents, all.body.spentCents);
  const instant = await get('lucia', 'insights/spending?to=2026-09-01T00:00:00%2B02:00');
  assert.equal(instant.body.range.to, '2026-08-31T22:00:00.000Z');

  const reversed = await get('lucia', 'insights/spending?from=2026-09-30&to=2026-09-01');
  assert.deepEqual(
    [reversed.status, reversed.body],
    [400, { error: 'The start date is after the end date.' }],
  );
  for (const query of [
    'q=x',
    'from=2026-09-01&from=2026-09-02',
    'from=yesterday',
    'to=',
    'limit=5',
  ])
    assert.deepEqual(
      await get('lucia', `insights/spending?${query}`),
      { status: 400, body: INVALID },
      query,
    );
});

test('SI5 summary: an injected unknown is unresolved, and an unknown credit is not income', async () => {
  const before = (await get('lucia', 'insights/spending')).body;
  await inject('acc-lucia', -1234, 'ZZQXV ALPHA');
  await inject('acc-lucia', 4321, 'ZZQXV BETA');
  const after = (await get('lucia', 'insights/spending')).body;
  const group = (key: string) => after.unresolved.groups.find((g: any) => g.merchantKey === key);
  assert.deepEqual(
    [group('ZZQXV ALPHA').count, group('ZZQXV ALPHA').totalCents, group('ZZQXV ALPHA').reason],
    [1, 1234, 'no_decider'],
  );
  assert.equal(group('ZZQXV BETA').totalCents, 4321);
  assert.equal(after.unresolved.count, before.unresolved.count + 2);
  assert.equal(after.incomeCents, before.incomeCents, 'an unknown credit waits for the customer');
  const credit = await byDescription('lucia', 'ZZQXV BETA');
  assert.deepEqual(shape(credit.category).slice(0, 2), ['other', 'needs_review']);
  // The customer may say it is income, never a transfer to a person.
  const refused = await set('lucia', { movementIds: [credit.id], category: 'transfer_person' });
  assert.deepEqual(
    [refused.status, refused.body],
    [400, { error: 'This category does not fit this movement.' }],
  );
  assert.equal((await set('lucia', { movementIds: [credit.id], category: 'income' })).status, 200);
  const done = (await get('lucia', 'insights/spending')).body;
  assert.equal(done.incomeCents, before.incomeCents + 4321);
});

test('SI5 set: one movement is confirmed by hand; similar counts the current bank answer only', async () => {
  const group = await ofMerchant('bruno', 'ESPAI NOU');
  assert.equal(group.length, 4);
  for (const m of group) assert.equal(m.category.state, 'needs_review');
  // A stored row of a movement the bank no longer returns: never counted, never changed.
  const { movementIds: _, ...category } = group[1].category;
  saveCategories('bruno', [
    { ...category, movementId: 'gone-1', fingerprint: 'x', updatedAt: new Date().toISOString() },
  ]);
  const seen = events().length;
  const first = await set('bruno', { movementIds: [group[0].id], category: 'eating_out_leisure' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    updated: 1,
    similar: [
      {
        merchantKey: 'ESPAI NOU',
        count: 3,
        movementIds: group.slice(1).map((m: any) => m.id),
      },
    ],
    rules: [],
  });
  const now = await ofMerchant('bruno', 'ESPAI NOU');
  assert.deepEqual(shape(now[0].category), ['eating_out_leisure', 'confirmed', 'user', 'user']);
  assert.deepEqual(
    now.slice(1).map((m: any) => m.category.state),
    ['needs_review', 'needs_review', 'needs_review'],
  );
  assert.deepEqual(events().slice(seen), [
    {
      kind: 'category.set',
      user_id: 'bruno',
      conversation_id: null,
      data: {
        channel: 'ui',
        movementId: group[0].id,
        from: 'other',
        to: 'eating_out_leisure',
        source: 'user',
      },
    },
  ]);
  // The same request again changes nothing and leaves no second event.
  const again = await set('bruno', { movementIds: [group[0].id], category: 'eating_out_leisure' });
  assert.deepEqual([again.status, again.body.updated, again.body.similar[0].count], [200, 0, 3]);
  assert.equal(events().length, seen + 1);
});

test('SI5 set: apply to similar creates the rule, changes the similar ones, and later movements follow', async () => {
  const group = await ofMerchant('bruno', 'ESPAI NOU');
  const seen = events().length;
  const { status, body } = await set('bruno', {
    movementIds: [group[0].id, group[0].id],
    category: 'eating_out_leisure',
    applyToSimilar: true,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    updated: 3,
    similar: [
      { merchantKey: 'ESPAI NOU', count: 3, movementIds: group.slice(1).map((m: any) => m.id) },
    ],
    rules: ['ESPAI NOU'],
  });
  const now = await ofMerchant('bruno', 'ESPAI NOU');
  assert.equal(now[0].category.source, 'user');
  for (const m of now.slice(1))
    assert.deepEqual(shape(m.category), [
      'eating_out_leisure',
      'confirmed',
      'user_rule',
      'user_rule:ESPAI NOU',
    ]);
  const added = events().slice(seen);
  assert.deepEqual(
    added.map((e) => [e.kind, e.data.channel, e.data.source ?? e.data.category]),
    [
      ...group.slice(1).map(() => ['category.set', 'ui', 'user_rule']),
      ['rule.created', 'ui', 'eating_out_leisure'],
    ],
  );
  assert.deepEqual(added.at(-1)!.data, {
    channel: 'ui',
    merchantKey: 'ESPAI NOU',
    category: 'eating_out_leisure',
  });
  // The vanished movement's row was not touched.
  assert.equal(
    appDb()
      .prepare(
        "SELECT state FROM movement_categories WHERE user_id='bruno' AND movement_id='gone-1'",
      )
      .pluck()
      .get(),
    'needs_review',
  );
  // Identical again: nothing to do, the rule is not recreated, no event.
  const again = await set('bruno', {
    movementIds: [group[0].id],
    category: 'eating_out_leisure',
    applyToSimilar: true,
  });
  assert.deepEqual(again.body, {
    updated: 0,
    similar: [{ merchantKey: 'ESPAI NOU', count: 0, movementIds: [] }],
    rules: ['ESPAI NOU'],
  });
  assert.equal(events().length, seen + 4);

  const rules = await get('bruno', 'insights/rules');
  assert.equal(rules.status, 200);
  assert.deepEqual(
    rules.body.rules.map((r: any) => [r.merchantKey, r.category]),
    [['ESPAI NOU', 'eating_out_leisure']],
  );
  assert.ok(!Number.isNaN(Date.parse(rules.body.rules[0].createdAt)));
  assert.deepEqual((await get('lucia', 'insights/rules')).body, { rules: [] });

  // A later movement of that merchant follows the rule on first read; another customer's does not.
  await inject('acc-bruno', -777, 'SUMUP *ESPAI NOU');
  await inject('acc-lucia', -777, 'SUMUP *ESPAI NOU');
  const later = (await ofMerchant('bruno', 'ESPAI NOU')).find((m: any) => m.amountCents === -777);
  assert.deepEqual(shape(later.category), [
    'eating_out_leisure',
    'confirmed',
    'user_rule',
    'user_rule:ESPAI NOU',
  ]);
  const [other] = await ofMerchant('lucia', 'ESPAI NOU');
  assert.deepEqual(shape(other.category).slice(0, 2), ['other', 'needs_review']);
  assert.equal(verifyAuditChain().status, 'verified');
});

test('SI5 set: a movement with no merchant key can be set alone and never gets a rule', async () => {
  // IT5: `Card payment 12` now has the key `CARD PAYMENT`, so the example is a bare number.
  await inject('acc-bruno', -350, '7781 0412');
  const bare = await byDescription('bruno', '7781 0412');
  assert.deepEqual([bare.category.merchantKey, bare.category.reason], ['', 'no_merchant']);
  const { status, body } = await set('bruno', {
    movementIds: [bare.id],
    category: 'shopping',
    applyToSimilar: true,
  });
  assert.deepEqual([status, body], [200, { updated: 1, similar: [], rules: [] }]);
  assert.equal((await get('bruno', 'insights/rules')).body.rules.length, 1);
});

test('SI5 set: a movement that is not the customer’s is a 404 and nothing is written', async () => {
  const [own] = (await movements('bruno')).filter((m: any) => m.category.state === 'estimated');
  const [foreign] = await movements('lucia');
  const seen = events().length;
  const stored = () => appDb().prepare('SELECT COUNT(*) FROM movement_categories').pluck().get();
  const rows = stored();
  for (const movementIds of [[foreign.id], ['invented-1'], [own.id, foreign.id], ['gone-1']]) {
    const { status, body } = await set('bruno', { movementIds, category: 'shopping' });
    assert.deepEqual([status, body], [404, { error: 'Movement not found.' }], String(movementIds));
  }
  assert.equal(events().length, seen);
  assert.equal(stored(), rows);
  const same = (await movements('bruno')).find((m: any) => m.id === own.id);
  assert.deepEqual(same.category, own.category);
});

test('SI5 set: the sign rule refuses the whole request', async () => {
  const all = await movements('bruno');
  const debit = all.find((m: any) => m.amountCents < 0 && m.category.state === 'estimated');
  const credit = all.find((m: any) => m.amountCents > 0);
  const seen = events().length;
  for (const [movementIds, category] of [
    [[debit.id], 'income'],
    [[credit.id], 'transfer_person'],
    [[credit.id, debit.id], 'income'],
  ] as const) {
    const { status, body } = await set('bruno', { movementIds, category });
    assert.deepEqual(
      [status, body],
      [400, { error: 'This category does not fit this movement.' }],
      category,
    );
  }
  assert.equal(events().length, seen);
  const now = await movements('bruno');
  for (const m of [debit, credit])
    assert.deepEqual(now.find((x: any) => x.id === m.id).category, m.category);
});

test('SI5 refusals: invalid bodies, operator, anonymous, foreign origin, unknown routes', async () => {
  const [m] = await movements('bruno');
  const seen = events().length;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
  for (const body of [
    { movementIds: [m.id], category: 'pets' },
    { movementIds: [], category: 'shopping' },
    { movementIds: ids(101), category: 'shopping' },
    { movementIds: [m.id], category: 'shopping', extra: 1 },
    { movementIds: [m.id], category: 'shopping', applyToSimilar: 'yes' },
    { movementIds: [m.id], category: 'shopping', description: 'MERCADONA', amountCents: 1 },
    { movementIds: [''], category: 'shopping' },
    { movementIds: m.id, category: 'shopping' },
    { category: 'shopping' },
    'not json',
    '',
  ])
    assert.deepEqual(
      await set('bruno', body),
      { status: 400, body: INVALID },
      JSON.stringify(body),
    );
  // 100 ids pass validation and reach the ownership check.
  assert.equal((await set('bruno', { movementIds: ids(100), category: 'shopping' })).status, 404);
  assert.equal((await call('bruno', 'POST', 'insights/reclassify', { all: true })).status, 400);
  const big = await set('bruno', {
    movementIds: [m.id],
    category: 'shopping',
    x: 'x'.repeat(300_000),
  });
  assert.equal(big.status, 413);

  const routes: [Method, string, unknown?][] = [
    ['GET', 'insights/spending'],
    ['GET', 'insights/rules'],
    ['POST', 'insights/categories', { movementIds: [m.id], category: 'shopping' }],
    ['POST', 'insights/reclassify', {}],
    ['DELETE', 'insights/rules/ESPAI%20NOU'],
  ];
  for (const [method, route, body] of routes) {
    const operator = await call('marta', method, route, body);
    assert.deepEqual(
      [operator.status, operator.body],
      [403, { error: 'A customer is required.' }],
      route,
    );
    assert.equal((await call(null, method, route, body)).status, 401, route);
    if (method === 'GET') continue;
    const foreign = await call('bruno', method, route, body, {
      host: 'localhost',
      origin: 'https://evil.example',
    });
    assert.deepEqual(
      [foreign.status, foreign.body],
      [403, { error: 'Origin not allowed.' }],
      route,
    );
    const same = await call('bruno', method, 'insights/nope', body, {
      host: 'localhost',
      origin: 'http://localhost',
    });
    assert.equal(same.status, 404);
  }
  // The operator's dashboard is still the inbox.
  assert.deepEqual(Object.keys((await get('marta', 'dashboard')).body), ['incidents']);
  // IT2: a path that is no route is a 404; a route asked with a method it does not define, a 405.
  for (const [method, route, status] of [
    ['GET', 'insights', 404],
    ['GET', 'insights/categories', 405],
    ['POST', 'insights/rules', 405],
    ['DELETE', 'insights/rules', 405],
    ['DELETE', 'insights/rules/A/B', 404],
    ['GET', 'insights/rules/ESPAI%20NOU', 405],
  ] as const)
    assert.deepEqual(
      await call('bruno', method, route, method === 'POST' ? {} : undefined),
      { status, body: { error: status === 404 ? 'Route not found.' : 'Method not allowed.' } },
      `${method} ${route}`,
    );
  assert.equal(events().length, seen);
  assert.equal((await get('bruno', 'insights/rules')).body.rules.length, 1);
});

test('SI5 rules: delete classifies the rule’s movements again and keeps the hand-set one', async () => {
  const group = await ofMerchant('bruno', 'ESPAI NOU');
  const ruled = group.filter((m: any) => m.category.source === 'user_rule');
  assert.equal(ruled.length, 4, 'three similar ones and the later one');
  // Another customer's delete of the same key finds nothing.
  assert.deepEqual((await call('lucia', 'DELETE', 'insights/rules/ESPAI%20NOU')).body, {
    removed: false,
    reclassified: 0,
  });
  const seen = events().length;
  const removed = await call('bruno', 'DELETE', 'insights/rules/ESPAI%20NOU');
  assert.deepEqual([removed.status, removed.body], [200, { removed: true, reclassified: 4 }]);
  const now = await ofMerchant('bruno', 'ESPAI NOU');
  assert.deepEqual(now.map((m: any) => m.category.source).sort(), [
    'none',
    'none',
    'none',
    'none',
    'user',
  ]);
  for (const m of now.filter((x: any) => x.category.source === 'none'))
    assert.deepEqual(shape(m.category), ['other', 'needs_review', 'none', 'no_decider']);
  assert.deepEqual((await get('bruno', 'insights/rules')).body, { rules: [] });
  assert.deepEqual(
    events()
      .slice(seen)
      .map((e) => [e.kind, e.data]),
    [['rule.removed', { channel: 'ui', merchantKey: 'ESPAI NOU', category: 'eating_out_leisure' }]],
  );
  // Unknown now, and a key no merchant can have: both a plain 200.
  for (const key of ['ESPAI NOU', 'ESPAI%20NOU', 'nope%2F..', '%E0%A4%A'])
    assert.deepEqual(
      await call('bruno', 'DELETE', `insights/rules/${key}`),
      { status: 200, body: { removed: false, reclassified: 0 } },
      key,
    );
  assert.equal(events().length, seen + 1);
  assert.equal(verifyAuditChain().status, 'verified');
});

test('SI5 rules: a replaced rule moves its movements, a hand-set one included', async () => {
  const group = await ofMerchant('bruno', 'ESPAI NOU');
  const hand = group.find((m: any) => m.category.source === 'user');
  const target = group.find((m: any) => m.category.source === 'none');
  const { body } = await set('bruno', {
    movementIds: [target.id],
    category: 'groceries',
    applyToSimilar: true,
  });
  // contracts.md: similar = the others of that key and sign "not already that category and
  // confirmed", so the customer's explicit "apply to all" also moves the one set by hand before.
  assert.equal(body.updated, 5);
  assert.ok(body.similar[0].movementIds.includes(hand.id));
  const now = await ofMerchant('bruno', 'ESPAI NOU');
  assert.deepEqual([...new Set(now.map((m: any) => m.category.id))], ['groceries']);
  const undone = await call('bruno', 'DELETE', 'insights/rules/ESPAI NOU');
  assert.deepEqual(undone.body, { removed: true, reclassified: 4 });
  const kept = (await ofMerchant('bruno', 'ESPAI NOU')).filter(
    (m: any) => m.category.state === 'confirmed',
  );
  assert.deepEqual(
    kept.map((m: any) => [m.id, m.category.source]),
    [[target.id, 'user']],
  );
});

test('SI5 reclassify: decider_unavailable movements are sent again', async () => {
  await inject('acc-bruno', -2222, 'ZZQXV GAMMA');
  const view = await bankView('bruno');
  const gamma = view.movements.find((m) => m.description === 'ZZQXV GAMMA')!;
  const input = {
    userId: 'bruno',
    movements: view.movements,
    ownAccountIds: new Set(view.accounts.map((a) => a.id)),
    wait: true,
  };
  const failing = {
    id: 'systemone' as const,
    threshold: 0.8,
    classify: async () => {
      throw new Error('down');
    },
  };
  deleteCategories('bruno', [gamma.id]);
  await classifyMovements({ ...input, deciders: [failing] });
  assert.equal(
    (await byDescription('bruno', 'ZZQXV GAMMA')).category.reason,
    'decider_unavailable',
  );
  const failed = (await movements('bruno')).filter(
    (m: any) => m.category.reason === 'decider_unavailable',
  ).length;

  const seen = events().length;
  const first = await call('bruno', 'POST', 'insights/reclassify', {});
  assert.deepEqual([first.status, first.body], [200, { queued: failed }]);
  // No decider here: the pipeline ran again and says so, instead of keeping the failure.
  assert.equal((await byDescription('bruno', 'ZZQXV GAMMA')).category.reason, 'no_decider');
  assert.deepEqual((await call('bruno', 'POST', 'insights/reclassify', {})).body, { queued: 0 });
  assert.equal(events().length, seen, 'a retry is not a category change');
  // With a decider that answers, the same movement is classified.
  const working = {
    ...failing,
    classify: async () => ({
      candidates: [{ category: 'health' as const, p: 0.95 }],
      confidence: 0.95,
      model: 'fake',
    }),
  };
  const decided = await classifyMovements({ ...input, deciders: [working] });
  assert.deepEqual(shape(decided.get(gamma.id)).slice(0, 3), ['health', 'estimated', 'model']);
});

test('SI5 store failure: a generic 500, nothing half-written, no event', async () => {
  const [m] = (await movements('lucia')).filter((x: any) => x.category.state === 'estimated');
  const seen = events().length;
  appDb().exec('ALTER TABLE events RENAME TO events_off');
  try {
    const { status, body } = await set('lucia', {
      movementIds: [m.id],
      category: 'shopping',
      applyToSimilar: true,
    });
    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: 'The request could not be completed. Check the service and configuration.',
    });
  } finally {
    appDb().exec('ALTER TABLE events_off RENAME TO events');
  }
  assert.equal(events().length, seen);
  assert.deepEqual((await movements('lucia')).find((x: any) => x.id === m.id).category, m.category);
});

test('SI5 logs: the access log hides the merchant key; no log line has an id or a description', async () => {
  assert.equal(routeLabel(['insights', 'rules', 'ESPAI NOU']), 'insights/rules/:key');
  assert.equal(routeLabel(['insights', 'rules']), 'insights/rules');
  assert.equal(routeLabel(['insights', 'categories']), 'insights/categories');
  assert.equal(routeLabel(['conversations', 'c1', 'messages']), 'conversations/:id/messages');
  const access = logged.filter((l) => l.includes('"api_request"') && l.includes('"DELETE"'));
  assert.ok(access.length > 0);
  assert.ok(access.some((line) => JSON.parse(line).route === 'insights/rules/:key'));
  for (const line of access)
    assert.match(JSON.parse(line).route, /^insights\/(nope|rules(\/:key){0,2})$/);
  for (const line of logged)
    assert.equal(/ESPAI|ZZQXV|demo-(bruno|lucia)|inj-\d/.test(line), false, line.slice(0, 300));
});

// Last: it stops the bank.
test('SI5 bank unavailable: a write stores nothing and records no event', async () => {
  const [m] = (await movements('bruno')).filter((x: any) => x.category.state === 'estimated');
  await set('bruno', { movementIds: [m.id], category: 'shopping', applyToSimilar: true });
  const rules = (await get('bruno', 'insights/rules')).body;
  const seen = events().length;
  const stored = () =>
    JSON.stringify(appDb().prepare('SELECT * FROM movement_categories ORDER BY 1,2').all());
  const rows = stored();
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const down = { error: 'The bank did not respond. Try again in a moment.' };
  for (const [method, route, body] of [
    ['POST', 'insights/categories', { movementIds: [m.id], category: 'groceries' }],
    ['DELETE', `insights/rules/${encodeURIComponent(rules.rules[0].merchantKey)}`],
    ['POST', 'insights/reclassify', {}],
    ['GET', 'insights/spending'],
  ] as [Method, string, unknown?][]) {
    const response = await call('bruno', method, route, body);
    assert.deepEqual([response.status, response.body], [504, down], route);
  }
  assert.equal(events().length, seen);
  assert.equal(stored(), rows);
  // The rules are the app's own records: they still read.
  assert.deepEqual((await get('bruno', 'insights/rules')).body, rules);
});
