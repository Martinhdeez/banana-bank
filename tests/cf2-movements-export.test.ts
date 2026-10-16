// CF2: GET /api/movements/export.csv, the CF3 search rows as a CSV file (RFC 4180, UTF-8 BOM, CRLF,
// formula-injection guard on text columns). Runs against the simulator or, with BANK_IMPL=alt, the
// alt bank (bank-specific ids are only asserted on the simulator).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-cf2-');
const alt = process.env.BANK_IMPL === 'alt';
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { closeAppDb } = await import('../src/db');
const { csvField, movementsCsv } = await import('../src/banking/movements');
const { routeLabel } = await import('../src/http');
const { emptyFilters, movementExportHref } = await import('../app/_components/MovementFilters');
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

// A minimal RFC 4180 reader, to check the file round-trips.
function parseCsv(text: string) {
  const rows: string[][] = [[]];
  let field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (rows.at(-1)!.push(field), (field = ''));
    else if (c === '\r' && text[i + 1] === '\n')
      (rows.at(-1)!.push(field), (field = ''), rows.push([]), i++);
    else field += c;
  }
  if (field || rows.at(-1)!.length) rows.at(-1)!.push(field);
  else rows.pop();
  return rows;
}
const HEADER = 'date,account,description,details,direction,amount,currency,reference';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  kind: 'movement' as const,
  title: 'Coffee',
  detail: '',
  amountCents: -234,
  account: 'Aurora account',
  accountId: 'acc-lucia',
  createdAt: '2026-09-23T16:41:12.000Z',
  direction: 'sent' as const,
  ...over,
});

test('CF2 csvField: RFC 4180 quoting and the formula guard on text only', () => {
  assert.equal(csvField('plain', true), 'plain');
  assert.equal(csvField('a,b', true), '"a,b"');
  assert.equal(csvField('say "hi"', true), '"say ""hi"""');
  assert.equal(csvField('two\r\nlines', true), '"two\r\nlines"');
  assert.equal(csvField('=1+1', true), "'=1+1");
  assert.equal(csvField('+34 600', true), "'+34 600");
  assert.equal(csvField('-cmd', true), "'-cmd");
  assert.equal(csvField('@SUM(A1)', true), "'@SUM(A1)");
  assert.equal(csvField('\tx', true), "'\tx");
  assert.equal(csvField('\rx', true), '"\'\rx"');
  assert.equal(csvField('=HYPERLINK("http://x","y")', true), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(csvField('-2.34', false), '-2.34');
});

test('CF2 movementsCsv: BOM, CRLF, header, signed amounts from integer cents', () => {
  assert.equal(movementsCsv([]), `\uFEFF${HEADER}\r\n`);
  const csv = movementsCsv(
    [1, 10, 100000, -85000, -234].map((amountCents, i) =>
      row({
        id: `m${i}`,
        amountCents,
        title: i ? 'Sent to Carla Ríos' : '=cmd',
        detail: 'a, "b"\nc',
      }),
    ),
  );
  assert.ok(csv.startsWith('\uFEFFdate,account'));
  assert.ok(csv.endsWith('\r\n'));
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows[0].join(','), HEADER);
  assert.ok(
    rows.every((r) => r.length === 8),
    'constant field count',
  );
  assert.deepEqual(
    rows.slice(1).map((r) => r[5]),
    ['0.01', '0.10', '1000.00', '-850.00', '-2.34'],
  );
  assert.deepEqual(rows[1], [
    '2026-09-23T16:41:12.000Z',
    'Aurora account',
    "'=cmd",
    'a, "b"\nc',
    'sent',
    '0.01',
    'EUR',
    'm0',
  ]);
  assert.equal(rows[2][2], 'Sent to Carla Ríos');
  // The reference is the bank operation when the caller gives one.
  assert.equal(parseCsv(movementsCsv([{ ...row(), reference: 'op-1' }]).slice(1))[1][7], 'op-1');
});

test('CF2 UI link: the search query, the account alone, or every movement', () => {
  const href = (v: Partial<typeof emptyFilters>, account: string | null = null) =>
    movementExportHref({ ...emptyFilters, ...v }, account);
  assert.equal(href({}), '/api/movements/export.csv');
  assert.equal(href({}, 'acc-lucia'), '/api/movements/export.csv?account=acc-lucia');
  assert.equal(
    href({ q: 'team', direction: 'sent' }, 'acc-lucia'),
    '/api/movements/export.csv?q=team&direction=sent&account=acc-lucia',
  );
  assert.equal(href({ min: 'abc' }), null);
  assert.equal(href({ min: '20', max: '10' }), null);
});

