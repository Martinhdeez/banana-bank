// K8: shared test data helpers. Import dynamically after setupEnv (or after setting DATA_DIR):
// src/config reads the environment at import time.
import assert from 'node:assert/strict';
import { appDb } from '../../src/db';
import { bankDb } from '../../simulator/db';
import { allChunks } from '../../src/retrieval/store';
import { embeddingKey, vectorBuffer } from '../../src/retrieval/embeddings';
import type { Chunk } from '../../src/types';
// Bank operations created so far, for one customer or all.
export const operations = (userId?: string) =>
  (
    (userId
      ? bankDb().prepare('SELECT COUNT(*) n FROM operations WHERE userId=?').get(userId)
      : bankDb().prepare('SELECT COUNT(*) n FROM operations').get()) as { n: number }
  ).n;
// Registers `query` so that its embedding is the vector of the first chunk matching `pick`.
export function queryLike(query: string, pick: (c: Chunk) => boolean) {
  const chunk = allChunks().find(pick);
  assert.ok(chunk, 'fixture chunk not found');
  appDb()
    .prepare('INSERT OR REPLACE INTO embedding_cache VALUES(?,?)')
    .run(embeddingKey(query), vectorBuffer(chunk.vector!));
  return query;
}
export function newConversation(userId: string) {
  const id = `conv-test-${Math.random().toString(36).slice(2)}`;
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(id, userId, 'Test', new Date().toISOString());
  return id;
}
