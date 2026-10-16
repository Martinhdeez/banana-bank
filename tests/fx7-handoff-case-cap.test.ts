// FX7: a customer holds at most config.handoffOpenCases (5) open support cases opened through
// request_human, by the model or directly (POST /api/actions). Past it no case is opened and the
// result names the most recent one. A local stand-in is the model; no bank, no provider.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setupEnv, callApi } from './helpers/bank';
import { call, fakeOpenAI, say } from './helpers/openai';

const { temp } = await setupEnv('banana-fx7-');
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { shortRef } = await import('../src/ui-helpers');
const { config } = await import('../src/config');
seedApp();
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const CAP = config.handoffOpenCases;
const conversation = async (user: string) =>
  (await callApi(user, 'conversations', {})).body.id as string;
const ask = async (user: string, conversationId: string) =>
  (
    await callApi(user, 'actions', {
      name: 'request_human',
      arguments: { summary: 'A person, please.' },
      conversationId,
    })
  ).body as { status: string; incidentId: string; limitReached?: boolean; message?: string };
const open = (user: string) =>
  appDb()
    .prepare("SELECT count(*) FROM incidents WHERE user_id=? AND status='open'")
    .pluck()
    .get(user) as number;
const casesOf = (conversationId: string) =>
  appDb()
    .prepare('SELECT count(*) FROM incidents WHERE conversation_id=?')
    .pluck()
    .get(conversationId) as number;
const messages = async (user: string, id: string) =>
  (await callApi(user, `conversations/${id}`)).body.messages as {
    content: string;
    extras: Record<string, unknown> | null;
  }[];
// Hugo and Omar have no open case at seed.
const fill = async (user: string, n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await ask(user, await conversation(user))).incidentId);
  return ids;
};

test('FX7: at the limit neither path opens a case; resolving one frees a slot', async () => {
  assert.equal(CAP, 5);
  const ids = await fill('hugo', CAP);
  assert.equal(new Set(ids).size, CAP);
  const latest = ids.at(-1)!;

  // Direct path: no row, the most recent open case, one fixed sentence that says so.
  const direct = await conversation('hugo');
  const refused = await ask('hugo', direct);
  assert.equal(refused.status, 'open');
  assert.equal(refused.incidentId, latest);
  assert.equal(refused.limitReached, true);
  await ask('hugo', direct); // a repeat stores no second message
  assert.equal(casesOf(direct), 0);
  assert.equal(open('hugo'), CAP);
  assert.deepEqual(await messages('hugo', direct), [
    {
      ...(await messages('hugo', direct))[0],
      content: `You already have open support requests (most recent reference ${shortRef(latest)}). A person from the bank will review them. No new request was opened for this conversation.`,
      extras: { handoff: { incidentId: latest, reference: shortRef(latest) } },
    },
  ]);

  // Model path: the tool result tells the model no case was opened.
  const chat = await conversation('hugo');
  script.push(
    () => call('request_human', { summary: 'Hugo wants a person.' }),
    () => say('You already have open requests.'),
  );
  await callApi('hugo', `conversations/${chat}/messages`, { content: 'A person, please' });
  const output = JSON.parse(
    modelRequests.at(-1)!.input.find((i) => i.type === 'function_call_output')!.output!,
  );
  assert.equal(output.incidentId, latest);
  assert.match(output.message, /^No new support case was opened: .* do not say a case was opened/);
  assert.ok(output.message.includes(shortRef(latest)));
  assert.equal(casesOf(chat), 0);
  assert.equal(open('hugo'), CAP);

  // The operator resolves one: the next request opens a case, with the unchanged result.
  const resolved = await callApi('marta', `incidents/${ids[0]}/resolve`, { confirm: true });
  assert.equal(resolved.status, 200);
  const again = await ask('hugo', chat);
  assert.deepEqual(Object.keys(again).sort(), ['incidentId', 'status']);
  assert.equal(casesOf(chat), 1);
  assert.equal(open('hugo'), CAP);
});

test('FX7: 10 parallel requests in 10 conversations one below the limit open exactly one case', async () => {
  await fill('omar', CAP - 1);
  const conversations = await Promise.all(Array.from({ length: 10 }, () => conversation('omar')));
  const results = await Promise.all(conversations.map((id) => ask('omar', id)));
  assert.equal(open('omar'), CAP);
  assert.equal(results.filter((r) => !r.limitReached).length, 1);
  assert.equal(new Set(results.map((r) => r.incidentId)).size, 1);
});

