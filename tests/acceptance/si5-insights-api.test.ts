// Acceptance tests for the spend-insights HTTP API (SI5), REQ-SI5-1 … -14 of
// docs/plan/23-spend-insights/requirements.md. Written from contracts.md only (V-cycle: the author
// has not seen the implementation). Black box: the app and the bank run as child processes and the
// tests speak HTTP. The server is the one of contracts.md §7: the alt bank with the demo seed and
// ALT_BANK_MOVEMENTS_LIMIT=100, the app with BANK_EXTERNAL=1, DECIDER=none and its own DATA_DIR.
// A second app (DECIDER=systemone, pointed at an HTTP stub written from §6) serves REQ-SI5-12/13;
// Next allows one `next dev` per checkout, so it is started after the first one is stopped.
// The only thing read behind HTTP is the existing `events` table (the audit log, REQ-SI5-11) and
// the apps' console output (REQ-SI5-14).
import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { freePort } from '../helpers/bank';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DECIDER_KEY = 'sk-' + 'acc-si5-decider-key-7f3a91'; // IT3: same value, no key-shaped literal
const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Groceries',
  eating_out_leisure: 'Eating out & leisure',
  transport: 'Transport',
  home_utilities: 'Home & utilities',
  health: 'Health',
  shopping: 'Shopping',
  work: 'Work & projects',
  transfer_person: 'Transfers to people',
  savings_internal: 'Savings / own transfer',
  income: 'Income',
  other: 'Other',
};
const CATEGORY_IDS = Object.keys(CATEGORY_LABELS);
const DECIDER_OPTIONS = CATEGORY_IDS.filter((c) => c !== 'savings_internal' && c !== 'income');
const REASON =
  /^(own_account|person_transfer|opening_balance|user|user_rule:.+|keyword:.+|refund:.+|tax_refund|credit|model.*|below_threshold|decider_unavailable|decider_budget|no_decider|no_merchant|pending)$/;
const NOT_FOUND = { error: 'Movement not found.' };
const INVALID = { error: 'Invalid request data.' };
const BAD_FIT = { error: 'This category does not fit this movement.' };

// ---------------------------------------------------------------- harness

type App = {
  url: string;
  dataDir: string;
  child: ChildProcess;
  out: string[]; // stdout + stderr of the app process
  seen: string[]; // every response body
  cookies: Map<string, string>;
};
type Res = { status: number; body: any; text: string; headers: Headers; label: string };

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-acc-si5-'));
const children: ChildProcess[] = [];
let bank: ChildProcess, bankUrl: string, A: App, stubApp: App | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reviewer (reconciliation of #95): how the apps are started, so that this file is reliable inside
// `npm test` (files run in parallel) and in a checkout where a dev server runs.
// - With a production build newer than every source file (`npm run build`), the apps are
//   `next start` on that build: no limit on how many run in one checkout.
// - Otherwise they are `next dev`, and Next.js allows one `next dev` per checkout. When another one
//   holds it, the start is tried again for 40 s (another test file's server is short-lived); after
//   that every test still to run is skipped with the reason. Never a failure, never a pass.
function freshBuild() {
  const newest = (p: string): number => {
    const stat = fs.statSync(p);
    return stat.isDirectory()
      ? Math.max(0, ...fs.readdirSync(p).map((f) => newest(path.join(p, f))))
      : stat.mtimeMs;
  };
  try {
    const built = fs.statSync(path.join(ROOT, '.next/BUILD_ID')).mtimeMs;
    return ['app', 'src', 'next.config.ts', 'proxy.ts', 'package.json'].every(
      (p) => newest(path.join(ROOT, p)) < built,
    );
  } catch {
    return false;
  }
}
const production = freshBuild();
class Skip extends Error {}
let skipped: string | undefined;
const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, async (t) => {
    if (skipped) return t.skip(skipped);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      t.skip((skipped = e.message));
    }
  });
const port = (fallback: number) => freePort().catch(() => fallback);

// No model key reaches a child: an empty value also stops .env.local from supplying one.
const baseEnv = () => ({
  ...process.env,
  OPENAI_API_KEY: '',
  DECIDER_API_KEY: '',
  BANK_SERVICE_SECRET: 'acc-si5-service',
  SESSION_SECRET: 'acc-si5-session',
  RATE_LIMIT_SCALE: '0',
});
function node(args: string[], env: NodeJS.ProcessEnv, out?: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => out?.push(String(d)));
  child.stderr!.on('data', (d) => out?.push(String(d)));
  children.push(child);
  return child;
}
async function waitFor(url: string, what: string, child: ChildProcess, out?: string[]) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`${what} did not start.\n${out?.join('').slice(-2000) ?? ''}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM'); // scripts/dev.ts stops its web child on SIGTERM
  await Promise.race([gone, sleep(8000)]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}
async function startApp(
  name: string,
  appPort: number,
  extra: Record<string, string>,
): Promise<App> {
  const dataDir = path.join(temp, name);
  fs.mkdirSync(dataDir);
  const env = {
    ...baseEnv(),
    DATA_DIR: dataDir,
    APP_PORT: String(appPort),
    BANK_PORT: new URL(bankUrl).port,
    BANK_URL: bankUrl,
    BANK_EXTERNAL: '1',
    ...extra,
  };
  // The seed step of `npm run setup` / `npm run demo` for this directory.
  const seeded = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const {appDb,closeAppDb}=await import('./src/db.ts');const {seedApp}=await import('./src/seed.ts');appDb();seedApp();closeAppDb();",
    ],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  assert.equal(seeded.status, 0, `seeding ${name} failed: ${seeded.stderr}`);
  const url = `http://127.0.0.1:${appPort}`;
  for (const deadline = Date.now() + 40_000; ; await sleep(2000)) {
    const out: string[] = [];
    const child = node(['scripts/dev.ts', ...(production ? ['--production'] : [])], env, out);
    try {
      await waitFor(`${url}/api/health`, `app ${name}`, child, out);
      return { url, dataDir, child, out, seen: [], cookies: new Map() };
    } catch (e) {
      await stop(child);
      if (!out.join('').includes('Another next dev server is already running')) throw e;
      if (Date.now() > deadline)
        throw new Skip(
          'another `next dev` is running in this checkout and there is no fresh production build: run `npm run build` first, or stop it, or run the tests in another checkout',
        );
    }
  }
}

// System One stub, from contracts.md §6. Behaviour is chosen by the cleaned description:
// `… HOLD…` waits until released, `… FAIL…` answers 529 while `failing`, the rest answer at once.
const stub = {
  requests: [] as { path: string; auth: string; description: string }[],
  held: [] as (() => void)[],
  failing: true,
  url: '',
};
const stubServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let description = '';
  try {
    description = String(JSON.parse(raw).state.description);
  } catch {}
  stub.requests.push({
    path: req.url ?? '',
    auth: String(req.headers.authorization ?? ''),
    description,
  });
  if (description.includes('HOLD')) await new Promise<void>((r) => stub.held.push(r));
  if (description.includes('FAIL') && stub.failing) return void res.writeHead(529).end('{}');
  const choice = description.includes('HOLD') ? 'shopping' : 'transport';
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        category: {
          type: 'choice',
          choice,
          confidence: 0.97,
          probabilities: Object.fromEntries(
            DECIDER_OPTIONS.map((o) => [o, o === choice ? 0.97 : 0.03 / 8]),
          ),
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});

