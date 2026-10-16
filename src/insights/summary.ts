// SI4: the spending summary (plan 23, contracts.md §3 "Totals"). Pure over one bank answer and
// its categories, so the dashboard's card and its rows come from the same read.
// SI5: what the customer changes (set category, rules, reclassify), shared by the HTTP routes and
// the agent tools. Server only. Every function takes the customer's current bank answer (`view`,
// from bankView): ids, signs and merchant keys come from it, never from the caller.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../auth';
import { appDb } from '../db';
import { recordEvent } from '../telemetry';
import type { ToolContext } from '../types';
import { movementWindow, when } from '../banking/movements';
import { activeDecider, classifyMovements, MADRID_MONTH, safe } from './classify';
import { merchantKey } from './normalize';
import { applyRules } from './rules';
import {
  askCounts,
  deleteCategories,
  fingerprint,
  removeUserRule,
  saveCategories,
  setUserRule,
  storedCategories,
  userRules,
} from './store';
import type { StoredCategory } from './store';
import { allowedFor, categoryLabel } from './taxonomy';
import type { Candidate, CategoryId, MovementInput, RowCategory } from './taxonomy';

export type SpendingSummary = {
  range: { from: string | null; to: string | null };
  window: { returned: number; oldestAt: string | null; mayBeTruncated: boolean };
  partial: boolean; // a requested `from` is earlier than window.oldestAt
  spentCents: number; // sum of categories[].spentCents
  incomeCents: number; // credits whose category is `income`
  categories: {
    id: CategoryId;
    label: string;
    spentCents: number; // |debits| minus refund credits in this category
    count: number;
    confirmedCents: number;
    estimatedCents: number; // sum = spentCents
  }[];
  unresolved: {
    count: number;
    totalCents: number;
    groups: {
      merchantKey: string;
      title: string;
      count: number;
      totalCents: number;
      movementIds: string[];
      candidates: Candidate[];
      reason: string;
      // IT6: a merchant with a payment and a refund in review has two groups of the same name.
      direction?: 'debit' | 'credit';
    }[];
  };
  pending: number;
  decider: 'systemone' | 'openai' | 'none';
};
type Category = SpendingSummary['categories'][number];
type Group = SpendingSummary['unresolved']['groups'][number];
const iso = (ms?: number) => (ms === undefined ? null : new Date(ms).toISOString());

export function spendingSummary(
  view: { movements: MovementInput[]; categories: ReadonlyMap<string, RowCategory> },
  range: { from?: number; to?: number }, // instants in ms, both inclusive
  decider: SpendingSummary['decider'],
): SpendingSummary {
  // The window is the whole bank answer. Its `limit` is left out: a bank may page below 100.
  const { returned, oldestAt, mayBeTruncated } = movementWindow(view.movements);
  const categories = new Map<CategoryId, Category>();
  const groups = new Map<string, Group>();
  let incomeCents = 0;
  let pending = 0;
  for (const m of view.movements) {
    const at = Date.parse(m.createdAt);
    if ((range.from !== undefined && at < range.from) || (range.to !== undefined && at > range.to))
      continue;
    const c = view.categories.get(m.id);
    // Still being classified (or never classified): counted, and in no total.
    if (!c || c.state === 'pending') {
      pending++;
      continue;
    }
    const debit = m.amountCents < 0;
    if (c.state === 'needs_review') {
      // No merchant key: a group of its own. IT5 (A15): else one group per key and sign, as the
      // pipeline decides, so a group can always be set whole (the sign rule is per movement).
      const id = c.merchantKey ? `${c.merchantKey}|${debit}` : `\n${m.id}`;
      const g = groups.get(id) ?? {
        merchantKey: c.merchantKey,
        title: c.merchantKey || m.description,
        count: 0,
        totalCents: 0,
        movementIds: [],
        candidates: c.candidates,
        reason: c.reason,
        direction: debit ? ('debit' as const) : ('credit' as const),
      };
      g.count++;
      g.totalCents += Math.abs(m.amountCents);
      g.movementIds.push(m.id);
      groups.set(id, g);
    }
    if (c.id === 'savings_internal') continue;
    if (c.id === 'income') {
      if (!debit) incomeCents += m.amountCents;
      continue;
    }
    // A credit in `other` (an opening row, a tax refund) is in no total; any other credit in a
    // spend category is a refund and lowers it.
    if (!debit && c.id === 'other') continue;
    const total = categories.get(c.id) ?? {
      id: c.id,
      label: categoryLabel(c.id),
      spentCents: 0,
      count: 0,
      confirmedCents: 0,
      estimatedCents: 0,
    };
    total.spentCents -= m.amountCents;
    total[c.state === 'confirmed' ? 'confirmedCents' : 'estimatedCents'] -= m.amountCents;
    total.count++;
    categories.set(c.id, total);
  }
  const sorted = [...categories.values()].sort((a, b) => b.spentCents - a.spentCents);
  const unresolved = [...groups.values()].sort((a, b) => b.totalCents - a.totalCents);
  return {
    range: { from: iso(range.from), to: iso(range.to) },
    window: { returned, oldestAt, mayBeTruncated },
    partial: range.from !== undefined && oldestAt !== null && range.from < Date.parse(oldestAt),
    spentCents: sorted.reduce((sum, c) => sum + c.spentCents, 0),
    incomeCents,
    categories: sorted,
    unresolved: {
      count: unresolved.reduce((sum, g) => sum + g.count, 0),
      totalCents: unresolved.reduce((sum, g) => sum + g.totalCents, 0),
      groups: unresolved,
    },
    pending,
    decider,
  };
}

