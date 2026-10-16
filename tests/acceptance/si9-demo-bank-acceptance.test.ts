// SI9 acceptance tests (V-cycle, independent test author; branch test/si9-demo-bank).
// Written from docs/plan/23-spend-insights/requirements.md (REQ-SI9-1…6), contracts.md §5 and §7,
// the dataset tables in inputs/demo-bank-dataset-proposal.md and docs/contracts.md ("Bank HTTP
// API"), without seeing the implementation. Public surface only: the alt bank as a process over
// HTTP, `npm run demo` and `npm run test:alt-bank` as commands. Nothing from src/ is imported and
// no model is called. Builders never edit this file.
// DS2 (contracts.md 2.31 and 2.32), reconciled by a third party on PR #170: the demo seed holds rows
// for all eight customers, 1 July to 5 October 2026, and the table of record is
// inputs/demo-bank-dataset.md. Four checks changed, each marked "DS2 reconciliation"; their
// expected values are the contract's §7 figures and that table, never the bank's output.
// DS3 (contracts.md 2.34 and 2.35), reconciled by a third party on PR #183: 170 rows were added
// (none changed), the window ends on 6 October and the openings rose; the same four checks
// changed again, each marked "DS3 reconciliation". Their figures were recomputed from the seed
// file alone before they were written here (.scratch/after/feat-ds3-realistic-demo-data/
// reconcile-recompute.mjs).
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from '../helpers/bank';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEED_FILE = 'tests/alt-bank/demo-seed.json'; // contracts.md §7
const SECRET = 'banana-local-service';
const CONTROL = 'alt-control';
const SIMULATOR_SHA256 = 'd1c0302c236c7a2994f3c792e00f7c2c900b936f2f178b4c1abeab2e498fd43e';

type Movement = {
  id: string;
  accountId: string;
  operationId: string | null;
  amountCents: number;
  description: string;
  createdAt: string;
};
type Account = { id: string; userId: string; balanceCents: number };
type State = { accounts: Account[]; operations: unknown[]; options: unknown };

// A child environment that owes nothing to the caller's shell: no bank, app, decider or key
// settings leak in, and a nested `node --test` is not mistaken for a subtest.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(ALT_BANK_|DEMO_|DECIDER|BANK_|NODE_TEST_CONTEXT$|OPENAI_API_KEY$|DATA_DIR$|APP_PORT$|APP_URL$|PORT$)/.test(
        key,
      )
    )
      delete env[key];
  return { ...env, BANK_SERVICE_SECRET: SECRET, ...extra };
}

const children = new Set<ChildProcess>();
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
async function stop(child: ChildProcess) {
  children.delete(child);
  child.kill();
  await exited(child);
}
after(async () => {
  for (const child of [...children]) await stop(child);
});

async function startBank(seeded: boolean, file = SEED_FILE) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/alt-bank/server.ts'], {
    cwd: ROOT,
    env: cleanEnv({
      BANK_PORT: String(port),
      ALT_BANK_MOVEMENTS_LIMIT: '100',
      ...(seeded ? { ALT_BANK_SEED_FILE: file } : {}),
    }),
    stdio: 'ignore',
  });
  children.add(child);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, child };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop(child);
  throw new Error(`The alt bank did not start (seed file ${seeded ? 'set' : 'unset'}).`);
}

