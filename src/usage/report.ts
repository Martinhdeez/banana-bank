// TR1 (plan 27 §6): what GET /api/usage answers. Every figure is a SUM over the rows of
// `ai_usage`: no aggregate is stored. Operator only (the route checks). No field holds customer
// text: `ai_usage` stores none, and the neighbours are joined for ids, times and a status only
// (never a conversation title or a message).
import { appDb } from '../db';
import { config } from '../config';
import { person } from '../people';
import { csvField } from '../banking/movements';
import { priceTable } from './prices';
// SC1: cap.ts imports madridDayStart from this file; both sides are used inside functions only.
import { capState, UNPRICED_TOKENS_A_DAY } from './cap';
import type { Consumer } from './record';

export type Totals = {
  requests: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  // Whole nano-dollars (1e-9 US$). null: the group has requests and none of them has a price
  // ("Not priced", never zero). With `unpricedRequests` > 0 the sum is partial.
  costNanoUsd: number | null;
  providerNanoUsd: number; // the part of costNanoUsd the provider itself reported
  unpricedRequests: number; // no cost: no price for the model, or tokens not reported
  unreportedRequests: number; // the provider reported no input tokens (a failed request)
};
type Row = Record<string, any>;
const SUMS = `COUNT(*) requests, COALESCE(SUM(outcome='failed'),0) failed,
  COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_input_tokens),0) cachedInputTokens,
  COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
  COALESCE(SUM(cost_nano_usd),0) costNanoUsd,
  COALESCE(SUM(CASE WHEN cost_basis='provider' THEN cost_nano_usd END),0) providerNanoUsd,
  COALESCE(SUM(cost_basis='unpriced'),0) unpricedRequests,
  COALESCE(SUM(input_tokens IS NULL),0) unreportedRequests`;
const shape = <T extends Row>(r: T): T =>
  r.requests > 0 && r.unpricedRequests === r.requests ? { ...r, costNanoUsd: null } : r;
// ponytail: every query scans the period's rows (index on user_id and run_id only); add an index
// on created_at, or a daily aggregate, when the table outgrows a demo.
const sums = (where: string, params: unknown[]) =>
  shape(
    appDb()
      .prepare(`SELECT ${SUMS} FROM ai_usage u WHERE ${where}`)
      .get(...params) as Totals,
  );
const grouped = (key: string, where: string, params: unknown[], tail = '') =>
  (
    appDb()
      .prepare(
        `SELECT ${key} AS key, ${SUMS} FROM ai_usage u WHERE ${where} GROUP BY ${key} ORDER BY costNanoUsd DESC, requests DESC, key ${tail}`,
      )
      .all(...params) as (Totals & { key: string })[]
  ).map(shape);

// The period starts on a calendar day of Europe/Madrid, the day the spending periods of the app
// use (src/insights/summary.ts), never a UTC day. `today`: since that day's midnight; `7d`: today
// and the six days before it; `30d`: and the 29 before it; `all`: no bound. UP1: `range`, the
// Madrid days `from` to `to` (YYYY-MM-DD, `to` inclusive, not after today).
export const PERIODS = ['today', '7d', '30d', 'all', 'range'] as const;
export type Period = (typeof PERIODS)[number];
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const MADRID_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  hourCycle: 'h23',
});
export function madridDayStart(now: Date, daysBack = 0) {
  const [y, m, d] = MADRID_DAY.format(now).split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d - daysBack);
  // Madrid is UTC+1 or UTC+2: its midnight is 23:00 or 22:00 UTC of the day before.
  const start = [1, 2]
    .map((h) => new Date(utcMidnight - h * 3_600_000))
    .find((t) => MADRID_HOUR.format(t) === '00');
  return (start ?? new Date(utcMidnight - 3_600_000)).toISOString();
}
// `since` inclusive, `until` exclusive (null: open). null for a bad query: the route answers 400.
export type Window = {
  period: Period;
  since: string | null;
  until: string | null;
  from?: string;
  to?: string;
};
const DAYS_BACK = { today: 0, '7d': 6, '30d': 29 } as const;
const realDate = (s?: string) =>
  !!s &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(Date.parse(s)) &&
  new Date(s).toISOString().startsWith(s);
