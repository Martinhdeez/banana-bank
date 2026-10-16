// Independent bank for portability checks. Written from docs/contracts.md ("Bank HTTP API") only:
// it imports nothing from src/ or simulator/, keeps state in memory, and deliberately behaves
// differently from the simulator wherever the contract leaves room (see docs/testing-alt-bank.md).
//
//   node --import tsx tests/alt-bank/server.ts        # port ALT_BANK_PORT || BANK_PORT || 4611
//
// Test-only control API (not part of the contract, never used by the app), token in
// `x-alt-control` (ALT_BANK_CONTROL_TOKEN, default "alt-control"):
//   POST /_control/reset                 reseed, clear faults and options
//   POST /_control/config {...Options}   merge options (see `Options` below)
//   POST /_control/reveal                end the read lag: every operation is visible now
//   POST /_control/movement {accountId, amountCents, description, createdAt?}   add one movement (SI9)
//   GET  /_control/state                 accounts, operations, options
//
// SI9: ALT_BANK_SEED_FILE=tests/alt-bank/demo-seed.json replaces the card payments of the accounts
// in that file with its movements (fixed ids and dates). Unset, the seed is the default one.
// DS1: its `descriptions` (transfer reference -> text) replace the `To acc-x: …` / `From acc-x: …`
// of those seeded transfers on both legs, so the demo's first screens show no raw account id.
// DS2: every customer has rows in the demo file (July to 5 October 2026); its `openingAt` dates
// the initial deposits before them. Without the file nothing changes.
import http from 'node:http';
import fs from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.BANK_SERVICE_SECRET || 'banana-local-service';
const CONTROL = process.env.ALT_BANK_CONTROL_TOKEN || 'alt-control';
const PORT = Number(process.env.ALT_BANK_PORT || process.env.BANK_PORT || 4611);
const WINDOW_MS = 60_000;

type Fault = 'reject-before' | 'drop' | 'gateway-504';
type Options = {
  faults: Fault[]; // consumed one per valid POST /v1/transfers (new or replay)
  commitDelayMs: number; // inside the transfer lock, before the atomic commit
  respondDelayMs: number; // after the commit, before the response
  readLagMs: number; // ops committed now stay invisible to lookup and operator listing this long
  readFaults: number; // next N operation lookups answer 503
  movementsLimit: number;
  movementsOrder: 'newest' | 'oldest'; // order inside the page of the most recent movements
  operatorLimit: number;
};
const defaults = (): Options => ({
  faults: [],
  commitDelayMs: 0,
  respondDelayMs: 0,
  readLagMs: Number(process.env.ALT_BANK_READ_LAG_MS || 0),
  readFaults: 0,
  movementsLimit: Number(process.env.ALT_BANK_MOVEMENTS_LIMIT || 25),
  movementsOrder: process.env.ALT_BANK_MOVEMENTS_ORDER === 'oldest' ? 'oldest' : 'newest',
  operatorLimit: Number(process.env.ALT_BANK_OPERATOR_LIMIT || 20),
});

// Own roster: the ids the app's people list uses; names are the fictional holders.
const customers: Record<string, string> = {
  lucia: 'Lucía Martín',
  bruno: 'Bruno Vidal',
  carla: 'Carla Ríos',
  diego: 'Diego Salas',
  elena: 'Elena Costa',
  hugo: 'Hugo Pérez',
  ines: 'Inés López',
  omar: 'Omar León',
};
const operators = new Set(['marta', 'pablo']);

type Account = { id: string; userId: string; label: string; iban: string; balanceCents: number };
type Op = {
  id: string;
  userId: string;
  reference: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  concept: string;
  createdAt: string;
  status: 'completed';
  currency: 'EUR';
};
type Movement = {
  id: string;
  accountId: string;
  operationId: string | null;
  amountCents: number;
  description: string;
  createdAt: string;
};
let accounts = new Map<string, Account>();
let ops = new Map<string, Op>(); // key: actor \0 reference
let visibleAt = new Map<string, number>(); // op id -> first instant reads can see it
let movements: Movement[] = [];
let options = defaults();
const ISO_DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
let injected = 0; // SI9: counter of /_control/movement ids; never reset, so ids stay unique
// SI9: optional demo data, read once; /_control/reset seeds it again.
const seedFile: {
  openingAt?: string; // DS2: date of every initial deposit (default 2026-08-01)
  openings?: Record<string, number>; // account id -> initial deposit
  movements: Omit<Movement, 'operationId'>[];
  transfers?: Omit<Op, 'id' | 'status' | 'currency'>[]; // replayed through commit()
  descriptions?: Record<string, string>; // DS1: seeded transfer reference -> movement text
} = process.env.ALT_BANK_SEED_FILE
  ? JSON.parse(fs.readFileSync(process.env.ALT_BANK_SEED_FILE, 'utf8'))
  : { movements: [] };
