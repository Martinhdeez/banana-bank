// FX6-b: a turn that fails for any reason leaves the customer one of three plain sentences; the
// error's own text stays in the API `code`, the server log and the run's error (operator's view).
// A local stand-in for the provider answers each cause; no bank is started (its reads fail soft).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupEnv, callApi } from './helpers/bank';

const { temp } = await setupEnv('banana-fx6-turn-');
// What the stand-in does with the next model request; embeddings answer unless `bad-embeddings`.
type Mode = number | 'drop' | 'bad-embeddings';
let mode = 429 as Mode;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const embeddings = req.url?.endsWith('/embeddings');
  if (embeddings) {
    const inputs = [JSON.parse(raw).input].flat();
    const embedding = Array.from({ length: mode === 'bad-embeddings' ? 3 : 1536 }, () => 0.1);
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding })),
      }),
    );
  }
  if (mode === 'drop') return req.socket.destroy();
  // x-should-retry: the client does not repeat the request, so the test does not wait.
  res.writeHead(mode as number, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
  res.end(JSON.stringify({ error: { message: 'PROVIDER-BODY sk-proj-abcdefghijkl quota' } }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_API_KEY = 'test-fake';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
seedApp();
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const UNAVAILABLE = /^The assistant is not available right now\./;
const BUSY = /^The assistant is busy right now\. Please try again in a moment\./;
const NOT_FINISHED = /^I could not finish this request\. Try again or ask for human support\.$/;
const causes: [Mode, RegExp, string, RegExp][] = [
  [
    401,
    UNAVAILABLE,
    'provider_refused',
    /^Internal \(configuration, not shown to the customer\): The AI provider returned 401\./,
  ],
  [
    429,
    BUSY,
    'provider_busy',
    /^Internal \(AI provider, not shown to the customer\): The AI provider returned 429\./,
  ],
  [
    503,
    BUSY,
    'provider_busy',
    /^Internal \(AI provider, not shown to the customer\): The AI provider returned 503\./,
  ],
  [
    'drop',
    BUSY,
    'provider_busy',
    /^Internal \(AI provider, not shown to the customer\): Connection error/,
  ],
  [
    400,
    NOT_FINISHED,
    'turn_failed',
    /^Internal \(AI provider, not shown to the customer\): The AI provider returned 400\./,
  ],
  [
    'bad-embeddings',
    NOT_FINISHED,
    'turn_failed',
    /^Internal \(error, not shown to the customer\): Unexpected dimensions/,
  ],
];
for (const [cause, sentence, code, internal] of causes)
  test(`FX6-b: ${cause}: a plain sentence for the customer, the reason for the operator`, async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'info', () => {});
    mode = cause;
    const { body: created } = await callApi('lucia', 'conversations', {});
    const id = created.id ?? created.conversation?.id;
    // A new text each time: an embedding already cached would not be asked for again.
    const r = await callApi('lucia', `conversations/${id}/messages`, { content: `Hello ${cause}` });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, code);
    assert.match(r.body.error, sentence);
    const stored = appDb()
      .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant'")
      .all(id) as { content: string }[];
    assert.deepEqual(
      stored.map((m) => m.content),
      [r.body.error],
    );
    const run = appDb()
      .prepare('SELECT status,error FROM runs WHERE conversation_id=?')
      .get(id) as {
      status: string;
      error: string;
    };
    assert.equal(run.status, 'failed');
    assert.match(run.error, internal);
    // Neither the customer nor the operator's record holds the provider's own body.
    assert.doesNotMatch(
      r.body.error + run.error,
      /PROVIDER-BODY|sk-proj|could not complete the request/,
    );
    assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes(code)));
  });