// ---- IT8: the summary of one period (contracts.md §3 "Periods") ----

export type PeriodEntry = {
  id: string; // 'YYYY-MM' (Europe/Madrid) or 'all'
  label: string; // 'Oct 2026', 'All movements'
  count: number; // movements of the bank window in it
  partial: boolean;
  // `window`: the bank window is truncated and starts inside this month (for `all`: is truncated).
  // `in_progress`: the current month. `window` wins when both hold.
  partialReason?: Reason;
};
type Reason = 'window' | 'in_progress';
export type PeriodSummary = SpendingSummary & {
  // IT8c: 'all', a month 'YYYY-MM', a year 'YYYY' or a day range 'YYYY-MM-DD..YYYY-MM-DD'.
  period: string;
  today: string; // IT8c: the server's day in Europe/Madrid, 'YYYY-MM-DD'
  // IT8c: the days (Europe/Madrid) of the oldest and newest movement of the bank window. Not
  // inside `window`: a frozen check compares that object whole with the agent tool's.
  windowDays: { from: string | null; to: string | null };
  // IT8c: of the applied period, when it is not `all` (see `periodSummary`).
  partialReason?: Reason;
  periods: PeriodEntry[]; // months newest first, then `all`
  // The period's own part of the review list (`unresolved` itself is always the whole window).
  unresolvedInPeriod: { count: number; debitCents: number };
};
// IT8c: a movement's calendar day in Europe/Madrid ('YYYY-MM-DD'; its first 7 characters are
// MADRID_MONTH's month); null when the bank's date does not parse.
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayOf = (createdAt: string) => safe(() => MADRID_DAY.format(new Date(createdAt)));
const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  year: 'numeric',
});
const inPeriod = (u: SpendingSummary['unresolved']) => ({
  count: u.count,
  debitCents: u.groups.reduce((sum, g) => sum + (g.direction === 'debit' ? g.totalCents : 0), 0),
});

// `period=` of GET /api/dashboard and GET /api/insights/spending: `all`, `current` (this month in
// Europe/Madrid by the server clock), a month `YYYY-MM`, and since IT8c a year `YYYY` or a day
// range `YYYY-MM-DD..YYYY-MM-DD` (real calendar dates, from <= to). Absent: `all`.
// DS2 (contracts.md 2.30): `last`, the last full calendar month by the same clock, which is what
// the spending card opens on; like `current` it is answered as that month's id.
const PERIOD =
  /^(all|current|last|\d{4}|\d{4}-(0[1-9]|1[0-2])|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/;
// 2026-02-30 parses (as 2 March) and does not print back as itself.
const realDay = (day: string) =>
  safe(() => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10)) === day;
