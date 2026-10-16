// CF3-api: GET /api/movements, search and filters over the bank's 100-movement window. Rows come
// from the overview's own builder (activityRows) plus `direction`. Runs against the simulator or,
// with BANK_IMPL=alt, the alt bank (the window test seeds the simulator's DB, so it is skipped there).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-cf3-');
const alt = process.env.BANK_IMPL === 'alt';
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { closeAppDb } = await import('../src/db');
const { activityRows } = await import('../src/ui-helpers');
const { parseMovementFilters, filterRows, movementWindow } =
  await import('../src/banking/movements');
const { sessionToken } = await import('../src/auth');
const { GET } = await import('../app/api/[...path]/route');
let bank: ChildProcess;
before(async () => {
  if (!alt) seedBank();
  bank = await startSimulator();
  if (!alt) setScenario('normal');
});
after(() => {
  bank?.kill();
  closeAppDb();
  if (!alt) closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const search = async (userId: string, query = '') => {
  const response = await GET(
    new Request(`http://localhost/api/movements${query}`, {
      headers: { cookie: `banana_actor=${sessionToken(userId)}` },
    }),
    { params: Promise.resolve({ path: ['movements'] }) },
  );
  return { status: response.status, body: (await response.json()) as any };
};
const send = async (toAccountId: string, amountCents: number, concept: string) => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: { fromAccountId: 'acc-lucia', toAccountId, amountCents, concept },
  });
  assert.equal(body.status, 'requires_confirmation');
  const done = await callApi('lucia', `approvals/${body.approval.id}/confirm`, {});
  assert.equal(done.body.status, 'completed');
};

// Pure: the same fixture shape as tests/ui-helpers.test.ts (R3/R4).
const at = (h: number) => `2026-09-29T${String(h).padStart(2, '0')}:00:00.000Z`;
const books = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-hugo',
  amountCents: 123,
  concept: 'Books',
};
const fixture: Parameters<typeof activityRows>[0] = {
  accounts: [
    { id: 'acc-lucia', label: 'Aurora account' },
    { id: 'acc-lucia-savings', label: 'Personal savings' },
  ],
  contacts: [
    { id: 'acc-hugo', name: 'Hugo Pérez', label: 'Horizon account' },
    { id: 'acc-carla', name: 'Carla Ríos', label: 'Aurora account' },
  ],
  approvals: [{ id: 'ap1', expires_at: at(9), payload: books }],
  transfers: [
    { intentId: 'i1', status: 'pending_verification', transfer: books, steps: [{ at: at(8) }] },
  ],
  movements: [
    {
      id: 'm1',
      accountId: 'acc-lucia',
      amountCents: -100,
      description: 'Coffee',
      createdAt: at(1),
    },
    {
      id: 'm2',
      accountId: 'acc-lucia',
      amountCents: 500,
      description: 'Transfer · Rent',
      createdAt: at(3),
      operationId: 'op1',
      fromAccountId: 'acc-carla',
      toAccountId: 'acc-lucia',
      concept: 'Rent',
    },
    {
      id: 'm3',
      accountId: 'acc-lucia',
      amountCents: -700,
      description: 'Transfer · Save',
      createdAt: at(4),
      operationId: 'op2',
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-lucia-savings',
      concept: 'Save',
    },
    {
      id: 'm4',
      accountId: 'acc-lucia-savings',
      amountCents: 700,
      description: 'Transfer · Save',
      createdAt: at(4),
      operationId: 'op2',
    },
  ],
};
const filters = (query: string) => {
  const parsed = parseMovementFilters(new URLSearchParams(query));
  assert.ok('filters' in parsed, JSON.stringify(parsed));
  return parsed.filters;
};

test('CF3 direction: pending, internal (merged and one leg), received, sent', () => {
  assert.deepEqual(
    activityRows(fixture, Infinity).map((r) => [r.id, r.direction]),
    [
      ['ap1', 'pending'],
      ['i1', 'pending'],
      ['op2', 'internal'],
      ['m2', 'received'],
      ['m1', 'sent'],
    ],
  );
  const savingsLeg = activityRows(fixture, Infinity, 'acc-lucia');
  assert.equal(savingsLeg.find((r) => r.id === 'm3')?.direction, 'internal');
});

test('CF3 filterRows: accent-folded text, absolute amounts, inclusive dates, direction', () => {
  const rows = activityRows({ ...fixture, approvals: [], transfers: [] }, Infinity);
  const ids = (query: string) => filterRows(rows, filters(query)).map((r) => r.id);
  assert.deepEqual(ids('q=rios'), ['m2']); // "Carla Ríos"
  assert.deepEqual(ids('q=PERSONAL+savings'), ['op2']); // the account column
  assert.deepEqual(ids('min=5&max=7'), ['op2', 'm2']); // |−100| = 1.00 is out
  assert.deepEqual(ids('max=1,00'), ['m1']);
  assert.deepEqual(ids(`from=${encodeURIComponent(at(3))}&to=${encodeURIComponent(at(4))}`), [
    'op2',
    'm2',
  ]);
  assert.deepEqual(ids('from=2026-09-29&to=2026-09-29'), ['op2', 'm2', 'm1']);
  assert.deepEqual(ids('to=2026-09-28'), []);
  assert.deepEqual(ids('direction=internal'), ['op2']);
  assert.deepEqual(ids('direction=sent'), ['m1']);
  assert.deepEqual(ids(''), ['op2', 'm2', 'm1']);
});

