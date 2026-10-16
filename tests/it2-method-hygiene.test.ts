// IT2: every API route answers only the methods it defines. Walks the route table × every method,
// in-process, on the alt bank with DECIDER=none (no model call): a method the route does not
// define is a 405 with an Allow header and the JSON error shape; one it defines is never a 405 or
// the dispatcher's 404; HEAD answers as GET; OPTIONS is a 204 with the route's own Allow.
// IT2_MATRIX=<file> also writes the status of every cell (before/after evidence).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-it2-methods-');
process.env.OPENAI_API_KEY = ''; // POST /api/ingestion must stop at the missing key
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { documents } = await import('../src/ingestion/pipeline');
const { sessionToken } = await import('../src/auth');
const { apiRoutes, routeMethods } = await import('../src/http');
const api = (await import('../app/api/[...path]/route')) as Record<string, any>;
seedApp();
const bank = await startSimulator('alt');
const matrix: string[] = [];
// Real ids, so a wrong method that answers like the GET shows as a 200; other ids are unknown.
const ids: Record<string, string> = {
  conversations: 'conv-lucia-support',
  incidents: (appDb().prepare('SELECT id FROM incidents LIMIT 1').get() as { id: string }).id,
  documents: documents().find((d) => d.audience === 'public')!.id,
};
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
  if (process.env.IT2_MATRIX) fs.writeFileSync(process.env.IT2_MATRIX, matrix.join('\n') + '\n');
});

const METHODS = ['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'];
const OPERATOR = ['incidents', 'preview-answer', 'ingestion'];
// What Next does for a method the route file does not export: HEAD runs GET, OPTIONS is its own
// 204, anything else its own bare 405 (no body, no Allow).
async function call(method: string, route: string, headers: Record<string, string> = {}) {
  const fn = api[method] ?? (method === 'HEAD' ? api.GET : undefined);
  if (!fn) return { status: method === 'OPTIONS' ? 204 : 405, allow: null, body: null, next: true };
  const path = route.split('/');
  const request = new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      host: 'localhost',
      'Content-Type': 'application/json',
      cookie: `banana_actor=${sessionToken(OPERATOR.includes(path[0]) ? 'marta' : 'lucia')}`,
      ...headers,
    },
    body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : '{}',
  });
  const response: Response = await fn(request, { params: Promise.resolve({ path }) });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, allow: response.headers.get('allow'), body, next: false };
}
const allowed = (methods: string[]) =>
  [...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'].sort();
const listed = (allow: string | null) => (allow ?? '').split(', ').sort();

for (const [pattern, methods] of Object.entries(apiRoutes)) {
  const route = pattern.replace(/:\w+/g, ids[pattern.split('/')[0]] ?? 'x');
  test(`IT2 ${pattern}: only ${methods.join(', ')}`, async () => {
    const seen: Record<string, number> = {};
    const problems: string[] = [];
    for (const method of METHODS) {
      const r = await call(method, route);
      seen[method] = r.status;
      matrix.push(
        `${pattern.padEnd(28)} ${method.padEnd(7)} ${r.status}${r.next ? ' (Next, not the app)' : ''}${r.allow ? `  Allow: ${r.allow}` : ''}`,
      );
      const allowOk = listed(r.allow).join() === allowed(methods).join();
      if (method === 'OPTIONS') {
        if (r.status !== 204 || !allowOk) problems.push(`OPTIONS: ${r.status}, Allow ${r.allow}`);
      } else if (allowed(methods).includes(method)) {
        if (r.status === 405 || r.body?.error === 'Route not found.')
          problems.push(`${method}: ${r.status} ${r.body?.error}`);
      } else if (r.status !== 405 || !allowOk || r.body?.error !== 'Method not allowed.')
        problems.push(`${method}: ${r.status}, Allow ${r.allow}, body ${JSON.stringify(r.body)}`);
    }
    if (methods.includes('GET') && seen.HEAD !== seen.GET)
      problems.push(`HEAD is ${seen.HEAD}, GET is ${seen.GET}`);
    assert.deepEqual(problems, [], route);
  });
}

test('IT2: the two reported cases, and the transfer endpoints keep status "failed"', async () => {
  for (const route of ['session', 'conversations']) {
    const r = await call('DELETE', route);
    assert.equal(r.status, 405);
    assert.equal(r.allow, 'GET, POST, HEAD, OPTIONS');
  }
  const r = await call('GET', 'actions');
  assert.deepEqual(r.body, { status: 'failed', error: 'Method not allowed.' });
  assert.equal(r.allow, 'POST, OPTIONS');
});

test('IT2: the origin check still comes first, and a path outside the table is a 404', async () => {
  const foreign = { origin: 'http://evil.example' };
  assert.equal((await call('DELETE', 'dashboard', foreign)).status, 403);
  assert.equal((await call('POST', 'insights/categories', foreign)).status, 403);
  for (const method of ['GET', 'POST', 'DELETE', 'PUT'])
    for (const route of [
      'nope',
      `conversations/${ids.conversations}/nope`,
      `incidents/${ids.incidents}/nope`,
      `documents/${ids.documents}/chunks/nope`,
    ]) {
      assert.equal(routeMethods(route.split('/')), undefined);
      const r = await call(method, route);
      assert.deepEqual([r.status, r.body?.error], [404, 'Route not found.'], `${method} ${route}`);
    }
});

// Review of #105: the order of the checks, pinned. Origin, then the method (before the session:
// the table is public and a session is one POST away), then the session, then the role.
test('IT2: without a session a defined method is still 401, an undefined one 405, no route 401', async () => {
  const anonymous = { cookie: '' };
  for (const [method, route, status] of [
    ['GET', 'dashboard', 401],
    ['POST', 'actions', 401],
    ['DELETE', 'insights/rules/KEY', 401],
    ['HEAD', 'dashboard', 401],
    ['DELETE', 'dashboard', 405],
    ['GET', 'actions', 405],
    ['PUT', 'health', 405],
    ['GET', 'nope', 401],
    ['PUT', 'nope', 401],
    ['OPTIONS', 'nope', 401],
    ['GET', `conversations/${ids.conversations}/nope`, 401],
  ] as const)
    assert.equal((await call(method, route, anonymous)).status, status, `${method} ${route}`);
  assert.equal((await call('OPTIONS', 'dashboard', anonymous)).status, 204);
  assert.equal(
    (await call('PUT', 'dashboard', { ...anonymous, origin: 'http://evil' })).status,
    403,
  );
});

test('IT2: an operator is 403 on the insights routes, 404 on an insights path that is no route', async () => {
  const operator = { cookie: `banana_actor=${sessionToken('marta')}` };
  for (const [method, route, status] of [
    ['GET', 'insights/spending', 403],
    ['POST', 'insights/categories', 403],
    ['DELETE', 'insights/rules/KEY', 403],
    ['GET', 'insights/categories', 405],
    ['DELETE', 'insights/rules', 405],
    ['GET', 'insights/nope', 404],
    ['GET', 'insights', 404],
  ] as const)
    assert.equal((await call(method, route, operator)).status, status, `${method} ${route}`);
});
