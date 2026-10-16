// FX4-a: with no model key the customer's chat says the assistant is unavailable in plain words;
// the setup hint stays in the API `code`, the server log and the run's error (operator's view).
// No bank is started: the account read fails soft and the run stops at the missing key.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, callApi } from './helpers/bank';

const { temp } = await setupEnv('banana-fx4-no-key-');
process.env.OPENAI_API_KEY = '';
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
seedApp();
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('FX4-a: no key: plain text for the customer, the setup hint for the developer and operator', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const { body: created } = await callApi('lucia', 'conversations', {});
  const id = created.id ?? created.conversation?.id;
  const r = await callApi('lucia', `conversations/${id}/messages`, { content: 'Hello' });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'missing_openai_api_key');
  assert.match(r.body.error, /^The assistant is not available right now\./);
  assert.doesNotMatch(r.body.error, /OPENAI_API_KEY|\.env/);

  const stored = appDb()
    .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant'")
    .all(id) as { content: string }[];
  assert.deepEqual(
    stored.map((m) => m.content),
    [r.body.error],
  );

  const run = appDb().prepare('SELECT status,error FROM runs WHERE conversation_id=?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(run.status, 'failed');
  assert.match(
    run.error,
    /^Internal \(configuration, not shown to the customer\): Set OPENAI_API_KEY/,
  );

  const line = logged.mock.calls
    .map((c) => String(c.arguments[0]))
    .find((l) => l.includes('assistant_unavailable'));
  assert.match(line ?? '', /missing_openai_api_key.*Set OPENAI_API_KEY/);
});