before(async () => {
  const bankPort = await port(4920);
  bankUrl = `http://127.0.0.1:${bankPort}`;
  bank = node(['tests/alt-bank/server.ts'], {
    ...baseEnv(),
    ALT_BANK_PORT: String(bankPort),
    ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
    ALT_BANK_MOVEMENTS_LIMIT: '100',
  });
  await waitFor(`${bankUrl}/health`, 'alt bank', bank);
  await new Promise<void>((r) => stubServer.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${(stubServer.address() as { port: number }).port}`;
  try {
    A = await startApp('app-none', await port(3920), { DECIDER: 'none' });
  } catch (e) {
    if (!(e instanceof Skip)) throw e;
    skipped = e.message;
  }
});
// The app with a decider (the stub). It replaces A: every test that needs A is declared before
// the first test that calls this.
async function appWithStub() {
  if (stubApp) return stubApp;
  await stop(A.child);
  return (stubApp = await startApp('app-systemone', await port(3921), {
    DECIDER: 'systemone',
    DECIDER_API_KEY: DECIDER_KEY,
    DECIDER_BASE_URL: stub.url,
  }));
}
after(async () => {
  for (const release of stub.held) release();
  stubServer.closeAllConnections();
  stubServer.close();
  await Promise.all([stop(A?.child), stop(stubApp?.child)]);
  await stop(bank);
  fs.rmSync(temp, { recursive: true, force: true });
});
// Last resort if the runner dies before `after`: children are stopped by PID, never by name.
process.on('exit', () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
});

async function login(app: App, userId: string) {
  let cookie = app.cookies.get(userId);
  if (!cookie) {
    const r = await fetch(`${app.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    assert.equal(r.status, 200, `login ${userId}`);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    app.cookies.set(userId, cookie);
  }
  return cookie;
}
async function call(
  app: App,
  who: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  route: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (who) headers.cookie = await login(app, who);
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${app.url}/api/${route}`, { method, headers, body });
  const text = await r.text();
  app.seen.push(text);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const label = `${method} /api/${route} as ${who ?? 'anonymous'} -> ${r.status} ${text.slice(0, 300)}`;
  return { status: r.status, body: json, text, headers: r.headers, label };
}
const ok = (r: Res) => (assert.equal(r.status, 200, r.label), r.body);
const refused = (r: Res, status: number, body: unknown) => {
  assert.equal(r.status, status, r.label);
  assert.deepEqual(r.body, body, r.label);
};
const dashboard = async (app: App, who: string) => ok(await call(app, who, 'GET', 'dashboard'));
const spending = async (app: App, who: string, query = '') =>
  ok(await call(app, who, 'GET', `insights/spending${query}`));
const setCategory = (
  app: App,
  who: string | null,
  body: unknown,
  headers?: Record<string, string>,
) => call(app, who, 'POST', 'insights/categories', { body, headers });
const rulesOf = async (app: App, who: string) =>
  ok(await call(app, who, 'GET', 'insights/rules')).rules as {
    merchantKey: string;
    category: string;
    createdAt: string;
  }[];
const deleteRule = (app: App, who: string | null, key: string, headers?: Record<string, string>) =>
  call(app, who, 'DELETE', `insights/rules/${encodeURIComponent(key)}`, { headers });

async function control(route: string, body?: unknown) {
  const r = await fetch(`${bankUrl}/_control/${route}`, {
    method: 'POST',
    headers: { 'x-alt-control': 'alt-control' },
    body: JSON.stringify(body ?? {}),
  });
  assert.equal(r.status, 200, `bank control ${route}`);
}
// A description of the guaranteed-unknown form (contracts.md §1): `ZZQXV` + space + letters.
let serial = 0;
const unknown = (tag = 'ACC') =>
  `ZZQXV ${tag}${[...String(serial++).padStart(3, '0')].map((d) => 'ABCDEFGHIJ'[+d]).join('')}`;
// Adds `n` movements with one description and returns the ids the app reports for the new ones.
async function inject(
  app: App,
  who: string,
  amountCents: number,
  description: string,
  n = 1,
  createdAt?: string,
): Promise<string[]> {
  const idsNow = async (): Promise<string[]> =>
    (await dashboard(app, who)).movements
      .filter((m: any) => m.description === description)
      .map((m: any) => m.id);
  const known = await idsNow();
  for (let i = 0; i < n; i++)
    await control('movement', { accountId: `acc-${who}`, amountCents, description, createdAt });
  const ids = (await idsNow()).filter((id) => !known.includes(id));
  assert.equal(ids.length, n, `${n} injected "${description}" in ${who}'s dashboard`);
  return ids;
}
const rowsById = async (app: App, who: string) =>
  new Map<string, any>((await dashboard(app, who)).movements.map((m: any) => [m.id, m]));
// What is stored for a customer, as far as the API shows it: used for "nothing was written".
async function categoryOf(app: App, who: string, id: string) {
  const category = (await rowsById(app, who)).get(id)?.category;
  assert.ok(category, `${who} ${id}: category is missing`);
  return category;
}
const snapshot = async (app: App, who: string) => ({
  rows: (await dashboard(app, who)).movements.map((m: any) => [
    m.id,
    m.category?.id,
    m.category?.state,
    m.category?.source,
  ]),
  rules: await rulesOf(app, who),
});
function auditEvents(app: App) {
  for (const file of fs.readdirSync(app.dataDir)) {
    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(path.join(app.dataDir, file), { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          "SELECT user_id, kind, data FROM events WHERE kind IN ('category.set','rule.created','rule.removed') ORDER BY rowid",
        )
        .all() as { user_id: string; kind: string; data: string }[];
      return rows.map((r) => ({ userId: r.user_id, kind: r.kind, data: JSON.parse(r.data) }));
    } catch {
    } finally {
      db?.close();
    }
  }
  throw new Error(`no database with an events table in ${app.dataDir}`);
}
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await sleep(200);
  }
}

function assertCategory(c: any, amountCents: number, where: string) {
  assert.ok(c && typeof c === 'object', `${where}: category is missing`);
  assert.ok(CATEGORY_IDS.includes(c.id), `${where}: id ${c.id}`);
  assert.ok(['estimated', 'confirmed', 'needs_review', 'pending'].includes(c.state), where);
  assert.ok(['user', 'user_rule', 'rule', 'model', 'none'].includes(c.source), where);
  assert.match(c.reason, REASON, where);
  for (const k of ['confidence', 'threshold'])
    assert.ok(c[k] === null || (typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 1), where + k);
  assert.ok(Array.isArray(c.candidates) && c.candidates.length <= 3, `${where}: candidates`);
  for (const cand of c.candidates) {
    assert.ok(CATEGORY_IDS.includes(cand.category), `${where}: candidate`);
    assert.ok(cand.p === null || typeof cand.p === 'number', `${where}: candidate p`);
  }
  assert.match(c.merchantKey, /^[A-Z0-9& ]{0,40}$/, where);
  assert.ok(!/^ | $| {2}/.test(c.merchantKey), `${where}: spaces in "${c.merchantKey}"`);
  assert.ok(c.model === null || typeof c.model === 'string', `${where}: model`);
  assert.ok(Array.isArray(c.movementIds) && c.movementIds.length >= 1, `${where}: movementIds`);
  // Sign rule: a debit is never income, a credit never transfer_person.
  assert.notEqual(c.id, amountCents < 0 ? 'income' : 'transfer_person', `${where}: sign rule`);
}

// The totals of contracts.md §3 "Totals", computed from rows that carry their category.
function expectedTotals(movements: any[], from = -Infinity, to = Infinity) {
  const categories = new Map<
    string,
    { spent: number; confirmed: number; debits: number; all: number }
  >();
  let income = 0;
  for (const m of movements) {
    const at = Date.parse(m.createdAt);
    if (at < from || at > to) continue;
    const { id, state } = m.category;
    if (m.amountCents > 0 && id === 'income') income += m.amountCents;
    // Spend: debits outside savings_internal (a debit is never income); refunds are credits in a
    // spend category; credits in `other` and everything in savings_internal are in no total.
    const spend =
      m.amountCents < 0
        ? id !== 'savings_internal' && id !== 'income'
        : !['income', 'savings_internal', 'other'].includes(id);
    if (!spend) continue;
    const c = categories.get(id) ?? { spent: 0, confirmed: 0, debits: 0, all: 0 };
    c.spent -= m.amountCents;
    if (state === 'confirmed') c.confirmed -= m.amountCents;
    if (m.amountCents < 0) c.debits++;
    c.all++;
    categories.set(id, c);
  }
  return { categories, income };
}
function assertTotals(summary: any, movements: any[], from?: number, to?: number) {
  const want = expectedTotals(movements, from, to);
  const got = new Map<string, any>(summary.categories.map((c: any) => [c.id, c]));
  assert.equal(got.size, summary.categories.length, 'one entry per category');
  for (const [id, w] of want.categories) {
    const g = got.get(id);
    assert.ok(g, `category ${id} is in the summary`);
    assert.equal(g.spentCents, w.spent, `${id}: spentCents`);
    assert.equal(g.confirmedCents, w.confirmed, `${id}: confirmedCents`);
    assert.ok(g.count >= w.debits && g.count <= w.all, `${id}: count ${g.count}`);
  }
  for (const c of summary.categories) {
    assert.ok(want.categories.has(c.id), `${c.id} has no spend in the rows`);
    assert.ok(c.id !== 'income' && c.id !== 'savings_internal', `${c.id} is not a spend category`);
    assert.equal(c.label, CATEGORY_LABELS[c.id]);
    assert.ok(c.count > 0, `${c.id}: count > 0`);
    assert.equal(c.confirmedCents + c.estimatedCents, c.spentCents, `${c.id}: confirmed+estimated`);
  }
  const spent = summary.categories.map((c: any) => c.spentCents);
  assert.deepEqual(
    spent,
    [...spent].sort((a, b) => b - a),
    'largest spentCents first',
  );
  assert.equal(
    summary.spentCents,
    spent.reduce((a: number, b: number) => a + b, 0),
    'spentCents',
  );
  assert.equal(summary.incomeCents, want.income, 'incomeCents');
}

