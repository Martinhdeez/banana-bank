// GL3 (plan 28 §4.5, D1, D10; REQ-PL-26): the month forecast in the chat. One read-only tool over
// src/forecast/month.ts, the function the dashboard runs, so the model states the server's
// figures and its fixed sentences ("An estimate.") and never a forecast of its own. Chat only.
// Privacy (plan 28 §13): the label of a charge the customer added by hand is their own free text
// and goes to no model. The result is built field by field (never the forecast object itself):
// such an item keeps its amount and date and is named "a payment you added".
import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { preparedList, today } from '../banking/prepared';
import { adjustmentsOf, preparedGoals, preparedOperationIds } from '../forecast/adjustments';
import {
  monthForecast,
  type ForecastInput,
  type MonthForecast,
  type RegularItem,
} from '../forecast/month';
import type { ToolContext } from '../types';
import { runView } from './insights';
import { money } from '../ui-helpers';

// GL4: a live model read 23079 cents as "23.079 €". Every `…Cents` number of a result gets a
// `…Euros` string beside it in the app's format; the cents stay for the chat's goal card.
export function withEuros<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withEuros) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) =>
      /Cents$/.test(key) && typeof v === 'number'
        ? [
            [key, v],
            [key.replace(/Cents$/, 'Euros'), money(v)],
          ]
        : [[key, withEuros(v)]],
    ),
  ) as T;
}

// The dashboard's forecast for a customer, from a bank view already read. `day`: today in Madrid.
export const forecastOf = (
  userId: string,
  view: { accounts: unknown[]; movements: ForecastInput['movements'] },
  day = today(),
): MonthForecast =>
  monthForecast({
    accounts: view.accounts as ForecastInput['accounts'],
    movements: view.movements,
    prepared: preparedList(userId),
    adjustments: adjustmentsOf(userId),
    preparedOperationIds: preparedOperationIds(userId), // RG1
    goals: preparedGoals(userId), // RG1b
    today: day,
  });

const YOURS = 'a payment you added';
// GL3 review: `excluded_by_you` is not one of them. Its text is the name of a key the client
// sent (`POST /api/forecast/adjustments` checks its form, not that a usual item has it), so it
// can be the customer's own words: it gets a fixed sentence too.
const SERVER_REASONS = new Set(['paused', 'no_date', 'irregular']);
const yours = (e: { source: string }) => e.source === 'expected_by_you';
// FC2 (review): an observation told in the chat is worked out without what the customer added,
// so its figure can differ from this one. Said here by the server; the model reconciles nothing.
const ADDED_NOTE =
  'These figures count payments the customer added to their month ahead. A shortfall told earlier in this chat as an observation does not count them, so the two figures can differ: state each as it is, say that this one includes payments the customer added, and work out no figure of your own.';
const regularForModel = (r: RegularItem) => ({
  label: r.source !== 'added_by_you' ? r.label : r.amountCents > 0 ? 'an income you added' : YOURS,
  amount: money(Math.abs(r.amountCents)),
  usualDay: r.usualDay,
  source: r.source,
  thisMonth: r.thisMonth,
  ...(r.nextDue && { nextDue: r.nextDue }), // RG1b: a prepared transfer's next payment
});
// What the model may read of a forecast.
export function forecastForModel(f: MonthForecast) {
  return {
    today: f.today,
    until: f.until,
    accounts: f.accounts.map((a) => {
      const mine = a.events.filter(yours);
      const s = a.shortfall;
      // The server's sentence names every estimated item counted up to the shortfall: with one of
      // the customer's own among them it is replaced by one that holds no label.
      const named = !!s && mine.some((e) => e.date <= s.date);
      return {
        id: a.id,
        label: a.label,
        balanceCents: a.balanceCents,
        endCents: a.endCents,
        lowest: a.lowest,
        headline: a.headline,
        explanation: named ? `${a.headline}, counting ${YOURS}. An estimate.` : a.explanation,
        shortfall: s && {
          date: s.date,
          shortCents: s.shortCents,
          certainty: s.certainty,
          // Passed on only in the server's two own forms; anything else may hold a label.
          forLabel:
            !/, added by you$/.test(s.forLabel) &&
            /^your prepared transfer to |, a usual charge$/.test(s.forLabel)
              ? s.forLabel
              : YOURS,
        },
        events: a.events.map((e) => ({
          date: e.date,
          label: yours(e) ? YOURS : e.label,
          amountCents: e.amountCents,
          balanceAfterCents: e.balanceAfterCents,
          source: e.source,
          certainty: e.certainty,
          ...(e.note && { note: e.note }),
        })),
        coverOptions: a.options.map((o) => ({ title: o.title, consequence: o.consequence })),
        // RG1: what comes every month, compact. An item the customer added keeps no label.
        regular: {
          income: a.regular.income.map(regularForModel),
          charges: a.regular.charges.map(regularForModel),
          irregularSpendPerMonth: a.regular.irregularSpend
            ? money(a.regular.irregularSpend.monthlyCents)
            : null,
        },
        // RG1b: the first 7 days of next month, listed only (no balance is projected there).
        nextMonth: a.nextMonth.map((n) => ({
          date: n.date,
          label: n.adjustmentId ? (n.amountCents > 0 ? 'an income you added' : YOURS) : n.label,
          amount: money(n.amountCents),
        })),
      };
    }),
    notCounted: f.notCounted.map((n) =>
      SERVER_REASONS.has(n.reason)
        ? n.text
        : n.reason === 'excluded_by_you'
          ? 'A usual payment you left out: not counted.'
          : `${YOURS}: already counted once, not counted twice.`,
    ),
    notes: f.notes,
    sourceLine: f.sourceLine,
    ...(f.adjustments.some((a) => a.kind === 'expect') && { addedByCustomer: ADDED_NOTE }),
  };
}

