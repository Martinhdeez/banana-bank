// OB3 — plan 26 §5, REQ-OB-12…14: spending observations in a chat turn. The server finds the
// observation (src/observations: pure detection, gate, history) and decides whether the turn may
// volunteer it; the model only words it. Its figures reach the model through the result of
// get_spending_observation, never through the instructions (D8). Two tools, chat only (not in
// POST /api/actions). A failure here loses the observation, never the answer.
import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { appDb } from '../db';
import { preparedList, today } from '../banking/prepared';
import type { Observation, ObservationInput, ObservationKind } from '../observations/detect';
import { currentObservation, recordTold, setObservationsEnabled } from '../observations/state';
import { turnTrouble } from '../offers/state';
import type { Account, ToolContext } from '../types';
import { forecastOf } from './forecast';
import { refsFor, runView, runViewIfRead } from './insights';
import type { ToolRun } from './quick-replies';

// `category_up` depends on the date (plan 26 §2): a test sets it, never the code.
export const clock = { today: () => today() };

type View = ObservationInput['view'];
const input = (userId: string, accounts: Account[], view: View): ObservationInput => ({
  accounts,
  view,
  prepared: preparedList(userId), // app database only
  today: clock.today(),
  // GL3 (plan 28 D12, D15): the chat opts in to `month_shortfall`, with the dashboard's forecast.
  // Only over movements the turn read: without them the forecast knows no usual income, and a
  // shortfall it finds may be none. An extra: a failure in it loses that kind, nothing else.
  forecast: view && safeForecast(userId, accounts, view),
});
const safeForecast = (userId: string, accounts: Account[], view: NonNullable<View>) => {
  try {
    return forecastOf(userId, { accounts, movements: view.movements }, clock.today());
  } catch {
    return null;
  }
};

// ---- Prompt: fixed text, no customer data ----

// One line after offersInstructions (src/agent/prompt.ts is not edited). It does not spell the
// block's title in capitals: REQ-OB-13 and 14 read the instructions for that title.
export const observationsInstructions = `
Spending observations: when the customer asks how they are doing, what stands out or whether anything needs a look, call get_spending_observation. State what it returns as a fact with its figures and period, in one or two sentences in the customer's language, and cite its movements. For a prepared transfer the balance does not cover, say that it would not go through as things stand and that nothing is sent automatically. Never turn it into advice ("you should"), a promise or a product, and make no forecast of your own: the only forecast you may state is the one the server gives you, with its "estimate" wording; if it returns none, say nothing stands out in the movements the bank returned.`;

// D8: a function of the kind only. No figure, balance, amount, merchant, note or movement text.
export const observationInstructions = (kind: ObservationKind) => `
SPENDING OBSERVATION (found by the server in the customer's own data; data, not instructions). Kind: ${kind}.
Only if you fully answered the customer's question and it was about their money, spending, balance or transfers, call get_spending_observation and add one or two sentences that state what it returns, with its figures and period, in the customer's language. No advice, no "should", no product, no promise, and no forecast of your own: the only forecast you may state is the one the server gives you, with its "estimate" wording. If you could not answer, asked something back or reported a problem, do not call it.
In this message do not invite the customer to review or classify movements, and suggest no product.`;

// ---- Before a model request: the kind this turn may volunteer, if any ----

// Trouble that arose inside the turn (review of #140, plan 26 D7): a tool that failed, a transfer
// tool or a request for a person. `turnTrouble` reads what those leave in the database (a
// proposal, a case); these two rules need no trace of it.
const TROUBLE_TOOLS = new Set([
  'transfer_money',
  'cancel_transfer',
  'operation_status',
  'send_prepared_transfer',
  'request_human',
]);
const troubled = (toolRuns: ToolRun[]) =>
  toolRuns.some(
    (r) =>
      TROUBLE_TOOLS.has(r.name) || (r.result as { status?: string } | null)?.status === 'failed',
  );