test('CF2 routeLabel keeps export.csv (no id)', () => {
  assert.equal(routeLabel(['movements', 'export.csv']), 'movements/export.csv');
  assert.equal(routeLabel(['conversations', 'abc']), 'conversations/:id');
});

const exportCsv = async (query = '', cookie?: string) =>
  GET(
    new Request(`http://localhost/api/movements/export.csv${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ path: ['movements', 'export.csv'] }) },
  );
const as = (userId: string) => `banana_actor=${sessionToken(userId)}`;

test('CF2 route: filtered file, headers, window header', async () => {
  const response = await exportCsv('?from=2026-09-23&to=2026-09-23&q=team+dinner', as('lucia'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="banana-movements-2026-09-23-2026-09-23.csv"',
  );
  assert.match(
    response.headers.get('x-movements-window') ?? '',
    /^returned=\d+; limit=100; truncated=(true|false); oldest=(\S+Z|none)$/,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const rows = parseCsv(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
  assert.equal(rows[0].join(','), HEADER);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const [date, account, description, details, direction, amount, currency, reference] = rows[1];
  assert.equal(date, '2026-09-23T16:41:12.000Z');
  assert.equal(account, 'Aurora account');
  assert.match(`${description} ${details}`, /Team dinner/);
  assert.equal(direction, 'sent');
  assert.equal(amount, '-85.00');
  assert.equal(currency, 'EUR');
  if (!alt) assert.equal(reference, 'op-historic-lucia');
});

test('CF2 route: same rows as GET /api/movements, empty result is a header-only file', async () => {
  const search = await GET(
    new Request('http://localhost/api/movements?direction=received', {
      headers: { cookie: as('lucia') },
    }),
    { params: Promise.resolve({ path: ['movements'] }) },
  );
  const { rows: found } = (await search.json()) as any;
  const file = parseCsv(
    (await (await exportCsv('?direction=received', as('lucia'))).text()).replace(/^\uFEFF/, ''),
  );
  assert.deepEqual(
    file.slice(1).map((r) => [r[0], r[2], r[4]]),
    found.map((r: any) => [r.createdAt, r.title, r.direction]),
  );
  const none = await exportCsv('?q=no+such+movement+cf2', as('lucia'));
  assert.equal(none.status, 200);
  // text() drops the BOM (UTF-8 decode); the bytes are checked above.
  assert.equal(await none.text(), `${HEADER}\r\n`);
  const noFrom = await exportCsv('', as('lucia'));
  assert.match(
    noFrom.headers.get('content-disposition') ?? '',
    /^attachment; filename="banana-movements-all-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
});

test('CF2 route: 400 on bad query, 401 without or with an expired session, 403 operator', async () => {
  const error = async (response: Response) => [
    response.status,
    ((await response.json()) as any).error,
  ];
  const invalid = [400, 'Invalid request data.'];
  assert.deepEqual(await error(await exportCsv('?foo=1', as('lucia'))), invalid);
  assert.deepEqual(await error(await exportCsv('?q=a&q=b', as('lucia'))), invalid);
  assert.deepEqual(await error(await exportCsv('?direction=pending', as('lucia'))), invalid);
  assert.deepEqual(await error(await exportCsv('?account=acc-hugo', as('lucia'))), [
    400,
    'Unknown account.',
  ]);
  assert.deepEqual(await error(await exportCsv('')), [401, 'Select a person to continue.']);
  const old = `banana_actor=${sessionToken('lucia', Math.floor(Date.now() / 1000) - 43201)}`;
  assert.deepEqual(await error(await exportCsv('', old)), [
    401,
    'Your session expired. Select a person again.',
  ]);
  assert.equal((await exportCsv('', as('marta'))).status, 403);
  // Only the export path is a route: anything else under movements is a 404.
  const other = await GET(
    new Request('http://localhost/api/movements/export.json', { headers: { cookie: as('lucia') } }),
    { params: Promise.resolve({ path: ['movements', 'export.json'] }) },
  );
  assert.equal(other.status, 404);
});
