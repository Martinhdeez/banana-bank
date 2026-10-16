// SI9: the demo bank. The alt bank with ALT_BANK_SEED_FILE serves the demo movements (since DS2
// of all eight customers, July to 5 October 2026) with fixed ids and dates, POST /_control/movement injects one movement, and
// `npm run demo` starts that bank plus the app on its own ports and data directory.
// Without the variable the alt bank is unchanged (tests/alt-bank.test.ts covers that side too).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers/bank';

const SEED_FILE = 'tests/alt-bank/demo-seed.json';
const INPUTS = 'docs/plan/23-spend-insights/inputs';
type Movement = {
  id: string;
  accountId: string;
  operationId: string | null;
  amountCents: number;
  description: string;
  createdAt: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url: string, tries: number, child?: ChildProcess) {
  for (let i = 0; i < tries; i++) {
    if (child && child.exitCode !== null) throw new Error('The process exited.');
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${url} did not answer.`);
}
async function startBank(env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/alt-bank/server.ts'], {
    env: { ...process.env, ALT_BANK_PORT: String(port), ALT_BANK_MOVEMENTS_LIMIT: '100', ...env },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/health`, 40);
  return { child, url };
}
const stopped = (child: ChildProcess) =>
  child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r));

// The bank contract's signature (docs/contracts.md), with the development secret.
function bank(url: string, actor: string, route: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const method = body === undefined ? 'GET' : 'POST';
  const time = String(Date.now());
  const signature = createHmac('sha256', process.env.BANK_SERVICE_SECRET || 'banana-local-service')
    .update([method, route, actor, time, raw].join('\n'))
    .digest('hex');
  return fetch(url + route, {
    method,
    headers: { 'x-bank-actor': actor, 'x-bank-time': time, 'x-bank-signature': signature },
    body: raw || undefined,
  });
}
const movementsOf = async (url: string, actor: string) =>
  (await (await bank(url, actor, '/v1/movements')).json()) as Movement[];
