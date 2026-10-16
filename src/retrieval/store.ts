import { randomUUID } from 'node:crypto';
import { appDb } from '../db';
import { config } from '../config';
import { vectorBuffer, readVector, embeddingKey } from './embeddings';
import type { Chunk } from '../types';
type IndexDump = {
  format: 1;
  model: string;
  dimensions: number;
  chunks: (Omit<Chunk, 'vector'> & { vectorBase64: string })[];
};
export function replaceChunks(chunks: Chunk[], settings: { model: string; dimensions: number }) {
  const db = appDb();
  db.transaction(() => {
    db.exec('DELETE FROM chunks');
    const insert = db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)');
    for (const c of chunks) {
      if (c.vector?.length !== settings.dimensions) throw new Error('Incomplete index.');
      insert.run(
        c.id,
        c.documentId,
        c.text,
        c.title,
        c.version,
        c.validFrom,
        c.validTo,
        c.audience,
        vectorBuffer(c.vector),
      );
    }
    db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('index-model', settings.model);
    db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('index-version', randomUUID());
    db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(
      'index-dimensions',
      String(settings.dimensions),
    );
  })();
  cache = undefined;
}
// K3: decoding every vector on every search was most of its cost. Decoded chunks are kept per
// index version (meta 'index-version', new on every replaceChunks), so an ingest or reset in this
// or another process is picked up on the next read. Callers must not mutate the returned chunks.
let cache: { version: string; chunks: Chunk[] } | undefined;
const row = (r: any): Chunk => ({
  id: r.id,
  documentId: r.document_id,
  text: r.text,
  title: r.title,
  version: r.version,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  audience: r.audience,
});
export function allChunks(): Chunk[] {
  const db = appDb();
  const version = (
    db.prepare("SELECT value FROM meta WHERE key='index-version'").get() as
      { value: string } | undefined
  )?.value;
  if (version && cache?.version === version) return cache.chunks;
  const chunks = (db.prepare('SELECT * FROM chunks ORDER BY id').all() as any[]).map((r) => ({
    ...row(r),
    vector: readVector(r.vector),
  }));
  cache = version ? { version, chunks } : undefined;
  return chunks;
}
// K3: one document's chunks without their vectors (GET /api/documents/:id/chunks).
export function documentChunks(documentId: string): Chunk[] {
  return (
    appDb()
      .prepare(
        'SELECT id,document_id,text,title,version,valid_from,valid_to,audience FROM chunks WHERE document_id=? ORDER BY id',
      )
      .all(documentId) as any[]
  ).map(row);
}
export function exportIndex(): IndexDump {
  const db = appDb();
  const model = (
    db.prepare('SELECT value FROM meta WHERE key=?').get('index-model') as { value: string }
  ).value;
  const dimensions = Number(
    (db.prepare('SELECT value FROM meta WHERE key=?').get('index-dimensions') as { value: string })
      .value,
  );
  return {
    format: 1,
    model,
    dimensions,
    chunks: allChunks().map(({ vector, ...c }) => ({
      ...c,
      vectorBase64: vectorBuffer(vector!).toString('base64'),
    })),
  };
}
export function restoreIndex(index: IndexDump) {
  if (index.format !== 1 || index.model !== config.embeddingModel)
    throw new Error('The initial index uses a different model. Run npm run ingest.');
  const chunks = index.chunks.map(({ vectorBase64, ...c }) => ({
    ...c,
    vector: readVector(Buffer.from(vectorBase64, 'base64')),
  }));
  replaceChunks(chunks, { model: index.model, dimensions: index.dimensions });
  const db = appDb();
  db.transaction(() => {
    for (const c of chunks)
      db.prepare('INSERT OR REPLACE INTO embedding_cache VALUES(?,?)').run(
        embeddingKey(c.text),
        vectorBuffer(c.vector),
      );
  })();
}