export function parsePeriod(search: URLSearchParams, now = new Date()): string {
  const given = search.getAll('period');
  const period = given[0] ?? 'all';
  const [from, to] = period.split('..');
  if (
    given.length > 1 ||
    !PERIOD.test(period) ||
    (to !== undefined && !(realDay(from) && realDay(to) && from <= to))
  )
    throw new HttpError(400, 'Invalid request data.');
  if (period !== 'current' && period !== 'last') return period;
  const month = MADRID_MONTH.format(now);
  if (period === 'current') return month;
  // Month 0 of a year is December of the year before.
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
}
// IT8c: the first and last day of a parsed period that is not `all`.
function daysOf(period: string): { from: string; to: string } {
  const [from, to] = period.split('..');
  if (to) return { from, to };
  if (period.length === 4) return { from: `${period}-01-01`, to: `${period}-12-31` };
  const [year, month] = period.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  return {
    from: `${period}-01`,
    to: `${period}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  };
}

// Every total is computed by spendingSummary over the movements of the period only, so the rules
// are the same. The window, the review groups and `pending` are those of the whole bank answer:
// sorting a merchant is not tied to a month, and the page reads again while anything is pending.
export function periodSummary(
  view: Parameters<typeof spendingSummary>[0],
  period: string,
  decider: SpendingSummary['decider'],
  now = new Date(),
  range: { from?: number; to?: number } = {}, // `all` only: from / to of /api/insights/spending
): PeriodSummary {
  const all = spendingSummary(view, range, decider);
  const today = MADRID_DAY.format(now);
  const current = today.slice(0, 7);
  const counts = new Map([[current, 0]]);
  const days = new Map<string, string>(); // movement id -> its day
  for (const m of view.movements) {
    const day = dayOf(m.createdAt);
    if (!day) continue;
    days.set(m.id, day);
    counts.set(day.slice(0, 7), (counts.get(day.slice(0, 7)) ?? 0) + 1);
  }
  const sorted = [...days.values()].sort();
  const windowDays = { from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
  const months = [...counts.keys()].sort().reverse();
  const truncated = all.window.mayBeTruncated;
  const entry = (id: string, label: string, count: number, reason?: Reason) => ({
    id,
    label,
    count,
    partial: !!reason,
    ...(reason && { partialReason: reason }),
  });
  const periods = [
    ...months.map((id) =>
      entry(
        id,
        MONTH_LABEL.format(new Date(`${id}-15T00:00:00Z`)),
        counts.get(id)!,
        truncated && id === months.at(-1) ? 'window' : id === current ? 'in_progress' : undefined,
      ),
    ),
    entry('all', 'All movements', all.window.returned, truncated ? 'window' : undefined),
  ];
  const added = { today, windowDays, periods };
  if (period === 'all')
    return { ...all, period, ...added, unresolvedInPeriod: inPeriod(all.unresolved) };
  const { from, to } = daysOf(period);
  const inside = (id: string) => days.has(id) && days.get(id)! >= from && days.get(id)! <= to;
  const part = spendingSummary(
    { ...view, movements: view.movements.filter((m) => inside(m.id)) },
    {},
    decider,
  );
  // IT8c: `window`: the bank returned a full page and the period reaches its oldest day or
  // before, so older movements of the period may be missing (that day's included). `in_progress`:
  // the period has not ended. `window` wins when both hold.
  const reason: Reason | undefined =
    truncated && windowDays.from !== null && from <= windowDays.from
      ? 'window'
      : to >= today
        ? 'in_progress'
        : undefined;
  return {
    ...part,
    range: { from, to },
    partial: !!reason,
    ...(reason && { partialReason: reason }),
    window: all.window,
    unresolved: all.unresolved,
    pending: all.pending,
    period,
    ...added,
    unresolvedInPeriod: inPeriod(part.unresolved),
  };
}

// ---- SI5 ----

type View = {
  accounts: { id: string }[];
  movements: MovementInput[];
  categories: ReadonlyMap<string, RowCategory>;
};
// Who changed it and through which channel; the agent tools pass their own context (SI6b).
export type Audit = { ctx: ToolContext; channel: 'ui' | 'chat' };
export const uiAudit = (userId: string): Audit => ({
  ctx: { userId, conversationId: null, runId: randomUUID(), intentId: randomUUID() },
  channel: 'ui',
});
export type SetCategoryResult = {
  updated: number; // movements changed, including similar ones
  similar: { merchantKey: string; count: number; movementIds: string[] }[];
  rules: string[]; // of the merchant keys in this call, those that have a rule after it
};

// Each movement with its category and the ids to send when changing it (RowCategoryOut).
export const withCategories = <M extends { id: string }>(view: {
  movements: M[];
  categories: ReadonlyMap<string, RowCategory>;
}) =>
  view.movements.map((m) => ({
    ...m,
    category: { ...view.categories.get(m.id)!, movementIds: [m.id] },
  }));

// `from` / `to` of GET /api/insights/spending, in the formats of /api/movements. An unknown or
// repeated key or a bad value is a 400 (the ZodError is answered as "Invalid request data.").
const rangeQuery = z.object({ from: when(false).optional(), to: when(true).optional() }).strict();
export function parseRange(search: URLSearchParams): { from?: number; to?: number } {
  const keys = [...search.keys()];
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 'Invalid request data.');
  const { from, to } = rangeQuery.parse(Object.fromEntries(search));
  if (from !== undefined && to !== undefined && from > to)
    throw new HttpError(400, 'The start date is after the end date.');
  return { from, to };
}

const sign = (m: MovementInput) => (m.amountCents < 0 ? 'debit' : 'credit');
const confirmed = (
  m: MovementInput,
  key: string,
  category: CategoryId,
  source: 'user' | 'user_rule',
): StoredCategory => ({
  movementId: m.id,
  fingerprint: fingerprint(m),
  merchantKey: key,
  id: category,
  state: 'confirmed',
  source,
  reason: source === 'user' ? 'user' : `user_rule:${key}`,
  confidence: null,
  threshold: null,
  candidates: [],
  model: null,
  updatedAt: new Date().toISOString(),
});
// Rules now, the deciders in the background: what a bank read does.
const classifyAgain = (userId: string, view: View) =>
  classifyMovements({
    userId,
    movements: view.movements,
    ownAccountIds: new Set(view.accounts.map((a) => a.id)),
  });

// contracts.md §3 "POST /api/insights/categories". All or nothing: an id outside the bank answer
// is a 404 and a category the sign forbids a 400 before anything is written; the rows, the rules
// and their audit events are one transaction. A repeat that changes nothing writes nothing.
export function setCategory(
  userId: string,
  view: View,
  input: { movementIds: string[]; category: CategoryId; applyToSimilar?: boolean },
  audit: Audit,
): SetCategoryResult {
  const { category, applyToSimilar = false } = input;
  const ids = new Set(input.movementIds);
  const chosen = view.movements.filter((m) => ids.has(m.id));
  if (chosen.length !== ids.size) throw new HttpError(404, 'Movement not found.');
  if (chosen.some((m) => !allowedFor(sign(m), category)))
    throw new HttpError(400, 'This category does not fit this movement.');

  const current = (id: string) => view.categories.get(id);
  const done = (m: MovementInput) =>
    current(m.id)?.id === category && current(m.id)?.state === 'confirmed';
  // IT5 (A6): would the customer's rule for this key decide this movement? Asked of the rules
  // themselves. A transfer (a counterparty fact, the banks' transfer wording, person wording) and
  // an opening row are decided by structure before any customer rule, so a rule made from one
  // would never apply, and its key would be text another party wrote.
  const own = new Set(view.accounts.map((a) => a.id));
  const legs = new Map<string, number>(); // own pairs, as classify.ts `settle` finds them
  for (const m of view.movements)
    if (m.operationId && own.has(m.accountId))
      legs.set(m.operationId, (legs.get(m.operationId) ?? 0) + 1);
  const ownPairOperationIds = new Set([...legs].filter(([, n]) => n === 2).map(([id]) => id));
  const ruled = (m: MovementInput, key: string) =>
    applyRules(m, {
      ownAccountIds: own,
      ownPairOperationIds,
      userRules: new Map([[key, category]]),
    })?.source === 'user_rule';
  // Per merchant key among the chosen movements a rule can decide, the signs chosen. No key, or
  // a movement decided by structure: no similar, no rule; the category is for that movement only.
  const signs = new Map<string, Set<string>>();
  for (const m of chosen) {
    const key = merchantKey(m.description);
    if (key && ruled(m, key)) signs.set(key, (signs.get(key) ?? new Set()).add(sign(m)));
  }
  // The other movements of the bank answer with that key and sign (a sign that passed the rule
  // above), not already that category and confirmed. Stored rows of vanished ids are not read.
  const similar = [...signs].map(([key, chosenSigns]) => ({
    key,
    movements: view.movements.filter(
      (m) =>
        !ids.has(m.id) &&
        merchantKey(m.description) === key &&
        chosenSigns.has(sign(m)) &&
        ruled(m, key) &&
        !done(m),
    ),
  }));
  const rules = userRules(userId);
  const newRules = applyToSimilar
    ? similar.map((s) => s.key).filter((key) => rules.get(key) !== category)
    : [];
  const rows = [
    ...chosen
      .filter((m) => !(done(m) && current(m.id)?.source === 'user'))
      .map((m) => confirmed(m, merchantKey(m.description), category, 'user')),
    ...(applyToSimilar
      ? similar.flatMap((s) => s.movements.map((m) => confirmed(m, s.key, category, 'user_rule')))
      : []),
  ];
  const { ctx, channel } = audit;
  appDb().transaction(() => {
    saveCategories(userId, rows);
    for (const r of rows) {
      const before = current(r.movementId);
      recordEvent(ctx, 'category.set', {
        channel,
        movementId: r.movementId,
        from: before && before.state !== 'pending' ? before.id : null,
        to: category,
        source: r.source,
      });
    }
    for (const key of newRules) {
      setUserRule(userId, key, category);
      recordEvent(ctx, 'rule.created', { channel, merchantKey: key, category });
    }
  })();
  return {
    updated: rows.length,
    similar: similar.map((s) => ({
      merchantKey: s.key,
      count: s.movements.length,
      movementIds: s.movements.map((m) => m.id),
    })),
    rules: [...signs.keys()].filter((key) => rules.has(key) || newRules.includes(key)),
  };
}

// contracts.md §3 "DELETE /api/insights/rules/:merchantKey": the rule goes, and the movements of
// the bank answer it classified are classified again. Movements set by hand (source `user`) stay.
export async function removeRule(userId: string, view: View, key: string, audit: Audit) {
  const category = userRules(userId).get(key);
  if (!category) return { removed: false, reclassified: 0 };
  const ids = view.movements
    .filter((m) => {
      const c = view.categories.get(m.id);
      return c?.source === 'user_rule' && c.merchantKey === key;
    })
    .map((m) => m.id);
  appDb().transaction(() => {
    removeUserRule(userId, key);
    deleteCategories(userId, ids);
    recordEvent(audit.ctx, 'rule.removed', { channel: audit.channel, merchantKey: key, category });
  })();
  await classifyAgain(userId, view);
  return { removed: true, reclassified: ids.length };
}

// contracts.md §3 "POST /api/insights/reclassify": the customer's "try again" for movements no
// decider could answer. Not a category change, so no audit event.
// IT4 (A2): the first "try again" for a merchant is immediate; once it was retried, a failure
// younger than a minute is left alone, so repeated posts cannot multiply the attempt budget.
// Rows and asks are read from the store here: a view read before another post's run is stale.
const RETRY_COOL_DOWN_MS = 60_000;
export async function reclassify(userId: string, view: View, now = () => new Date()) {
  const at = now().getTime();
  const rows = storedCategories(userId, view.movements);
  const since = new Date(at - 24 * 3600_000).toISOString();
  const asked = askCounts(userId, since);
  const item = (m: MovementInput) => `${rows.get(m.id)!.merchantKey}|${sign(m)}`;
  const again = view.movements.filter((m) => {
    const r = rows.get(m.id);
    if (r?.reason !== 'decider_unavailable') return false;
    const retried = (asked.get(item(m)) ?? 0) > 1;
    return !(retried && at - Date.parse(r.updatedAt) < RETRY_COOL_DOWN_MS);
  });
  if (!again.length) return { queued: 0 };
  deleteCategories(
    userId,
    again.map((m) => m.id),
  );
  await classifyAgain(userId, view);
  // With no decider the pipeline ran again for all of them (they are now `no_decider`).
  if (activeDecider() === 'none') return { queued: again.length };
  // IT7: with one, `queued` is the movements whose merchant was really sent, i.e. got a new ask.
  // One the daily budget left out is stored `decider_budget` and is not counted (the run takes
  // its budget before classifyAgain returns).
  const sent = askCounts(userId, since);
  const queued = again.filter((m) => (sent.get(item(m)) ?? 0) > (asked.get(item(m)) ?? 0)).length;
  return { queued };
}
