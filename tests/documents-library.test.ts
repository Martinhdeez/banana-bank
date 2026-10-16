// DL1: document library filters (product, validity) and the cited chunk kept with each citation so
// the library can highlight the excerpt an answer rested on. No bank and no OpenAI calls.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-library-'));
process.env.DATA_DIR = temp;
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const route = await import('../app/api/[...path]/route');
const run = await import('../src/agent/run');
seedApp();
const library = async (as: string, query = '') =>
  (
    await route.GET(
      new Request(`http://127.0.0.1/api/documents${query}`, {
        headers: { cookie: `banana_actor=${sessionToken(as)}` },
      }),
      { params: Promise.resolve({ path: ['documents'] }) },
    )
  ).json();

test('DL1: without filters the library lists every visible document with product and validity', async () => {
  const all = await library('lucia');
  assert.ok(all.documents.length > 50);
  assert.ok(all.documents.every((d: any) => d.audience === 'public'));
  assert.deepEqual(all.products, [
    'aurora',
    'horizon',
    'cloud',
    'travel',
    'family',
    'professional',
    'young',
    'community',
  ]);
  const byId = (id: string) => all.documents.find((d: any) => d.id === id);
  assert.equal(byId('faq-aurora-waiver').product, 'aurora');
  assert.equal(byId('faq-internal-transfer').product, null);
  assert.equal(byId('archive-aurora-1').validity, 'archived');
  assert.equal(byId('aurora-fees-2026').validity, 'current');
});

test('DL1: product and validity filters', async () => {
  const current = (await library('lucia', '?product=aurora&validity=current')).documents;
  const ids = current.map((d: any) => d.id);
  for (const id of ['aurora-fees-2026', 'faq-aurora-waiver', 'notice-aurora'])
    assert.ok(ids.includes(id), id);
  assert.ok(current.every((d: any) => d.product === 'aurora' && d.validTo === null));
  const archived = (await library('lucia', '?validity=archived')).documents;
  assert.ok(archived.length > 0);
  assert.ok(archived.every((d: any) => d.validity === 'archived' && d.id.startsWith('archive-')));
  const operator = (await library('marta', '?validity=current')).documents;
  assert.ok(
    operator.some((d: any) => d.audience === 'internal'),
    'operators keep internal documents',
  );
});

test('DL1: a citation keeps the id of the cited chunk', () => {
  const pool = [
    {
      id: 'chunk-a',
      documentId: 'aurora-fees-2026',
      text: 'Aurora fee',
      title: 'Aurora · current fees',
      version: 2,
      validFrom: '2026-09-01',
      validTo: null,
      audience: 'public',
      score: 1,
    },
  ];
  assert.deepEqual(run.citedSources('The fee is EUR 6 [aurora-fees-2026].', pool), [
    {
      id: 'chunk-a',
      documentId: 'aurora-fees-2026',
      title: 'Aurora · current fees',
      version: 2,
      validFrom: '2026-09-01',
      validTo: null,
    },
  ]);
});

after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
