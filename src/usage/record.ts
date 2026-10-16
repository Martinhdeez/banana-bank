// TR1 (plan 27 D1–D3, D8, D9): one row of `ai_usage` per request the app makes to a model
// provider, written at once, as the request returns. Server only.
// - A write can never fail or delay a customer's request: recordUsage is synchronous, makes no
//   network call and never throws (one `usage_write_failed` log line per kind of failure).
// - No prompt, answer, tool argument or movement text is taken: tool NAMES and counts only.
// - Who pays travels in an AsyncLocalStorage scope; with none open the row is `system`, never
//   a customer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appDb, appDbOpen } from '../db';
import { config } from '../config';
import { log } from '../http';
import { costNanoUsd, priceFor } from './prices';

export const CONSUMERS = [
  'assistant',
  'operator_preview',
  'decider:systemone',
  'decider:openai',
  'embeddings',
  'voice',
] as const;
export type Consumer = (typeof CONSUMERS)[number];
type Scope = {
  actor: 'customer' | 'operator';
  userId: string;
  conversationId?: string;
  runId?: string;
};
const scopes = new AsyncLocalStorage<Scope>();
export const usageScope = <T>(scope: Scope, fn: () => T): T => scopes.run(scope, fn);
// A classification run records for its own customer: the open scope is kept (a chat turn: its
// conversation and run) only when it names that customer; otherwise a scope without conversation.
export function usageScopeFor<T>(userId: string, fn: () => T): T {
  const open = scopes.getStore();
  return open?.actor === 'customer' && open.userId === userId
    ? fn()
    : scopes.run({ actor: 'customer', userId }, fn);
}

// The hostname of a client's base URL: never a path, a query or credentials.
export function hostOf(baseUrl: string | undefined) {
  try {
    return new URL(baseUrl ?? '').hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}
export const openaiHost = () => hostOf(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
// A provider's count is untrusted: anything but a whole number from 0 is "not reported".
const count = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
// The usage block of an OpenAI Responses answer. Reasoning tokens are inside the output.
export const responseUsage = (
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number } | null;
        output_tokens_details?: { reasoning_tokens?: number } | null;
      }
    | null
    | undefined,
) => ({
  inputTokens: usage?.input_tokens,
  cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
  outputTokens: usage?.output_tokens,
  reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
});

const failures = new Set<string>();
export function recordUsage(r: {
  consumer: Consumer;
  model: string;
  host: string;
  outcome: 'ok' | 'failed';
  seq?: number;
  attempt?: number;
  tools?: string[];
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  providerCostUsd?: unknown; // `usage.cost` in US$, when the provider returns one: it wins
}): void {
  try {
    // No open database (an adapter used on its own, outside the app): nothing is created for it.
    if (config.aiUsage === 'off' || !appDbOpen()) return;
    const scope = scopes.getStore();
    const input = count(r.inputTokens),
      cached = count(r.cachedInputTokens),
      output = count(r.outputTokens);
    const price = priceFor(r.model);
    const reported =
      typeof r.providerCostUsd === 'number' &&
      Number.isFinite(r.providerCostUsd) &&
      r.providerCostUsd >= 0
        ? Math.round(r.providerCostUsd * 1e9)
        : null;
    const cost = reported ?? costNanoUsd({ input, cached, output }, price);
    appDb()
      .prepare(
        `INSERT INTO ai_usage(created_at,actor,user_id,conversation_id,run_id,consumer,seq,attempt,outcome,model,host,
          input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,tools,
          price_input,price_cached,price_output,price_source,cost_nano_usd,cost_basis)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        scope?.actor ?? 'system',
        scope?.userId ?? null,
        scope?.conversationId ?? null,
        scope?.runId ?? null,
        r.consumer,
        r.seq ?? 1,
        r.attempt ?? 1,
        r.outcome,
        String(r.model).slice(0, 120),
        r.host,
        input,
        cached,
        output,
        count(r.reasoningTokens),
        JSON.stringify(r.tools ?? []),
        price?.input ?? null,
        price?.cached ?? null,
        price?.output ?? null,
        price?.source ?? null,
        cost,
        reported !== null ? 'provider' : cost !== null ? 'estimated' : 'unpriced',
      );
  } catch (error) {
    try {
      const kind = String((error as { code?: unknown })?.code ?? (error as Error)?.name);
      if (failures.has(kind)) return;
      failures.add(kind);
      log('error', 'usage_write_failed', { kind, consumer: r.consumer });
    } catch {}
  }
}