const control = (url: string, route: string, body?: unknown, token = 'alt-control') =>
  fetch(`${url}/_control/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-alt-control': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const balanceOf = async (url: string, id: string) =>
  ((await (await control(url, 'state')).json()) as any).accounts.find((a: any) => a.id === id)
    .balanceCents as number;
const demoRows = (rows: Movement[]) => rows.filter((m) => m.id.startsWith('demo-'));
const CUSTOMERS = ['lucia', 'bruno', 'carla', 'diego', 'elena', 'hugo', 'ines', 'omar'];

let plain: Awaited<ReturnType<typeof startBank>>;
let seeded: Awaited<ReturnType<typeof startBank>>;
before(async () => {
  [plain, seeded] = await Promise.all([startBank(), startBank({ ALT_BANK_SEED_FILE: SEED_FILE })]);
});
after(() => {
  plain?.child.kill();
  seeded?.child.kill();
});
const seedFile = () =>
  JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as {
    openings: Record<string, number>;
    movements: Omit<Movement, 'operationId'>[];
    transfers: { fromAccountId: string; toAccountId: string; amountCents: number }[];
  };

// REQ-SI9-1
test('without ALT_BANK_SEED_FILE the alt bank serves its default card payments', async () => {
  for (const user of ['lucia', 'bruno']) {
    const rows = await movementsOf(plain.url, user);
    assert.equal(rows.filter((m) => /^Card payment \d+$/.test(m.description)).length, 30);
    assert.ok(rows.some((m) => m.id === `m-${user}-30`));
    assert.equal(demoRows(rows).length, 0);
  }
  assert.equal(await balanceOf(plain.url, 'acc-lucia'), 300000 - 3000 - 8500);
});

// REQ-SI9-2
test('with the seed file every customer gets the file rows: ids, dates, counts, balance', async () => {
  const file = seedFile();
  for (const user of CUSTOMERS) {
    const account = `acc-${user}`;
    const rows = (await movementsOf(seeded.url, user)).filter((m) => m.accountId === account);
    const expected = file.movements.filter((m) => m.accountId === account);
    assert.ok(expected.length > 20, `${user} has rows in the file`);
    assert.equal(rows.filter((m) => m.description.startsWith('Card payment')).length, 0);
    // Every row that is not the opening deposit or a transfer leg comes from the file.
    const own = rows.filter((m) => !m.operationId && m.description !== 'Initial deposit');
    assert.ok(own.every((m) => m.id.startsWith(`demo-${user}-`)));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual(
      own.sort(byId).map(({ operationId, ...m }) => m),
      [...expected].sort(byId),
    );
    assert.ok(
      // DS3: the window is 1 July to 6 October 2026 (Madrid).
      own.every((m) => m.createdAt >= '2026-06-30T22:00' && m.createdAt < '2026-10-06T22:00'),
      'fixed dates inside the contract window',
    );
    const all = (await movementsOf(seeded.url, user)).filter(
      (m) => m.description !== 'Initial deposit',
    );
    // DS3: 60 to 90 movements each. The upper bound is the one that matters: `npm run demo` asks
    // for a page of 100, and a full page that starts in July silences the month forecast and
    // `category_up` (src/banking/movements.ts `movementWindow`). 90 leaves room for the transfers
    // a demo session makes.
    assert.ok(all.length >= 60 && all.length <= 90, `${user} has ${all.length} movements`);
    // Balance = opening + movements: the opening deposit is itself a movement of the account.
    const sum = rows.reduce((total, m) => total + m.amountCents, 0);
    assert.equal(await balanceOf(seeded.url, account), sum);
    assert.equal(
      rows.find((m) => m.description === 'Initial deposit')!.amountCents,
      file.openings[account],
    );
  }
  // The balances the documented scenes use: kept by DS2 (the openings changed instead).
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), 293761);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), 459252);
  assert.equal(await balanceOf(seeded.url, 'acc-diego'), 7500);
  // Rows with a counterparty in the roster are replayed as transfers, once.
  const savings = (await movementsOf(seeded.url, 'lucia')).filter(
    (m) => m.accountId === 'acc-lucia-savings' && m.description === 'ahorro mensual',
  );
  assert.equal(savings.length, 3);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia-savings'), 70000 + 60000);
});

test('the two historic transfers are seeded once; a history longer than the 25-movement page is real rows', async () => {
  const dinner = (await movementsOf(seeded.url, 'lucia')).filter(
    (m) => m.description === 'Transfer · Team dinner',
  );
  assert.equal(dinner.length, 1);
  assert.equal(
    (await movementsOf(seeded.url, 'elena')).filter(
      (m) => m.description === 'Transfer · Transfer to Hugo',
    ).length,
    1,
  );
  // DS2: Carla's 30 "Card payment N" rows were the fixture for a history longer than the bank's
  // default page. Her demo rows do that job now: 58 movements, of which the page holds the 25 newest.
  const carla = await movementsOf(seeded.url, 'carla');
  assert.equal(carla.filter((m) => m.description.startsWith('Card payment')).length, 0);
  assert.ok(demoRows(carla).length > 25);
  const paged = await startBank({ ALT_BANK_SEED_FILE: SEED_FILE, ALT_BANK_MOVEMENTS_LIMIT: '25' });
  try {
    const page = await movementsOf(paged.url, 'carla');
    const newest = [...carla].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
    assert.deepEqual(page.map((m) => m.createdAt).sort(), newest.map((m) => m.createdAt).sort());
  } finally {
    paged.child.kill();
  }
});

// DS1: what the demo's first screens show. The app prints a seeded transfer's bank text as its
// title and masks an IBAN to its last four digits.
test('DS1: no seeded movement of the demo names a raw account id; a live transfer keeps the bank wording', async () => {
  for (const user of CUSTOMERS) {
    const raw = (await movementsOf(seeded.url, user)).filter((m) => /acc-/.test(m.description));
    assert.deepEqual(
      raw.map((m) => m.description),
      [],
      user,
    );
  }
  // Without the seed file the historic transfer is worded as before.
  assert.ok(
    (await movementsOf(plain.url, 'lucia')).some(
      (m) => m.description === 'To acc-bruno: Team dinner',
    ),
  );
  const fresh = await startBank({ ALT_BANK_SEED_FILE: SEED_FILE });
  try {
    await bank(fresh.url, 'lucia', '/v1/transfers', {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-bruno',
      amountCents: 100,
      concept: 'ds1',
      reference: 'ds1-live',
    });
    assert.ok(
      (await movementsOf(fresh.url, 'bruno')).some((m) => m.description === 'From acc-lucia: ds1'),
    );
  } finally {
    fresh.child.kill();
  }
});

test('DS1: every account ends its IBAN with four digits of its own', async () => {
  for (const url of [plain.url, seeded.url]) {
    const { accounts } = (await (await control(url, 'state')).json()) as {
      accounts: { iban: string }[];
    };
    const tails = accounts.map((a) => a.iban.replace(/\s+/g, '').slice(-4));
    assert.equal(new Set(tails).size, accounts.length, tails.join(' '));
    assert.equal(new Set(accounts.map((a) => a.iban)).size, accounts.length);
    for (const a of accounts) assert.match(a.iban, /^ES00 9999 0000 \d{4} 0000 \d{4}$/);
  }
});

test('the demo ids are the same after a control reset and after a bank restart', async () => {
  const ids = async (url: string) =>
    Object.fromEntries(
      await Promise.all(
        ['lucia', 'bruno'].map(async (u) => [
          u,
          demoRows(await movementsOf(url, u))
            .map((m) => `${m.id} ${m.createdAt}`)
            .sort(),
        ]),
      ),
    );
  const first = await ids(seeded.url);
  assert.equal(first.lucia.length, 77); // DS3: 47 + 30
  assert.equal(first.bruno.length, 68); // DS3: 48 + 20
  const again = await startBank({ ALT_BANK_SEED_FILE: SEED_FILE });
  try {
    assert.deepEqual(await ids(again.url), first);
    await control(again.url, 'reset', {});
    assert.deepEqual(await ids(again.url), first);
  } finally {
    again.child.kill();
  }
});

// REQ-SI9-3
test('the bank contract holds on the seeded bank: a transfer commits once and replays', async () => {
  const transfer = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 1234,
    concept: 'SI9 contract',
    reference: `si9-${Date.now()}`,
  };
  const before = await balanceOf(seeded.url, 'acc-lucia');
  const created = await bank(seeded.url, 'lucia', '/v1/transfers', transfer);
  assert.equal(created.status, 201);
  const op = (await created.json()) as { id: string };
  const replay = await bank(seeded.url, 'lucia', '/v1/transfers', transfer);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { id: string }).id, op.id);
  assert.equal(await balanceOf(seeded.url, 'acc-lucia'), before - 1234);
  const found = await bank(seeded.url, 'lucia', `/v1/operations/${transfer.reference}`);
  assert.equal(((await found.json()) as { id: string }).id, op.id);
  const legs = (await movementsOf(seeded.url, 'lucia')).filter((m) => m.operationId === op.id);
  assert.equal(legs.length, 1);
});

// REQ-SI9-4
test('POST /_control/movement injects one movement for that customer only', async () => {
  const movement = { accountId: 'acc-bruno', amountCents: -1500, description: 'ZZQXV SI9 PROBE' };
  assert.equal((await control(seeded.url, 'movement', movement, 'wrong')).status, 403);
  const before = await balanceOf(seeded.url, 'acc-bruno');
  const started = Date.now();
  const answer = await control(seeded.url, 'movement', movement);
  assert.equal(answer.status, 200);
  const state = (await answer.json()) as any;
  assert.ok(Array.isArray(state.accounts) && Array.isArray(state.operations) && state.options);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), before - 1500);
  const mine = (await movementsOf(seeded.url, 'bruno')).filter(
    (m) => m.description === movement.description,
  );
  assert.equal(mine.length, 1);
  assert.match(mine[0].id, /^inj-\d+$/);
  assert.equal(mine[0].amountCents, -1500);
  assert.equal(mine[0].operationId, null);
  assert.ok(Math.abs(Date.parse(mine[0].createdAt) - started) < 5000, 'dated now');
  const lucia = await movementsOf(seeded.url, 'lucia');
  assert.ok(!lucia.some((m) => m.description === movement.description));

  const dated = { ...movement, amountCents: 250, createdAt: '2026-09-30T10:00:00.000Z' };
  await control(seeded.url, 'movement', dated);
  const both = (await movementsOf(seeded.url, 'bruno')).filter((m) => m.id.startsWith('inj-'));
  assert.equal(both.length, 2);
  assert.notEqual(both[0].id, both[1].id);
  assert.ok(both.some((m) => m.createdAt === dated.createdAt && m.amountCents === 250));
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), before - 1500 + 250);

  const unknown = await control(seeded.url, 'movement', { ...movement, accountId: 'acc-nobody' });
  assert.equal(unknown.status, 404);
  const bad = await control(seeded.url, 'movement', { ...movement, amountCents: 1.5 });
  assert.equal(bad.status, 400);
  assert.equal(await balanceOf(seeded.url, 'acc-bruno'), before - 1500 + 250);
  // The route also exists on the default bank.
  assert.equal(
    (await control(plain.url, 'movement', { ...movement, accountId: 'acc-carla' })).status,
    200,
  );
});

// REQ-SI9-5
test('npm run demo creates and seeds a missing data dir and starts both services, with or without a key', async (t) => {
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'banana-si9-demo-')), 'data');
  const [appPort, bankPort] = [await freePort(), await freePort()];
  async function run(key: string, check: (out: () => string) => Promise<void>) {
    let out = '';
    const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts'], {
      env: {
        ...process.env,
        DEMO_DATA_DIR: dataDir,
        DEMO_APP_PORT: String(appPort),
        DEMO_BANK_PORT: String(bankPort),
        // Present but empty: dotenv does not replace them from a local .env.local.
        OPENAI_API_KEY: key,
        DECIDER: '',
        DECIDER_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    demo.stdout.on('data', (d) => (out += d));
    demo.stderr.on('data', (d) => (out += d));
    try {
      await waitFor(`http://127.0.0.1:${appPort}/api/health`, 360, demo);
      await check(() => out);
    } catch (e) {
      // Next.js allows one `next dev` per project folder: not a defect of the demo script.
      if (out.includes('Another next dev server is already running')) return false;
      throw new Error(`${e}\n--- demo output ---\n${out}`);
    } finally {
      demo.kill('SIGTERM');
      await stopped(demo);
    }
    await assert.rejects(fetch(`http://127.0.0.1:${bankPort}/health`), 'bank stopped');
    await assert.rejects(fetch(`http://127.0.0.1:${appPort}/api/health`), 'app stopped');
    return true;
  }
  assert.ok(!fs.existsSync(dataDir));
  const started = await run('', async (out) => {
    assert.ok(fs.existsSync(path.join(dataDir, 'app.sqlite')), 'data dir created');
    assert.match(out(), /conversations: \d+/, 'seeded');
    assert.match(out(), new RegExp(`http://127\\.0\\.0\\.1:${appPort}`));
    assert.match(out(), /decider: none/i);
    const health = await (await fetch(`http://127.0.0.1:${bankPort}/health`)).json();
    assert.deepEqual(health, { status: 'up', impl: 'alt-bank' });
    const lucia = await movementsOf(`http://127.0.0.1:${bankPort}`, 'lucia');
    assert.equal(demoRows(lucia).length, 77);
    assert.equal(
      lucia.length,
      86,
      'the whole history fits the page (ALT_BANK_MOVEMENTS_LIMIT=100)',
    );
  });
  if (!started) return t.skip('another next dev server is running in this checkout');
  await run('not-a-real-key', async (out) => {
    assert.match(out(), /decider: openai/i);
    assert.doesNotMatch(out(), /conversations: \d+/, 'an existing data dir is not seeded again');
  });
  fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
});