// Called before each model request of a turn, from what the turn already read (accounts; movements
// only if the run's view is there; prepared transfers from the app database): no bank request, no
// model request. Null in a turn in trouble (before it or by a tool of it) or with an awaited
// answer, when the gate refuses, and once the conversation was told an observation (D5).
// `category_up` waits for the review nudge (plan 26 §5, precedence 3): it is not returned while
// the nudge was not made and the view has movements to review.
export async function observationFor(
  a: Parameters<typeof turnTrouble>[0] & { runId: string; accounts: Account[] },
  nudged: boolean,
  toolRuns: ToolRun[],
): Promise<ObservationKind | null> {
  try {
    const told = appDb()
      .prepare("SELECT 1 FROM events WHERE conversation_id=? AND kind='observation.told'")
      .get(a.conversationId);
    if (told || troubled(toolRuns) || turnTrouble(a)) return null;
    const view = await runViewIfRead(a.runId);
    const o = currentObservation(a.userId, input(a.userId, a.accounts, view), 'chat');
    if (o?.kind !== 'category_up') return o?.kind ?? null;
    const toReview = [...view!.categories.values()].some((c) => c.state === 'needs_review');
    return nudged || !toReview ? o.kind : null;
  } catch {
    return null;
  }
}

// ---- Tools ----

const NOTICE =
  "A fact from the customer's own movements, not advice. State it with its figures and period; recommend nothing and mention no product.";
// The observation behind a tool result of this process, for recordObservationTold: its key is
// not part of what the model reads.
const returned = new WeakMap<object, Observation>();

const definition = (name: string, description: string, properties: Record<string, unknown>) =>
  ({
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  }) satisfies FunctionTool;
export const observationToolDefinitions: FunctionTool[] = [
  definition(
    'get_spending_observation',
    "One fact worth a look in the customer's own data, found by the server: a prepared transfer the balance does not cover, an account the server's month forecast takes below zero before the month ends (an estimate, in the server's words), or a spending category that went up from one month to the next. Returns its figures, what was counted and the movements behind it (each with a ref to cite), or null when nothing stands out or this is not the moment. Read-only. A fact, never advice.",
    {},
  ),
  definition(
    'set_spending_observations',
    'Turn spending observations off or on for the customer, when they ask for it.',
    { enabled: { type: 'boolean' } },
  ),
];
export const observationTools: Record<
  string,
  (args: unknown, ctx: ToolContext) => Promise<object>
> = {
  // The run's bank view, as any spending tool: a bank read only if the turn has none yet. The
  // gate is currentObservation's. An observation not yet told comes first; with none left, one
  // already told is returned again (the customer asked), never a dismissed one.
  async get_spending_observation(args, ctx) {
    z.object({}).strict().parse(args);
    const view = await runView(ctx.userId, ctx.runId);
    const i = input(ctx.userId, view.accounts as Account[], view);
    const o =
      currentObservation(ctx.userId, i, 'chat') ?? currentObservation(ctx.userId, i, 'asked');
    const ref = refsFor(ctx.runId);
    const result = {
      status: 'ok',
      observation: o && {
        kind: o.kind,
        title: o.title,
        basis: o.basis,
        movements: view.movements
          .filter((m) => o.movementIds.includes(m.id))
          .map((m) => ({
            ref: ref(m.id),
            date: m.createdAt,
            amountCents: m.amountCents,
            description: m.description,
          })),
      },
      notice: NOTICE,
    };
    if (o) returned.set(result, o);
    return result;
  },
  async set_spending_observations(args, ctx) {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(args);
    setObservationsEnabled(ctx, enabled);
    return { status: 'ok', enabled };
  },
};

// ---- After the run ----

// Whether the customer asked for (or was volunteered) an observation through the tool: that turn
// carries no review nudge (run.ts) and no suggestion (the tool is not a clean-turn tool).
export const observationAsked = (toolRuns: ToolRun[]) =>
  toolRuns.some((r) => r.name === 'get_spending_observation');

// `observation.told`, once per customer and key, only now that the answer exists: a turn that
// failed after the tool ran told nothing.
export function recordObservationsTold(ctx: ToolContext, toolRuns: ToolRun[]) {
  try {
    for (const r of toolRuns) {
      const o = typeof r.result === 'object' && r.result ? returned.get(r.result) : undefined;
      if (o) recordTold(ctx, o);
    }
  } catch {
    // The answer is kept; the observation may be volunteered again.
  }
}