export function usageWindow(
  q: { period: Period; from?: string; to?: string },
  now = new Date(),
): Window | null {
  const { period, from, to } = q;
  if (period !== 'range') {
    if (from !== undefined || to !== undefined) return null;
    return {
      period,
      since: period === 'all' ? null : madridDayStart(now, DAYS_BACK[period]),
      until: null,
    };
  }
  if (!realDate(from) || !realDate(to) || from! > to! || to! > MADRID_DAY.format(now)) return null;
  // Noon UTC of a date is that same date in Madrid. The end is the next Madrid midnight, never
  // +24 h: a day of a DST change lasts 23 or 25 hours.
  const noon = (d: string) => new Date(`${d}T12:00:00Z`);
  return {
    period,
    since: madridDayStart(noon(from!)),
    until: madridDayStart(noon(to!), -1),
    from,
    to,
  };
}
const bound = ({ since, until }: Window): [string, unknown[]] =>
  since && until
    ? ['u.created_at>=? AND u.created_at<?', [since, until]]
    : since
      ? ['u.created_at>=?', [since]]
      : ['1', []];

const nameOf = (userId: string) => person(userId)?.name ?? userId;
const byConsumer = (where: string, params: unknown[]) =>
  grouped('u.consumer', where, params).map(({ key, ...t }) => ({
    consumer: key as Consumer,
    ...t,
  }));

export function usageOverview(window: Window, now = new Date()) {
  const [where, params] = bound(window);
  const customers = grouped('u.user_id', `${where} AND u.actor='customer'`, params, 'LIMIT 200');
  const priced = customers.reduce((sum, c) => sum + (c.costNanoUsd ?? 0), 0);
  return {
    enabled: config.aiUsage === 'on',
    ...window,
    firstRecordAt: appDb().prepare('SELECT MIN(created_at) FROM ai_usage').pluck().get() as
      string | null,
    totals: sums(where, params),
    // Customers only, by cost. `sharePct`: this customer's part of the customers' priced cost;
    // null when the customer has no priced request (unknown is not 0 %).
    byCustomer: customers.map(({ key, ...t }) => ({
      userId: key,
      name: nameOf(key),
      ...t,
      // SC1: at the daily cap now, today, whichever period was asked (false with no cap).
      // ponytail: one indexed read per listed customer (200 at most); one grouped query if it matters.
      capped: capState(key, now),
      sharePct:
        t.costNanoUsd === null || !priced ? null : Math.round((t.costNanoUsd / priced) * 1000) / 10,
    })),
    // Operator and system requests (preview, index build), outside the customers' shares.
    staffAndSystem: sums(`${where} AND u.actor<>'customer'`, params),
    byConsumer: byConsumer(where, params),
    // Counts only: a tool's result is part of the next request's input, so tokens are not split.
    byTool: appDb()
      .prepare(
        `SELECT j.value tool, COUNT(*) calls, COUNT(DISTINCT u.run_id) runs FROM ai_usage u, json_each(u.tools) j WHERE ${where} GROUP BY j.value ORDER BY calls DESC, tool`,
      )
      .all(...params) as { tool: string; calls: number; runs: number }[],
    prices: priceTable(),
    // SC1: the daily cap per customer and the instant both its measures count from; null = no cap.
    cap:
      config.aiDailyCapNanoUsd === null
        ? null
        : {
            dailyNanoUsd: config.aiDailyCapNanoUsd,
            unpricedTokens: UNPRICED_TOKENS_A_DAY,
            dayStart: madridDayStart(now),
          },
  };
}

// The newest support case of a conversation: the id the operator's case view opens.
const caseOf = (conversationId: string | null) =>
  conversationId
    ? ((appDb()
        .prepare(
          'SELECT id FROM incidents WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC',
        )
        .pluck()
        .get(conversationId) as string | undefined) ?? null)
    : null;