// ---------------------------------------------------------------- guards (pass before SI5 lands)

test('harness guard: the app serves the seeded bank through the existing routes', async () => {
  assert.deepEqual(ok(await call(A, null, 'GET', 'health')), { ok: true });
  assert.equal((await call(A, null, 'GET', 'dashboard')).status, 401);
  const lucia = await dashboard(A, 'lucia');
  assert.ok(lucia.movements.some((m: any) => m.id === 'demo-lucia-001'));
  const rows = ok(await call(A, 'lucia', 'GET', 'movements')).rows;
  assert.ok(rows.some((r: any) => r.direction === 'internal'));
  assert.ok(Array.isArray((await dashboard(A, 'marta')).incidents), 'operator sees the inbox');
  refused(
    await call(A, 'lucia', 'POST', 'notifications/read', {
      body: { all: true },
      headers: { origin: 'https://evil.example' },
    }),
    403,
    { error: 'Origin not allowed.' },
  );
});

test('harness guard: existing POST routes already answer 400, 413 and the common headers as the tests expect', async () => {
  refused(await call(A, 'lucia', 'POST', 'notifications/read', { raw: '{' }), 400, INVALID);
  refused(
    await call(A, 'lucia', 'POST', 'notifications/read', { body: { all: true, x: 1 } }),
    400,
    INVALID,
  );
  refused(
    await call(A, 'lucia', 'POST', 'notifications/read', {
      raw: JSON.stringify({ all: true, pad: 'x'.repeat(300_000) }),
    }),
    413,
    { error: 'The request is too large.' },
  );
  const r = await call(A, 'lucia', 'GET', 'notifications', {
    headers: { 'x-request-id': 'acc-si5-guard' },
  });
  assert.equal(r.status, 200, r.label);
  assert.equal(r.headers.get('x-request-id'), 'acc-si5-guard');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  await sleep(300);
  const lines = A.out
    .join('')
    .split('\n')
    .filter((l) => l.includes('acc-si5-guard'));
  assert.ok(lines.length >= 1, 'the app log is captured, with the request id');
  assert.match(lines.join('\n'), /api_request/);
});

test('harness guard: an injected movement reaches the dashboard of its customer only', async () => {
  const description = unknown();
  const [id] = await inject(A, 'lucia', -777, description);
  assert.match(id, /^inj-\d+$/);
  const bruno = await dashboard(A, 'bruno');
  assert.ok(!bruno.movements.some((m: any) => m.description === description));
});

// ---------------------------------------------------------------- REQ-SI5-1

test('REQ-SI5-1 every bank movement in GET /api/dashboard has a category of the contract shape with movementIds', async () => {
  for (const who of ['lucia', 'bruno']) {
    const { movements } = await dashboard(A, who);
    assert.ok(movements.length >= 30, `${who} has the seeded movements`);
    for (const m of movements) {
      assertCategory(m.category, m.amountCents, `${who} ${m.id}`);
      assert.ok(m.category.movementIds.includes(m.id), `${m.id}: movementIds holds its own id`);
      if (!m.operationId) assert.deepEqual(m.category.movementIds, [m.id]);
      assert.notEqual(m.category.state, 'pending', 'DECIDER=none decides at once');
    }
  }
});

test('REQ-SI5-1 every row of GET /api/movements has a category with movementIds of bank movements', async () => {
  for (const who of ['lucia', 'bruno']) {
    const ids = new Set((await dashboard(A, who)).movements.map((m: any) => m.id));
    const { rows } = ok(await call(A, who, 'GET', 'movements'));
    assert.ok(rows.length >= 28);
    for (const row of rows) {
      assertCategory(row.category, row.direction === 'received' ? 1 : -1, `${who} row ${row.id}`);
      for (const id of row.category.movementIds) assert.ok(ids.has(id), `${id} is a bank movement`);
    }
  }
});

test('REQ-SI5-1 a merged "Between your accounts" row is savings_internal and lists both legs', async () => {
  const byId = await rowsById(A, 'lucia');
  const merged = ok(await call(A, 'lucia', 'GET', 'movements')).rows.filter(
    (r: any) => r.direction === 'internal' && r.category?.movementIds?.length === 2,
  );
  assert.ok(merged.length >= 2, 'the two seeded savings transfers are merged rows with two ids');
  for (const row of merged) {
    assert.equal(row.category.id, 'savings_internal');
    const [x, y] = row.category.movementIds.map((id: string) => byId.get(id));
    assert.ok(x && y, 'both legs are bank movements');
    assert.ok(x.operationId && x.operationId === y.operationId, 'the legs share one operation');
    assert.equal(x.amountCents, -y.amountCents);
    for (const leg of [x, y]) assert.equal(leg.category.id, 'savings_internal');
  }
  // movementIds are "the ids to send when changing this row": posting them changes both legs.
  const ids = merged[0].category.movementIds;
  const result = ok(
    await setCategory(A, 'lucia', { movementIds: ids, category: 'savings_internal' }),
  );
  assert.equal(result.updated, 2);
  const now = await rowsById(A, 'lucia');
  for (const id of ids) {
    assert.equal(now.get(id).category.state, 'confirmed');
    assert.equal(now.get(id).category.source, 'user');
  }
});

test('REQ-SI5-1 proposal rows have no category', async () => {
  const proposal = ok(
    await call(A, 'lucia', 'POST', 'actions', {
      body: {
        name: 'transfer_money',
        arguments: {
          fromAccountId: 'acc-lucia',
          toAccountId: 'acc-bruno',
          amountCents: 100,
          concept: 'acceptance',
        },
      },
    }),
  );
  assert.equal(proposal.status, 'requires_confirmation');
  try {
    const d = await dashboard(A, 'lucia');
    assert.ok(
      d.movements.every((m: any) => m.category),
      'bank movements have a category',
    );
    assert.ok(d.approvals.length >= 1);
    for (const p of [...d.approvals, ...d.transfers]) assert.equal(p.category, undefined);
    const { rows } = ok(await call(A, 'lucia', 'GET', 'movements'));
    assert.ok(rows.every((r: any) => r.category && !['pending', 'verifying'].includes(r.kind)));
  } finally {
    await call(A, 'lucia', 'POST', `approvals/${proposal.approval.id}/cancel`);
  }
});

// ---------------------------------------------------------------- REQ-SI5-2

test('REQ-SI5-2 dashboard.insights equals GET /api/insights/spending for the same bank state', async () => {
  for (const who of ['lucia', 'bruno']) {
    const d = await dashboard(A, who);
    assert.ok(d.insights, 'dashboard.insights is missing');
    assert.deepEqual(await spending(A, who), d.insights);
  }
});

test('REQ-SI5-2 the summary has the contract shape and describes the bank window', async () => {
  const { movements, insights: s } = await dashboard(A, 'lucia');
  assert.deepEqual(s.range, { from: null, to: null });
  assert.equal(s.window.returned, movements.length);
  assert.equal(
    Date.parse(s.window.oldestAt),
    Math.min(...movements.map((m: any) => Date.parse(m.createdAt))),
  );
  assert.equal(s.window.mayBeTruncated, false, 'fewer movements than the page of 100');
  assert.equal(s.partial, false);
  assert.equal(s.pending, 0);
  assert.equal(s.decider, 'none');
  for (const k of ['spentCents', 'incomeCents']) assert.ok(Number.isInteger(s[k]), k);
  assert.ok(Array.isArray(s.categories) && Array.isArray(s.unresolved.groups));
});

test('REQ-SI5-2 totals follow the contract and agree with the rows of the same response', async () => {
  for (const who of ['lucia', 'bruno']) {
    const d = await dashboard(A, who);
    assertTotals(d.insights, d.movements);
    assert.ok(d.insights.spentCents > 0 && d.insights.incomeCents > 0, `${who} spends and earns`);
  }
  // Opening rows are `other` and in no total; own transfers are in no total.
  const { movements, insights } = await dashboard(A, 'lucia');
  const openings = movements.filter((m: any) => m.description === 'Initial deposit');
  assert.equal(openings.length, 2);
  for (const m of openings) {
    assert.equal(m.category.id, 'other');
    assert.equal(m.category.state, 'estimated');
  }
  const income = movements.filter((m: any) => m.category.id === 'income');
  assert.ok(
    income.some((m: any) => m.id === 'demo-lucia-010'),
    'the salary is income',
  );
  assert.equal(
    insights.incomeCents,
    income.reduce((a: number, m: any) => a + m.amountCents, 0),
  );
  assert.ok(!insights.categories.some((c: any) => c.id === 'savings_internal'));
});

