// IT2: the alt bank's test-only POST /_control/movement refuses a malformed or empty body and a
// createdAt that is not an ISO date-time with 400 VALIDATION (it was a 500, and any string).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-it2-alt-control-');
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
const headers = { 'x-alt-control': 'alt-control' };
const post = (body: string, token = 'alt-control') =>
  fetch(`${process.env.BANK_URL}/_control/movement`, {
    method: 'POST',
    headers: { 'x-alt-control': token },
    body,
  });
const movement = { accountId: 'acc-bruno', amountCents: -100, description: 'ZZQXV IT2' };
const state = async () =>
  JSON.stringify(await (await fetch(`${process.env.BANK_URL}/_control/state`, { headers })).json());
async function refused(body: string) {
  const r = await post(body);
  assert.equal(r.status, 400, `body ${body}`);
  assert.equal(((await r.json()) as { code: string }).code, 'VALIDATION', `body ${body}`);
}

test('IT2: a malformed or empty body is 400 VALIDATION and changes nothing', async () => {
  const before = await state();
  for (const body of ['', '{"accountId": ', 'not json', 'null', '"text"', '7', '[]'])
    await refused(body);
  await refused(JSON.stringify([movement])); // an array is not an object (review)
  assert.equal(await state(), before);
});

test('IT2: createdAt must be an ISO date-time', async () => {
  const before = await state();
  for (const createdAt of [
    'yesterday',
    '',
    '2026-09-30',
    '2026-13-45T10:00:00.000Z',
    '30/09/2026 10:00',
    // Review: a day that month does not have, an hour past 24, an offset without its colon, no zone.
    '2026-02-30T10:00:00Z',
    '2025-02-29T10:00:00Z',
    '2026-09-30T25:00:00Z',
    '2026-09-30T12:00:00+0200',
    '2026-09-30T10:00:00',
    5,
    {},
  ])
    await refused(JSON.stringify({ ...movement, createdAt }));
  assert.equal(await state(), before);
});

test('IT2: valid bodies and the other refusals are unchanged', async () => {
  for (const createdAt of [
    undefined,
    null,
    '2026-09-30T10:00:00.000Z',
    '2026-09-30T10:00:00Z',
    '2026-09-30T12:00:00+02:00',
    '2026-09-30T10:00Z',
    '2024-02-29T23:30:00-05:00', // a leap day, whatever the offset
  ])
    assert.equal((await post(JSON.stringify({ ...movement, createdAt }))).status, 200);
  assert.equal((await post('', 'wrong')).status, 403);
  assert.equal((await post(JSON.stringify({ ...movement, accountId: 'nope' }))).status, 404);
  await refused(JSON.stringify({ ...movement, amountCents: 1.5 }));
});
