// IT1 (follow-up to SI6b): bank requests per chat turn. Since SI6b every turn read the whole bank
// view for the spending digest: 5 bank requests on a plain turn (accounts and contacts twice) and
// 400 ms of waiting when the movements read hung. Deterministic: fake OpenAI, the simulator on a
// free port, DECIDER=none. The app reads the bank with global fetch, counted here by path.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say } from './helpers/openai';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-it1-');
process.env.DECIDER = 'none';
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { bankView } = await import('../src/banking/view');
const run = await import('../src/agent/run');
const { newConversation } = await import('./helpers/data');
seedApp();
const bank = await startSimulator('simulator');
const rejections: unknown[] = [];
process.on('unhandledRejection', (e) => rejections.push(e));
after(() => {
  bank.kill();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const bankPaths: string[] = [];
const realFetch = globalThis.fetch;
let hang = false;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(process.env.BANK_URL!)) bankPaths.push(new URL(url).pathname);
  // A movements read that never answers: only the bank client's timeout ends it.
  if (hang && url.endsWith('/v1/movements'))
    return new Promise((_, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  return realFetch(input, init);
};
// One chat turn: the sorted bank paths it requested, its duration and its SPENDING STATE digest.
async function turn(
  userId: string,
  content: string,
  calls: (() => object)[] = [],
  opts?: Parameters<typeof run.sendMessage>[3],
  conversationId = newConversation(userId),
) {
  script.push(...calls);
  bankPaths.length = 0;
  const started = performance.now();
  const result = await run.sendMessage(userId, conversationId, content, opts);
  const ms = performance.now() - started;
  const { instructions } = modelRequests.at(-1)!;
  return {
    result,
    ms,
    paths: [...bankPaths].sort(),
    state: instructions.slice(instructions.indexOf('SPENDING STATE')),
    conversationId,
  };
}
const ACCOUNTS = '/v1/accounts',
  CONTACTS = '/v1/contacts',
  MOVEMENTS = '/v1/movements';
// A stored needs_review row is what tells a turn that there are movements to mention.
const storeUnresolved = (userId: string) =>
  appDb()
    .prepare(
      "INSERT OR REPLACE INTO movement_categories VALUES(?,?,'f','ZZQXV STALE','other','needs_review','none','no_decider',NULL,NULL,'[]',NULL,?)",
    )
    .run(userId, 'it1-stale-row', new Date().toISOString());

test('IT1 a plain turn with nothing to say about spending reads accounts and contacts once and no movements', async () => {
  // The app has classified this customer's movements (the Overview does) and none is to review.
  await bankView('lucia');
  const first = await turn('lucia', 'What does my account cost?');
  assert.equal(first.result.answer, 'OK.');
  assert.deepEqual(first.paths, [ACCOUNTS, CONTACTS]);
  assert.match(first.state, /Today's date/);
  assert.doesNotMatch(first.state, /could not be read/);
  // Nothing is kept for the next turn: each run asks the bank again.
  const second = await turn('lucia', 'And a card?', [], undefined, first.conversationId);
  assert.deepEqual(second.paths, [ACCOUNTS, CONTACTS]);
});

test('IT1 a customer the app has never classified is read once: the first turn looks, the next does not', async () => {
  const first = await turn('omar', 'hello');
  assert.deepEqual(first.paths, [ACCOUNTS, CONTACTS, MOVEMENTS]);
  assert.match(first.state, /Movements to review: 0 in/);
  const second = await turn('omar', 'hello again', [], undefined, first.conversationId);
  assert.deepEqual(second.paths, [ACCOUNTS, CONTACTS]);
});

test('IT1 a transfer proposal makes four bank requests: the turn reads and the proposal reads', async () => {
  const { paths, result } = await turn('lucia', 'Send 15 euros to Bruno', [
    () =>
      call('transfer_money', {
        fromAccountId: 'acc-lucia',
        recipient: 'Bruno',
        toAccountId: null,
        amountCents: 1500,
        concept: 'IT1 dinner',
        secondTransfer: null,
        replacesApprovalId: null,
      }),
    () => say('Review the proposal.'),
  ]);
  assert.equal(result.answer, 'Review the proposal.');
  assert.deepEqual(paths, [ACCOUNTS, ACCOUNTS, CONTACTS, CONTACTS]);
  assert.equal(
    (appDb().prepare('SELECT COUNT(*) n FROM approvals WHERE user_id=?').get('lucia') as any).n,
    1,
  );
});

test('IT1 a hung movements read costs nothing on a turn that needs no spending data', async () => {
  hang = true;
  try {
    const { ms, paths, result, state } = await turn('lucia', 'What does my account cost?');
    assert.equal(result.answer, 'OK.');
    assert.deepEqual(paths, [ACCOUNTS, CONTACTS]);
    assert.ok(ms < 300, `the turn took ${Math.round(ms)} ms`);
    assert.doesNotMatch(state, /could not be read/);
  } finally {
    hang = false;
  }
});

test('IT1 a spending tool reads the movements on demand and reuses the accounts and contacts of the turn', async () => {
  let summary: any;
  const { paths } = await turn('bruno', 'How much did I spend?', [
    () => call('get_spending_summary', { from: null, to: null }),
    () => call('list_unresolved_movements', {}),
    (() => {
      summary = JSON.parse(modelRequests.at(-1)!.input.find((i) => i.output)!.output!);
      return say('Your spending.');
    }) as () => object,
  ]);
  assert.equal(summary.status, 'ok');
  assert.deepEqual(paths, [ACCOUNTS, CONTACTS, MOVEMENTS]);
});

test('IT1 an attachment turn reads the bank view once, and its digest has the current category', async () => {
  const view = await bankView('carla');
  const m = view.movements[0];
  const { paths, state } = await turn('carla', 'What is this?', [], {
    attachment: { id: m.id, title: 'T', amountCents: m.amountCents, createdAt: m.createdAt },
  });
  assert.deepEqual(paths, [ACCOUNTS, CONTACTS, MOVEMENTS]);
  assert.match(state, /ATTACHED MOVEMENT/);
  assert.ok(state.includes(`category ${JSON.stringify(view.categories.get(m.id)!.id)}`));
  assert.match(state, /Movements to review: \d+ in/);
});

test('IT1 stored unresolved movements make the turn read the bank; the digest shows the bank answer, not the stored rows', async () => {
  appDb().prepare('DELETE FROM movement_categories WHERE user_id=?').run('diego');
  storeUnresolved('diego');
  const { paths, state } = await turn('diego', 'hello');
  assert.deepEqual(paths, [ACCOUNTS, CONTACTS, MOVEMENTS]);
  assert.match(state, /Movements to review: \d+ in/);
  // The stored row is of a movement the bank no longer returns: it is never shown as current.
  assert.doesNotMatch(state, /ZZQXV STALE|it1-stale-row/);
  // The same turn against a hung movements read waits for the digest bound and then answers.
  hang = true;
  try {
    const slow = await turn('diego', 'hello');
    assert.equal(slow.result.answer, 'OK.');
    assert.ok(slow.ms < 1000, `the turn took ${Math.round(slow.ms)} ms`);
    assert.match(slow.state, /could not be read from the bank in time/);
  } finally {
    hang = false;
  }
});

test('IT1 an awaited target makes the next turn read the bank view', async () => {
  const view = await bankView('elena');
  const id = newConversation('elena');
  await turn(
    'elena',
    'Which category is this?',
    [
      () => call('suggest_category_choices', { movementId: view.movements[0].id }),
      () => say('Which category was it?'),
    ],
    undefined,
    id,
  );
  appDb().prepare('DELETE FROM movement_categories WHERE user_id=?').run('elena');
  const next = await turn('elena', 'it was clothes', [], undefined, id);
  assert.deepEqual(next.paths, [ACCOUNTS, CONTACTS, MOVEMENTS]);
  assert.match(next.state, /Awaiting the customer's answer/);
  assert.match(next.state, /Movements to review: \d+ in/);
});

test('IT1 a failed accounts read is not kept for the run, and no read is left unhandled', async () => {
  // The turn's accounts read fails once; the tool of the same run asks the bank again.
  let failures = 1;
  const counting = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).endsWith(ACCOUNTS) && failures-- > 0) {
      bankPaths.push(ACCOUNTS);
      return Promise.reject(new Error('down'));
    }
    return counting(input, init);
  };
  try {
    let listed: any;
    const { paths, result } = await turn('hugo', 'My movements?', [
      () => call('list_movements', {}),
      (() => {
        listed = JSON.parse(modelRequests.at(-1)!.input.find((i) => i.output)!.output!);
        return say('Your movements.');
      }) as () => object,
    ]);
    assert.equal(result.answer, 'Your movements.');
    assert.equal(listed.status, 'ok');
    assert.deepEqual(paths, [ACCOUNTS, ACCOUNTS, CONTACTS, MOVEMENTS]);
  } finally {
    globalThis.fetch = counting;
  }
  // The hung reads of the tests above have reached the bank client's timeout by now.
  await new Promise((r) => setTimeout(r, config.bankTimeoutMs + 100));
  assert.deepEqual(rejections, []);
});