test('REQ-SI5-2 a refund (a credit in a spend category) is subtracted from that category and from the spend', async () => {
  const before = await spending(A, 'lucia');
  const groceries = (s: any) => s.categories.find((c: any) => c.id === 'groceries');
  assert.ok(groceries(before), 'Lucía has groceries (MERCADONA)');
  const [id] = await inject(A, 'lucia', 1234, unknown('REFUND'));
  ok(await setCategory(A, 'lucia', { movementIds: [id], category: 'groceries' }));
  const d = await dashboard(A, 'lucia');
  assert.equal(groceries(d.insights).spentCents, groceries(before).spentCents - 1234);
  assert.equal(d.insights.spentCents, before.spentCents - 1234);
  assert.equal(d.insights.incomeCents, before.incomeCents, 'a refund is not income');
  assertTotals(d.insights, d.movements);
});

// ---------------------------------------------------------------- REQ-SI5-3

test('REQ-SI5-3 from and to limit the summary', async () => {
  const { movements } = await dashboard(A, 'bruno');
  const all = await spending(A, 'bruno');
  const s = await spending(A, 'bruno', '?from=2026-09-01&to=2026-09-30');
  assert.ok(typeof s.range.from === 'string' && typeof s.range.to === 'string');
  assertTotals(
    s,
    movements,
    Date.parse('2026-09-01T00:00:00.000Z'),
    Date.parse('2026-09-30T23:59:59.999Z'),
  );
  assert.ok(s.spentCents > 0 && s.spentCents < all.spentCents, 'September is part of the window');
  // An ISO instant is accepted like on /api/movements, and one bound alone works.
  const instant = await spending(
    A,
    'bruno',
    `?from=${encodeURIComponent('2026-09-01T00:00:00.000Z')}`,
  );
  assertTotals(instant, movements, Date.parse('2026-09-01T00:00:00.000Z'));
  const untilAugust = await spending(A, 'bruno', '?to=2026-08-31');
  assertTotals(untilAugust, movements, undefined, Date.parse('2026-08-31T23:59:59.999Z'));
});

test('REQ-SI5-3 partial is true only when from is before the oldest returned movement', async () => {
  assert.equal((await spending(A, 'bruno', '?from=2020-01-01')).partial, true);
  assert.equal((await spending(A, 'bruno', '?from=2026-09-15')).partial, false);
  assert.equal((await spending(A, 'bruno', '?to=2026-09-15')).partial, false);
  assert.equal((await spending(A, 'bruno')).partial, false);
});

test('REQ-SI5-3 from after to is a 400 with the contract text', async () => {
  refused(await call(A, 'bruno', 'GET', 'insights/spending?from=2026-09-30&to=2026-09-01'), 400, {
    error: 'The start date is after the end date.',
  });
});

test('REQ-SI5-3 an unknown key, a repeated key or a bad value is a 400', async () => {
  for (const query of [
    '?foo=1',
    '?userId=bruno',
    '?from=2026-09-01&from=2026-09-02',
    '?to=2026-09-01&to=2026-09-01',
    '?from=yesterday',
    '?to=2026-13-45',
  ])
    refused(await call(A, 'lucia', 'GET', `insights/spending${query}`), 400, INVALID);
});

// ---------------------------------------------------------------- REQ-SI5-4

test('REQ-SI5-4 the demo bank guarantees: Lucía has 5+ movements to review in 3+ groups, Bruno has ESPAI NOU four times', async () => {
  const lucia = (await spending(A, 'lucia')).unresolved;
  assert.ok(lucia.count >= 5, `Lucía: ${lucia.count} to review`);
  assert.ok(lucia.groups.length >= 3, `Lucía: ${lucia.groups.length} groups`);
  const espai = (await spending(A, 'bruno')).unresolved.groups.filter(
    (g: any) => g.merchantKey === 'ESPAI NOU',
  );
  assert.equal(espai.length, 1);
  assert.ok(espai[0].count >= 4);
  for (const id of ['demo-bruno-002', 'demo-bruno-009', 'demo-bruno-015', 'demo-bruno-021'])
    assert.ok(espai[0].movementIds.includes(id), `${id} is in the ESPAI NOU group`);
});

test('REQ-SI5-4 unresolved lists the needs_review movements grouped by merchant key with counts, totals and reason', async () => {
  for (const who of ['lucia', 'bruno']) {
    const { movements, insights } = await dashboard(A, who);
    const review = movements.filter((m: any) => m.category.state === 'needs_review');
    const u = insights.unresolved;
    assert.equal(u.count, review.length);
    const abs = (list: any[]) => list.reduce((a, m) => a + Math.abs(m.amountCents), 0);
    assert.equal(u.totalCents, abs(review));
    assert.deepEqual(
      u.groups.flatMap((g: any) => g.movementIds).sort(),
      review.map((m: any) => m.id).sort(),
      'every movement to review is in exactly one group',
    );
    const totals = u.groups.map((g: any) => g.totalCents);
    assert.deepEqual(
      totals,
      [...totals].sort((a, b) => b - a),
      'largest totalCents first',
    );
    const keyed = u.groups.filter((g: any) => g.merchantKey !== '').map((g: any) => g.merchantKey);
    assert.equal(new Set(keyed).size, keyed.length, 'one group per merchant key');
    for (const g of u.groups) {
      const members = review.filter((m: any) => g.movementIds.includes(m.id));
      assert.equal(g.count, members.length);
      assert.equal(g.totalCents, abs(members));
      assert.ok(members.every((m: any) => m.category.merchantKey === g.merchantKey));
      assert.ok(
        members.some((m: any) => m.category.reason === g.reason),
        `reason ${g.reason}`,
      );
      assert.ok(typeof g.title === 'string' && g.title.length > 0);
      assert.ok(Array.isArray(g.candidates));
      if (g.merchantKey === '') assert.equal(g.count, 1, 'an empty key is its own group');
    }
  }
});

test('REQ-SI5-4 an injected ZZQXV movement is other, needs_review and appears in unresolved', async () => {
  const [id] = await inject(A, 'lucia', -1999, unknown());
  const row = (await rowsById(A, 'lucia')).get(id);
  assert.deepEqual(
    [row.category.id, row.category.state, row.category.source, row.category.reason],
    ['other', 'needs_review', 'none', 'no_decider'],
  );
  assert.notEqual(row.category.merchantKey, '');
  const group = (await spending(A, 'lucia')).unresolved.groups.find((g: any) =>
    g.movementIds.includes(id),
  );
  assert.ok(group, 'the injected movement is in an unresolved group');
  assert.deepEqual(
    [group.merchantKey, group.count, group.totalCents, group.reason],
    [row.category.merchantKey, 1, 1999, 'no_decider'],
  );
});

// ---------------------------------------------------------------- REQ-SI5-5

test('REQ-SI5-5 setting one movement confirms it (source user) and similar counts the others of that merchant', async () => {
  const [a, b, c] = await inject(A, 'lucia', -1500, unknown(), 3);
  const key = (await categoryOf(A, 'lucia', a)).merchantKey;
  const result = ok(await setCategory(A, 'lucia', { movementIds: [a], category: 'shopping' }));
  assert.equal(result.updated, 1);
  assert.equal(result.similar.length, 1);
  assert.equal(result.similar[0].merchantKey, key);
  assert.equal(result.similar[0].count, 2);
  assert.deepEqual([...result.similar[0].movementIds].sort(), [b, c].sort());
  assert.ok(Array.isArray(result.rules) && !result.rules.includes(key), 'no rule was created');
  const rows = await rowsById(A, 'lucia');
  const set = rows.get(a).category;
  assert.deepEqual(
    [set.id, set.state, set.source, set.reason],
    ['shopping', 'confirmed', 'user', 'user'],
  );
  for (const id of [b, c]) assert.equal(rows.get(id).category.state, 'needs_review');
  const row = ok(await call(A, 'lucia', 'GET', 'movements')).rows.find((r: any) =>
    r.category.movementIds.includes(a),
  );
  assert.deepEqual([row.category.id, row.category.state], ['shopping', 'confirmed']);
  assert.ok(!(await rulesOf(A, 'lucia')).some((r) => r.merchantKey === key));
});

