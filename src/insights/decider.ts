// SI3: one question for any provider: "which category is this movement, and how sure are you?"
// (plan 23, contracts.md §1 "Decider interface"). Server only. Walking the chain, applying the
// threshold and storing the answer belong to src/insights/classify.ts (SI4).
import { z } from 'zod';
import { config } from '../config';
import { log } from '../http';
import type { Candidate } from './taxonomy';
import { openaiDecider } from './deciders/openai';
import { systemOneDecider } from './deciders/systemone';

// Everything a provider is told about a movement: the cleaned description, as data, and labels.
// No amount, time, date, id or account can pass: unknown keys are stripped, values must match.
const stateSchema = z.object({
  description: z.string().regex(/^[A-Z0-9& ]{1,80}$/),
  direction: z.enum(['debit', 'credit']),
  typical_time: z.enum(['late_night', 'morning', 'midday', 'evening', 'mixed']),
  typical_day: z.enum(['weekday', 'weekend', 'mixed']),
  typical_amount: z.enum(['small', 'medium', 'large', 'mixed']),
  occurrences: z.enum(['once', 'few', 'recurring_monthly', 'frequent']),
});
export type DecisionState = z.infer<typeof stateSchema>;
// Computed over this merchant's movements (same merchant key and sign) in the current bank answer.
export type MerchantProfile = Omit<DecisionState, 'description' | 'direction'>;
export type DecisionItem = {
  key: string; // merchant key + sign; opaque to the decider, never sent
  description: string; // cleanDescription: upper case, [A-Z0-9& ], no run of digit-only tokens, ≤ 80 chars
  direction: 'debit' | 'credit';
  profile: MerchantProfile; // labels only, never raw numbers, times or dates
};
export type Decision = {
  candidates: Candidate[]; // p set; best first; categories from DECIDER_OPTIONS only
  confidence: number; // 0..1; what the threshold is compared with
  model: string; // the model id the provider reported; stored as `<decider id>:<model>`
};
export interface Decider {
  id: 'systemone' | 'openai';
  threshold: number; // 0..1, the bar for this decider
  classify(item: DecisionItem): Promise<Decision>; // one movement per call; throws DeciderError
}

// Two classes only. The message is built from the class and the status, never from a provider's
// text or a caught error, so no key, request body or description can travel in it.
export class DeciderError extends Error {
  retryable: boolean;
  status?: number;
  retryAfterS?: number;
  constructor(retryable: boolean, status?: number, retryAfterS?: number) {
    super(
      `Decider request failed (${status ?? 'no response'}, ${retryable ? 'retryable' : 'not retryable'}).`,
    );
    this.name = 'DeciderError';
    this.retryable = retryable;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}
// Retryable: 429, 5xx including 529, 408, and no status (timeout, network). Anything else is not.
export const retryableStatus = (status?: number) =>
  status === undefined || status === 408 || status === 429 || status >= 500;

// The six fields both adapters send. An item that is not cleaned text and labels is refused.
export function decisionState(item: DecisionItem): DecisionState {
  const state = stateSchema.safeParse({
    ...item.profile,
    description: item.description,
    direction: item.direction,
  });
  if (!state.success) throw new DeciderError(false);
  return state.data;
}

// At most `max` tasks at once; the others wait in order. A function declaration, so the adapters
// (imported above, and importing this module back) can call it while they load.
export function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // takes over a freed slot
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

let warnedNoOpenaiKey = false;
// The chain from the environment (contracts.md §5). `settings` is a seam for tests.
export function deciderChain(
  settings: Pick<typeof config, 'decider' | 'deciderApiKey'> = config,
): Decider[] {
  const { decider, deciderApiKey } = settings;
  const openaiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const chain: Decider[] = [];
  if (decider === 'systemone' || (decider === 'auto' && deciderApiKey))
    chain.push(systemOneDecider());
  if ((decider === 'openai' || decider === 'auto') && openaiKey) chain.push(openaiDecider());
  if (decider === 'openai' && !openaiKey && !warnedNoOpenaiKey) {
    warnedNoOpenaiKey = true;
    log('warn', 'decider_no_openai_key', { decider });
  }
  return chain;
}
