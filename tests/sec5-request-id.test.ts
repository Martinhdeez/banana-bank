// SEC5: every API response and bank call carries an x-request-id; server logs are one JSON line
// with that id and no secrets; the access log uses route labels instead of ids.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-sec5-'));
process.env.DATA_DIR = temp;
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken, sign } = await import('../src/auth');
const { config } = await import('../src/config');
const { GET, POST } = await import('../app/api/[...path]/route');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const token = sessionToken('carla');
async function call(
  route: string,
  { body, cookie = true, id }: { body?: string; cookie?: boolean; id?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = `banana_actor=${token}`;
  if (id !== undefined) headers['x-request-id'] = id;
  const request = new Request(`http://localhost/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body,
  });
  return (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
}

test('SEC5: every API response carries an x-request-id', async () => {
  const ids = [
    await call('health'),
    await call('dashboard', { cookie: false }),
    await call('session', { body: '{"userId":"carla"}' }),
  ].map((r) => r.headers.get('x-request-id'));
  for (const id of ids) assert.match(String(id), UUID);
  assert.equal(new Set(ids).size, ids.length, 'ids differ per request');
});

test('SEC5: a valid client x-request-id is echoed, an invalid one replaced', async () => {
  assert.equal((await call('health', { id: 'abc-123' })).headers.get('x-request-id'), 'abc-123');
  for (const bad of ['a'.repeat(65), 'bad id'])
    assert.match(String((await call('health', { id: bad })).headers.get('x-request-id')), UUID);
});

test('SEC5: bank calls carry the request id and an unchanged signature', async (t) => {
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    seen.push(new Request(input, init));
    return Response.json([]);
  });
  const r = await call('dashboard', { id: 'trace-1' });
  assert.equal(r.headers.get('x-request-id'), 'trace-1');
  assert.ok(seen.length > 0, 'the dashboard called the bank');
  for (const req of seen) {
    const h = req.headers,
      url = new URL(req.url);
    assert.equal(h.get('x-request-id'), 'trace-1');
    const signed = [
      req.method,
      url.pathname + url.search,
      h.get('x-bank-actor'),
      h.get('x-bank-time'),
      '',
    ].join('\n');
    assert.equal(h.get('x-bank-signature'), sign(signed, config.serviceSecret));
  }
});

test('SEC5: logs are one JSON line with the request id and no secrets', async (t) => {
  const db = appDb(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-sec5', 'carla', 'S', now);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
    'msg-sec5',
    'conv-sec5',
    'assistant',
    'Hi',
    now,
    null,
  );
  db.prepare('INSERT INTO message_sources VALUES(?,?)').run('msg-sec5', '[{"documentId": ');
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
  const r = await call('conversations/conv-sec5');
  assert.equal(r.status, 500);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].length, 1, 'one argument: the JSON line');
  const line = String(logged[0][0]);
  const entry = JSON.parse(line);
  assert.equal(entry.event, 'app_request_failed');
  assert.equal(entry.level, 'error');
  assert.equal(entry.requestId, r.headers.get('x-request-id'));
  assert.ok(!line.includes(token), 'no cookie value');
  assert.ok(!line.includes('banana_actor'), 'no cookie name');
});

test('SEC5: the access log uses route labels, not ids', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => logged.push(args));
  const id = randomUUID();
  const r = await call(`approvals/${id}/confirm`, { body: '{}' });
  const lines = logged.map((a) => String(a[0]));
  const entry = JSON.parse(lines.find((l) => l.includes('"api_request"'))!);
  assert.equal(entry.route, 'approvals/:id/confirm');
  assert.equal(entry.method, 'POST');
  assert.equal(entry.status, r.status);
  assert.equal(typeof entry.ms, 'number');
  assert.equal(entry.requestId, r.headers.get('x-request-id'));
  assert.ok(!lines.join('\n').includes(id), 'no approval id in the access log');
});