test('REQ-SI5-5 repeating the same set is idempotent', async () => {
  const [a, b] = await inject(A, 'lucia', -900, unknown(), 2);
  const body = { movementIds: [a], category: 'health' };
  const first = ok(await setCategory(A, 'lucia', body));
  const state = await snapshot(A, 'lucia');
  const second = ok(await setCategory(A, 'lucia', body));
  assert.deepEqual(second.similar, first.similar);
  assert.deepEqual(second.similar[0].movementIds, [b]);
  assert.deepEqual(await snapshot(A, 'lucia'), state);
  // applyToSimilar: false is the same as leaving it out.
  ok(await setCategory(A, 'lucia', { ...body, applyToSimilar: false }));
  assert.deepEqual(await snapshot(A, 'lucia'), state);
});

test('REQ-SI5-5 similar counts only movements in the current bank answer', async () => {
  // Three movements of one merchant; the bank then stops returning the oldest one.
  const description = unknown();
  const [old] = await inject(A, 'elena', -1100, description, 1, '2020-01-01T10:00:00.000Z');
  await inject(A, 'elena', -1100, description, 2);
  const all = (await dashboard(A, 'elena')).movements; // all three now have a stored category
  const [x, y] = all
    .filter((m: any) => m.description === description && m.id !== old)
    .map((m: any) => m.id);
  await control('config', { movementsLimit: all.length - 1 });
  try {
    assert.ok(
      !(await rowsById(A, 'elena')).has(old),
      'the bank no longer returns the old movement',
    );
    const result = ok(await setCategory(A, 'elena', { movementIds: [x], category: 'transport' }));
    assert.equal(result.updated, 1);
    assert.equal(result.similar.length, 1);
    assert.equal(result.similar[0].count, 1);
    assert.deepEqual(result.similar[0].movementIds, [y]);
    // A movement the bank does not return now is not the actor's "current bank answer".
    refused(
      await setCategory(A, 'elena', { movementIds: [old], category: 'transport' }),
      404,
      NOT_FOUND,
    );
  } finally {
    await control('config', { movementsLimit: 100 });
  }
  const back = (await rowsById(A, 'elena')).get(old);
  assert.equal(back.category.state, 'needs_review', 'the vanished movement was never changed');
});

// ---------------------------------------------------------------- REQ-SI5-6

test("REQ-SI5-6 another customer's movement id or an invented id is a 404 and nothing is written", async () => {
  const [mine] = await inject(A, 'lucia', -640, unknown(), 2);
  const lucia = await snapshot(A, 'lucia');
  const bruno = await snapshot(A, 'bruno');
  const events = auditEvents(A).length;
  const foreign = await setCategory(A, 'lucia', {
    movementIds: ['demo-bruno-002'],
    category: 'shopping',
  });
  const invented = await setCategory(A, 'lucia', {
    movementIds: ['no-such-movement'],
    category: 'shopping',
  });
  refused(foreign, 404, NOT_FOUND);
  assert.deepEqual(invented.body, foreign.body, "B's id answers like an unknown id");
  assert.equal(invented.status, foreign.status);
  // Even when the list also holds valid ids, with or without "apply to similar".
  for (const applyToSimilar of [false, true])
    for (const movementIds of [
      [mine, 'demo-bruno-002'],
      ['demo-bruno-002', mine],
      [mine, 'no-such-movement'],
    ])
      refused(
        await setCategory(A, 'lucia', { movementIds, category: 'shopping', applyToSimilar }),
        404,
        NOT_FOUND,
      );
  assert.deepEqual(await snapshot(A, 'lucia'), lucia, 'nothing changed for the actor');
  assert.deepEqual(await snapshot(A, 'bruno'), bruno, 'nothing changed for the other customer');
  assert.equal(auditEvents(A).length, events, 'no audit event');
});

test("REQ-SI5-6 a customer's summary, rows and rules hold nothing of another customer", async () => {
  const [id] = await inject(A, 'bruno', -810, unknown('ISOL'));
  const key = (await categoryOf(A, 'bruno', id)).merchantKey;
  ok(
    await setCategory(A, 'bruno', { movementIds: [id], category: 'health', applyToSimilar: true }),
  );
  assert.ok((await rulesOf(A, 'bruno')).some((r) => r.merchantKey === key));
  const text = [
    await call(A, 'lucia', 'GET', 'insights/spending'),
    await call(A, 'lucia', 'GET', 'insights/rules'),
    await call(A, 'lucia', 'GET', 'dashboard'),
    await call(A, 'lucia', 'GET', 'movements'),
  ]
    .map((r) => (assert.equal(r.status, 200, r.label), r.text))
    .join('\n');
  assert.ok(!text.includes(key), "B's merchant key is in none of A's responses");
  assert.ok(!text.includes(`"${id}"`), "B's movement id is in none of A's responses");
  assert.ok(!text.includes('demo-bruno-'));
  // A cannot remove B's rule: for A that key is an unknown key.
  assert.deepEqual(ok(await deleteRule(A, 'lucia', key)), { removed: false, reclassified: 0 });
  assert.ok(
    (await rulesOf(A, 'bruno')).some((r) => r.merchantKey === key),
    "B's rule is still there",
  );
  assert.equal((await categoryOf(A, 'bruno', id)).state, 'confirmed');
});

// ---------------------------------------------------------------- REQ-SI5-7

test('REQ-SI5-7 applyToSimilar confirms the similar movements as user_rule and creates the rule', async () => {
  const espai = ['demo-bruno-002', 'demo-bruno-009', 'demo-bruno-015', 'demo-bruno-021'];
  const others = (await dashboard(A, 'bruno')).movements
    .filter(
      (m: any) => m.category.merchantKey === 'ESPAI NOU' && m.amountCents < 0 && m.id !== espai[0],
    )
    .map((m: any) => m.id);
  assert.ok(espai.slice(1).every((id) => others.includes(id)));
  const result = ok(
    await setCategory(A, 'bruno', {
      movementIds: [espai[0]],
      category: 'eating_out_leisure',
      applyToSimilar: true,
    }),
  );
  assert.equal(result.updated, 1 + others.length);
  assert.equal(result.similar.length, 1);
  assert.equal(result.similar[0].merchantKey, 'ESPAI NOU');
  assert.equal(result.similar[0].count, others.length);
  assert.deepEqual([...result.similar[0].movementIds].sort(), [...others].sort());
  assert.ok(result.rules.includes('ESPAI NOU'));
  const rows = await rowsById(A, 'bruno');
  const hand = rows.get(espai[0]).category;
  assert.deepEqual([hand.id, hand.state, hand.source], ['eating_out_leisure', 'confirmed', 'user']);
  for (const id of others) {
    const c = rows.get(id).category;
    assert.deepEqual(
      [c.id, c.state, c.source, c.reason],
      ['eating_out_leisure', 'confirmed', 'user_rule', 'user_rule:ESPAI NOU'],
      id,
    );
  }
  const rule = (await rulesOf(A, 'bruno')).find((r) => r.merchantKey === 'ESPAI NOU');
  assert.equal(rule?.category, 'eating_out_leisure');
  assert.ok(!Number.isNaN(Date.parse(rule!.createdAt)));
  const s = await spending(A, 'bruno');
  assert.ok(!s.unresolved.groups.some((g: any) => g.merchantKey === 'ESPAI NOU'));
  const category = s.categories.find((c: any) => c.id === 'eating_out_leisure');
  assert.ok(category.confirmedCents >= 1500 * (1 + others.length));
});

test('REQ-SI5-7 a movement of that merchant injected afterwards is confirmed · user_rule on first read', async () => {
  ok(
    await setCategory(A, 'bruno', {
      movementIds: ['demo-bruno-002'],
      category: 'eating_out_leisure',
      applyToSimilar: true,
    }),
  );
  const [id] = await inject(A, 'bruno', -1650, 'SUMUP *ESPAI NOU'); // the first read is inside
  const c = await categoryOf(A, 'bruno', id);
  assert.deepEqual(
    [c.id, c.state, c.source, c.merchantKey],
    ['eating_out_leisure', 'confirmed', 'user_rule', 'ESPAI NOU'],
  );
});

