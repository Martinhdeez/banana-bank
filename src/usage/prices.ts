// TR1 (plan 27 §4, D4–D6): what a token costs. DEFAULTS with their source and the date they were
// read; `AI_PRICES` (src/config.ts) overrides a model. A price is whole nano-dollars per token,
// the same number as US$ per billion tokens (US$ per million × 1000), so a cost is exact integer
// arithmetic. A model with no price has no cost: never zero, never another model's price.
import { config, type ModelPrice } from '../config';

export type Price = ModelPrice & { source: string };
// Both pages were read on 2026-10-05 through a page fetch (a tool that returns the page's text),
// not by hand in a browser. The long-context rate of the chat model is not applied: a response
// does not say which tier was billed, and a chat turn is far below it.
const OPENAI =
  'OpenAI pricing page (developers.openai.com/api/docs/pricing), Standard tier, read 2026-10-05';
const TYPESAFE =
  'Typesafe models page (docs.typesafe.ai/models: $42 per billion tokens, output tokens are free), read 2026-10-05';
// VC1: both pages read on 2026-10-07 through a page fetch. The model page lists these rates for
// its audio tokens; the pricing page's "Transcription models" row gives the same pair.
const OPENAI_TRANSCRIBE =
  'OpenAI pricing page (developers.openai.com/api/docs/pricing, Transcription models) and model page (developers.openai.com/api/docs/models/gpt-4o-mini-transcribe, Audio tokens), read 2026-10-07';
const DEFAULTS: Record<string, Price> = {
  'gpt-6-luna': { input: 100, cached: 10, output: 500, source: OPENAI },
  'text-embedding-3-small': { input: 20, cached: null, output: 0, source: OPENAI },
  'gpt-4o-mini-transcribe': { input: 1250, cached: null, output: 5000, source: OPENAI_TRANSCRIBE },
  'jev-1.13': { input: 42, cached: null, output: 0, source: TYPESAFE },
  'typesafe/jev-1.13': { input: 42, cached: null, output: 0, source: TYPESAFE },
};

// Every listed price, the setting's entries over the defaults (GET /api/usage shows them).
export function priceTable(overrides = config.aiPrices): (Price & { model: string })[] {
  const all: Record<string, Price> = { ...DEFAULTS };
  for (const [model, p] of Object.entries(overrides))
    all[model] = { ...p, source: 'AI_PRICES setting' };
  return Object.entries(all).map(([model, p]) => ({ model, ...p }));
}
// The exact id, else the longest listed prefix (`gpt-6-luna-2026-09-01` → `gpt-6-luna`).
export function priceFor(model: string, overrides = config.aiPrices): Price | null {
  const match = priceTable(overrides)
    .filter((p) => model.startsWith(p.model))
    .sort((a, b) => b.model.length - a.model.length)[0];
  if (!match) return null;
  return {
    input: match.input,
    cached: match.cached,
    output: match.output,
    source: match.source,
  };
}
// (input − cached) × input rate + cached × cached rate + output × output rate. Reasoning tokens
// are part of the output and are not added again. null = not priced: no price, a count the
// provider did not report (a missing output is no obstacle when output is free), cached > input,
// or cached tokens with no cached rate.
export function costNanoUsd(
  tokens: { input?: number | null; cached?: number | null; output?: number | null },
  price: ModelPrice | null,
): number | null {
  if (!price) return null;
  const { input, output } = tokens,
    cached = tokens.cached ?? 0;
  if (input == null || (output == null && price.output !== 0)) return null;
  if (cached > input || (cached > 0 && price.cached === null)) return null;
  return (
    (input - cached) * price.input + cached * (price.cached ?? 0) + (output ?? 0) * price.output
  );
}