// Data consistency with the plan's inputs (dev set only; the held-out set is never read here).
test('the seed file holds the plan tables (SI9 rows) and is the DS2 dataset table; no seed description contradicts the dev set', () => {
  const text = fs.readFileSync(`${INPUTS}/demo-bank-dataset-proposal.md`, 'utf8');
  const file = seedFile();
  // inputs/README.md point 4: a person transfer stays transfer_person whatever its concept.
  const relabelled = new Set(['lucia-026', 'bruno-001', 'bruno-013']);
  const labels = new Map<string, string>();
  for (const user of ['lucia', 'bruno']) {
    const section = text.split(`\n## ${user}\n`)[1].split('\n## ')[0];
    const rows = [
      ...section.matchAll(
        /^\| (\d+) \| (\S+) (\S+) \| (-?[\d.]+) \| `(.+?)` \| `(\w+)` \| (.*) \|$/gm,
      ),
    ];
    assert.equal(rows.length, user === 'lucia' ? 32 : 29);
    for (const [, n, day, time, amount, description, label, why] of rows) {
      const key = `${user}-${n.padStart(3, '0')}`;
      // A row marked UNKNOWN is pending by design (the user is asked): `other` there is the
      // expected pipeline outcome, not a claim about the true category the dev set holds.
      if (!why.includes('UNKNOWN'))
        labels.set(description, relabelled.has(key) ? 'transfer_person' : label);
      const cents = Math.round(Number(amount) * 100);
      // Madrid local time; CEST is UTC+2 for the whole window.
      const createdAt = new Date(`${day}T${time}:00+02:00`).toISOString();
      const savings = /^To (acc-\S+-savings): /.exec(description);
      if (why.includes('EXISTING')) {
        assert.ok(
          !file.movements.some((m) => m.id === `demo-${key}`),
          `${key} is not seeded twice`,
        );
      } else if (savings) {
        const match = file.transfers.filter(
          (t: any) => t.toAccountId === savings[1] && t.createdAt === createdAt,
        );
        assert.equal(match.length, 1, `${key} is a transfer`);
        assert.equal(match[0].amountCents, -cents);
      } else {
        assert.deepEqual(
          file.movements.find((m) => m.id === `demo-${key}`),
          {
            id: `demo-${key}`,
            accountId: `acc-${user}`,
            amountCents: cents,
            description,
            createdAt,
          },
        );
      }
    }
  }
  // DS2: the SI9 rows above are still in the file, unchanged; the whole file is the table of
  // inputs/demo-bank-dataset.md (every `demo-` row of it, and nothing else).
  const table = [
    ...fs
      .readFileSync(`${INPUTS}/demo-bank-dataset.md`, 'utf8')
      .matchAll(/^\| `(demo-\S+)` \| (\S+) (\S+) \| `(\S+)` \| (-?[\d.,]+) \| `(.+?)` \|/gm),
  ].map(([, id, day, time, accountId, amount, description]) => ({
    id,
    accountId,
    amountCents: Math.round(Number(amount.replace(/,/g, '')) * 100),
    description,
    createdAt: new Date(`${day}T${time}:00+02:00`).toISOString(),
  }));
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  assert.deepEqual(table.sort(byId), [...file.movements].sort(byId));
  assert.equal(file.movements.length, 591); // DS3: 421 + 170
  assert.equal(file.transfers.length, 14);
  const dev = fs
    .readFileSync(`${INPUTS}/eval-set-dev.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; description: string; expected: string });
  for (const row of dev) {
    const label = labels.get(row.description);
    if (label) assert.equal(row.expected, label, `${row.id} "${row.description}"`);
  }
});