export function usageOfCustomer(userId: string, window: Window) {
  const [range, rangeParams] = bound(window);
  const where = `${range} AND u.actor='customer' AND u.user_id=?`,
    params = [...rangeParams, userId];
  const db = appDb();
  // ponytail: one query per conversation (at most 50); one joined query if this ever matters.
  const conversations = (
    db
      .prepare(
        `SELECT u.conversation_id conversationId, COALESCE(c.created_at, MIN(u.created_at)) startedAt,
           c.id IS NULL removed, COUNT(DISTINCT u.run_id) turns, ${SUMS}
         FROM ai_usage u LEFT JOIN conversations c ON c.id=u.conversation_id
         WHERE ${where} AND u.conversation_id IS NOT NULL
         GROUP BY u.conversation_id ORDER BY MAX(u.created_at) DESC LIMIT 50`,
      )
      .all(...params) as Row[]
  ).map((c) => ({
    ...shape(c),
    removed: !!c.removed, // the conversation was deleted (a reseed); its rows stay
    caseId: caseOf(c.conversationId),
    runs: (
      db
        .prepare(
          `SELECT u.run_id runId, COALESCE(r.started_at, MIN(u.created_at)) startedAt,
             COALESCE(r.status,'removed') status, ${SUMS}
           FROM ai_usage u LEFT JOIN runs r ON r.id=u.run_id
           WHERE ${where} AND u.conversation_id=?
           GROUP BY u.run_id ORDER BY MIN(u.created_at) DESC LIMIT 100`,
        )
        .all(...params, c.conversationId) as Row[]
    ).map(shape),
  }));
  return {
    ...window,
    customer: { userId, name: nameOf(userId) },
    totals: sums(where, params),
    byConsumer: byConsumer(where, params),
    // The spending card, the Overview and the document search: requests with no conversation.
    outsideChat: sums(`${where} AND u.conversation_id IS NULL`, params),
    conversations,
  };
}

// The requests of one chat turn, in order. Not bounded by a period: a turn is one moment.
export function usageOfRun(runId: string) {
  const rows = appDb()
    .prepare('SELECT * FROM ai_usage u WHERE u.run_id=? ORDER BY u.id LIMIT 50')
    .all(runId) as Row[];
  const first = rows[0];
  return {
    runId,
    actor: (first?.actor ?? null) as string | null,
    userId: (first?.user_id ?? null) as string | null,
    conversationId: (first?.conversation_id ?? null) as string | null,
    caseId: caseOf(first?.conversation_id ?? null),
    totals: sums('u.run_id=?', [runId]), // of every request of the run; `requests` lists 50 at most
    requests: rows.map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      consumer: r.consumer as Consumer,
      seq: r.seq as number,
      attempt: r.attempt as number,
      outcome: r.outcome as 'ok' | 'failed',
      model: r.model as string,
      host: r.host as string,
      inputTokens: r.input_tokens as number | null,
      cachedInputTokens: r.cached_input_tokens as number | null,
      outputTokens: r.output_tokens as number | null,
      reasoningTokens: r.reasoning_tokens as number | null,
      tools: JSON.parse(r.tools) as string[],
      costNanoUsd: r.cost_nano_usd as number | null,
      costBasis: r.cost_basis as 'estimated' | 'provider' | 'unpriced',
      priceInput: r.price_input as number | null,
      priceCached: r.price_cached as number | null,
      priceOutput: r.price_output as number | null,
      priceSource: r.price_source as string | null,
    })),
  };
}

// The case view: the usage of each chat run of a conversation, by run id.
export function usageByRun(conversationId: string) {
  return new Map(
    grouped('u.run_id', 'u.conversation_id=? AND u.run_id IS NOT NULL', [conversationId]).map(
      ({ key, ...t }) => [key, t as Totals],
    ),
  );
}

const CSV_HEADER =
  'customer_id,name,requests,failed,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_nano_usd,provider_nano_usd,unpriced_requests,unreported_requests,share_pct';
// The per-customer table of a period, then one `staff_and_system` line. An empty cost cell means
// "not priced". Same CSV rules as the movements export (BOM, CRLF, formula-safe text cells).
export function usageCsv(window: Window, now = new Date()) {
  const { byCustomer, staffAndSystem } = usageOverview(window, now);
  const line = (id: string, name: string, t: Totals, share: number | null) =>
    [
      csvField(id, true),
      csvField(name, true),
      t.requests,
      t.failed,
      t.inputTokens,
      t.cachedInputTokens,
      t.outputTokens,
      t.reasoningTokens,
      t.costNanoUsd ?? '',
      t.providerNanoUsd,
      t.unpricedRequests,
      t.unreportedRequests,
      share ?? '',
    ].join(',');
  const lines = [
    CSV_HEADER,
    ...byCustomer.map((c) => line(c.userId, c.name, c, c.sharePct)),
    line('staff_and_system', 'Staff and system', staffAndSystem, null),
  ];
  return `﻿${lines.map((l) => `${l}\r\n`).join('')}`;
}
