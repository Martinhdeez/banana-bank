// SEC4: a JSON body over MAX_BODY_BYTES is a 413 (Content-Length or streamed count), malformed JSON
// stays a 400, and /api/documents rejects unknown, repeated or invalid query parameters.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeOpenAI, say } from './helpers/openai';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-sec4-'));
process.env.DATA_DIR = temp;
const { server } = await fakeOpenAI(() => say('ok'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { GET, POST } = await import('../app/api/[...path]/route');
seedApp();
after(() => {
  closeAppDb();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
const big = 'a'.repeat(300_000);
async function call(
  as: string,
  route: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
) {
  const request = new Request(`http://localhost/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `banana_actor=${sessionToken(as)}`,
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
  const response = await (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: new URL(request.url).pathname.split('/').slice(2) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

test('SEC4: a body over MAX_BODY_BYTES is 413 without being parsed', async () => {
  const r = await call('lucia', 'search', JSON.stringify({ query: big }), {
    'Content-Length': String(big.length + 12),
  });
  assert.equal(r.status, 413);
  assert.deepEqual(r.body, { error: 'The request is too large.' });
});

test('SEC4: a chunked body without Content-Length is cut off at the limit', async () => {
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 400_000) return controller.close();
      sent += 10_000;
      controller.enqueue(new TextEncoder().encode('a'.repeat(10_000)));
    },
  });
  const r = await call('lucia', 'search', stream);
  assert.equal(r.status, 413);
  assert.ok(sent < 400_000, `the reader stopped early (${sent} bytes pulled)`);
});

test('SEC4: 413 on money routes carries status failed and writes no intent', async () => {
  const before = appDb().prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number };
  const r = await call('lucia', 'actions', JSON.stringify({ padding: big }));
  assert.equal(r.status, 413);
  assert.deepEqual(r.body, { status: 'failed', error: 'The request is too large.' });
  const now = appDb().prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number };
  assert.equal(now.n, before.n);
});

test('SEC4: the limit counts bytes, not characters', async () => {
  // 100 000 three-byte characters = 300 KB.
  const r = await call('lucia', 'search', JSON.stringify({ query: '€'.repeat(100_000) }));
  assert.equal(r.status, 413);
});

test('SEC4: the largest legitimate body (preview-answer, 10 × 12 000 chars) is accepted', async () => {
  const source = (i: number) => ({
    id: `c${i}`,
    documentId: `d${i}`,
    text: 'x'.repeat(12_000),
    title: null,
    version: null,
    validFrom: null,
    validTo: null,
    audience: 'public',
    score: 1,
  });
  const r = await call(
    'marta',
    'preview-answer',
    JSON.stringify({
      question: 'q'.repeat(8000),
      sources: Array.from({ length: 10 }, (_, i) => source(i)),
    }),
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('SEC4: malformed or empty JSON stays 400', async () => {
  assert.deepEqual(await call('lucia', 'search', '{"query": '), {
    status: 400,
    body: { error: 'Invalid request data.' },
  });
  assert.equal((await call('lucia', 'search', '')).status, 400);
});

test('SEC4: resolve without a body still asks for confirmation; a huge body is 413', async () => {
  const empty = await call('marta', 'incidents/none/resolve', '');
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /explicit confirmation/);
  const huge = await call(
    'marta',
    'incidents/none/resolve',
    JSON.stringify({ confirm: true, big }),
  );
  assert.equal(huge.status, 413);
});

test('SEC4: /api/documents rejects unknown, repeated or invalid query parameters', async () => {
  for (const query of [
    '?validity=old',
    '?foo=1',
    '?validity=current&validity=archived',
    '?product=a&product=b',
  ])
    assert.deepEqual(
      await call('lucia', `documents${query}`),
      {
        status: 400,
        body: { error: 'Invalid request data.' },
      },
      query,
    );
  const unknownProduct = await call('lucia', 'documents?product=nope');
  assert.equal(unknownProduct.status, 200);
  assert.deepEqual(unknownProduct.body.documents, []);
  const current = await call('lucia', 'documents?validity=current&product=aurora');
  assert.equal(current.status, 200);
  assert.ok(current.body.documents.length > 0);
  assert.equal((await call('lucia', 'documents')).status, 200);
});