test("REQ-SI5-7 another customer's movement of the same merchant is not touched by the rule", async () => {
  ok(
    await setCategory(A, 'bruno', {
      movementIds: ['demo-bruno-002'],
      category: 'eating_out_leisure',
      applyToSimilar: true,
    }),
  );
  const [id] = await inject(A, 'lucia', -1500, 'SUMUP *ESPAI NOU');
  const c = await categoryOf(A, 'lucia', id);
  assert.equal(c.merchantKey, 'ESPAI NOU');
  assert.deepEqual([c.id, c.state, c.source], ['other', 'needs_review', 'none']);
  assert.ok(!(await rulesOf(A, 'lucia')).some((r) => r.merchantKey === 'ESPAI NOU'));
});

test('REQ-SI5-7 applyToSimilar replaces an existing rule for the merchant', async () => {
  const [a, b] = await inject(A, 'lucia', -700, unknown(), 2);
  const key = (await categoryOf(A, 'lucia', a)).merchantKey;
  ok(await setCategory(A, 'lucia', { movementIds: [a], category: 'health', applyToSimilar: true }));
  ok(
    await setCategory(A, 'lucia', { movementIds: [a], category: 'shopping', applyToSimilar: true }),
  );
  const rules = (await rulesOf(A, 'lucia')).filter((r) => r.merchantKey === key);
  assert.deepEqual(
    rules.map((r) => r.category),
    ['shopping'],
    'one rule per merchant key',
  );
  const c = await categoryOf(A, 'lucia', b);
  assert.deepEqual([c.id, c.state, c.source], ['shopping', 'confirmed', 'user_rule']);
});

// ---------------------------------------------------------------- REQ-SI5-8

test('REQ-SI5-8 a debit set to income or a credit set to transfer_person is a 400 and writes nothing', async () => {
  const [debit] = await inject(A, 'lucia', -1300, unknown('DEBIT'), 2);
  const [credit] = await inject(A, 'lucia', 1300, unknown('CREDIT'), 2);
  const state = await snapshot(A, 'lucia');
  const events = auditEvents(A).length;
  for (const applyToSimilar of [false, true]) {
    refused(
      await setCategory(A, 'lucia', { movementIds: [debit], category: 'income', applyToSimilar }),
      400,
      BAD_FIT,
    );
    refused(
      await setCategory(A, 'lucia', {
        movementIds: [credit],
        category: 'transfer_person',
        applyToSimilar,
      }),
      400,
      BAD_FIT,
    );
    // One id of the list fails the sign rule: nothing is written for the others either.
    refused(
      await setCategory(A, 'lucia', {
        movementIds: [debit, credit],
        category: 'transfer_person',
        applyToSimilar,
      }),
      400,
      BAD_FIT,
    );
    refused(
      await setCategory(A, 'lucia', {
        movementIds: [credit, debit],
        category: 'income',
        applyToSimilar,
      }),
      400,
      BAD_FIT,
    );
  }
  assert.deepEqual(await snapshot(A, 'lucia'), state);
  assert.equal(auditEvents(A).length, events, 'no audit event');
  // The allowed directions work: a debit may be a person transfer, a credit may be income.
  ok(await setCategory(A, 'lucia', { movementIds: [debit], category: 'transfer_person' }));
  ok(await setCategory(A, 'lucia', { movementIds: [credit], category: 'income' }));
});

// ---------------------------------------------------------------- REQ-SI5-9

test('REQ-SI5-9 GET /api/insights/rules lists the customer rules, newest first', async () => {
  const keys: string[] = [];
  for (const category of ['health', 'transport']) {
    const [id] = await inject(A, 'carla', -500, unknown('RULE'));
    keys.push((await categoryOf(A, 'carla', id)).merchantKey);
    ok(await setCategory(A, 'carla', { movementIds: [id], category, applyToSimilar: true }));
    await sleep(20);
  }
  const res = await call(A, 'carla', 'GET', 'insights/rules');
  assert.deepEqual(Object.keys(ok(res)), ['rules']);
  const rules = res.body.rules;
  for (const r of rules) {
    assert.deepEqual(Object.keys(r).sort(), ['category', 'createdAt', 'merchantKey']);
    assert.ok(CATEGORY_IDS.includes(r.category) && !Number.isNaN(Date.parse(r.createdAt)));
  }
  assert.deepEqual(
    rules.slice(0, 2).map((r: any) => [r.merchantKey, r.category]),
    [
      [keys[1], 'transport'],
      [keys[0], 'health'],
    ],
  );
  const times = rules.map((r: any) => Date.parse(r.createdAt));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
});

test('REQ-SI5-9 DELETE removes the rule, sends its user_rule movements back to review and keeps hand-set ones', async () => {
  const description = unknown();
  const [a, b, c] = await inject(A, 'lucia', -2100, description, 3);
  const key = (await categoryOf(A, 'lucia', a)).merchantKey;
  ok(await setCategory(A, 'lucia', { movementIds: [a], category: 'health', applyToSimilar: true }));
  ok(await setCategory(A, 'lucia', { movementIds: [b], category: 'health' })); // b by hand
  let rows = await rowsById(A, 'lucia');
  assert.deepEqual(
    [a, b, c].map((id) => rows.get(id).category.source),
    ['user', 'user', 'user_rule'],
  );
  assert.deepEqual(ok(await deleteRule(A, 'lucia', key)), { removed: true, reclassified: 1 });
  assert.ok(!(await rulesOf(A, 'lucia')).some((r) => r.merchantKey === key), 'the rule is gone');
  rows = await rowsById(A, 'lucia');
  for (const id of [a, b]) {
    const hand = rows.get(id).category;
    assert.deepEqual([hand.id, hand.state, hand.source], ['health', 'confirmed', 'user'], id);
  }
  const back = rows.get(c).category;
  assert.deepEqual([back.id, back.state, back.source], ['other', 'needs_review', 'none']);
  assert.ok(
    (await spending(A, 'lucia')).unresolved.groups.some((g: any) => g.movementIds.includes(c)),
  );
  // The rule no longer applies to a later movement of that merchant.
  const [later] = await inject(A, 'lucia', -2100, description);
  assert.equal((await categoryOf(A, 'lucia', later)).state, 'needs_review');
  // Removing it again: no such rule, still 200.
  assert.deepEqual(ok(await deleteRule(A, 'lucia', key)), { removed: false, reclassified: 0 });
});

test('REQ-SI5-9 removing the ESPAI NOU rule puts its movements back in review (no global rule knows it)', async () => {
  ok(
    await setCategory(A, 'bruno', {
      movementIds: ['demo-bruno-002'],
      category: 'eating_out_leisure',
      applyToSimilar: true,
    }),
  );
  const ruled = (await dashboard(A, 'bruno')).movements
    .filter((m: any) => m.category.merchantKey === 'ESPAI NOU' && m.category.source === 'user_rule')
    .map((m: any) => m.id);
  assert.ok(ruled.length >= 3);
  // The key travels URL-encoded (`ESPAI%20NOU`).
  assert.deepEqual(ok(await deleteRule(A, 'bruno', 'ESPAI NOU')), {
    removed: true,
    reclassified: ruled.length,
  });
  const rows = await rowsById(A, 'bruno');
  for (const id of ruled) {
    const c = rows.get(id).category;
    assert.deepEqual([c.id, c.state, c.source], ['other', 'needs_review', 'none'], id);
  }
  const hand = rows.get('demo-bruno-002').category;
  assert.deepEqual([hand.id, hand.state, hand.source], ['eating_out_leisure', 'confirmed', 'user']);
  const group = (await spending(A, 'bruno')).unresolved.groups.find(
    (g: any) => g.merchantKey === 'ESPAI NOU',
  );
  assert.equal(group?.count, ruled.length);
});

test('REQ-SI5-9 DELETE of an unknown key answers removed: false with a 200', async () => {
  for (const key of ['ZZQXV NEVERSEEN', 'A&B 24'])
    assert.deepEqual(ok(await deleteRule(A, 'lucia', key)), { removed: false, reclassified: 0 });
});

// ---------------------------------------------------------------- REQ-SI5-10

const insightsRoutes = (id: string): ['GET' | 'POST' | 'DELETE', string, unknown?][] => [
  ['GET', 'insights/spending'],
  ['GET', 'insights/rules'],
  [
    'POST',
    'insights/categories',
    { movementIds: [id], category: 'shopping', applyToSimilar: true },
  ],
  ['POST', 'insights/reclassify', {}],
  ['DELETE', 'insights/rules/ESPAI%20NOU'],
];

