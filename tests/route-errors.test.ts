// K6: a malformed request body is a 400; a corrupt value stored in our own database is a 500 whose
// full error (name, message, stack) is logged server-side, without the request's cookie or body.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-route-errors-'));
process.env.DATA_DIR = temp;
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { GET, POST } = await import('../app/api/[...path]/route');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const cookie = `banana_actor=${sessionToken('carla')}`;
async function call(route: string, body?: string) {
  const request = new Request(`http://localhost/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body,
  });
  const response = await (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
  return { status: response.status, body: (await response.json()) as { error: string } };
}

test('K6: a malformed request body is a 400', async () => {
  const r = await call('session', '{"userId": ');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Invalid request data.');
});

test('K6: corrupt stored JSON is a 500 with the full error logged, not a 400', async (t) => {
  const db = appDb(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-k6', 'carla', 'K6', now);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
    'msg-k6',
    'conv-k6',
    'assistant',
    'Hi',
    now,
    null,
  );
  db.prepare('INSERT INTO message_sources VALUES(?,?)').run('msg-k6', '[{"documentId": ');
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
  const r = await call('conversations/conv-k6');
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body.error, /JSON|Syntax|position/);
  assert.equal(logged.length, 1);
  // SEC5: the log is one JSON line; same facts as before.
  const text = String(logged[0][0]),
    entry = JSON.parse(text);
  assert.equal(entry.event, 'app_request_failed');
  assert.equal(entry.name, 'SyntaxError');
  assert.match(entry.stack, /^SyntaxError: .*\n +at /);
  assert.equal(entry.path, '/api/conversations/conv-k6');
  assert.ok(!text.includes(sessionToken('carla')), 'the session cookie is not logged');
});

test('K8: the per-resource routing keeps 404 for unknown and partial paths', async () => {
  for (const route of ['nope', 'toString', 'constructor', 'dashboard/extra'])
    assert.equal((await call(route)).status, 404, route);
  // IT2: a real path with a method it does not define (these two are POST only) is a 405.
  for (const route of ['search', 'ingestion']) assert.equal((await call(route)).status, 405, route);
  assert.equal((await call('approvals/x/other', '{}')).status, 404);
});

test("K6: a bank error reaches the client in plain words, the bank's text only in the log", async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'SQLITE_BUSY at ledger.ts:42' }, { status: 400 }),
  );
  const logged: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => logged.push(args));
  const r = await call('dashboard');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'The bank could not complete this request.');
  assert.match(JSON.stringify(logged), /SQLITE_BUSY/);
});
