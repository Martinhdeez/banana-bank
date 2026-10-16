import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { appDb } from '../db';
import { config } from '../config';
import { openaiHost, recordUsage } from '../usage/record';
export const dimensions = 1536;
export function vectorBuffer(vector: number[]) {
  return Buffer.from(new Float32Array(vector).buffer);
}
export function readVector(buffer: Buffer) {
  return Array.from(
    new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  );
}
export function embeddingKey(text: string) {
  return createHash('sha256')
    .update(`${config.embeddingModel}:${dimensions}:text-v1:${text}`)
    .digest('hex');
}
export class MissingOpenAIKeyError extends Error {
  constructor() {
    super(
      'Set OPENAI_API_KEY in .env.local or the environment to use the agent and semantic search, then restart the services.',
    );
    this.name = 'MissingOpenAIKeyError';
  }
}
export function openai() {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new MissingOpenAIKeyError();
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2, timeout: 45000 });
}
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const db = appDb(),
    result: number[][] = new Array(texts.length),
    missing: { index: number; text: string; key: string }[] = [];
  texts.forEach((text, index) => {
    const key = embeddingKey(text),
      cached = db.prepare('SELECT vector FROM embedding_cache WHERE key=?').get(key) as
        { vector: Buffer } | undefined;
    if (cached) result[index] = readVector(cached.vector);
    else missing.push({ index, text, key });
  });
  for (let offset = 0; offset < missing.length; offset += 48) {
    const batch = missing.slice(offset, offset + 48);
    // TR1 (plan 27 §3, §5): one row per embeddings request, for whoever's request needed it (the
    // open usage scope; none = `system`, the index build). A cached text makes no request and has
    // no row. An embedding has no output tokens.
    const usage = { consumer: 'embeddings', host: openaiHost() } as const;
    const response = await openai()
      .embeddings.create({
        model: config.embeddingModel,
        input: batch.map((x) => x.text),
        dimensions,
        encoding_format: 'float',
      })
      .catch((e: unknown) => {
        recordUsage({ ...usage, outcome: 'failed', model: config.embeddingModel });
        throw e;
      });
    recordUsage({
      ...usage,
      outcome: 'ok',
      model: typeof response.model === 'string' ? response.model : config.embeddingModel,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: 0,
    });
    for (const item of response.data) {
      const target = batch[item.index];
      if (!target || item.embedding.length !== dimensions)
        throw new Error('Unexpected dimensions returned by the embeddings API.');
      result[target.index] = item.embedding;
      db.prepare('INSERT OR REPLACE INTO embedding_cache VALUES(?,?)').run(
        target.key,
        vectorBuffer(item.embedding),
      );
    }
    if (batch.some((x) => !result[x.index])) throw new Error('Incomplete embeddings response.');
  }
  return result;
}