test('FX7: a product-interest case and a conversation with money unverified are not counted or refused', async () => {
  // Omar is at the limit (test above).
  assert.equal((await ask('omar', await conversation('omar'))).limitReached, true);
  // The app's own case for a product interest (src/offers/state.ts records both rows).
  const interestConversation = await conversation('omar'),
    interest = randomUUID();
  insert('incidents', {
    id: interest,
    user_id: 'omar',
    conversation_id: interestConversation,
    summary: 'Product interest: x.',
    status: 'open',
    created_at: new Date().toISOString(),
  });
  recordEvent(
    { userId: 'omar', conversationId: interestConversation, runId: randomUUID(), intentId: '' },
    'offer.interest',
    { offerId: 'x', incidentId: interest },
  );
  // A transfer sent with no verified outcome: this conversation always gets its case.
  const money = await conversation('omar');
  insert('intents', {
    id: randomUUID(),
    user_id: 'omar',
    conversation_id: money,
    run_id: randomUUID(),
    payload: '{}',
    status: 'pending_verification',
    bank_reference: 'ref-fx7',
    created_at: new Date().toISOString(),
  });
  const opened = await ask('omar', money);
  assert.equal(opened.limitReached, undefined);
  assert.equal(casesOf(money), 1);
  assert.equal(open('omar'), CAP + 2);
  // Neither counts: with one plain case resolved there is a slot again.
  const plain = appDb()
    .prepare(
      "SELECT id FROM incidents WHERE user_id='omar' AND status='open' AND id NOT IN (?,?) LIMIT 1",
    )
    .pluck()
    .get(interest, opened.incidentId) as string;
  await callApi('marta', `incidents/${plain}/resolve`, { confirm: true });
  assert.equal((await ask('omar', await conversation('omar'))).limitReached, undefined);
  assert.equal((await ask('omar', await conversation('omar'))).limitReached, true);
});

// FX7 (review): the content of a refused request reaches the operator on the case it named.
test('FX7: a request refused at the limit is read by the operator on the case the customer was given', async () => {
  // Hugo is at the limit (first test). One direct request, clicked twice, and one by the model path.
  const { runTool } = await import('../src/agent/tools');
  const first = await conversation('hugo');
  const said = { summary: 'My transfer of yesterday went to the <b>wrong</b> person.' };
  const refused = (
    await callApi('hugo', 'actions', {
      name: 'request_human',
      arguments: said,
      conversationId: first,
    })
  ).body;
  await callApi('hugo', 'actions', {
    name: 'request_human',
    arguments: said,
    conversationId: first,
  });
  assert.equal(refused.limitReached, true);
  const detail = (await callApi('marta', `incidents/${refused.incidentId}`)).body;
  assert.equal(detail.incident.user_id, 'hugo');
  assert.equal(detail.incident.status, 'open');
  assert.deepEqual(
    detail.summary.cappedRequests
      .map((c: { summary: string }) => c.summary)
      .filter((s: string) => s === said.summary),
    [said.summary],
  );
  assert.ok(
    detail.summary.text.some(
      (l: string) =>
        l.startsWith('Later request with no case of its own') && l.endsWith(said.summary),
    ),
  );
  // Another customer's case shows nothing of it.
  const other = (await callApi('marta', 'incidents/case-lucia')).body;
  assert.deepEqual(other.summary.cappedRequests, []);

  // 5 direct and 5 runTool calls at once, one below the limit, open exactly one case.
  const before = open('hugo');
  const closing = appDb()
    .prepare("SELECT id FROM incidents WHERE user_id='hugo' AND status='open' AND id<>? LIMIT 1")
    .pluck()
    .get(refused.incidentId) as string;
  await callApi('marta', `incidents/${closing}/resolve`, { confirm: true });
  assert.equal(open('hugo'), before - 1);
  const ten = await Promise.all(Array.from({ length: 10 }, () => conversation('hugo')));
  const results = (await Promise.all(
    ten.map((id, n) =>
      n % 2
        ? ask('hugo', id)
        : runTool('request_human', { summary: 'x' }, {
            userId: 'hugo',
            conversationId: id,
            runId: randomUUID(),
            intentId: '',
          } as never),
    ),
  )) as { limitReached?: boolean }[];
  assert.equal(open('hugo'), before);
  assert.equal(results.filter((r) => !r.limitReached).length, 1);
});
