// K3: decoded chunk vectors are cached, and the cache follows every change of the index: an ingest
// (replaceChunks), a reset (seedApp) and a change made by another process on the same database.
// GET /api/documents/:id/chunks reads one document's chunks without decoding any vector.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-vector-cache-'));
process.env.DATA_DIR = temp;
process.env.OPENAI_API_KEY = 'test-no-network';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const store = await import('../src/retrieval/store');
const { searchDocuments } = await import('../src/retrieval/search');
const { embeddingKey, vectorBuffer } = await import('../src/retrieval/embeddings');
const { config } = await import('../src/config');
seedApp();
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const settings = { model: config.embeddingModel, dimensions: 1536 };
const docs = () => new Set(store.allChunks().map((c) => c.documentId));
// The query's embedding is the vector of a lost-response chunk (no API call).
const query = 'what if the bank does not answer';
const target = store.allChunks().find((c) => c.documentId === 'faq-lost-response')!;
appDb()
  .prepare('INSERT OR REPLACE INTO embedding_cache VALUES(?,?)')
  .run(embeddingKey(query), vectorBuffer(target.vector!));

test('K3: repeated reads reuse the decoded chunks', () => {
  assert.equal(store.allChunks(), store.allChunks());
});

test('K3: replaceChunks (ingest) invalidates the cache', async () => {
  const all = store.allChunks();
  assert.equal((await searchDocuments(query))[0].documentId, 'faq-lost-response');
  store.replaceChunks(
    all.filter((c) => c.documentId !== 'faq-lost-response'),
    settings,
  );
  assert.ok(!docs().has('faq-lost-response'));
  assert.ok(!(await searchDocuments(query)).some((r) => r.documentId === 'faq-lost-response'));
  store.replaceChunks(all, settings);
  assert.equal((await searchDocuments(query))[0].documentId, 'faq-lost-response');
});

test('K3: a reset (seedApp) invalidates the cache', () => {
  store.replaceChunks(store.allChunks().slice(0, 3), settings);
  assert.equal(store.allChunks().length, 3);
  seedApp();
  assert.ok(store.allChunks().length > 3);
});

test('K3: an index replaced by another process is picked up', () => {
  const before = store.allChunks().length;
  const other = new Database(path.join(temp, 'app.sqlite'));
  other.transaction(() => {
    other.prepare('DELETE FROM chunks WHERE document_id=?').run('faq-lost-response');
    other.prepare("INSERT OR REPLACE INTO meta VALUES('index-version','other-process')").run();
  })();
  other.close();
  assert.ok(store.allChunks().length < before);
  assert.ok(!docs().has('faq-lost-response'));
  seedApp();
});

test('K3: document chunks are listed without vectors', () => {
  const chunks = store.documentChunks('faq-lost-response');
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.documentId === 'faq-lost-response' && !('vector' in c)));
  assert.deepEqual(
    chunks.map((c) => c.id),
    store
      .allChunks()
      .filter((c) => c.documentId === 'faq-lost-response')
      .map((c) => c.id),
  );
});
