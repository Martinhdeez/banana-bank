// IT8: the spending summary by period (contracts.md §3 "Periods"). The demo bank (alt bank with
// the demo seed) over the real routes, and the pure function with an injected clock. No model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-it8-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { GET } = await import('../app/api/[...path]/route');
const { parsePeriod, periodSummary, spendingSummary } = await import('../src/insights/summary');
const { insightsTools } = await import('../src/agent/insights');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function get(route: string, query = '', headers: Record<string, string> = {}) {
  const response = await GET(
    new Request(`http://localhost/api/${route}${query}`, {
      headers: { cookie: `banana_actor=${sessionToken('lucia')}`, ...headers },
    }),
    { params: Promise.resolve({ path: route.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
// The test's own month of a date, not the code's.
const madridMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
// What a category's amount must be from the rows shown (contracts.md §3 "Totals").
function sums(rows: any[]) {
  const spent: Record<string, number> = {};
  let income = 0;
  for (const { amountCents, category: c } of rows) {
    if (c.state === 'pending' || c.id === 'savings_internal') continue;
    if (c.id === 'income') income += Math.max(0, amountCents);
    else if (!(amountCents > 0 && c.id === 'other')) spent[c.id] = (spent[c.id] ?? 0) - amountCents;
  }
  return { spent, income };
}
const byCategory = (s: any) =>
  Object.fromEntries(s.categories.map((c: any) => [c.id, c.spentCents]));

test('IT8 demo bank: each period is the sum of its rows, and the months add up to `all`', async () => {
  const dash = (await get('dashboard')).body;
  const all = dash.insights;
  // IT8b review: the first read (rows classified in the call) and a later one (rows from the
  // store) are the same bytes, key order included.
  assert.equal(
    JSON.stringify((await get('dashboard')).body.movements),
    JSON.stringify(dash.movements),
  );
  assert.equal(all.period, 'all');
  assert.deepEqual((await get('insights/spending')).body, all, 'both routes, same default');
  assert.deepEqual(byCategory(all), sums(dash.movements).spent);

  const months = all.periods.filter((p: any) => p.id !== 'all');
  assert.ok(months.length >= 2, 'the demo seed spans at least two months');
  assert.deepEqual(
    months.map((p: any) => p.id),
    months
      .map((p: any) => p.id)
      .sort()
      .reverse(),
    'newest first',
  );
  assert.deepEqual(all.periods.at(-1), {
    id: 'all',
    label: 'All movements',
    count: dash.movements.length,
    partial: false,
  });
  assert.ok(months.some((p: any) => p.id === '2026-09' && p.label === 'Sep 2026'));

  let spent = 0,
    income = 0,
    count = 0;
  for (const p of months) {
    const rows = dash.movements.filter((m: any) => madridMonth(m.createdAt) === p.id);
    assert.equal(p.count, rows.length, p.id);
    const { status, body } = await get('dashboard', `?period=${p.id}`);
    const s = body.insights;
    assert.equal(status, 200);
    assert.equal(s.period, p.id);
    const expected = sums(rows);
    assert.deepEqual(byCategory(s), expected.spent, p.id);
    assert.equal(s.incomeCents, expected.income, p.id);
    assert.equal(
      s.spentCents,
      Object.values(expected.spent).reduce((a, b) => a + b, 0),
    );
    // The review list, the window and the list of periods do not depend on the period.
    assert.deepEqual(s.unresolved, all.unresolved);
    assert.deepEqual([s.window, s.periods, s.pending], [all.window, all.periods, all.pending]);
    assert.deepEqual((await get('insights/spending', `?period=${p.id}`)).body, s);
    spent += s.spentCents;
    income += s.incomeCents;
    count += s.unresolvedInPeriod.count;
  }
  assert.deepEqual([spent, income, count], [all.spentCents, all.incomeCents, all.unresolved.count]);
});

test('IT8 HTTP: `current`, a month with no movements, and an invalid period', async () => {
  const current = (await get('dashboard', '?period=current')).body.insights;
  assert.equal(current.period, madridMonth(new Date().toISOString()));
  assert.ok(current.periods.some((p: any) => p.id === current.period));

  const empty = (await get('insights/spending', '?period=2031-01')).body;
  assert.deepEqual(
    [empty.period, empty.spentCents, empty.incomeCents, empty.categories],
    ['2031-01', 0, 0, []],
  );

  for (const [route, query] of [
    ['dashboard', '?period=2026-13'],
    ['dashboard', '?period=october'],
    ['dashboard', '?period=all&period=2026-09'],
    ['insights/spending', '?period=2026-9'],
    ['insights/spending', '?period=2026-09&from=2026-09-01'],
  ]) {
    const { status, body } = await get(route, query);
    assert.deepEqual([status, body.error], [400, 'Invalid request data.'], route + query);
  }
});

// IT8b: the period may come in the `x-insights-period` request header instead of the query.
test('IT8b the `x-insights-period` header is the query parameter by another transport', async () => {
  const header = (value: string) => ({ 'x-insights-period': value });
  const expected = {
    all: 'all',
    current: madridMonth(new Date().toISOString()),
    '2026-09': '2026-09',
  };
  for (const route of ['dashboard', 'insights/spending']) {
    const summary = (body: any) => (route === 'dashboard' ? body.insights : body);
    for (const [value, period] of Object.entries(expected)) {
      const byHeader = await get(route, '', header(value));
      assert.equal(byHeader.status, 200, `${route} ${value}`);
      assert.equal(summary(byHeader.body).period, period, `${route} ${value}`);
      assert.deepEqual(byHeader.body, (await get(route, `?period=${value}`)).body);
    }
    // Neither given: the whole window, as before.
    assert.deepEqual((await get(route)).body, (await get(route, '', header('all'))).body);

    for (const [query, value] of [
      ['', 'october'],
      ['', '2026-13'],
      ['', ''],
      ['', 'all, 2026-09'], // what a repeated header reads as
      ['?period=2026-09', '2026-09'], // both transports, even when they agree
      ['?period=all', 'current'],
    ]) {
      const { status, body } = await get(route, query, header(value));
      assert.deepEqual(
        [status, body.error],
        [400, 'Invalid request data.'],
        `${route}${query} "${value}"`,
      );
    }
  }
  const mixed = await get('insights/spending', '?from=2026-09-01', header('2026-09'));
  assert.deepEqual([mixed.status, mixed.body.error], [400, 'Invalid request data.']);
});

// A view of the pure function: one confirmed grocery payment per date.
function viewOf(dates: string[]) {
  const movements = dates.map((createdAt, i) => ({
    id: `m${i}`,
    accountId: 'a',
    amountCents: -100,
    description: 'SHOP',
    createdAt,
  }));
  const category = { id: 'groceries', state: 'confirmed', merchantKey: 'SHOP', candidates: [] };
  return { movements, categories: new Map(movements.map((m) => [m.id, category])) } as any;
}

test('IT8 the month is the Europe/Madrid one, on both sides of midnight', () => {
  const at = (iso: string) => parsePeriod(new URLSearchParams('period=current'), new Date(iso));
  // Winter time (UTC+1) and summer time (UTC+2).
  assert.deepEqual(
    [at('2026-10-31T22:59:59Z'), at('2026-10-31T23:00:00Z')],
    ['2026-10', '2026-11'],
  );
  assert.deepEqual(
    [at('2026-08-31T21:59:59Z'), at('2026-08-31T22:00:00Z')],
    ['2026-08', '2026-09'],
  );
  assert.equal(parsePeriod(new URLSearchParams('')), 'all');
  // DS2: `last` is the month before that one, by the same clock; December from January.
  const last = (iso: string) => parsePeriod(new URLSearchParams('period=last'), new Date(iso));
  assert.deepEqual(
    [last('2026-10-31T22:59:59Z'), last('2026-10-31T23:00:00Z'), last('2027-01-15T10:00:00Z')],
    ['2026-09', '2026-10', '2026-12'],
  );

  const view = viewOf(['2026-10-31T22:59:59Z', '2026-10-31T23:00:00Z', '2026-11-02T10:00:00Z']);
  const s = (period: string) =>
    periodSummary(view, period, 'none', new Date('2026-11-03T10:00:00Z'));
  assert.deepEqual(
    [s('2026-10').spentCents, s('2026-11').spentCents, s('all').spentCents],
    [100, 200, 300],
  );
});

test('IT8 partial: the month in progress, the month a truncated window starts in, an empty current month', () => {
  const now = new Date('2026-12-15T10:00:00Z');
  const dates = (n: number, month: string) =>
    Array.from(
      { length: n },
      (_, i) => `${month}-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`,
    );

  const small = periodSummary(
    viewOf([...dates(3, '2026-11'), ...dates(2, '2026-10')]),
    '2026-12',
    'none',
    now,
  );
  assert.deepEqual(small.periods, [
    { id: '2026-12', label: 'Dec 2026', count: 0, partial: true, partialReason: 'in_progress' },
    { id: '2026-11', label: 'Nov 2026', count: 3, partial: false },
    { id: '2026-10', label: 'Oct 2026', count: 2, partial: false },
    { id: 'all', label: 'All movements', count: 5, partial: false },
  ]);
  assert.deepEqual([small.spentCents, small.incomeCents, small.categories], [0, 0, []]);

  const full = periodSummary(
    viewOf([...dates(60, '2026-12'), ...dates(40, '2026-11')]),
    'all',
    'none',
    now,
  );
  assert.deepEqual(
    full.periods.map((p) => [p.id, p.partialReason]),
    [
      ['2026-12', 'in_progress'],
      ['2026-11', 'window'],
      ['all', 'window'],
    ],
  );
});

// ---- IT8c: day ranges and years (contracts.md §3 "Periods", 2.21) ----

const madridDay = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

test('IT8c demo bank: a range is the sum of its rows, ranges add up to the month, a year to its months', async () => {
  const dash = (await get('dashboard')).body;
  const all = dash.insights;
  const spending = async (period: string) => {
    const { status, body } = await get('insights/spending', `?period=${period}`);
    assert.equal(status, 200, period);
    assert.equal(body.period, period);
    // Both routes and both transports, the same answer.
    assert.deepEqual(
      (await get('dashboard', '', { 'x-insights-period': period })).body.insights,
      body,
    );
    return body;
  };
  const rowsIn = (from: string, to: string) =>
    dash.movements.filter(
      (m: any) => madridDay(m.createdAt) >= from && madridDay(m.createdAt) <= to,
    );
  const check = async (from: string, to: string) => {
    const s = await spending(`${from}..${to}`);
    const expected = sums(rowsIn(from, to));
    assert.deepEqual(byCategory(s), expected.spent, `${from}..${to}`);
    assert.equal(s.incomeCents, expected.income);
    assert.deepEqual(s.range, { from, to });
    assert.deepEqual(
      [s.unresolved, s.pending, s.periods],
      [all.unresolved, all.pending, all.periods],
    );
    return s;
  };
  const september = await spending('2026-09');
  assert.deepEqual(september.range, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual([september.partial, 'partialReason' in september], [false, false]);
  const [first, second] = [
    await check('2026-09-01', '2026-09-15'),
    await check('2026-09-16', '2026-09-30'),
  ];
  assert.ok(first.spentCents > 0 && second.spentCents > 0, 'both halves have spending');
  for (const key of ['spentCents', 'incomeCents'])
    assert.equal(first[key] + second[key], september[key], key);
  assert.equal(
    first.unresolvedInPeriod.count + second.unresolvedInPeriod.count,
    september.unresolvedInPeriod.count,
  );
  // One day, and a week across the month boundary.
  const day = await check('2026-09-01', '2026-09-01');
  assert.ok(day.categories.length > 0, 'the demo seed has movements on 1 September');
  await check('2026-08-31', '2026-09-06');

  // The demo seed is all in 2026: the year is the sum of its months, and the whole window.
  const year = await spending('2026');
  assert.deepEqual(year.range, { from: '2026-01-01', to: '2026-12-31' });
  const months = all.periods.filter((p: any) => p.id.startsWith('2026-'));
  let spent = 0;
  for (const p of months)
    spent += (await get('insights/spending', `?period=${p.id}`)).body.spentCents;
  assert.deepEqual([year.spentCents, year.incomeCents], [spent, all.incomeCents]);
  assert.deepEqual(year.categories, all.categories);
  const empty = await spending('2025');
  assert.deepEqual([empty.spentCents, empty.incomeCents, empty.categories], [0, 0, []]);
  assert.deepEqual([empty.partial, 'partialReason' in empty], [false, false]);

  // `today` and the window's days, on every period.
  const days = dash.movements.map((m: any) => madridDay(m.createdAt)).sort();
  for (const s of [all, september, first, year]) {
    assert.equal(s.today, madridDay(new Date().toISOString()));
    assert.deepEqual([s.window, s.windowDays], [all.window, { from: days[0], to: days.at(-1) }]);
  }
  assert.deepEqual([all.range, all.partial], [{ from: null, to: null }, false]);
  const current = (await get('dashboard', '?period=current')).body.insights;
  assert.deepEqual([current.partial, current.partialReason], [true, 'in_progress']);
  assert.deepEqual(current.range.from, `${current.period}-01`);
});

test('IT8c HTTP: an invalid range or year is a 400 on both transports', async () => {
  for (const value of [
    '2026-09-15..2026-09-01', // reversed
    '2026-02-30..2026-03-01', // not a calendar date
    '2026-09-01..2026-09-31',
    '2026-1-1..2026-1-2',
    '2026-09-01...2026-09-15',
    '2026-09-01..2026-09-15 ',
    '2026-09-01..',
    '2026-09-01',
    '20261',
    '202',
  ])
    for (const route of ['dashboard', 'insights/spending']) {
      const byQuery = await get(route, `?period=${encodeURIComponent(value)}`);
      assert.deepEqual([byQuery.status, byQuery.body.error], [400, 'Invalid request data.'], value);
      // A header's trailing space is not part of its value, so that one is the valid range.
      if (value.endsWith(' ')) continue;
      const byHeader = await get(route, '', { 'x-insights-period': value });
      assert.deepEqual(
        [byHeader.status, byHeader.body.error],
        [400, 'Invalid request data.'],
        value,
      );
    }
  const mixed = await get('insights/spending', '?period=2026-09-01..2026-09-15&to=2026-09-10');
  assert.equal(mixed.status, 400);
});

test('IT8c the day is the Europe/Madrid one: the DST change, a month boundary, `today`', () => {
  // 25 Oct 2026: clocks go back at 01:00Z, so the day starts at 22:00Z and ends at 23:00Z.
  const view = viewOf([
    '2026-10-24T21:59:00Z', // 24 Oct 23:59
    '2026-10-24T22:00:00Z', // 25 Oct 00:00
    '2026-10-25T22:59:00Z', // 25 Oct 23:59
    '2026-10-25T23:00:00Z', // 26 Oct 00:00
    '2026-10-31T22:59:00Z', // 31 Oct 23:59
    '2026-10-31T23:00:00Z', // 1 Nov 00:00
    '2025-12-31T22:59:00Z', // 31 Dec 2025 23:59
    '2025-12-31T23:00:00Z', // 1 Jan 2026 00:00
  ]);
  const s = (period: string, now = '2026-11-03T10:00:00Z') =>
    periodSummary(view, period, 'none', new Date(now));
  const spent = (period: string) => s(period).spentCents;
  assert.deepEqual(
    ['2026-10-24..2026-10-24', '2026-10-25..2026-10-25', '2026-10-26..2026-10-26'].map(spent),
    [100, 200, 100],
  );
  assert.deepEqual(
    ['2026-10-26..2026-10-31', '2026-10-26..2026-11-01', '2026-11-01..2026-11-01'].map(spent),
    [200, 300, 100],
  );
  assert.deepEqual(['2025', '2026', 'all'].map(spent), [100, 700, 800]);
  assert.equal(spent('2026'), spent('2026-01') + spent('2026-10') + spent('2026-11'));
  assert.deepEqual(s('2026-10').range, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(s('2028-02').range, { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(
    [s('all').windowDays.from, s('all').windowDays.to, s('2025').windowDays.to],
    ['2025-12-31', '2026-11-01', '2026-11-01'],
  );
  assert.deepEqual(
    [
      '2026-10-31T22:59:59Z',
      '2026-10-31T23:00:00Z',
      '2026-08-31T21:59:59Z',
      '2026-08-31T22:00:00Z',
    ].map((now) => s('all', now).today),
    ['2026-10-31', '2026-11-01', '2026-08-31', '2026-09-01'],
  );
  const parse = (period: string) => parsePeriod(new URLSearchParams({ period }));
  assert.equal(parse('2028-02-29..2028-02-29'), '2028-02-29..2028-02-29');
  assert.throws(() => parse('2027-02-29..2027-03-01'));
});

test('IT8c partial of the applied period: the window, in progress, a closed past range', () => {
  const now = new Date('2026-12-15T10:00:00Z');
  const reason = (view: any, period: string) => {
    const s = periodSummary(view, period, 'none', now);
    assert.equal(s.partial, s.partialReason !== undefined);
    return s.partialReason;
  };
  const dates = (n: number, month: string) =>
    Array.from(
      { length: n },
      (_, i) => `${month}-${String(10 + (i % 15)).padStart(2, '0')}T10:00:00Z`,
    );
  // A full page (100): the window starts on 10 November and may be cut there.
  const full = viewOf([...dates(60, '2026-12'), ...dates(40, '2026-11')]);
  // Not a full page: the bank has nothing older, so a period reaching back is complete.
  const small = viewOf([...dates(3, '2026-12'), ...dates(2, '2026-11')]);
  const periods = [
    '2026-11-01..2026-11-20', // starts before the window
    '2026-11-10..2026-11-12', // starts on the window's oldest day
    '2026-11-11..2026-11-30', // closed, inside the window
    '2026-12-01..2026-12-14', // closed yesterday
    '2026-12-14..2026-12-15', // ends today
    '2026-12-01..2027-01-31', // ends later
    '2026', // reaches before the window and is in progress
    '2026-11',
    '2025',
  ];
  assert.deepEqual(
    periods.map((p) => reason(full, p)),
    [
      'window',
      'window',
      undefined,
      undefined,
      'in_progress',
      'in_progress',
      'window',
      'window',
      'window',
    ],
  );
  assert.deepEqual(
    periods.map((p) => reason(small, p)),
    [
      undefined,
      undefined,
      undefined,
      undefined,
      'in_progress',
      'in_progress',
      'in_progress',
      undefined,
      undefined,
    ],
  );
  // The applied period agrees with its entry in `periods`.
  const s = periodSummary(full, '2026-11', 'none', now);
  assert.equal(s.periods.find((p) => p.id === '2026-11')!.partialReason, s.partialReason);
});

test('IT8c `all` and a month keep every figure they had: only fields were added', () => {
  const view = viewOf(['2026-09-30T21:59:00Z', '2026-09-30T22:00:00Z', '2026-10-20T10:00:00Z']);
  const now = new Date('2026-12-15T10:00:00Z');
  const { today, period, periods, unresolvedInPeriod, windowDays, ...rest } = periodSummary(
    view,
    'all',
    'none',
    now,
  );
  assert.deepEqual(rest, spendingSummary(view, {}, 'none'));
  assert.deepEqual(
    [today, period, windowDays],
    ['2026-12-15', 'all', { from: '2026-09-30', to: '2026-10-20' }],
  );

  const month = periodSummary(view, '2026-10', 'none', now);
  const rows = { ...view, movements: view.movements.slice(1) };
  const old = spendingSummary(rows, {}, 'none');
  for (const key of ['spentCents', 'incomeCents', 'categories', 'decider'] as const)
    assert.deepEqual(month[key], old[key], key);
  assert.deepEqual(
    [month.unresolved, month.pending, month.periods],
    [rest.unresolved, rest.pending, periods],
  );
  assert.deepEqual(month.unresolvedInPeriod, { count: 0, debitCents: 0 });
});

test('IT8 the assistant tool still answers for the whole window, without the period fields', async () => {
  const all = (await get('dashboard')).body.insights;
  const ctx = { userId: 'lucia', conversationId: null, runId: 'it8', intentId: 'it8' };
  const tool: any = await insightsTools.get_spending_summary({ from: null, to: null }, ctx);
  assert.deepEqual(
    [tool.spentCents, tool.incomeCents, tool.unresolved.count, 'period' in tool, 'periods' in tool],
    [all.spentCents, all.incomeCents, all.unresolved.count, false, false],
  );
  assert.equal('period' in spendingSummary(viewOf([]), {}, 'none'), false);
});
