import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../config';
import type { Chunk, DocumentRecord } from '../types';
import { chunkDocument } from './chunker';
import { embedTexts, dimensions } from '../retrieval/embeddings';
import { replaceChunks, exportIndex } from '../retrieval/store';
export function documents(): DocumentRecord[] {
  return JSON.parse(fs.readFileSync(path.resolve('fixtures/documents/manifest.json'), 'utf8'));
}
const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
// F4g — contract: "Documents can contain historical versions and third-party content".
// Only text a reader sees is indexed: comments, style/script blocks and hidden elements are
// dropped (hidden text is an injection vector), block boundaries become line breaks so
// headings and paragraphs survive for chunking (F4c), and entities are decoded.
// ponytail: regex, not a DOM parser — a hidden element nesting the same tag is cut at the
// first closing tag; switch to a real parser if untrusted HTML is ever ingested.
export function htmlToText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(
      /<(\w+)\b[^>]*?(\shidden\b|aria-hidden\s*=\s*["']?true|display\s*:\s*none|visibility\s*:\s*hidden)[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) =>
      code[0] !== '#'
        ? (entities[code.toLowerCase()] ?? all)
        : String.fromCodePoint(
            code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
          ),
    )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// F4c — CSV notices (`section,content`, quoted multi-line cells) are read as their content
// column, one paragraph block per row, so headings and fee paragraphs are chunkable.
function csvContent(csv: string) {
  const rows: string[][] = [[]];
  let cell = '',
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (rows.at(-1)!.push(cell), (cell = ''));
    else if (ch === '\n') (rows.at(-1)!.push(cell), rows.push([]), (cell = ''));
    else cell += ch;
  }
  rows.at(-1)!.push(cell);
  const column = rows[0].indexOf('content');
  return rows
    .slice(1)
    .map((r) => (r[column] ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}
export function readDocument(doc: DocumentRecord) {
  const root = path.resolve('fixtures/documents');
  const filename = path.resolve(root, doc.file);
  if (!filename.startsWith(root + path.sep)) throw new Error('Invalid document path.');
  let text = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  if (filename.endsWith('.html')) text = htmlToText(text);
  if (filename.endsWith('.csv')) text = csvContent(text);
  return text;
}
export async function ingest(onProgress: (value: string) => void = () => {}) {
  const docs = documents();
  const chunks: Chunk[] = docs.flatMap((doc) => chunkDocument(doc, readDocument(doc)));
  onProgress(`${docs.length} documents · ${chunks.length} chunks`);
  const vectors = await embedTexts(chunks.map((c) => c.text));
  const complete = chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
  replaceChunks(complete, { model: config.embeddingModel, dimensions });
  onProgress('Index updated.');
  return {
    documents: docs.length,
    chunks: complete.length,
    model: config.embeddingModel,
    dimensions,
  };
}
export function saveInitialIndex() {
  fs.mkdirSync('fixtures/embeddings', { recursive: true });
  fs.writeFileSync('fixtures/embeddings/index.json.gz', gzipSync(JSON.stringify(exportIndex())));
}