// PA1: right after prepare_transfer or create_goal saved a transfer, the forecast of the account
// the money leaves, with it counted: the get_month_forecast figures, cut to what the answer says.
// undefined when it cannot be worked out (a bank read failed, too little history read): the
// save's result never depends on it.
export async function afterThis(ctx: ToolContext, accountId: string) {
  try {
    const f = forecastOf(ctx.userId, await runView(ctx.userId, ctx.runId));
    if (f.history.months === null && f.history.reason === 'window_short') return undefined;
    const a = forecastForModel(f).accounts.find((x) => x.id === accountId);
    if (!a) return undefined;
    if (!a.shortfall) return { covered: true, headline: a.headline };
    const { date, shortCents, forLabel } = a.shortfall;
    const o = f.accounts.find((x) => x.id === accountId)!.options[0];
    return {
      shortfall: withEuros({ date, shortCents, forLabel, explanation: a.explanation }),
      // `prepareWith`: the cover's prepare_transfer arguments. Stored with the answer
      // (extras.coverOffer) for prepare_cover after a yes; the model never passes it.
      cover: o
        ? {
            title: o.title,
            consequence: o.consequence,
            prepareWith: { ...o.prepare, recipient: null, note: null, inDays: null, day: null },
          }
        : null,
    };
  } catch {
    return undefined;
  }
}

export const forecastToolDefinitions: FunctionTool[] = [
  {
    type: 'function',
    name: 'get_month_forecast',
    description:
      "The server's forecast of each of the customer's accounts to the end of this month: its verdict (headline and explanation), a shortfall if any, what is still to come (prepared transfers, which are certain, and usual charges and income, which are estimates) and a way to cover a shortfall. It also lists each account's regular income and regular charges (found by the rules in the last three full months or added by the customer as monthly, already paid this month or not) and its average irregular spend per month: use them for questions about fixed or regular payments. Monthly prepared transfers, savings goals' included, are among the regular items (source prepared, with their next payment); nextMonth lists what falls in the first 7 days of next month, as listed payments only. Read-only. An estimate by fixed rules, never a promise.",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];
export const forecastTools: Record<string, (args: unknown, ctx: ToolContext) => Promise<object>> = {
  async get_month_forecast(args, ctx) {
    z.object({}).strict().parse(args);
    const view = await runView(ctx.userId, ctx.runId);
    return {
      status: 'ok',
      ...forecastForModel(forecastOf(ctx.userId, view)),
      notice:
        'The server\'s figures and sentences. State a headline only with its explanation, in the same words, and keep "estimate" wherever it is. Add no figure, cause or advice of your own.',
    };
  },
};

// One line of the chat instructions (run.ts). Fixed text, no customer data.
export const forecastInstructions = `
Month forecast: when the customer asks whether they will make it to the end of the month, whether an account will go short or what is still to come this month, call get_month_forecast. State each account's headline together with its explanation, in the same words in the customer's language, and keep the word "estimate" wherever the result has it. It is the server's estimate and no forecast of your own: add no figure, no cause, no advice and no promise, and say nothing about the months after this one beyond the nextMonth lines of the result, stated as listed payments with no balance of your own. If the result lists a cover option, you may say that it exists: it is prepared on the Plan page, or with prepare_transfer only when the customer asks you to prepare it, and nothing is sent until they send and confirm it.`;
