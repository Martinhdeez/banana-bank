// DV3: reproducible transfer probe. Against a running app and bank, every bank scenario goes
// through propose (POST /api/actions transfer_money) → confirm (POST /api/approvals/:id/confirm)
// as Lucía, and the table shows how many bank operations each scenario created and what the
// customer was told. One intent must create exactly one operation.
//
//   APP_URL=http://127.0.0.1:3000 BANK_URL=http://127.0.0.1:4001 npm run probe:transfers
//
// TEST UTILITY ONLY: scenarios are set and operations counted through the bank's admin API
// (/admin/scenario, /admin/snapshot, Bearer BANK_ADMIN_SECRET), as docs/contracts.md allows for
// local testing. The app never calls it. Against tests/alt-bank/server.ts (no /admin) the same
// faults are set through its /_control API. Moves 1 € per intent from acc-lucia to acc-bruno;
// restores `intermittent 17` (simulator) or clears the faults (alt bank) at the end.
import { config } from '../src/config';

const app = (process.env.APP_URL || `http://127.0.0.1:${config.appPort}`).replace(/\/$/, '');
const bank = config.bankUrl.replace(/\/$/, '');
const admin = { Authorization: `Bearer ${config.adminSecret}` };
const control = { 'x-alt-control': process.env.ALT_BANK_CONTROL_TOKEN || 'alt-control' };
const json = { 'Content-Type': 'application/json' };

type Scenario = { name: string; profile: string; seed?: number; intents: number; retry?: boolean };
const scenarios: Scenario[] = [
  { name: 'normal', profile: 'normal', intents: 1 },
  {
    name: 'intermittent 17 (3rd new operation loses its response)',
    profile: 'intermittent',
    seed: 17,
    intents: 3,
  },
  { name: 'reject-before', profile: 'reject-before', intents: 1 },
  { name: 'lost-response', profile: 'lost-response', intents: 1 },
  { name: 'slow-response', profile: 'slow-response', intents: 1 },
  { name: 'read-unavailable', profile: 'read-unavailable', intents: 1 },
  { name: 'same intent sent and confirmed twice', profile: 'normal', intents: 1, retry: true },
];
// Alt bank equivalents (tests/alt-bank/server.ts options); intermittent has none.
const altOptions: Record<string, object> = {
  normal: {},
  'reject-before': { faults: ['reject-before'] },
  'lost-response': { faults: ['gateway-504'] },
  'slow-response': { respondDelayMs: 2600 },
  'read-unavailable': { faults: ['gateway-504'], readFaults: 1 },
};
const altReset = { faults: [], respondDelayMs: 0, readFaults: 0 };

async function call(url: string, init: RequestInit = {}) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
}

const kind = (await fetch(`${bank}/admin/snapshot`, { headers: admin })).ok
  ? 'simulator'
  : (await fetch(`${bank}/_control/state`, { headers: control })).ok
    ? 'alt-bank'
    : null;
if (!kind) {
  console.error(`No admin API (simulator) or /_control API (alt bank) at ${bank}.`);
  process.exit(1);
}

async function luciaOps(): Promise<number> {
  const { body } =
    kind === 'simulator'
      ? await call(`${bank}/admin/snapshot`, { headers: admin })
      : await call(`${bank}/_control/state`, { headers: control });
  return body.operations.filter((o: { userId: string }) => o.userId === 'lucia').length;
}

async function setScenario(s: Scenario | null): Promise<boolean> {
  if (kind === 'simulator') {
    const profile = s?.profile ?? 'intermittent';
    const seed = s ? (s.seed ?? 17) : 17;
    const r = await call(`${bank}/admin/scenario`, {
      method: 'POST',
      headers: { ...admin, ...json },
      body: JSON.stringify({ profile, seed }),
    });
    return r.status === 200;
  }
  const options = s ? altOptions[s.profile] : {};
  if (!options) return false;
  await call(`${bank}/_control/config`, {
    method: 'POST',
    headers: { ...control, ...json },
    body: JSON.stringify({ ...altReset, ...options }),
  });
  return true;
}

const session = await fetch(`${app}/api/session`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ userId: 'lucia' }),
});
if (!session.ok) {
  console.error(`The app at ${app} did not open a session (${session.status}).`);
  process.exit(1);
}
const cookie = session.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const post = (path: string, body: object = {}) =>
  call(`${app}${path}`, {
    method: 'POST',
    headers: { ...json, cookie },
    body: JSON.stringify(body),
  });

const propose = (concept: string, intentId: string) =>
  post('/api/actions', {
    name: 'transfer_money',
    intentId,
    arguments: { fromAccountId: 'acc-lucia', toAccountId: 'acc-bruno', amountCents: 100, concept },
  });
const confirm = async (approvalId: string) => {
  const r = await post(`/api/approvals/${approvalId}/confirm`);
  return (r.body?.status as string) ?? `HTTP ${r.status}`;
};

const run = new Date().toISOString();
const rows: string[][] = [];
let wrong = 0;
// K7: the scenario is restored even when a request throws midway.
try {
  for (const [n, s] of scenarios.entries()) {
    if (!(await setScenario(s))) {
      rows.push([s.name, '-', '-', `not available on the ${kind}`]);
      continue;
    }
    const before = await luciaOps();
    const told: string[] = [];
    for (let i = 1; i <= s.intents; i++) {
      const id = `probe-${run}-${n}-${i}`;
      const concept = `probe ${s.profile} ${i}`;
      const proposal = await propose(concept, id);
      const approvalId = proposal.body?.approval?.id;
      told.push(approvalId ? await confirm(approvalId) : `proposal ${proposal.body?.status}`);
      if (s.retry && approvalId) {
        const again = await propose(concept, id);
        told.push(`again: proposal ${again.body?.status}, confirm ${await confirm(approvalId)}`);
      }
    }
    const created = (await luciaOps()) - before;
    // More operations than intents is a duplicate; "completed" without an operation is a false report.
    const completed = told.filter((t) => t === 'completed').length;
    if (created > s.intents || created < completed) wrong++;
    rows.push([s.name, String(s.intents), String(created), told.join(', ')]);
  }
} finally {
  await setScenario(null);
}

console.log(`# Transfer probe ${run}`);
console.log(`app ${app} | bank ${bank} (${kind}) | customer lucia, 1 € per intent to acc-bruno\n`);
const header = ['scenario', 'intents', 'bank operations created', 'status told to customer'];
console.log(`| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
console.log(
  `\n${wrong ? `FAIL: ${wrong} scenario(s) duplicated an operation or reported one that does not exist.` : 'OK: at most one bank operation per intent, and every "completed" has its operation.'}`,
);
console.log(
  kind === 'simulator' ? 'Scenario restored to intermittent 17.' : 'Alt bank faults cleared.',
);
if (wrong) process.exitCode = 1;
