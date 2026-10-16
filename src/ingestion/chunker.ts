import { createHash } from 'node:crypto';
import type { Chunk, DocumentRecord } from '../types';
const MAX_CHUNK = 1200;
// Packs pieces (paragraphs or sentences) into groups of at most `max` characters.
function pack(pieces: string[], max: number, separator: string) {
  const groups: string[] = [];
  for (const piece of pieces) {
    const last = groups.at(-1);
    if (last !== undefined && last.length + separator.length + piece.length <= max)
      groups[groups.length - 1] = last + separator + piece;
    else groups.push(piece);
  }
  return groups;
}
// F4c — contract: "make its evidence traceable". Chunks follow the document's sections
// (Markdown headings) instead of fixed 650-char windows, so a fee or condition paragraph is
// never cut in half; oversized sections are packed by paragraph, then by sentence, up to
// MAX_CHUNK. Every chunk carries the document's title, version and validity, and its text
// starts with the title and section heading so it embeds with its product and context.
export function chunkDocument(doc: DocumentRecord, text: string): Chunk[] {
  const sections = text.split(/\n(?=#{1,6} )/).map((s) => s.trim());
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const heading = /^#{1,6} .*/.exec(section)?.[0] ?? '';
    const paragraphs = section
      .slice(heading.length)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) =>
        p.length <= MAX_CHUNK
          ? [p]
          : pack(
              p.match(/[^.!?]+(?:[.!?]+|$)/g)!.map((s) => s.trim()),
              MAX_CHUNK,
              ' ',
            ),
      );
    const prefix = [doc.title, heading.endsWith(doc.title) ? '' : heading]
      .filter(Boolean)
      .join('\n');
    for (const body of pack(paragraphs, MAX_CHUNK, '\n\n')) {
      const part = [prefix, body].filter(Boolean).join('\n\n');
      chunks.push({
        id: createHash('sha256')
          .update(`${doc.id}:${chunks.length}:${part}`)
          .digest('hex')
          .slice(0, 24),
        documentId: doc.id,
        text: part,
        title: doc.title,
        version: doc.version,
        validFrom: doc.validFrom,
        validTo: doc.validTo,
        audience: doc.audience,
      });
    }
  }
  return chunks;
}
