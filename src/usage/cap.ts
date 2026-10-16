// SC1: a daily AI spend cap per customer (AI_DAILY_CAP_USD, src/config.ts). Read from what TR1
// records, never stored: the day is the bank's (Europe/Madrid), so the cap lifts at its midnight.
// Server only. Unset: no cap, and the table is not read.
import { appDb } from '../db';
import { config } from '../config';
import { log } from '../http';
import { madridDayStart } from './report';

// A request with no cost (a model with no listed price) cannot count in dollars: such requests
// have their own fixed limit, in tokens a day (input + output).
export const UNPRICED_TOKENS_A_DAY = 1_000_000;
export const CAP_SENTENCE =
  'The assistant is not available for the rest of today. Your accounts, transfers and confirmations still work from the other tabs, and you can ask for human support here.';
// What a capped chat turn throws into its failed-turn path (src/agent/run.ts, turnFailure).
export class DailyCapError extends Error {
  sentence = CAP_SENTENCE;
  constructor() {
    super('The customer is at AI_DAILY_CAP_USD for today: no model request was made.');
  }
}

// True when the customer's own requests of today (actor `customer`: never an operator's or the
// system's) reached the limit in priced cost, or in unpriced tokens. Any error reading is "not
// capped": a cap read may never break a turn.
// No lock: turns that start together each pass the check, so the day can end over the limit by
// one turn per conversation open at that moment.
export function capState(userId: string, now = new Date()): boolean {
  const cap = config.aiDailyCapNanoUsd;
  if (cap === null) return false;
  try {
    const { cost, unpriced } = appDb()
      .prepare(
        `SELECT COALESCE(SUM(cost_nano_usd),0) cost,
           COALESCE(SUM(CASE WHEN cost_nano_usd IS NULL THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0) END),0) unpriced
         FROM ai_usage WHERE user_id=? AND created_at>=? AND actor='customer'`,
      )
      .get(userId, madridDayStart(now)) as { cost: number; unpriced: number };
    return cost >= cap || unpriced >= UNPRICED_TOKENS_A_DAY;
  } catch (error) {
    log('error', 'usage_cap_read_failed', { kind: (error as Error)?.name });
    return false;
  }
}
