// HS1: "Ask for human support" on a failed assistant turn opens the conversation's case with
// POST /api/actions, without the model. A local stand-in for the provider fails each turn (as in
// tests/fx6-turn-failure.test.ts); no bank is started and no real provider is called.
// HS2: the server marks the failed turn's message (`extras.turnFailed`) and stores the direct
// action's confirmation as a message (`extras.handoff`); the page keys on those, not on wording.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setupEnv, callApi } from './helpers/bank';
import { call, say } from './helpers/openai';

const { temp } = await setupEnv('banana-hs1-');
let status = 429;
// With status 200 the stand-in is a model: one scripted output per request.
const script: object[] = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/embeddings')) {
    const embedding = Array.from({ length: 1536 }, () => 0.1);
    return res.end(
      JSON.stringify({
        data: [JSON.parse(raw).input]
          .flat()
          .map((_, index) => ({ object: 'embedding', index, embedding })),
      }),
    );
  }
  if (status === 200)
    return res.end(
      JSON.stringify({
        id: 'resp_fake',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'fake-model',
        output: [script.shift()],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    );
  res.writeHead(status, { 'x-should-retry': 'false' });
  res.end(JSON.stringify({ error: { message: 'stand-in' } }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { shortRef } = await import('../src/ui-helpers');
const { Assistant, askForSupport, SUPPORT_SUMMARY } = await import('../app/_components/Assistant');
type SupportState = import('../app/_components/Assistant').SupportState;
seedApp();
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const noop = () => {};
const BUTTON = 'Ask for human support';
const FAILURE = 'I could not finish this request. Try again or ask for human support.';
const CONFIRMATION =
  /^A support request is open for this conversation \(reference #[0-9A-Z]{6}\)\. A person from the bank will review it\.$/;
const message = (id: string, role: string, content: string, extras: object | null = null) => ({
  id,
  role,
  content,
  created_at: '2026-10-05T10:00:00.000Z',
  run_id: null,
  sources: [],
  extras,
});
const render = (messages: object[], extra: object = {}) =>
  renderToStaticMarkup(
    createElement(Assistant, {
      conversations: [],
      conversationId: 'c1',
      messages,
      busyId: null,
      failed: null,
      text: '',
      onText: noop,
      onSend: noop,
      onRetry: noop,
      onOpenConversation: noop,
      onNewConversation: noop,
      onOpenSource: noop,
      messagesEndRef: { current: null },
      approvals: null,
      suggestions: [],
      onAskSupport: noop,
      ...extra,
    } as Parameters<typeof Assistant>[0]),
  );
const newConversation = async () => (await callApi('lucia', 'conversations', {})).body.id as string;
const cases = (conversationId: string) =>
  appDb()
    .prepare('SELECT id,summary,status FROM incidents WHERE conversation_id=?')
    .all(conversationId) as { id: string; summary: string; status: string }[];
type Stored = { id: string; role: string; content: string; extras: Record<string, any> | null };
const stored = async (id: string) =>
  (await callApi('lucia', `conversations/${id}`)).body.messages as Stored[];
const askPerson = (conversationId: string, user = 'lucia') =>
  callApi(user, 'actions', {
    name: 'request_human',
    arguments: { summary: SUPPORT_SUMMARY },
    conversationId,
  });
const quiet = (t: { mock: { method: (o: object, m: any, f: () => void) => unknown } }) => {
  for (const level of ['error', 'warn', 'info']) t.mock.method(console, level, noop);
};

// [what the provider does, the API code]; '' = no key at all.
const causes: [number | '', string][] = [
  ['', 'missing_openai_api_key'],
  [401, 'provider_refused'],
  [429, 'provider_busy'],
  [400, 'turn_failed'],
];
for (const [cause, code] of causes)
  test(`HS2: ${code}: the failed turn's stored answer carries the code and offers the button`, async (t) => {
    quiet(t);
    process.env.OPENAI_API_KEY = cause === '' ? '' : 'test-fake';
    if (cause !== '') status = cause;
    const id = await newConversation();
    const r = await callApi('lucia', `conversations/${id}/messages`, { content: `Hi ${code}` });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, code);
    const messages = await stored(id);
    // The marker is the API code and nothing else (the reason stays in the run's error).
    assert.deepEqual(
      messages.map((m) => m.extras),
      [null, { turnFailed: code }],
    );
    const html = render(messages);
    assert.equal(html.split(BUTTON).length - 1, 1);
    assert.match(
      html,
      /class="secondary-button"[^>]*aria-busy="false"[^>]*>Ask for human support</,
    );
    // The page keys on the marker, not on the wording: the same text without it has no button
    // (a message stored before HS2), and another wording with it has one.
    assert.doesNotMatch(render(messages.map((m) => ({ ...m, extras: null }))), /Ask for human/);
    assert.match(
      render(messages.map((m) => ({ ...m, content: 'Reworded.' }))),
      />Ask for human support</,
    );
  });

test('HS2: a completed turn with no text is marked no_answer; a normal answer has no marker', async () => {
  process.env.OPENAI_API_KEY = 'test-fake';
  status = 200;
  const id = await newConversation();
  script.push(say(''));
  const empty = await callApi('lucia', `conversations/${id}/messages`, { content: 'Hi empty' });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.answer, FAILURE);
  assert.deepEqual((await stored(id)).at(-1)!.extras, { turnFailed: 'no_answer' });
  script.push(say('Hello.'));
  await callApi('lucia', `conversations/${id}/messages`, { content: 'Hi again' });
  const messages = await stored(id);
  assert.equal(messages.at(-1)!.content, 'Hello.');
  assert.equal(messages.at(-1)!.extras?.turnFailed, undefined);
  assert.doesNotMatch(render(messages), /Ask for human/);
});

test('HS1: no button on a normal answer, on a "Not sent" bubble, or on an older failed turn', () => {
  const failed = { turnFailed: 'turn_failed' };
  assert.doesNotMatch(
    render([message('u', 'user', 'Hi'), message('a', 'assistant', 'Hello.')]),
    /Ask for human/,
  );
  // Another error (409, 404, 504, 429 of the app): nothing was stored, the bubble has Retry only.
  const notSent = render([], { failed: { conversationId: 'c1', content: 'Hi' } });
  assert.match(notSent, /Not sent\./);
  assert.doesNotMatch(notSent, /Ask for human/);
  assert.doesNotMatch(
    render([
      message('a1', 'assistant', FAILURE, failed),
      message('u', 'user', 'Again'),
      message('a2', 'assistant', 'Here it is.'),
    ]),
    /Ask for human/,
  );
  // The stored confirmation follows the failed turn: the button is gone.
  assert.doesNotMatch(
    render([
      message('a1', 'assistant', FAILURE, failed),
      message('a2', 'assistant', 'A support request is open.', {
        handoff: { incidentId: 'i1', reference: '#ABC123' },
      }),
    ]),
    /Ask for human support</,
  );
});

test('HS1: in flight and failed states of the bubble', () => {
  const failed = [
    message('u', 'user', 'Hi'),
    message('a', 'assistant', FAILURE, { turnFailed: 'provider_busy' }),
  ];
  const asking = render(failed, { support: { status: 'asking' } });
  assert.match(asking, /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>Asking…</);
  const error = render(failed, { support: { status: 'error' } });
  assert.match(error, /We could not open a support request\. Try again\./);
  assert.match(error, /aria-busy="false"[^>]*>Ask for human support</);
  assert.doesNotMatch(error, /disabled=""[^>]*>Ask for human/);
});

test('HS2: the click opens one case and the confirmation is the stored message', async (t) => {
  quiet(t);
  process.env.OPENAI_API_KEY = '';
  const id = await newConversation();
  await callApi('lucia', `conversations/${id}/messages`, { content: 'Hi click' });
  const states: Record<string, SupportState> = {};
  const seen: (string | undefined)[] = [];
  let posts = 0,
    shown: Stored[] = [];
  const post = async (path: string, body: unknown) => {
    posts++;
    const r = await callApi('lucia', path, body);
    assert.equal(r.status, 200);
    // The action's result is what it was.
    assert.deepEqual(Object.keys(r.body).sort(), ['incidentId', 'status']);
    return r.body;
  };
  const ask = () =>
    askForSupport(
      id,
      states,
      post,
      () => seen.push(states[id]?.status),
      async () => void (shown = await stored(id)),
    );
  // Two rapid clicks: the second finds the first in flight and sends nothing.
  await Promise.all([ask(), ask()]);
  assert.equal(posts, 1);
  assert.deepEqual(seen, ['asking', undefined]);
  const [opened, ...rest] = cases(id);
  assert.deepEqual(rest, []);
  // The server's own validation accepted the summary, stored unchanged.
  assert.equal(opened.summary, SUPPORT_SUMMARY);
  assert.equal(opened.status, 'open');
  // What the page reloaded: the failed turn, then the confirmation with the operator's reference.
  assert.deepEqual(
    shown.map((m) => m.role),
    ['user', 'assistant', 'assistant'],
  );
  const confirmation = shown[2];
  assert.match(confirmation.content, CONFIRMATION);
  assert.ok(confirmation.content.includes(shortRef(opened.id)));
  assert.deepEqual(confirmation.extras, {
    handoff: { incidentId: opened.id, reference: shortRef(opened.id) },
  });
  const html = render(shown);
  assert.doesNotMatch(html, /Ask for human support</);
  assert.equal(html.split('A support request is open').length - 1, 1);
  // A reload reads the same messages.
  assert.deepEqual(await stored(id), shown);
  // The operator's inbox lists the case; its view holds the confirmation and the summary.
  const inbox = (await callApi('marta', 'dashboard')).body.incidents as { id: string }[];
  assert.ok(inbox.some((c) => c.id === opened.id));
  const view = JSON.stringify((await callApi('marta', `incidents/${opened.id}`)).body);
  assert.ok(view.includes(confirmation.content));
  assert.ok(view.includes(SUPPORT_SUMMARY));
});

test('HS2: 10 parallel calls leave one case and one message; a later failed turn gets its own confirmation', async (t) => {
  quiet(t);
  process.env.OPENAI_API_KEY = '';
  const id = await newConversation(),
    other = await newConversation();
  const handoffs = async () => (await stored(id)).filter((m) => m.extras?.handoff);
  const results = await Promise.all(Array.from({ length: 10 }, () => askPerson(id)));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  assert.equal(new Set(results.map((r) => r.body.incidentId)).size, 1);
  assert.equal(cases(id).length, 1);
  assert.equal((await handoffs()).length, 1);
  // Another conversation of the same customer is untouched.
  assert.deepEqual(await stored(other), []);
  assert.deepEqual(cases(other), []);
  // The turn fails again and the customer asks again: the same case, and a confirmation after
  // that failed turn (so its button goes too); a repeat of that click stores nothing.
  await callApi('lucia', `conversations/${id}/messages`, { content: 'Hi once more' });
  await askPerson(id);
  await askPerson(id);
  assert.equal(cases(id).length, 1);
  assert.equal((await handoffs()).length, 2);
  assert.ok((await stored(id)).at(-1)!.extras?.handoff);
});

test("HS2: another customer's conversation: 404, nothing stored; no conversation: no message", async () => {
  const id = await newConversation();
  const count = () => appDb().prepare('SELECT count(*) FROM messages').pluck().get();
  const before = count();
  assert.equal((await askPerson(id, 'diego')).status, 404);
  assert.equal((await askPerson(id, 'marta')).status, 403);
  const none = await callApi('lucia', 'actions', {
    name: 'request_human',
    arguments: { summary: SUPPORT_SUMMARY },
  });
  assert.equal(none.body.status, 'failed');
  assert.deepEqual(cases(id), []);
  assert.equal(count(), before);
});

test('HS2: the model path is unchanged: its own answer is the only message', async () => {
  process.env.OPENAI_API_KEY = 'test-fake';
  status = 200;
  const id = await newConversation();
  script.push(
    call('request_human', { summary: 'Lucia wants a person.' }),
    say('A person will help.'),
  );
  const r = await callApi('lucia', `conversations/${id}/messages`, { content: 'A person, please' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (await stored(id)).map((m) => [m.role, m.content, m.extras]),
    [
      ['user', 'A person, please', null],
      ['assistant', 'A person will help.', null],
    ],
  );
  assert.deepEqual(
    cases(id).map((c) => c.summary),
    ['Lucia wants a person.'],
  );
});

test('HS1: a refused or failed action leaves the button usable again', async () => {
  const states: Record<string, SupportState> = {};
  let reloads = 0,
    answer: () => Promise<Record<string, unknown>> = async () => ({
      status: 'failed',
      error: 'x',
    });
  const ask = () =>
    askForSupport(
      'c1',
      states,
      () => answer(),
      noop,
      async () => void reloads++,
    );
  await ask();
  assert.deepEqual(states.c1, { status: 'error' });
  answer = async () => {
    throw new Error('network');
  };
  await ask();
  assert.deepEqual(states.c1, { status: 'error' });
  assert.equal(reloads, 0);
  answer = async () => ({ status: 'open', incidentId: 'i1' });
  await ask();
  assert.equal(states.c1, undefined);
  assert.equal(reloads, 1);
});
