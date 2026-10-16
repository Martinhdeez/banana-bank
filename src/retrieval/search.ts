import { appDb } from '../db';
import { config, referenceDate } from '../config';
import { embedTexts } from './embeddings';
import { allChunks } from './store';
import type { Chunk, SearchResult } from '../types';
// F4b — contract: "rely on applicable documentation… Documents can contain historical
// versions". A document applies at `date` (YYYY-MM-DD, inclusive bounds) when it is already
// effective and not yet superseded; chunks without validity never apply.
export function appliesAt(c: Pick<Chunk, 'validFrom' | 'validTo'>, date: string) {
  return !!c.validFrom && c.validFrom <= date && (!c.validTo || date <= c.validTo);
}
export async function searchDocuments(
  query: string,
  role = 'customer',
  limit = 5,
  at = referenceDate,
  products: string[] = [],
): Promise<SearchResult[]> {
  const meta = appDb().prepare('SELECT value FROM meta WHERE key=?').get('index-model') as
    { value: string } | undefined;
  if (!meta) throw new Error('No document index. Run npm run setup or npm run ingest.');
  if (meta.value !== config.embeddingModel)
    throw new Error('The model does not match the index. Re-ingest the documents.');
  const [queryVector] = await embedTexts([query]);
  // A2 — contract: "make its evidence traceable". Several chunks of one document used to fill the
  // top N (procedure-2 took 4 of 5 slots); keep only each document's best chunk before the cut,
  // for the chat, the search_documents tool and POST /api/search alike.
  const seen = new Set<string>();
  const best = allChunks()
    .filter((c) => (role === 'operator' || c.audience === 'public') && appliesAt(c, at))
    .map(({ vector, ...c }) => {
      if (vector!.length !== queryVector.length)
        throw new Error('Incompatible embedding dimensions.');
      const score = vector!.reduce((sum, v, i) => sum + v * queryVector[i], 0);
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter((c) => !seen.has(c.documentId) && !!seen.add(c.documentId));
  return preferProducts(best, products).slice(0, limit);
}
// A3 — contract: "make its evidence traceable". When the same statement exists for several
// products (aurora-fees-2026 and horizon-fees-2026 both say internal transfers are free), the
// customer's own product document is the evidence to show. Its twin (same id, one segment
// replaced by the customer's product) is ranked just before the best-scoring twin; the other
// product's document is kept and scores are not changed, so a question about another product
// still finds its document.
function preferProducts<T extends { documentId: string; score: number }>(
  ranked: T[],
  products: string[],
) {
  if (!products.length) return ranked;
  const mine = (id: string) => id.split('-').some((s) => products.includes(s));
  const twins = (other: string, own: string) => {
    const a = other.split('-'),
      b = own.split('-');
    const diff = a.flatMap((s, i) => (s === b[i] ? [] : [i]));
    return (
      a.length === b.length &&
      diff.length === 1 &&
      products.includes(b[diff[0]]) &&
      !products.includes(a[diff[0]])
    );
  };
  const rank = new Map(ranked.map((r) => [r.documentId, r.score]));
  for (const own of ranked)
    for (const other of ranked)
      if (twins(other.documentId, own.documentId))
        rank.set(own.documentId, Math.max(rank.get(own.documentId)!, other.score));
  return [...ranked].sort(
    (x, y) =>
      rank.get(y.documentId)! - rank.get(x.documentId)! ||
      Number(mine(y.documentId)) - Number(mine(x.documentId)),
  );
}