// Signed as docs/contracts.md defines it.
async function bank(url: string, actor: string, pathWithQuery: string, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const raw = body === undefined ? '' : JSON.stringify(body);
  const time = String(Date.now());
  const response = await fetch(url + pathWithQuery, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-bank-actor': actor,
      'x-bank-time': time,
      'x-bank-signature': createHmac('sha256', SECRET)
        .update([method, pathWithQuery, actor, time, raw].join('\n'))
        .digest('hex'),
    },
    body: body === undefined ? undefined : raw,
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function control(url: string, route: string, body?: unknown, token: string | null = CONTROL) {
  const response = await fetch(`${url}/_control/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: token === null ? {} : { 'x-alt-control': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const movementsOf = async (url: string, actor: string) =>
  (await bank(url, actor, '/v1/movements')).body as Movement[];
const stateOf = async (url: string) => (await control(url, 'state')).body as State;
const balanceOf = async (url: string, accountId: string) =>
  (await stateOf(url)).accounts.find((a) => a.id === accountId)!.balanceCents;
const isOpening = (m: Movement) => m.id.startsWith('m-open-');

// ---- The dataset (inputs/demo-bank-dataset-proposal.md, tables `lucia` and `bruno`) ------------
// [row number, local time in Europe/Madrid, cents, description]. The window is all CEST (UTC+2).
// Rows with a counterparty in the roster are transfers and are listed apart: Lucía 11 and 30 (to
// her savings) and the EXISTING `ref-historic-lucia` (Lucía 26, Bruno 25).
type Row = [number, string, number, string];
const MERCADONA = 'COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES';
const LUCIA: Row[] = [
  [1, '2026-08-04 08:00', -95000, 'RECIBO ALQUILER INMOB. CASTELLANA 41 SL'],
  [2, '2026-08-05 08:00', -6743, 'RECIBO IBERDROLA CLIENTES SAU'],
  [3, '2026-08-08 11:20', -5432, MERCADONA],
  [4, '2026-08-10 08:00', -3990, 'RECIBO DIGI SPAIN TELECOM SLU'],
  [5, '2026-08-14 06:00', -1099, 'PAYPAL *SPOTIFY 35314369001'],
  [6, '2026-08-16 01:30', -1400, 'LA ESQUINA SL'],
  [7, '2026-08-19 23:00', -2399, 'AMZN Mktp ES*2K4LL0P93'],
  [8, '2026-08-22 11:05', -6107, MERCADONA],
  [9, '2026-08-25 10:00', -15000, 'TRANSFERENCIA 000123'],
  [10, '2026-08-28 08:00', 215000, 'NOMINA AGOSTO ACME CONSULTING SL'],
  [12, '2026-08-31 08:10', -3270, 'RECARGA ABONO TRANSPORTE CRTM'],
  [13, '2026-09-01 08:00', -95000, 'RECIBO ALQUILER INMOB. CASTELLANA 41 SL'],
  [14, '2026-09-05 08:00', -7120, 'RECIBO IBERDROLA CLIENTES SAU'],
  [15, '2026-09-05 12:10', -4890, MERCADONA],
  [16, '2026-09-06 02:10', -2150, 'LA ESQUINA SL'],
  [17, '2026-09-08 18:20', -1245, 'FARMACIA LDA. M. RUIZ 0001'],
  [18, '2026-09-10 08:00', -3990, 'RECIBO DIGI SPAIN TELECOM SLU'],
  [19, '2026-09-12 13:00', -7640, 'EL CORTE INGLES 0018 MADRID'],
  [20, '2026-09-12 18:30', -4995, 'ZARA ESPANA S.A. 3321 MADRID'],
  [21, '2026-09-13 00:45', -1600, 'LA ESQUINA SL'],
  [22, '2026-09-14 06:00', -1099, 'PAYPAL *SPOTIFY 35314369001'],
  [23, '2026-09-18 20:00', -5000, 'REINTEGRO CAJERO 0921 MADRID'],
  [24, '2026-09-19 11:40', -7215, MERCADONA],
  [25, '2026-09-21 22:30', -4150, 'AMZN Mktp ES*7HH21MM04'],
  [27, '2026-09-27 03:41', -1800, 'TPV BAR LA ESQUINA SL 27/09 03:41'],
  [28, '2026-09-27 04:05', -1135, 'UBER *TRIP HELP.UBER.COM NL'],
  [29, '2026-09-28 08:00', 215000, 'NOMINA SEPTIEMBRE ACME CONSULTING SL'],
  [31, '2026-09-30 08:10', -3270, 'RECARGA ABONO TRANSPORTE CRTM'],
  [32, '2026-10-01 08:00', -95000, 'RECIBO ALQUILER INMOB. CASTELLANA 41 SL'],
];
const SORIANO = 'TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER';
const CONSUM = 'Pago en CONSUM COOP V. VALENCIA';
const BRUNO: Row[] = [
  [1, '2026-08-04 09:00', -62000, SORIANO],
  [2, '2026-08-06 09:05', -1500, 'SUMUP *ESPAI NOU'],
  [3, '2026-08-07 19:30', -3820, CONSUM],
  [4, '2026-08-09 10:00', -2921, 'VALENBISI ABONO ANUAL'],
  [5, '2026-08-12 08:00', 140000, 'TRANSFERENCIA RECIBIDA ESTUDIO NORTE SL FRA 2026-031'],
  [6, '2026-08-12 21:40', -1790, 'GLOVO 12AGO VLC2K7 VALENCIA'],
  [7, '2026-08-15 08:00', -3500, 'VODAFONE ESPANA SAU RECIBO'],
  [8, '2026-08-18 06:00', -3629, 'ADOBE *CREATIVE CLOUD'],
  [9, '2026-08-20 09:10', -1500, 'SUMUP *ESPAI NOU'],
  [10, '2026-08-21 20:10', -4567, CONSUM],
  [11, '2026-08-27 22:05', -2130, 'GLOVO 27AGO VLC9P1 VALENCIA'],
  [12, '2026-08-31 08:00', -29400, 'CUOTA AUTONOMOS TGSS'],
  [13, '2026-09-01 09:00', -62000, SORIANO],
  [14, '2026-09-02 21:00', -4000, 'PAYPAL *JGARCIA88'],
  [15, '2026-09-03 09:00', -1500, 'SUMUP *ESPAI NOU'],
  [16, '2026-09-04 19:45', -2980, CONSUM],
  [17, '2026-09-09 08:00', 98000, 'TRANSFERENCIA RECIBIDA PIXELWORKS BV INV 118'],
  [18, '2026-09-10 21:15', -1560, 'GLOVO 10SEP VLC4T2 VALENCIA'],
  [19, '2026-09-12 02:20', -980, 'CABIFY ESPANA SLU'],
  [20, '2026-09-15 08:00', -3500, 'VODAFONE ESPANA SAU RECIBO'],
  [21, '2026-09-17 09:05', -1500, 'SUMUP *ESPAI NOU'],
  [22, '2026-09-18 06:00', -3629, 'ADOBE *CREATIVE CLOUD'],
  [23, '2026-09-18 20:00', -5112, CONSUM],
  [24, '2026-09-20 13:00', -24900, 'MEDIAMARKT SATURN E-COMMERCE'],
  [26, '2026-09-24 22:30', -1980, 'GLOVO 24SEP VLC1X9 VALENCIA'],
  [27, '2026-09-26 23:10', -2450, 'CERVECERIA EL CABANYAL'],
  [28, '2026-09-30 08:00', 165000, 'TRANSFERENCIA RECIBIDA ESTUDIO NORTE SL FRA 2026-038'],
  [29, '2026-09-30 08:05', -29400, 'CUOTA AUTONOMOS TGSS'],
];
const utc = (local: string) => new Date(`${local.replace(' ', 'T')}:00+02:00`).toISOString();
const seedRows = (persona: string, rows: Row[]) =>
  rows.map(([n, local, amountCents, description]) => ({
    id: `demo-${persona}-${String(n).padStart(3, '0')}`,
    accountId: `acc-${persona}`,
    amountCents,
    description,
    createdAt: utc(local),
  }));
// DS2 reconciliation (contracts.md §7, 2.31 and 2.32): the SI9 rows above are kept; the new rows
// are numbered from 33 to 50 (Lucía) and from 30 to 49 (Bruno). `movements` is the contract's count
// without the initial deposits: Lucía 56 - 2 (47 demo rows, six savings legs, the Team dinner),
// Bruno 50 - 1 (48 demo rows, the Team dinner). It was 32 / 34 and 29 / 29.
// DS3 reconciliation (2.34): the rows of DS3 continue the same ranges, to 80 (Lucía, 30 more)
// and to 69 (Bruno, 20 more): 86 - 2 and 70 - 1 movements. It was to 50 / 54 and to 49 / 49.
const PERSONAS = [
  { persona: 'lucia', rows: LUCIA, added: [33, 80], movements: 84 },
  { persona: 'bruno', rows: BRUNO, added: [30, 69], movements: 69 },
];
// DS2 reconciliation: openings and finals are the contract's "Balances after the seed" (§7, 2.32).
// The finals of the first three are the SI9 ones, kept; their openings were 300000, 90000, 310000.
// DS3 reconciliation (2.34, 2.35): every final is unchanged; the openings of the eight main
// accounts rose by what the added rows spend (they were 253441, 260790 and 61256 here). All
// twelve accounts are now listed: the contract states each opening, the three savings accounts
// the file does not name keeping the bank's own 90000.
const BALANCES = [
  { id: 'acc-lucia', openingCents: 409634, finalCents: 293761 },
  { id: 'acc-lucia-savings', openingCents: 70000, finalCents: 130000 },
  { id: 'acc-bruno', openingCents: 351770, finalCents: 459252 },
  { id: 'acc-carla', openingCents: 349807, finalCents: 208901 },
  { id: 'acc-carla-savings', openingCents: 90000, finalCents: 165000 },
  { id: 'acc-diego', openingCents: 78086, finalCents: 7500 },
  { id: 'acc-elena', openingCents: 358809, finalCents: 286396 },
  { id: 'acc-elena-savings', openingCents: 90000, finalCents: 180000 },
  { id: 'acc-hugo', openingCents: 180234, finalCents: 347212 },
  { id: 'acc-ines', openingCents: 400730, finalCents: 483285 },
  { id: 'acc-ines-savings', openingCents: 90000, finalCents: 120000 },
  { id: 'acc-omar', openingCents: 449198, finalCents: 616022 },
];
// DS2 reconciliation: what contracts.md §7 (2.31, counts as of 2.32) states per customer: the
// movements of `GET /v1/movements` with a page of 100, initial deposits included, and the balances
// after the seed, in cents.
// DS3 reconciliation (2.34): the counts were 56, 50, 60, 59, 59, 63, 64, 54; the balances are
// the same.
const CUSTOMERS: Record<string, { movements: number; balances: Record<string, number> }> = {
  lucia: { movements: 86, balances: { 'acc-lucia': 293761, 'acc-lucia-savings': 130000 } },
  bruno: { movements: 70, balances: { 'acc-bruno': 459252 } },
  carla: { movements: 86, balances: { 'acc-carla': 208901, 'acc-carla-savings': 165000 } },
  diego: { movements: 66, balances: { 'acc-diego': 7500 } },
  elena: { movements: 86, balances: { 'acc-elena': 286396, 'acc-elena-savings': 180000 } },
  hugo: { movements: 78, balances: { 'acc-hugo': 347212 } },
  ines: { movements: 81, balances: { 'acc-ines': 483285, 'acc-ines-savings': 120000 } },
  omar: { movements: 82, balances: { 'acc-omar': 616022 } },
};
// DS3 reconciliation (2.35, §7 "The cap"): no customer has more than 90 seeded movements besides
// the initial deposits. The demo asks the bank for a page of 100; a full page that starts in July
// silences the month forecast and `category_up`, which need July, August and September whole.
// A later seed that goes over fails here by name, not only on a count somebody would re-pin.
const MAX_SEEDED = 90;
const OPENING_AT = '2026-07-01T06:00:00.000Z';
const SEEDED_TRANSFERS = [
  ...['carla', 'elena'].flatMap((u) => ['07', '08', '09'].map((m) => `demo-${u}-savings-${m}`)),
  ...['07', '08', '09'].map((m) => `demo-hugo-rent-${m}`),
  'demo-ines-savings-07',
  'demo-ines-savings-09',
  ...['07', '08', '09'].map((m) => `demo-lucia-savings-${m}`),
  'ref-historic-elena',
  'ref-historic-lucia',
];
// The table of record (inputs/demo-bank-dataset.md): one section per customer, one line per
// movement. A transfer between roster accounts has a random id in this bank ("(transfer)" in the
// table) and the table gives times to the minute, so rows are compared without a transfer's id
// and to the minute.
const DATASET = fs.readFileSync(
  path.join(ROOT, 'docs/plan/23-spend-insights/inputs/demo-bank-dataset.md'),
  'utf8',
);
const TABLE_ROW =
  /^\| (?:`([^`]+)`|\(transfer\)) \| (\d{4}-\d\d-\d\d \d\d:\d\d) \| `([^`]+)` \| (-?[\d,]+)\.(\d\d) \| `(.*)` \| .* \|$/;
function tableRows(customer: string) {
  const section = DATASET.split(/^## /m).find((part) => part.startsWith(`${customer}\n`));
  assert.ok(section, `no section "## ${customer}" in the dataset table`);
  const lines = section
    .split('\n')
    .filter((line) => line.startsWith('| ') && /\d{4}-\d\d-\d\d/.test(line));
  return lines.map((line) => {
    const cells = TABLE_ROW.exec(line);
    assert.ok(cells, `unreadable row of the dataset table: ${line}`);
    const [, id, local, accountId, units, cents, description] = cells;
    const amount = Number(units.replace(/[-,]/g, '')) * 100 + Number(cents);
    return {
      id: id ?? '',
      accountId,
      amountCents: units.startsWith('-') ? -amount : amount,
      description,
      minute: utc(local).slice(0, 16),
    };
  });
}
const sortRows = <T>(rows: T[]) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const SAVINGS_DATES = ['2026-08-29T07:00:00.000Z', '2026-09-29T07:00:00.000Z'];
const HISTORIC_DATE = '2026-09-23T16:41:12.000Z';
const demoIds = (list: Movement[]) => list.filter((m) => m.id.startsWith('demo-'));

let plain: { url: string; child: ChildProcess };
let seeded: { url: string; child: ChildProcess };
before(async () => {
  plain = await startBank(false);
  seeded = await startBank(true);
});
async function assertSeeded() {
  assert.ok(
    demoIds(await movementsOf(seeded.url, 'lucia')).length > 0,
    `the bank started with ALT_BANK_SEED_FILE=${SEED_FILE} serves no demo- movement for lucia`,
  );
}

// ---- REQ-SI9-1 ---------------------------------------------------------------------------------

test('REQ-SI9-1 without ALT_BANK_SEED_FILE the alt bank serves its default data', async () => {
  const lucia = await movementsOf(plain.url, 'lucia');
  assert.equal(demoIds(lucia).length, 0);
  const cards = lucia.filter((m) => /^m-lucia-\d+$/.test(m.id));
  assert.deepEqual(
    cards.map((m) => m.id).sort(),
    Array.from({ length: 30 }, (_, i) => `m-lucia-${i + 1}`).sort(),
  );
  for (const m of cards) {
    assert.equal(m.description, `Card payment ${m.id.split('-')[2]}`);
    assert.equal(m.amountCents, -100);
    assert.equal(m.accountId, 'acc-lucia');
  }
  assert.deepEqual(
    lucia
      .filter(isOpening)
      .map((m) => [m.id, m.description, m.amountCents])
      .sort(),
    [
      ['m-open-acc-lucia', 'Initial deposit', 300000],
      ['m-open-acc-lucia-savings', 'Initial deposit', 90000],
    ],
  );
  const dinner = lucia.filter((m) => m.operationId !== null);
  assert.deepEqual(
    dinner.map((m) => [m.description, m.amountCents, m.createdAt]),
    [['To acc-bruno: Team dinner', -8500, HISTORIC_DATE]],
  );
  assert.equal(lucia.length, 33);
  const bruno = await movementsOf(plain.url, 'bruno');
  assert.equal(demoIds(bruno).length, 0);
  assert.equal(bruno.filter((m) => /^m-bruno-\d+$/.test(m.id)).length, 30);
  const state = await stateOf(plain.url);
  const balance = (id: string) => state.accounts.find((a) => a.id === id)!.balanceCents;
  assert.equal(balance('acc-lucia'), 300000 - 30 * 100 - 8500);
  assert.equal(balance('acc-lucia-savings'), 90000);
  assert.equal(balance('acc-bruno'), 310000 - 30 * 100 + 8500);
  assert.equal(balance('acc-diego'), 7500);
  assert.equal(state.accounts.length, 12);
  assert.deepEqual((state.operations as any[]).map((o) => o.reference).sort(), [
    'ref-historic-elena',
    'ref-historic-lucia',
  ]);
});

test(
  'REQ-SI9-1 `npm run test:alt-bank` passes without ALT_BANK_SEED_FILE',
  { timeout: 300_000 },
  async () => {
    // Not spawnSync: blocking this process lets the banks close its idle connections.
    const run = spawn('npm', ['run', 'test:alt-bank'], {
      cwd: ROOT,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    run.stdout!.on('data', (chunk) => (output += chunk));
    run.stderr!.on('data', (chunk) => (output += chunk));
    await exited(run);
    assert.equal(run.exitCode, 0, output.slice(-4000));
  },
);

// DS2 reconciliation (contracts.md 2.31, §7). Until 2.30 the file named Lucía and Bruno only and
// this check was "with the seed file, every other customer has the same data as without it":
// the six others were compared with the bank without the file. Since 2.31 the file names all
// eight, so that sentence is false; what it guarded (the file gives a customer exactly its own
// rows and touches nobody else) is kept in two parts:
//   1. with the demo file every customer has the rows of the dataset table, no default row, the
//      contract's count and balances, and every balance is the sum of its account's movements;
//   2. a customer the file does not name has the same data as without it (§7 "Seed file format":
//      only an account with rows in `movements` gets them instead of the default rows), shown
//      with a file cut down to Lucía's part of the demo file.
// "Without the variable nothing changes" stays with the first test of this file.
test('REQ-SI9-1 with the seed file every customer has exactly the rows of the dataset table, and a customer the file does not name has the same data as without it', async () => {
  await assertSeeded();
  const state = await stateOf(seeded.url);
  assert.deepEqual(
    [...new Set(state.accounts.map((a) => a.userId))].sort(),
    Object.keys(CUSTOMERS).sort(),
  );
  assert.deepEqual((state.operations as any[]).map((o) => o.reference).sort(), SEEDED_TRANSFERS);
  for (const [user, want] of Object.entries(CUSTOMERS)) {
    const list = await movementsOf(seeded.url, user);
    const besidesOpenings = list.filter((m) => !isOpening(m)).length;
    assert.ok(
      besidesOpenings <= MAX_SEEDED && list.length < 100,
      `${user} has ${besidesOpenings} seeded movements: over the cap of ${MAX_SEEDED} the page of 100 can cut July off`,
    );
    assert.equal(list.length, want.movements, `movements of ${user}`);
    assert.equal(
      list.filter((m) => /^m-[a-z]+-\d+$/.test(m.id) || /^Card payment/.test(m.description)).length,
      0,
      `${user} still has default "Card payment" rows`,
    );
    for (const m of list) {
      if (isOpening(m)) assert.equal(m.createdAt, OPENING_AT, `${m.id} date`);
      else if (!m.operationId)
        assert.match(m.id, new RegExp(`^demo-${user}-\\d{3}$`), `${m.id} of ${user}`);
    }
    assert.deepEqual(
      sortRows(
        list.map((m) => ({
          id: m.operationId ? '' : m.id,
          accountId: m.accountId,
          amountCents: m.amountCents,
          description: m.description,
          minute: m.createdAt.slice(0, 16),
        })),
      ),
      sortRows(tableRows(user)),
      `rows of ${user} against the dataset table`,
    );
    const mine = state.accounts.filter((a) => a.userId === user);
    assert.deepEqual(
      Object.fromEntries(mine.map((a) => [a.id, a.balanceCents])),
      want.balances,
      `balances of ${user}`,
    );
    for (const a of mine)
      assert.equal(
        list.filter((m) => m.accountId === a.id).reduce((total, m) => total + m.amountCents, 0),
        a.balanceCents,
        `${a.id}: the balance is the sum of its movements`,
      );
  }

  // Part 2: a seed file that names Lucía only.
  const demoFile = JSON.parse(fs.readFileSync(path.join(ROOT, SEED_FILE), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-si9-partial-'));
  const file = path.join(temp, 'lucia-only.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      openings: { 'acc-lucia': demoFile.openings['acc-lucia'] },
      movements: demoFile.movements.filter((m: Movement) => m.accountId === 'acc-lucia'),
      transfers: demoFile.transfers.filter((t: { userId: string }) => t.userId === 'lucia'),
    }),
  );
  const partial = await startBank(true, file);
  try {
    assert.ok(
      demoIds(await movementsOf(partial.url, 'lucia')).length > 0,
      'the partial file is read',
    );
    // Transfer movements and operations get random ids in this bank: compare them without the id.
    const comparable = (list: Movement[]) =>
      sortRows(
        list.map((m) => ({
          ...m,
          id: m.operationId ? '' : m.id,
          operationId: m.operationId ? 'op' : null,
        })),
      );
    for (const user of Object.keys(CUSTOMERS).filter((u) => u !== 'lucia')) {
      const without = await movementsOf(plain.url, user);
      assert.ok(without.length > 0, `the bank without the file has movements for ${user}`);
      assert.deepEqual(
        comparable(await movementsOf(partial.url, user)),
        comparable(without),
        `movements of ${user}`,
      );
      assert.deepEqual(
        (await bank(partial.url, user, '/v1/accounts')).body,
        (await bank(plain.url, user, '/v1/accounts')).body,
        `accounts of ${user}`,
      );
    }
  } finally {
    await stop(partial.child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ---- REQ-SI9-2 ---------------------------------------------------------------------------------

test("REQ-SI9-2 Lucía's and Bruno's seeded movement ids are demo-<persona>-NNN, not the default rows", async () => {
  // DS2 reconciliation: the ids are the SI9 rows and the contract's added range, nothing else (it
  // was "a number from 1 to the 32 / 29 rows of the proposal's table").
  for (const { persona, rows, added, movements } of PERSONAS) {
    const list = await movementsOf(seeded.url, persona);
    assert.equal(
      list.filter((m) => /^m-[a-z]+-\d+$/.test(m.id) || /^Card payment/.test(m.description)).length,
      0,
      `${persona} still has default "Card payment" rows`,
    );
    const ids = demoIds(list).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const id of ids) {
      const n = new RegExp(`^demo-${persona}-(\\d{3})$`).exec(id);
      assert.ok(n, `${id} is not demo-${persona}-NNN`);
      assert.ok(Number(n[1]) >= 1 && Number(n[1]) <= added[1], `${id} is not a row of the table`);
    }
    for (const row of seedRows(persona, rows)) assert.ok(ids.includes(row.id), `${row.id} missing`);
    const news = Array.from(
      { length: added[1] - added[0] + 1 },
      (_, i) => `demo-${persona}-${String(added[0] + i).padStart(3, '0')}`,
    );
    assert.deepEqual(
      [...ids].sort(),
      [...seedRows(persona, rows).map((r) => r.id), ...news].sort(),
      `ids of ${persona}`,
    );
    assert.equal(list.filter((m) => !isOpening(m)).length, movements, `row count of ${persona}`);
  }
});

test('REQ-SI9-2 seeded rows carry the dataset descriptions, amounts and fixed dates (Madrid time stored as UTC)', async () => {
  for (const { persona, rows } of PERSONAS) {
    const byId = new Map((await movementsOf(seeded.url, persona)).map((m) => [m.id, m]));
    for (const row of seedRows(persona, rows)) {
      const m = byId.get(row.id);
      assert.ok(m, `${row.id} missing`);
      const { id, accountId, amountCents, description, createdAt } = m;
      assert.deepEqual({ id, accountId, amountCents, description, createdAt }, row);
    }
  }
});

// DS2 reconciliation (contracts.md §7, 2.31): the window is 2026-07-01 … 2026-10-05 in
// Europe/Madrid (CEST, UTC+2) and holds for every customer. It was 2026-08-04 … 2026-10-02 for
// Lucía and Bruno.
// DS3 reconciliation (2.34): the window ends on 6 October (it ended on the 5th).
test('REQ-SI9-2 every seeded date is inside the contract window 2026-07-01 … 2026-10-06', async () => {
  await assertSeeded();
  for (const persona of Object.keys(CUSTOMERS))
    for (const m of (await movementsOf(seeded.url, persona)).filter((m) => !isOpening(m))) {
      assert.equal(
        new Date(m.createdAt).toISOString(),
        m.createdAt,
        `${m.id} is not a UTC ISO date`,
      );
      assert.ok(
        m.createdAt >= '2026-06-30T22:00:00.000Z' && m.createdAt < '2026-10-06T22:00:00.000Z',
        `${m.id} ${m.createdAt} is outside the window`,
      );
    }
});

test('REQ-SI9-2 dataset transfers are present once: two monthly savings, the historic Team dinner not seeded twice', async () => {
  await assertSeeded();
  const lucia = await movementsOf(seeded.url, 'lucia');
  const bruno = await movementsOf(seeded.url, 'bruno');
  const count = (list: Movement[], accountId: string, amountCents: number, createdAt: string) =>
    list.filter(
      (m) =>
        m.accountId === accountId && m.amountCents === amountCents && m.createdAt === createdAt,
    ).length;
  for (const date of SAVINGS_DATES) {
    assert.equal(count(lucia, 'acc-lucia', -20000, date), 1, `savings debit ${date}`);
    assert.equal(count(lucia, 'acc-lucia-savings', 20000, date), 1, `savings credit ${date}`);
  }
  assert.equal(lucia.filter((m) => m.amountCents === -8500).length, 1);
  assert.equal(count(lucia, 'acc-lucia', -8500, HISTORIC_DATE), 1);
  assert.equal(bruno.filter((m) => m.amountCents === 8500).length, 1);
  assert.equal(count(bruno, 'acc-bruno', 8500, HISTORIC_DATE), 1);
  // The historic operation still answers by its reference (the app's seeded cases refer to it).
  const op = await bank(seeded.url, 'lucia', '/v1/operations/ref-historic-lucia');
  assert.equal(op.status, 200);
  assert.equal(op.body.amountCents, 8500);
  assert.equal(
    ((await stateOf(seeded.url)).operations as any[]).filter(
      (o) => o.reference === 'ref-historic-lucia',
    ).length,
    1,
  );
});

test('REQ-SI9-2 each balance equals the opening balance plus the movements', async () => {
  await assertSeeded();
  // DS2 reconciliation: the identity is unchanged; the openings are the contract's 2.32 figures
  // (BALANCES) and the initial deposit itself must be that opening.
  // DS3 reconciliation: the openings of 2.34, and all twelve accounts (it was four).
  const all: Movement[] = [];
  for (const user of Object.keys(CUSTOMERS)) all.push(...(await movementsOf(seeded.url, user)));
  assert.equal(BALANCES.length, (await stateOf(seeded.url)).accounts.length, 'every account');
  for (const { id, openingCents, finalCents } of BALANCES) {
    assert.deepEqual(
      all.filter((m) => m.accountId === id && isOpening(m)).map((m) => m.amountCents),
      [openingCents],
      `${id}: the initial deposit`,
    );
    const sum = all
      .filter((m) => m.accountId === id && !isOpening(m))
      .reduce((total, m) => total + m.amountCents, 0);
    const balance = await balanceOf(seeded.url, id);
    assert.equal(balance, openingCents + sum, `${id}: opening + movements`);
    assert.equal(balance, finalCents, `${id}: the dataset's final balance`);
  }
  const accounts = (await bank(seeded.url, 'lucia', '/v1/accounts')).body as Account[];
  assert.equal(accounts.find((a) => a.id === 'acc-lucia')!.balanceCents, 293761);
});