const seededAccounts = new Set(seedFile.movements.map((m) => m.accountId));

function seed() {
  accounts = new Map();
  ops = new Map();
  visibleAt = new Map();
  movements = [];
  options = defaults();
  const add = (id: string, userId: string, label: string, cents: number, n: number) => {
    cents = seedFile.openings?.[id] ?? cents;
    accounts.set(id, {
      id,
      userId,
      label,
      // DS1: the account number also ends the IBAN with four digits of its own (4821, 2521, …):
      // the app masks an IBAN to its last four, and every account used to read "···· 0000".
      iban: `ES00 9999 0000 ${String(n).padStart(4, '0')} 0000 ${String((4821 + n * 2477) % 10000).padStart(4, '0')}`,
      balanceCents: cents,
    });
    movements.push({
      id: `m-open-${id}`,
      accountId: id,
      operationId: null,
      amountCents: cents,
      description: 'Initial deposit',
      createdAt: seedFile.openingAt ?? '2026-08-01T08:00:00.000Z',
    });
  };
  Object.keys(customers).forEach((u, i) => {
    add(
      `acc-${u}`,
      u,
      i % 2 ? 'Horizon account' : 'Aurora account',
      u === 'diego' ? 7500 : 300000 + i * 10000,
      i,
    );
    if (i % 2 === 0) add(`acc-${u}-savings`, u, 'Personal savings', 90000, 100 + i);
    // Enough history to exceed the smaller movements page.
    for (let d = 1; d <= 30; d++)
      if (u !== 'diego' && !seededAccounts.has(`acc-${u}`)) {
        const id = `acc-${u}`;
        accounts.get(id)!.balanceCents -= 100;
        movements.push({
          id: `m-${u}-${d}`,
          accountId: id,
          operationId: null,
          amountCents: -100,
          description: `Card payment ${d}`,
          createdAt: new Date(Date.parse('2026-09-01T12:00:00Z') + d * 3600_000).toISOString(),
        });
      }
  });
  for (const m of seedFile.movements) {
    accounts.get(m.accountId)!.balanceCents += m.amountCents;
    movements.push({ ...m, operationId: null });
  }
  for (const t of seedFile.transfers ?? [])
    commit(
      t.userId,
      t.reference,
      t.fromAccountId,
      t.toAccountId,
      t.amountCents,
      t.concept,
      t.createdAt,
      seedFile.descriptions?.[t.reference],
    );
  // The app's seeded case history refers to these two references.
  commit(
    'lucia',
    'ref-historic-lucia',
    'acc-lucia',
    'acc-bruno',
    8500,
    'Team dinner',
    '2026-09-23T16:41:12.000Z',
    seedFile.descriptions?.['ref-historic-lucia'],
  );
  commit(
    'elena',
    'ref-historic-elena',
    'acc-elena',
    'acc-hugo',
    2500,
    'Transfer to Hugo',
    '2026-09-23T16:42:10.000Z',
    seedFile.descriptions?.['ref-historic-elena'],
  );
  visibleAt.clear();
}

function commit(
  userId: string,
  reference: string,
  fromAccountId: string,
  toAccountId: string,
  amountCents: number,
  concept: string,
  createdAt = new Date().toISOString(),
  description?: string, // DS1: seeded transfers only; live ones keep the bank's own wording
): Op {
  const op: Op = {
    id: `alt-${randomUUID()}`,
    userId,
    reference,
    fromAccountId,
    toAccountId,
    amountCents,
    concept,
    createdAt,
    status: 'completed',
    currency: 'EUR',
  };
  // Atomic: synchronous, no await between the checks' results and these writes.
  accounts.get(fromAccountId)!.balanceCents -= amountCents;
  accounts.get(toAccountId)!.balanceCents += amountCents;
  movements.push(
    {
      id: randomUUID(),
      accountId: fromAccountId,
      operationId: op.id,
      amountCents: -amountCents,
      description: description ?? `To ${toAccountId}: ${concept}`,
      createdAt,
    },
    {
      id: randomUUID(),
      accountId: toAccountId,
      operationId: op.id,
      amountCents,
      description: description ?? `From ${fromAccountId}: ${concept}`,
      createdAt,
    },
  );
  ops.set(`${userId}\0${reference}`, op);
  visibleAt.set(op.id, Date.now() + options.readLagMs);
  return op;
}

