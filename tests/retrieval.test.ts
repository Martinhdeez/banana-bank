// F4b, F4f, A2, A3: retrieval ranks only applicable documents for the caller's audience, one chunk per
// document, preferring the customer's product document over its equivalent for another product.
// Deterministic: query vectors are stored chunk vectors injected through the embedding cache,
// so no embeddings request is made (the base URL points to a closed port).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-retrieval-'));
process.env.DATA_DIR = temp;
process.env.OPENAI_API_KEY = 'test-no-network';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { searchDocuments } = await import('../src/retrieval/search');
const { runTool } = await import('../src/agent/tools');
const { documents } = await import('../src/ingestion/pipeline');
const { referenceDate } = await import('../src/config');
seedApp();
const manifest = new Map(documents().map((d) => [d.id, d]));
const applies = (id: string, at: string) => {
  const d = manifest.get(id)!;
  return d.validFrom <= at && (!d.validTo || at <= d.validTo);
};
const { queryLike } = await import('./helpers/data');
const archivedFee = queryLike(
  'What was the Aurora fee?',
  (c) => c.documentId === 'archive-aurora-1' && c.text.includes('EUR 8 per month'),
);
const currentFee = queryLike(
  'What is the Aurora fee?',
  (c) => c.documentId === 'aurora-fees-2026' && c.text.includes('monthly fee is EUR 6'),
);

test('F4b: default search returns only documents valid at the reference date', async () => {
  const results = await searchDocuments(archivedFee);
  assert.ok(results.length > 0);
  for (const r of results) assert.ok(applies(r.documentId, referenceDate), r.documentId);
  assert.ok(!results.some((r) => r.documentId.startsWith('archive-')));
});

test('F4b: a past date returns the version that applied then, never mixed', async () => {
  const results = await (
    searchDocuments as (...a: unknown[]) => ReturnType<typeof searchDocuments>
  )(currentFee, 'customer', 5, '2026-08-15');
  assert.ok(results.some((r) => r.documentId.startsWith('archive-aurora')));
  for (const r of results) assert.ok(applies(r.documentId, '2026-08-15'), r.documentId);
});

test('F4b: the search_documents tool applies the same validity rule', async () => {
  const ctx = { userId: 'lucia', conversationId: null, runId: 'run-f4b', intentId: 'i-f4b' };
  const result = (await runTool(
    'search_documents',
    { query: archivedFee, validAt: null },
    ctx,
  )) as {
    sources: { documentId: string }[];
  };
  assert.ok(result.sources.length > 0);
  for (const r of result.sources) assert.ok(applies(r.documentId, referenceDate), r.documentId);
});

test('F4f: operators get internal procedures through the tool, customers do not', async () => {
  const query = queryLike('internal procedure', (c) => c.documentId === 'procedure-1');
  const search = async (userId: string) =>
    (
      (await runTool(
        'search_documents',
        { query, validAt: null },
        { userId, conversationId: null, runId: `run-${userId}`, intentId: `i-${userId}` },
      )) as { sources: { audience: string }[] }
    ).sources;
  assert.ok((await search('marta')).some((s) => s.audience === 'internal'));
  assert.ok((await search('lucia')).every((s) => s.audience === 'public'));
});

// A2: one result per document, so several chunks of one document cannot crowd out the rest
// (live evidence: procedure-2 took 4 of 5 slots in /api/search for Marta). The faq-cancellation
// passage fills all 5 slots with its own chunks before A2.
const cancelQuery = queryLike(
  'Can I cancel a transfer?',
  (c) => c.documentId === 'faq-cancellation',
);

test('A2: search keeps the best chunk of each document before the top-5 cut', async () => {
  const results = await searchDocuments(cancelQuery);
  const ids = results.map((r) => r.documentId);
  assert.equal(results.length, 5);
  assert.equal(ids[0], 'faq-cancellation');
  assert.equal(new Set(ids).size, ids.length, ids.join(','));
  const scores = results.map((r) => r.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
  );
});

test('A2: POST /api/search returns distinct documents with the SearchResult shape', async () => {
  const { callApi } = await import('./helpers/bank');
  const { status, body } = await callApi('lucia', 'search', { query: cancelQuery });
  assert.equal(status, 200);
  const ids = body.sources.map((s: { documentId: string }) => s.documentId);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, ids.length, ids.join(','));
  for (const s of body.sources)
    assert.deepEqual(Object.keys(s).sort(), [
      'audience',
      'documentId',
      'id',
      'score',
      'text',
      'title',
      'validFrom',
      'validTo',
      'version',
    ]);
});

// A3: live evidence 22 — Bruno (Horizon account) got aurora-fees-2026 as evidence for "internal
// transfers are free"; offline, horizon-fees-2026 ranks 9th for that passage.
const internalFee = queryLike(
  'Is there a fee to send 50 euros to Carla?',
  (c) => c.documentId === 'aurora-fees-2026' && c.text.includes('Standard internal transfers'),
);
const search = searchDocuments as (...a: unknown[]) => ReturnType<typeof searchDocuments>;

test("A3: the customer's product document ranks just before its twin, which is kept", async () => {
  const ids = (await search(internalFee, 'customer', 5, undefined, ['horizon'])).map(
    (r) => r.documentId,
  );
  assert.ok(ids.includes('horizon-fees-2026'), ids.join(','));
  assert.equal(
    ids.indexOf('horizon-fees-2026'),
    ids.indexOf('aurora-fees-2026') - 1,
    ids.join(','),
  );
});

test('A3: without customer products the ranking is the neutral one', async () => {
  const neutral = (await searchDocuments(internalFee)).map((r) => r.documentId);
  assert.equal(neutral[0], 'aurora-fees-2026');
  assert.ok(!neutral.includes('horizon-fees-2026'));
  const aurora = (await search(internalFee, 'customer', 5, undefined, ['aurora'])).map(
    (r) => r.documentId,
  );
  assert.deepEqual(aurora, neutral);
});

after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