test('REQ-SI5-10 every /api/insights/* route answers 401 without a session and 403 to an operator', async () => {
  const [id] = await inject(A, 'lucia', -450, unknown(), 2);
  const state = await snapshot(A, 'lucia');
  for (const [method, route, body] of insightsRoutes(id)) {
    const anonymous = await call(A, null, method, route, { body });
    refused(anonymous, 401, { error: 'Select a person to continue.' });
    const forged = await call(A, null, method, route, {
      body,
      headers: { cookie: 'banana_actor=lucia' },
    });
    assert.equal(forged.status, 401, forged.label);
    for (const operator of ['marta', 'pablo']) {
      const r = await call(A, operator, method, route, { body });
      assert.equal(r.status, 403, r.label);
      assert.equal(typeof r.body?.error, 'string', r.label);
    }
  }
  assert.deepEqual(await snapshot(A, 'lucia'), state, 'nothing was written');
});

test('REQ-SI5-10 the operator dashboard stays the inbox, without insights or categories', async () => {
  const d = await dashboard(A, 'marta');
  assert.ok(Array.isArray(d.incidents));
  assert.equal(d.insights, undefined);
  assert.equal(d.movements, undefined);
  // The customer dashboard has them: this is what the operator must not get.
  assert.ok((await dashboard(A, 'lucia')).insights, 'the customer dashboard has insights');
});

test('REQ-SI5-10 every non-GET insights route answers 403 to a foreign origin', async () => {
  const [id] = await inject(A, 'lucia', -460, unknown(), 2);
  const key = (await categoryOf(A, 'lucia', id)).merchantKey;
  ok(
    await setCategory(A, 'lucia', { movementIds: [id], category: 'health', applyToSimilar: true }),
  );
  const state = await snapshot(A, 'lucia');
  const denied = { error: 'Origin not allowed.' };
  for (const origin of ['https://evil.example', 'http://bank.example:3000']) {
    refused(
      await setCategory(A, 'lucia', { movementIds: [id], category: 'shopping' }, { origin }),
      403,
      denied,
    );
    refused(
      await call(A, 'lucia', 'POST', 'insights/reclassify', { body: {}, headers: { origin } }),
      403,
      denied,
    );
    refused(await deleteRule(A, 'lucia', key, { origin }), 403, denied);
  }
  assert.deepEqual(
    await snapshot(A, 'lucia'),
    state,
    'nothing was written, the rule is still there',
  );
  // The app's own origin is accepted.
  ok(await setCategory(A, 'lucia', { movementIds: [id], category: 'health' }, { origin: A.url }));
  ok(
    await call(A, 'lucia', 'POST', 'insights/reclassify', { body: {}, headers: { origin: A.url } }),
  );
  assert.equal(ok(await deleteRule(A, 'lucia', key, { origin: A.url })).removed, true);
});