class Fail extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const visible = (op: Op) => Date.now() >= (visibleAt.get(op.id) ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sign = (s: string) => createHmac('sha256', SECRET).update(s).digest('hex');
function sameHex(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const newestFirst = <T extends { createdAt: string }>(a: T, b: T) =>
  b.createdAt.localeCompare(a.createdAt);

// ponytail: one global transfer lock; per-actor locks if throughput ever matters.
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function parseTransfer(body: any) {
  const { fromAccountId, toAccountId, amountCents, concept, reference } = body ?? {};
  const bad = (field: string) => new Fail(400, 'VALIDATION', `Field "${field}" is not acceptable.`);
  if (typeof fromAccountId !== 'string' || !fromAccountId) throw bad('fromAccountId');
  if (typeof toAccountId !== 'string' || !toAccountId) throw bad('toAccountId');
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 10_000_000)
    throw bad('amountCents');
  if (typeof concept !== 'string' || concept.length > 500) throw bad('concept');
  if (typeof reference !== 'string' || reference.length < 1 || reference.length > 120)
    throw bad('reference');
  return { fromAccountId, toAccountId, amountCents, concept, reference };
}

async function transfer(actor: string, body: unknown, res: http.ServerResponse) {
  const t = parseTransfer(body);
  if (!customers[actor]) throw new Fail(403, 'ROLE', 'Only customers may move money.');
  const fault = options.faults.shift();
  if (fault === 'reject-before')
    throw new Fail(503, 'MAINTENANCE', 'Core banking is in maintenance, try later.');
  const result = await exclusive(async () => {
    const key = `${actor}\0${t.reference}`;
    const prior = ops.get(key);
    if (prior) {
      const same =
        prior.fromAccountId === t.fromAccountId &&
        prior.toAccountId === t.toAccountId &&
        prior.amountCents === t.amountCents &&
        prior.concept === t.concept;
      if (!same)
        throw new Fail(409, 'REFERENCE_TAKEN', 'This reference was used for another payload.');
      return { ...prior, replay: true };
    }
    const from = accounts.get(t.fromAccountId);
    if (!from) throw new Fail(404, 'NO_SOURCE', 'Unknown source account.');
    if (from.userId !== actor)
      throw new Fail(403, 'NOT_HOLDER', 'Actor does not hold the source account.');
    if (!accounts.has(t.toAccountId))
      throw new Fail(404, 'NO_DESTINATION', 'Unknown destination account.');
    if (t.toAccountId === t.fromAccountId)
      throw new Fail(400, 'SAME_ACCOUNT', 'Source equals destination.');
    if (options.commitDelayMs) await sleep(options.commitDelayMs);
    // Re-read after the delay: the lock serialises transfers, so the balance is current.
    if (from.balanceCents < t.amountCents)
      throw new Fail(422, 'NSF', 'Balance too low for this amount.');
    return {
      ...commit(actor, t.reference, t.fromAccountId, t.toAccountId, t.amountCents, t.concept),
      replay: false,
    };
  });
  if (options.respondDelayMs) await sleep(options.respondDelayMs);
  if (fault === 'drop') return void res.socket?.destroy();
  if (fault === 'gateway-504') {
    res
      .writeHead(504, { 'Content-Type': 'text/html' })
      .end('<html><body>504 Gateway Time-out</body></html>');
    return;
  }
  send(res, result.replay ? 200 : 201, result);
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  if (res.destroyed || res.headersSent) return;
  res
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(data));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://alt-bank');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (url.pathname === '/health') return send(res, 200, { status: 'up', impl: 'alt-bank' });

  if (url.pathname.startsWith('/_control/')) {
    if (req.headers['x-alt-control'] !== CONTROL)
      throw new Fail(403, 'CONTROL', 'Bad control token.');
    if (url.pathname === '/_control/reset') seed();
    else if (url.pathname === '/_control/config')
      options = { ...options, ...JSON.parse(raw || '{}') };
    else if (url.pathname === '/_control/reveal') visibleAt.clear();
    else if (url.pathname === '/_control/balance') {
      const { accountId, balanceCents } = JSON.parse(raw);
      accounts.get(accountId)!.balanceCents = balanceCents;
    } else if (url.pathname === '/_control/movement') {
      // SI9: a movement that is not a transfer (the contract has no way to create one).
      // IT2: a body that is not a JSON object, or a createdAt that is not an ISO date-time, is a
      // 400 (it was a 500, and any string was stored as the date).
      let input: any;
      try {
        input = JSON.parse(raw);
      } catch {}
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Fail(400, 'VALIDATION', 'The body must be a JSON object.');
      const { accountId, amountCents, description, createdAt } = input;
      const account = accounts.get(accountId);
      if (!account) throw new Fail(404, 'NO_ACCOUNT', 'Unknown account.');
      if (!Number.isInteger(amountCents) || typeof description !== 'string')
        throw new Fail(400, 'VALIDATION', 'amountCents must be an integer, description a string.');
      if (
        createdAt != null &&
        !(
          typeof createdAt === 'string' &&
          ISO_DATE_TIME.test(createdAt) &&
          !Number.isNaN(Date.parse(createdAt)) &&
          // Date.parse rolls 02-30 over to March: the day must survive a round trip.
          new Date(createdAt.slice(0, 10)).toISOString().slice(0, 10) === createdAt.slice(0, 10)
        )
      )
        throw new Fail(400, 'VALIDATION', 'createdAt must be an ISO date-time.');
      account.balanceCents += amountCents;
      movements.push({
        id: `inj-${++injected}`,
        accountId,
        operationId: null,
        amountCents,
        description,
        createdAt: createdAt ?? new Date().toISOString(),
      });
    } else if (url.pathname !== '/_control/state') throw new Fail(404, 'NO_ROUTE', 'Nothing here.');
    return send(res, 200, {
      accounts: [...accounts.values()],
      operations: [...ops.values()],
      options,
    });
  }

  // Signature check exactly as the contract defines it (path with query, as sent).
  const actor = String(req.headers['x-bank-actor'] || '');
  const time = String(req.headers['x-bank-time'] || '');
  const signature = String(req.headers['x-bank-signature'] || '');
  const known = !!customers[actor] || operators.has(actor);
  if (
    !known ||
    !/^\d+$/.test(time) ||
    Math.abs(Date.now() - Number(time)) > WINDOW_MS ||
    !sameHex(signature, sign([req.method, req.url, actor, time, raw].join('\n')))
  )
    throw new Fail(401, 'AUTH_CONTEXT', 'Request context could not be authenticated.');

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Fail(400, 'BAD_JSON', 'Body is not JSON.');
  }
  const own = (userId: string) =>
    [...accounts.values()]
      .filter((a) => a.userId === userId)
      .sort((a, b) => b.id.localeCompare(a.id));
  const p = url.pathname;
  if (req.method === 'GET' && p === '/v1/accounts') return send(res, 200, own(actor));
  if (req.method === 'GET' && p === '/v1/contacts') {
    if (!customers[actor]) throw new Fail(403, 'ROLE', 'Contacts are for customers.');
    return send(
      res,
      200,
      [...accounts.values()]
        .filter((a) => a.userId !== actor)
        .map(({ balanceCents, ...a }) => ({ ...a, name: customers[a.userId] })),
    );
  }
  if (req.method === 'GET' && p === '/v1/movements') {
    const mine = new Set(own(actor).map((a) => a.id));
    const page = movements
      .filter((m) => mine.has(m.accountId))
      .sort(newestFirst)
      .slice(0, options.movementsLimit);
    return send(res, 200, options.movementsOrder === 'oldest' ? page.reverse() : page);
  }
  if (req.method === 'POST' && p === '/v1/transfers') return transfer(actor, body, res);
  if (req.method === 'GET' && p.startsWith('/v1/operations/')) {
    if (options.readFaults > 0) {
      options.readFaults--;
      throw new Fail(503, 'READ_REPLICA_DOWN', 'Operation index unavailable.');
    }
    const op = ops.get(`${actor}\0${decodeURIComponent(p.slice('/v1/operations/'.length))}`);
    if (!op || !visible(op))
      throw new Fail(404, 'NO_OPERATION', 'No operation under that reference.');
    return send(res, 200, op);
  }
  if (req.method === 'GET' && p === '/v1/operator/customer') {
    if (!operators.has(actor)) throw new Fail(403, 'ROLE', 'Operator role needed.');
    const id = url.searchParams.get('id') || '';
    if (!customers[id]) throw new Fail(404, 'NO_CUSTOMER', 'Unknown customer.');
    const all = [...ops.values()].filter((o) => o.userId === id && visible(o)).sort(newestFirst);
    return send(res, 200, {
      accounts: own(id),
      operations: all.slice(0, options.operatorLimit),
      hasMore: all.length > options.operatorLimit,
    });
  }
  throw new Fail(404, 'NO_ROUTE', 'Nothing here.');
}

seed();
const server = http.createServer((req, res) =>
  handle(req, res).catch((e) =>
    e instanceof Fail
      ? send(res, e.status, { error: e.message, code: e.code, retryable: e.status >= 500 })
      : send(res, 500, { error: 'Unexpected failure.', code: 'INTERNAL' }),
  ),
);
server.listen(PORT, '127.0.0.1', () => console.log(`Alt bank: http://127.0.0.1:${PORT}`));
for (const s of ['SIGTERM', 'SIGINT'] as const)
  process.on(s, () => server.close(() => process.exit(0)));