test('CF3 parseMovementFilters: strict keys and values', () => {
  const error = (query: string) => {
    const parsed = parseMovementFilters(new URLSearchParams(query));
    assert.ok('error' in parsed, query);
    return parsed.error;
  };
  for (const bad of [
    'foo=1',
    'q=a&q=b',
    'min=1e3',
    'min=0',
    'min=-5',
    'direction=pending',
    'from=yesterday',
    'from=2026-02-31',
    'to=2026-09-29T10:00:00',
    `q=${'x'.repeat(101)}`,
  ])
    assert.equal(error(bad), 'Invalid request data.', bad);
  assert.match(error('from=2026-09-30&to=2026-09-29'), /start date/);
  assert.match(error('min=10&max=5'), /minimum amount/);
  assert.equal(filters('min=12,50').minCents, 1250);
});

test('CF3 movementWindow: the contract window of 100 recent movements', () => {
  const raw = Array.from({ length: 100 }, (_, i) => ({
    createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
  }));
  assert.deepEqual(movementWindow(raw), {
    limit: 100,
    returned: 100,
    oldestAt: '2026-09-01T00:00:00.000Z',
    mayBeTruncated: true,
  });
  assert.deepEqual(movementWindow([]), {
    limit: 100,
    returned: 0,
    oldestAt: null,
    mayBeTruncated: false,
  });
});

test('CF3 route: filters, merged internal move, window, isolation, roles', async () => {
  await send('acc-carla', 110, 'CF3 search dinner');
  await send('acc-lucia-savings', 120, 'CF3 search save');
  const all = await search('lucia');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, all.body.rows.length);
  assert.ok(all.body.rows.every((r: any) => r.direction !== 'pending'));
  const found = await search('lucia', '?q=cf3+SEARCH+dinner');
  assert.deepEqual(
    found.body.rows.map((r: any) => [r.direction, r.amountCents, r.accountId]),
    [['sent', -110, 'acc-lucia']],
  );
  const received = await search('lucia', '?direction=received');
  // The alt bank's 25-row page may hold no credit at all, so only the exclusion is asserted.
  assert.ok(!received.body.rows.some((r: any) => r.detail.includes('CF3 search dinner')));
  assert.ok(received.body.rows.every((r: any) => r.amountCents > 0 && r.direction === 'received'));
  const savings = await search('lucia', '?account=acc-lucia-savings&direction=internal');
  assert.deepEqual(
    savings.body.rows.map((r: any) => [r.title, r.amountCents, r.accountId]),
    [['Between your accounts', 120, 'acc-lucia-savings']],
  );
  const merged = await search('lucia', '?q=cf3+search+save');
  assert.deepEqual(
    merged.body.rows.map((r: any) => [r.direction, r.amountCents]),
    [['internal', 120]],
  );
  // The window counts the raw movements the bank returned for this customer.
  const own = new Set(['acc-lucia', 'acc-lucia-savings']);
  assert.ok(all.body.window.returned >= all.body.rows.length);
  assert.ok(all.body.rows.every((r: any) => own.has(r.accountId)));
  // Another customer never sees lucia's rows, and cannot name her account.
  const hugo = await search('hugo', '?q=cf3');
  assert.deepEqual(hugo.body.rows, []);
  assert.deepEqual(await search('hugo', '?account=acc-lucia'), {
    status: 400,
    body: { error: 'Unknown account.' },
  });
  assert.deepEqual(await search('lucia', '?account=acc-carla'), {
    status: 400,
    body: { error: 'Unknown account.' },
  });
  assert.deepEqual(await search('lucia', '?sort=asc'), {
    status: 400,
    body: { error: 'Invalid request data.' },
  });
  assert.equal((await search('lucia', '?direction=sent&direction=received')).status, 400);
  const operator = await search('marta');
  assert.equal(operator.status, 403);
  const anonymous = await GET(new Request('http://localhost/api/movements'), {
    params: Promise.resolve({ path: ['movements'] }),
  });
  assert.equal(anonymous.status, 401);
});

test(
  'CF3 route: over 100 movements the window says it may be truncated',
  { skip: alt },
  async () => {
    const put = bankDb().prepare('INSERT INTO movements VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 120; i++)
      put.run(
        `cf3-${i}`,
        'acc-diego',
        null,
        -1,
        `CF3 bulk ${i}`,
        new Date(Date.UTC(2026, 8, 25) + i * 1000).toISOString(),
      );
    const { body } = await search('diego');
    assert.equal(body.window.returned, 100);
    assert.equal(body.window.mayBeTruncated, true);
    assert.equal(body.window.oldestAt, body.rows.at(-1).createdAt);
    assert.equal(body.total, 100);
  },
);