test('REQ-SI5-10 invalid bodies of POST /api/insights/categories are a 400 and write nothing', async () => {
  const [id, other] = await inject(A, 'lucia', -470, unknown(), 2);
  const state = await snapshot(A, 'lucia');
  const good = { movementIds: [id], category: 'shopping' };
  const bodies: unknown[] = [
    { ...good, category: 'food' }, // unknown category
    { ...good, category: 'Shopping' },
    { ...good, category: null },
    { movementIds: [id] }, // category missing
    { category: 'shopping' }, // ids missing
    { ...good, movementIds: [] }, // empty list
    { ...good, movementIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }, // 101 ids
    { ...good, movementIds: [id, ...Array.from({ length: 100 }, (_, i) => `id-${i}`)] },
    { ...good, movementIds: id }, // not a list
    { ...good, movementIds: [id, 7] },
    { ...good, movementIds: [null] },
    { ...good, movementIds: [{ id }] },
    { ...good, applyToSimilar: 'yes' },
    { ...good, applyToSimilar: 1 },
    { ...good, applyToSimilar: null },
    { ...good, extra: 1 }, // extra key
    { ...good, userId: 'bruno' },
    { ...good, movementId: other },
    [good],
    'shopping',
    null,
  ];
  for (const body of bodies) {
    const r = await setCategory(A, 'lucia', body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${r.label}`);
    assert.deepEqual(r.body, INVALID, r.label);
  }
  for (const raw of ['{', '', 'movementIds=x&category=shopping'])
    refused(await call(A, 'lucia', 'POST', 'insights/categories', { raw }), 400, INVALID);
  assert.deepEqual(await snapshot(A, 'lucia'), state);
});

test('REQ-SI5-10 the body of POST /api/insights/reclassify is strict', async () => {
  for (const body of [{ extra: 1 }, { movementIds: ['x'] }, []])
    refused(await call(A, 'lucia', 'POST', 'insights/reclassify', { body }), 400, INVALID);
});

test('REQ-SI5-10 a body over the limit is a 413 on the insights POST routes', async () => {
  const [id] = await inject(A, 'lucia', -480, unknown());
  const state = await snapshot(A, 'lucia');
  const raw = JSON.stringify({ movementIds: [id], category: 'shopping', pad: 'x'.repeat(300_000) });
  for (const route of ['insights/categories', 'insights/reclassify'])
    refused(await call(A, 'lucia', 'POST', route, { raw }), 413, {
      error: 'The request is too large.',
    });
  assert.deepEqual(await snapshot(A, 'lucia'), state);
});

test('REQ-SI5-10 insights responses carry the request id and the security headers of every API response', async () => {
  const responses = [
    await call(A, 'lucia', 'GET', 'insights/spending', {
      headers: { 'x-request-id': 'acc-si5-1' },
    }),
    await call(A, 'lucia', 'GET', 'insights/rules', { headers: { 'x-request-id': 'acc-si5-1' } }),
    await call(A, 'lucia', 'POST', 'insights/reclassify', {
      body: {},
      headers: { 'x-request-id': 'acc-si5-1' },
    }),
    await deleteRule(A, 'lucia', 'ZZQXV NEVERSEEN', { 'x-request-id': 'acc-si5-1' }),
  ];
  for (const r of responses) {
    assert.equal(r.status, 200, r.label);
    assert.equal(r.headers.get('x-request-id'), 'acc-si5-1', r.label);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', r.label);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', r.label);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/, r.label);
  }
});

// ---------------------------------------------------------------- REQ-SI5-11

test('REQ-SI5-11 each category change and each rule creation or removal records one event with channel ui', async () => {
  const mine = () => auditEvents(A).filter((e) => e.userId === 'diego');
  const [a, b, c] = await inject(A, 'diego', -300, unknown(), 3);
  const key = (await categoryOf(A, 'diego', a)).merchantKey;
  let seen = mine().length;
  const fresh = () => {
    const all = mine();
    const added = all.slice(seen);
    seen = all.length;
    return added;
  };

  // One movement by hand: one category.set.
  ok(await setCategory(A, 'diego', { movementIds: [a], category: 'shopping' }));
  let added = fresh();
  assert.deepEqual(
    added.map((e) => e.kind),
    ['category.set'],
  );
  const { from, ...first } = added[0].data;
  assert.deepEqual(first, { channel: 'ui', movementId: a, to: 'shopping', source: 'user' });
  assert.ok(from === 'other' || from === null, `from: ${from}`);

  // Apply to similar: one category.set per changed movement and one rule.created.
  ok(await setCategory(A, 'diego', { movementIds: [a], category: 'health', applyToSimilar: true }));
  added = fresh();
  const sets = added.filter((e) => e.kind === 'category.set');
  assert.equal(added.length, 4, JSON.stringify(added));
  assert.deepEqual(sets.map((e) => e.data.movementId).sort(), [a, b, c].sort());
  for (const e of sets) {
    assert.equal(e.data.channel, 'ui');
    assert.equal(e.data.to, 'health');
    assert.equal(e.data.source, e.data.movementId === a ? 'user' : 'user_rule');
    if (e.data.movementId === a) assert.equal(e.data.from, 'shopping');
    else assert.ok(e.data.from === 'other' || e.data.from === null, `from: ${e.data.from}`);
  }
  assert.deepEqual(
    added.filter((e) => e.kind === 'rule.created').map((e) => e.data),
    [{ channel: 'ui', merchantKey: key, category: 'health' }],
  );

  // Refused requests record nothing.
  await setCategory(A, 'diego', { movementIds: [a, 'no-such-movement'], category: 'shopping' });
  await setCategory(A, 'diego', { movementIds: [a], category: 'income' });
  await deleteRule(A, 'diego', 'ZZQXV NEVERSEEN');
  assert.deepEqual(fresh(), []);

  // Removing the rule: one rule.removed.
  assert.equal(ok(await deleteRule(A, 'diego', key)).removed, true);
  added = fresh();
  assert.deepEqual(
    added.filter((e) => e.kind !== 'category.set').map((e) => [e.kind, e.data]),
    [['rule.removed', { channel: 'ui', merchantKey: key, category: 'health' }]],
  );
});

// ---------------------------------------------------------------- REQ-SI5-13, -14 on the DECIDER=none app

test('REQ-SI5-13 with nothing unavailable (DECIDER=none) reclassify queues nothing', async () => {
  const state = await snapshot(A, 'lucia');
  assert.deepEqual(ok(await call(A, 'lucia', 'POST', 'insights/reclassify', { body: {} })), {
    queued: 0,
  });
  assert.deepEqual(await snapshot(A, 'lucia'), state);
});

test('REQ-SI5-14 no log line holds a raw description of a classified movement or a movement id', async () => {
  // A dirty description whose merchant key differs from it, through every insights route.
  const description = 'COMPRA TARJ. 4532XXXXXXXX9876 ZZQXV LOGCHECK 0412 MADRID ES';
  const [id] = await inject(A, 'lucia', -990, description);
  const key = (await categoryOf(A, 'lucia', id)).merchantKey;
  await setCategory(A, 'lucia', { movementIds: [id], category: 'shopping', applyToSimilar: true });
  await setCategory(A, 'lucia', { movementIds: [id, 'demo-bruno-002'], category: 'shopping' });
  await setCategory(A, 'lucia', { movementIds: [id], category: 'income' });
  await spending(A, 'lucia');
  await deleteRule(A, 'lucia', key, { 'x-request-id': 'acc-si5-log-delete' });
  await sleep(300);
  const out = A.out.join('');
  assert.match(
    out,
    /api_request/,
    'the access log is captured (otherwise this test proves nothing)',
  );
  for (const raw of [
    description,
    'COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES',
    'PAYPAL *SPOTIFY 35314369001',
    'TPV BAR LA ESQUINA SL 27/09 03:41',
    'SUMUP *ESPAI NOU',
    'Pago en CONSUM COOP V. VALENCIA',
  ])
    assert.ok(!out.includes(raw), `a log line holds the raw description "${raw}"`);
  const ids = out.match(/\b(demo-(lucia|bruno)-\d{3}|inj-\d+)\b/g);
  assert.equal(ids, null, `log lines hold movement ids: ${ids?.slice(0, 5)}`);
  // The app's own (JSON) line for the DELETE does not spell the merchant key of the path.
  const lines = out.split('\n').filter((l) => l.includes('acc-si5-log-delete'));
  assert.ok(lines.length >= 1, 'the DELETE was logged with its request id');
  for (const line of lines.filter((l) => l.trim().startsWith('{')))
    assert.ok(!line.includes(key) && !line.includes(encodeURIComponent(key)), line);
});

// ---------------------------------------------------------------- REQ-SI5-12, -13 (model stub)

test('REQ-SI5-12 an undecided movement is pending and counted, the dashboard stays fast, and a later read has it decided', async () => {
  const B = await appWithStub();
  await dashboard(B, 'carla'); // compile the route before timing it
  // Unknown movements left by earlier tests are decided by the stub first.
  await until(
    async () => (await dashboard(B, 'carla')).insights?.pending,
    (pending) => !pending,
  );
  const description = unknown('HOLD');
  await control('movement', { accountId: 'acc-carla', amountCents: -2500, description });
  const started = performance.now();
  const first = await call(B, 'carla', 'GET', 'dashboard');
  const elapsed = performance.now() - started;
  const d = ok(first);
  const row = d.movements.find((m: any) => m.description === description);
  assert.deepEqual(
    [row.category?.id, row.category?.state, row.category?.source, row.category?.reason],
    ['other', 'pending', 'none', 'pending'],
  );
  assert.ok(
    elapsed < 1000,
    `dashboard took ${Math.round(elapsed)} ms while the decider does not answer`,
  );
  assert.equal(d.insights.pending, 1);
  assert.equal(d.insights.decider, 'systemone');
  assert.equal((await spending(B, 'carla')).pending, 1);
  // Still pending, still fast, while the stub holds its answer.
  await until(
    async () => stub.held.length,
    (n) => n > 0,
    5000,
  );
  assert.equal(stub.held.length, 1, 'one decider request for the merchant is waiting');
  const again = performance.now();
  const second = await dashboard(B, 'carla');
  assert.ok(performance.now() - again < 1000);
  assert.equal(second.movements.find((m: any) => m.id === row.id).category.state, 'pending');
  // The stub answers: a later read has the decision.
  stub.held.splice(0).forEach((release) => release());
  const decided = await until(
    async () => (await dashboard(B, 'carla')).movements.find((m: any) => m.id === row.id).category,
    (c) => c.state !== 'pending',
  );
  assert.deepEqual([decided.id, decided.state, decided.source], ['shopping', 'estimated', 'model']);
  assert.equal(decided.confidence, 0.97);
  assert.equal(decided.model, 'systemone:jev-1.13.0');
  assert.match(decided.reason, /^model/);
  assert.equal((await spending(B, 'carla')).pending, 0);
});

test('REQ-SI5-13 reclassify returns the number of decider_unavailable movements and makes them classifiable again', async () => {
  const B = await appWithStub();
  stub.failing = true;
  const description = unknown('FAIL');
  const [id] = await inject(B, 'carla', -3100, description);
  const category = async () => await categoryOf(B, 'carla', id);
  const failed = await until(category, (c) => c.state !== 'pending', 15_000);
  assert.deepEqual(
    [failed.id, failed.state, failed.source, failed.reason],
    ['other', 'needs_review', 'none', 'decider_unavailable'],
  );
  const calls = () =>
    stub.requests.filter((r) => r.description.includes(description.toUpperCase())).length;
  const before = calls();
  assert.ok(before >= 1 && before <= 3, `${before} decider requests (budget: 3)`);
  // The decider works again, but a failed row is not retried by a plain read.
  stub.failing = false;
  await dashboard(B, 'carla');
  await sleep(700);
  assert.equal(calls(), before, 'no decider request without an explicit refresh');
  assert.equal((await category()).reason, 'decider_unavailable');
  // An explicit refresh queues it; the decider then classifies it.
  assert.deepEqual(ok(await call(B, 'carla', 'POST', 'insights/reclassify', { body: {} })), {
    queued: 1,
  });
  const decided = await until(category, (c) => c.source === 'model');
  assert.deepEqual(
    [decided.id, decided.state, decided.source],
    ['transport', 'estimated', 'model'],
  );
  assert.deepEqual(ok(await call(B, 'carla', 'POST', 'insights/reclassify', { body: {} })), {
    queued: 0,
  });
});

// ---------------------------------------------------------------- REQ-SI5-14

test('REQ-SI5-14 no response and no console output contains the decider key', async () => {
  const B = await appWithStub();
  // Reads on the app that holds the key, including the routes most likely to describe the decider.
  for (const route of ['health', 'dashboard', 'insights/spending', 'insights/rules', 'movements'])
    await call(B, 'carla', 'GET', route);
  await call(B, 'carla', 'POST', 'insights/reclassify', { body: {} });
  await call(B, 'carla', 'POST', 'insights/categories', {
    body: { movementIds: ['nope'], category: 'x' },
  });
  assert.ok(B.seen.length > 10);
  assert.ok(
    stub.requests.some((r) => r.auth === `Bearer ${DECIDER_KEY}`),
    'the app did use the key (otherwise this test proves nothing)',
  );
  for (const text of [...B.seen, ...A.seen])
    assert.ok(!text.includes(DECIDER_KEY), text.slice(0, 200));
  assert.ok(
    !(A.out.join('') + B.out.join('')).includes(DECIDER_KEY),
    'the key is in the console output',
  );
});

// ---------------------------------------------------------------- bank unavailable (last: it stops the bank)

test('REQ-SI5-3 when the bank read is unavailable the insights routes answer the bank error, as the existing reads do', async () => {
  const B = await appWithStub();
  const [id] = await inject(B, 'lucia', -510, unknown());
  const events = auditEvents(B).length;
  await stop(bank);
  const existing = await call(B, 'lucia', 'GET', 'movements');
  assert.ok([503, 504].includes(existing.status), existing.label);
  const summary = await call(B, 'lucia', 'GET', 'insights/spending');
  assert.equal(summary.status, existing.status, summary.label);
  assert.deepEqual(summary.body, existing.body, 'the same bank error as GET /api/movements');
  // A write needs the actor's current bank answer: without it nothing is written.
  const write = await setCategory(B, 'lucia', {
    movementIds: [id],
    category: 'shopping',
    applyToSimilar: true,
  });
  assert.ok([503, 504].includes(write.status), write.label);
  assert.equal(auditEvents(B).length, events, 'no audit event');
});
