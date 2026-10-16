// UP1: the operator's AI usage report over the last 30 Madrid days and over a chosen range of
// Madrid calendar days (`to` inclusive), with a bad range refused, never silently widened.
// The real route handler on a temp database; rows are written with chosen instants. No network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';

const { temp } = await setupEnv('banana-up1-');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const report = await import('../src/usage/report');
const api = await import('../app/api/[...path]/route');
seedApp();
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const insert = appDb().prepare(
  `INSERT INTO ai_usage(created_at,actor,user_id,consumer,seq,attempt,outcome,model,host,tools,cost_basis)
   VALUES(?,'customer','lucia','assistant',1,1,'ok','m','h','[]','unpriced')`,
);
const at = (...instants: string[]) => instants.forEach((i) => insert.run(i));
async function get(route: string) {
  const response = await api.GET(
    new Request(`http://localhost/api/${route}`, {
      headers: { cookie: `banana_actor=${sessionToken('marta')}` },
    }),
    { params: Promise.resolve({ path: route.split('?')[0].split('/') }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    disposition: response.headers.get('content-disposition'),
    body: text.startsWith('{') ? JSON.parse(text) : null,
  };
}
const madridDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);

// Madrid moves to summer time on 29 March 2026 (a 23-hour day): 28 Mar starts 2026-03-27T23:00Z,
// 30 Mar starts 2026-03-29T22:00Z. A "+24 h per day" end would wrongly take the 22:00Z row.
at(
  '2026-03-27T22:59:59.000Z', // 27 Mar 23:59 Madrid: out
  '2026-03-27T23:00:00.000Z', // 28 Mar 00:00 Madrid: in
  '2026-03-29T21:59:59.000Z', // 29 Mar 23:59 Madrid: in
  '2026-03-29T22:00:00.000Z', // 30 Mar 00:00 Madrid: out
);

test('UP1: a range is Madrid days, `to` inclusive, across the March DST change', async () => {
  const q = 'period=range&from=2026-03-28&to=2026-03-29';
  const { status, body } = await get(`usage?${q}`);
  assert.equal(status, 200);
  assert.equal(body.period, 'range');
  assert.equal(body.from, '2026-03-28');
  assert.equal(body.to, '2026-03-29');
  assert.equal(body.since, '2026-03-27T23:00:00.000Z');
  assert.equal(body.until, '2026-03-29T22:00:00.000Z');
  assert.equal(body.totals.requests, 2);
  const customer = await get(`usage?customer=lucia&${q}`);
  assert.equal(customer.status, 200);
  assert.equal(customer.body.until, '2026-03-29T22:00:00.000Z');
  assert.equal(customer.body.totals.requests, 2);
  const csv = await get(`usage/export.csv?${q}`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /\r\nlucia,[^\r]*?,2,/);
  assert.match(csv.disposition ?? '', /2026-03-28.*2026-03-29/);
});

test('UP1: the October change makes 25 Oct a 25-hour day; the end is the next Madrid midnight', () => {
  const w = report.usageWindow(
    { period: 'range', from: '2026-10-24', to: '2026-10-25' },
    new Date('2026-10-26T10:00:00Z'),
  );
  assert.deepEqual(w, {
    period: 'range',
    since: '2026-10-23T22:00:00.000Z',
    until: '2026-10-25T23:00:00.000Z',
    from: '2026-10-24',
    to: '2026-10-25',
  });
});

test('UP1: 30d is today and the 29 Madrid days before it', async () => {
  assert.deepEqual(report.usageWindow({ period: '30d' }, new Date('2026-10-07T10:00:00Z')), {
    period: '30d',
    since: '2026-09-07T22:00:00.000Z',
    until: null,
  });
  const start = Date.parse(report.madridDayStart(new Date(), 29));
  const before = (await get('usage?period=30d')).body.totals.requests;
  at(new Date(start - 1000).toISOString(), new Date(start).toISOString());
  const { status, body } = await get('usage?period=30d');
  assert.equal(status, 200);
  assert.equal(body.period, '30d');
  assert.equal(body.since, new Date(start).toISOString());
  assert.equal(body.until, null);
  assert.equal(body.totals.requests, before + 1);
});

test('UP1: a bad range is a 400 on the overview, the customer view and the CSV', async () => {
  const tomorrow = madridDate(new Date(Date.parse(report.madridDayStart(new Date(), -1)) + 3.6e6));
  const today = madridDate(new Date());
  const bad = [
    'period=range&from=2026-02-30&to=2026-03-01', // not a real date
    'period=range&from=2026-3-1&to=2026-03-02', // not YYYY-MM-DD
    'period=range&from=2026-03-02&to=2026-03-01', // from after to
    `period=range&from=${today}&to=${tomorrow}`, // to in the future
    'period=range&from=2026-03-01', // missing to
    'period=range&to=2026-03-01', // missing from
    'period=range', // missing both
    'period=7d&from=2026-03-01&to=2026-03-02', // a range on a fixed period
    'from=2026-03-01&to=2026-03-02', // a range on the default period
    'period=range&from=2026-03-01&to=2026-03-02&from=2026-03-01', // repeated key
  ];
  for (const q of bad)
    for (const route of [`usage?${q}`, `usage?customer=lucia&${q}`, `usage/export.csv?${q}`]) {
      const r = await get(route);
      assert.equal(r.status, 400, route);
      assert.deepEqual(r.body, { error: 'Invalid request data.' }, route);
    }
  assert.equal((await get(`usage?period=range&from=${today}&to=${today}`)).status, 200);
});

test('UP1: today, 7d and all keep their start, with no end', async () => {
  for (const [period, back] of [
    ['today', 0],
    ['7d', 6],
  ] as const) {
    const { status, body } = await get(`usage?period=${period}`);
    assert.equal(status, 200);
    assert.equal(body.period, period);
    assert.equal(body.since, report.madridDayStart(new Date(), back));
    assert.equal(body.until, null);
    assert.equal('from' in body, false);
  }
  const all = (await get('usage?period=all')).body;
  assert.equal(all.since, null);
  assert.equal(all.until, null);
  assert.equal(all.totals.requests, appDb().prepare('SELECT COUNT(*) FROM ai_usage').pluck().get());
  assert.equal((await get('usage')).body.period, '7d');
  assert.match(
    (await get('usage/export.csv?period=7d')).disposition ?? '',
    /banana-ai-usage-7d\.csv/,
  );
});