test('REQ-SI9-2 the same ids and dates come back after a bank restart', async () => {
  const read = async () => {
    const instance = await startBank(true);
    const rows = [];
    for (const { persona } of PERSONAS)
      rows.push(
        ...demoIds(await movementsOf(instance.url, persona))
          .map(({ id, accountId, amountCents, description, createdAt }) => ({
            id,
            accountId,
            amountCents,
            description,
            createdAt,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    await stop(instance.child);
    return rows;
  };
  const first = await read();
  const second = await read();
  assert.equal(first.length >= LUCIA.length + BRUNO.length, true, `${first.length} demo rows`);
  assert.deepEqual(second, first);
});

// ---- REQ-SI9-3 ---------------------------------------------------------------------------------

test('REQ-SI9-3 on the seeded bank a transfer commits once and replays', async () => {
  await assertSeeded();
  const body = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 1234,
    concept: 'SI9 acceptance',
    reference: `si9-acceptance-${Date.now()}`,
  };
  const from = await balanceOf(seeded.url, 'acc-lucia');
  const to = await balanceOf(seeded.url, 'acc-bruno');
  const rowsBefore = (await movementsOf(seeded.url, 'lucia')).length;
  const first = await bank(seeded.url, 'lucia', '/v1/transfers', body);
  assert.ok([200, 201].includes(first.status), JSON.stringify(first));
  assert.equal(first.body.status, 'completed');
  assert.equal(first.body.replay, false);
  for (const key of [
    'fromAccountId',
    'toAccountId',
    'amountCents',
    'concept',
    'reference',
  ] as const)
    assert.equal(first.body[key], body[key]);
  assert.equal(first.body.userId, 'lucia');
  const again = await bank(seeded.url, 'lucia', '/v1/transfers', body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.id, first.body.id);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), from - 1234);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), to + 1234);
  assert.equal((await movementsOf(seeded.url, 'lucia')).length, rowsBefore + 1);
  const lookup = await bank(seeded.url, 'lucia', `/v1/operations/${body.reference}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.id, first.body.id);
  const clash = await bank(seeded.url, 'lucia', '/v1/transfers', { ...body, amountCents: 1235 });
  assert.equal(clash.status, 409);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), from - 1234);
  // Still a bank: no signature, no answer; no overdraft.
  assert.equal((await fetch(`${seeded.url}/v1/movements`)).status, 401);
  const overdraft = await bank(seeded.url, 'lucia', '/v1/transfers', {
    ...body,
    amountCents: 10_000_000,
    reference: `${body.reference}-nsf`,
  });
  assert.equal(overdraft.status, 422);
});

// ---- REQ-SI9-4 ---------------------------------------------------------------------------------

const INJECT = 'ZZQXV ACCEPTANCE STORE';

test('REQ-SI9-4 POST /_control/movement needs the control header', async () => {
  const body = { accountId: 'acc-lucia', amountCents: -777, description: `${INJECT} NOHEADER` };
  const before = await balanceOf(seeded.url, 'acc-lucia');
  assert.equal((await control(seeded.url, 'movement', body, null)).status, 403);
  assert.equal((await control(seeded.url, 'movement', body, 'wrong-token')).status, 403);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), before);
  assert.equal(
    (await movementsOf(seeded.url, 'lucia')).filter((m) => m.description === body.description)
      .length,
    0,
  );
  // With the header the same body is accepted: the 403 above is the header, not a missing route.
  assert.equal((await control(seeded.url, 'movement', body)).status, 200);
});

test('REQ-SI9-4 an injected movement is returned for that customer only and moves the balance by its amount', async () => {
  const description = `${INJECT} 77`;
  const before = await balanceOf(seeded.url, 'acc-lucia');
  const others = {
    bruno: await balanceOf(seeded.url, 'acc-bruno'),
    savings: await balanceOf(seeded.url, 'acc-lucia-savings'),
  };
  const sentAt = Date.now();
  const r = await control(seeded.url, 'movement', {
    accountId: 'acc-lucia',
    amountCents: -1999,
    description,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // "answers the state as the other control routes do"
  assert.ok(Array.isArray(r.body.accounts) && Array.isArray(r.body.operations) && r.body.options);
  assert.equal(
    r.body.accounts.find((a: Account) => a.id === 'acc-lucia').balanceCents,
    before - 1999,
  );
  const mine = (await movementsOf(seeded.url, 'lucia')).filter(
    (m) => m.description === description,
  );
  assert.equal(mine.length, 1);
  assert.match(mine[0].id, /^inj-\d+$/);
  assert.equal(mine[0].accountId, 'acc-lucia');
  assert.equal(mine[0].amountCents, -1999);
  const at = Date.parse(mine[0].createdAt);
  assert.ok(at >= sentAt - 1000 && at <= Date.now() + 1000, `dated now, got ${mine[0].createdAt}`);
  for (const other of ['bruno', 'carla', 'elena'])
    assert.equal(
      (await movementsOf(seeded.url, other)).filter(
        (m) => m.description === description || m.id === mine[0].id,
      ).length,
      0,
      `${other} must not see it`,
    );
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), before - 1999);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), others.bruno);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia-savings'), others.savings);
  const accounts = (await bank(seeded.url, 'lucia', '/v1/accounts')).body as Account[];
  assert.equal(accounts.find((a) => a.id === 'acc-lucia')!.balanceCents, before - 1999);
});

test('REQ-SI9-4 an injected movement keeps a given createdAt, accepts a credit, and gets its own inj-<n> id', async () => {
  const before = await balanceOf(seeded.url, 'acc-bruno');
  const createdAt = '2026-09-15T10:30:00.000Z';
  for (const description of [`${INJECT} DATED A`, `${INJECT} DATED B`]) {
    const r = await control(seeded.url, 'movement', {
      accountId: 'acc-bruno',
      amountCents: 500,
      description,
      createdAt,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const mine = (await movementsOf(seeded.url, 'bruno')).filter((m) =>
    m.description.startsWith(`${INJECT} DATED`),
  );
  assert.equal(mine.length, 2);
  for (const m of mine) {
    assert.match(m.id, /^inj-\d+$/);
    assert.equal(m.createdAt, createdAt);
    assert.equal(m.amountCents, 500);
  }
  assert.notEqual(mine[0].id, mine[1].id);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), before + 1000);
});

test('REQ-SI9-4 an unknown account is a 404 and changes nothing', async () => {
  // A known route first, so that the 404 below is the account and not a missing route.
  const ok = await control(seeded.url, 'movement', {
    accountId: 'acc-lucia',
    amountCents: -1,
    description: `${INJECT} ROUTE CHECK`,
  });
  assert.equal(ok.status, 200, 'POST /_control/movement does not exist');
  const before = await stateOf(seeded.url);
  const r = await control(seeded.url, 'movement', {
    accountId: 'acc-nobody',
    amountCents: -100,
    description: `${INJECT} NOBODY`,
  });
  assert.equal(r.status, 404);
  assert.deepEqual((await stateOf(seeded.url)).accounts, before.accounts);
  for (const user of ['lucia', 'bruno'])
    assert.equal(
      (await movementsOf(seeded.url, user)).filter((m) => m.description.endsWith('NOBODY')).length,
      0,
    );
});

test('REQ-SI9-4 the route also works on the bank without the seed file', async () => {
  const before = await balanceOf(plain.url, 'acc-carla');
  const r = await control(plain.url, 'movement', {
    accountId: 'acc-carla',
    amountCents: -250,
    description: `${INJECT} PLAIN`,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await balanceOf(plain.url, 'acc-carla'), before - 250);
  assert.equal(
    (await movementsOf(plain.url, 'carla')).filter((m) => m.description === `${INJECT} PLAIN`)
      .length,
    1,
  );
});

// ---- REQ-SI9-5 ---------------------------------------------------------------------------------
// `npm run demo` (contracts.md §5). Its port and directory variables (DEMO_APP_PORT,
// DEMO_BANK_PORT, DEMO_DATA_DIR) are named in the item plan 09 only; see the change note.

async function demo(t: TestContext, keys: Record<string, string>) {
  const appPort = await freePort();
  const bankPort = await freePort();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-si9-demo-'));
  const dataDir = path.join(temp, 'data'); // does not exist: the script must create and seed it
  const defaultData = path.join(ROOT, '.data');
  const hadDefaultData = fs.existsSync(defaultData);
  let output = '';
  // Own process group, so that stopping it also stops the bank and the app it started.
  const child = spawn('npm', ['run', 'demo'], {
    cwd: ROOT,
    env: cleanEnv({
      DEMO_APP_PORT: String(appPort),
      DEMO_BANK_PORT: String(bankPort),
      DEMO_DATA_DIR: dataDir,
      ...keys,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch {}
  };
  const app = `http://127.0.0.1:${appPort}`;
  const bankUrl = `http://127.0.0.1:${bankPort}`;
  try {
    let up = false;
    for (let i = 0; i < 360 && !up && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        up = (await fetch(`${app}/api/dashboard`)).status < 500;
      } catch {}
    }
    // Reviewer (reconciliation of #89): without `--production` the demo starts `next dev`, and
    // Next.js allows one `next dev` per project folder. A dev server already running in this
    // checkout is a limit of the environment, not a defect of the demo: skip, do not fail.
    if (!up && output.includes('Another next dev server is already running'))
      return t.skip(
        'another `next dev` is running in this checkout: stop it, or run the tests in another checkout',
      );
    assert.ok(up, `\`npm run demo\` did not serve the app on its port:\n${output.slice(-3000)}`);

    // Both services, on the ports it was given.
    assert.equal((await fetch(`${bankUrl}/health`)).ok, true, 'bank on its own port');
    // The bank is the seeded alt bank…
    const lucia = (await bank(bankUrl, 'lucia', '/v1/movements')).body as Movement[];
    assert.ok(Array.isArray(lucia), JSON.stringify(lucia));
    for (const row of seedRows('lucia', LUCIA))
      assert.ok(
        lucia.some((m) => m.id === row.id),
        `${row.id} missing: the demo bank needs the seed and a page of 100`,
      );
    // …its own data directory was created and seeded (a seeded fixture answers)…
    assert.ok(fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0, 'data dir created');
    const session = await fetch(`${app}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'lucia' }),
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    const fixture = await fetch(`${app}/api/conversations/conv-lucia-support`, {
      headers: { cookie },
    });
    assert.equal(fixture.status, 200, 'the data directory is not seeded');
    // …and the app reads that bank (no model is involved in this action).
    const accounts = await fetch(`${app}/api/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'list_accounts', arguments: {} }),
    });
    assert.equal(accounts.status, 200);
    assert.match(JSON.stringify(await accounts.json()), /293761/);
    if (!hadDefaultData) assert.equal(fs.existsSync(defaultData), false, '.data was created');
  } finally {
    signal('SIGTERM');
    await Promise.race([exited(child), new Promise((r) => setTimeout(r, 10_000))]);
    signal('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test(
  'REQ-SI9-5 `npm run demo` with no key at all starts both services on its own ports and creates and seeds its data directory',
  { timeout: 240_000 },
  (t) => demo(t, {}),
);

test(
  'REQ-SI9-5 `npm run demo` with only OPENAI_API_KEY set starts both services on its own ports and creates and seeds its data directory',
  { timeout: 240_000 },
  (t) => demo(t, { OPENAI_API_KEY: 'si9-acceptance-not-a-real-key' }),
);

// ---- REQ-SI9-6 ---------------------------------------------------------------------------------

test('REQ-SI9-6 simulator/ has no change', () => {
  // sha256 over the sorted files of simulator/ as on `main` and `origin/dev` @ 04682d9 (git tree
  // 74d1813): path, NUL, content, NUL. No git needed, so it also holds in the delivery ZIP.
  const dir = path.join(ROOT, 'simulator');
  const files = (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
  assert.deepEqual(files, ['bank.ts', 'db.ts', 'seed.ts', 'server.ts']);
  const hash = createHash('sha256');
  for (const f of files)
    hash
      .update(`${f}\0`)
      .update(fs.readFileSync(path.join(dir, f)))
      .update('\0');
  assert.equal(hash.digest('hex'), SIMULATOR_SHA256);
});
