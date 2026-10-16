// GL1 (plan 28 §4.3, D6): savings goals over the app database. A goal is a name, an amount and a
// date, fed by ONE monthly prepared transfer between two own accounts. Nothing here sends money,
// creates an intent or an approval, or writes to the bank: the goal's transfer is prepared
// (prepareTransfer) and the customer sends and confirms each month on the existing path.
// "Saved" is the sum of the COMPLETED intents of the goal's own prepared transfers (deleted ones
// included), never a balance.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appDb, insert } from '../db';
import { HttpError } from '../auth';
import { text } from '../http';
import { formatDate, money } from '../ui-helpers';
import { changePrepared, preparedList, prepareTransfer, today } from '../banking/prepared';
import type { PreparedView } from '../banking/prepared';
import { periodSummary } from '../insights/summary';
import type { ActionResult, ToolContext } from '../types';
import {
  CAN_SAVE_REASON,
  firstDue,
  goalFigures,
  goalHistory,
  monthlyForDate,
  nextStart,
  occurrence,
  planFor,
  realDate,
} from './plan';
import type { GoalFigures, HistoryMonth } from './plan';

type Named = { id: string; label: string };
export type GoalView = GoalFigures & {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string;
  savedCents: number;
  prepared: PreparedView | null;
  from: Named;
  to: Named;
  reachedAt?: string;
  history: HistoryMonth[];
};
type GoalRow = {
  id: string;
  user_id: string;
  name: string;
  target_cents: number;
  target_date: string;
  created_at: string;
};
type PreparedRow = {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  concept: string;
  note: string | null;
  day: number;
  created_at: string;
};
type Account = { id: string; label?: string };
const MAX_GOALS = 20;
const MAX_TARGET_CENTS = 1_000_000_000; // €10,000,000
const day = (instant: string) => today(new Date(instant));

// Each goal as the routes answer it, with `start`: the occurrence a replacement of its transfer
// starts on (nextStart).
function load(userId: string, accounts: Account[], now: Date, only?: string) {
  const db = appDb(),
    t = today(now);
  // First: reading the list closes an occurrence whose send completed (prepared.ts D10).
  const prepared = preparedList(userId, now);
  const goals = db
    .prepare(
      `SELECT * FROM goals WHERE user_id=? AND status='active' ${only ? 'AND id=?' : ''} ORDER BY created_at,rowid`,
    )
    .all(...(only ? [userId, only] : [userId])) as GoalRow[];
  if (!goals.length) return [];
  // When a prepared transfer was deleted, and which occurrences were skipped: the audit events
  // (the row itself keeps no date for either).
  const events = db
    .prepare(
      "SELECT kind, json_extract(data,'$.preparedId') id, json_extract(data,'$.occurrence') occurrence, created_at FROM events WHERE user_id=? AND kind IN ('prepared.deleted','prepared.skipped')",
    )
    .all(userId) as { kind: string; id: string; occurrence: string | null; created_at: string }[];
  const label = (id: string) => ({ id, label: accounts.find((a) => a.id === id)?.label || id });
  return goals.map((goal) => {
    const rows = db
      .prepare(
        'SELECT id,from_account_id,to_account_id,amount_cents,concept,note,day,created_at FROM prepared_transfers WHERE goal_id=? ORDER BY created_at,rowid',
      )
      .all(goal.id) as PreparedRow[];
    const contributions = rows
      .flatMap(
        (row) =>
          db
            .prepare(
              "SELECT i.id, json_extract(i.payload,'$.amountCents') amountCents, COALESCE(a.consumed_at,i.created_at) at FROM intents i LEFT JOIN approvals a ON a.intent_id=i.id WHERE i.user_id=? AND i.status='completed' AND i.id LIKE ?",
            )
            .all(userId, `prepared:${row.id}:%`) as {
            id: string;
            amountCents: number;
            at: string;
          }[],
      )
      .sort((a, b) => a.at.localeCompare(b.at))
      // The intent of an occurrence is `prepared:<row>:<its due date>:<attempt>`.
      .map((c) => ({
        ...c,
        day: day(c.at),
        row: c.id.split(':')[1],
        occurrence: c.id.split(':')[2],
      }));
    // The latest occurrence paid before an instant (all of them when none is given).
    const paidThrough = (before = '9') =>
      contributions
        .filter((c) => c.at < before)
        .map((c) => c.occurrence)
        .sort()
        .at(-1);
    let savedCents = 0,
      reachedAt: string | undefined;
    for (const c of contributions) {
      savedCents += c.amountCents;
      if (!reachedAt && savedCents >= goal.target_cents) reachedAt = c.day;
    }
    const last = rows.at(-1)!;
    const active = prepared.find((p) => rows.some((r) => r.id === p.id)) ?? null;
    const view: GoalView = {
      id: goal.id,
      name: goal.name,
      targetCents: goal.target_cents,
      targetDate: goal.target_date,
      savedCents,
      ...goalFigures({
        targetCents: goal.target_cents,
        targetDate: goal.target_date,
        savedCents,
        reachedAt,
        prepared: active,
        last: { amountCents: last.amount_cents, day: last.day, paidThrough: paidThrough() },
        today: t,
      }),
      prepared: active,
      from: label(last.from_account_id),
      to: label(last.to_account_id),
      ...(reachedAt && { reachedAt }),
      history: goalHistory(
        day(goal.created_at).slice(0, 7),
        t,
        contributions,
        rows.map((row) => {
          const of = events.filter((e) => e.id === row.id);
          const deleted = of.find((e) => e.kind === 'prepared.deleted');
          return {
            amountCents: row.amount_cents,
            day: row.day,
            // Not stored: the same rule the row was created with, on what was paid by then.
            firstDue: nextStart(day(row.created_at), row.day, paidThrough(row.created_at)),
            deletedDay: deleted && day(deleted.created_at),
            skipped: of.flatMap((e) => (e.occurrence ? [e.occurrence] : [])),
            paid: contributions.filter((c) => c.row === row.id).map((c) => c.occurrence),
          };
        }),
      ),
    };
    return { view, start: nextStart(t, last.day, paidThrough()), last };
  });
}
const views = (...args: Parameters<typeof load>) => load(...args).map((g) => g.view);

type BankView = Parameters<typeof periodSummary>[0] & { accounts: Account[] };
// What the customer kept a month: the mean of (income − spending) over up to three full months
// that are whole inside the bank's movement window. null: no such month. It warns, never blocks.
// ponytail: a movement still to sort is in no total, as in the spending card.
export function roomOf(view: BankView, now = new Date()) {
  const kept: number[] = [];
  for (let back = 1; back <= 3; back++) {
    const month = occurrence(today(now), 1, -back).slice(0, 7);
    const s = periodSummary(view, month, 'none', now);
    if (s.partial || !s.windowDays.from || s.windowDays.from.slice(0, 7) > month) break;
    kept.push(s.incomeCents - s.spentCents);
  }
  return kept.length
    ? {
        monthlyCents: Math.round(kept.reduce((a, b) => a + b, 0) / kept.length),
        months: kept.length,
      }
    : null;
}

const dateIn = (date: string, now: Date) => {
  const t = today(now);
  if (!realDate(date) || date <= t || date > `${Number(t.slice(0, 4)) + 30}${t.slice(4)}`)
    throw new HttpError(400, 'Choose a date after today, at most 30 years ahead.');
  return date;
};
const cents = z.number().int().min(1).max(MAX_TARGET_CENTS);
const monthDay = z.number().int().min(1).max(31);
const planBody = z
  .object({
    targetCents: cents,
    targetDate: z.string(),
    day: monthDay,
    goalId: z.string().min(1).max(120).optional(),
  })
  .strict();
const createBody = z
  .object({
    name: text(z.string().trim().min(1).max(60)),
    targetCents: cents,
    targetDate: z.string(),
    fromAccountId: z.string().min(1).max(120),
    toAccountId: z.string().min(1).max(120),
    day: monthDay,
  })
  .strict();
const adjustBody = z.union([
  z.object({ monthlyCents: cents }).strict(),
  z.object({ targetDate: z.string() }).strict(),
]);

// GET /api/goals
export function goalsOf(userId: string, view: BankView, now = new Date()) {
  const canSave = view.accounts.length > 1;
  return {
    today: today(now),
    canSave,
    canSaveReason: canSave ? null : CAN_SAVE_REASON,
    accounts: view.accounts.map((a) => ({ id: a.id, label: a.label || a.id })),
    room: roomOf(view, now),
    goals: views(userId, view.accounts, now),
  };
}
// POST /api/goals/plan: arithmetic over the body and the room; reads and writes no app data.
// With `goalId` (the what-if of an existing goal; owner or 404) the plan is the one an adjust
// would make: the goal's own day, from its next unpaid occurrence.
export function planGoal(userId: string, body: unknown, view: BankView, now = new Date()) {
  const { targetCents, targetDate, day, goalId } = planBody.parse(body);
  const goal = goalId ? owned(userId, goalId, view.accounts, now) : null;
  const plan = planFor(
    targetCents,
    goal?.start ?? firstDue(today(now), day),
    goal?.last.day ?? day,
    dateIn(targetDate, now),
  );
  const room = roomOf(view, now);
  return { ...plan, fits: room ? plan.monthlyCents <= room.monthlyCents : null };
}
// GL4: what the goal's transfer is for. The bank concept is short and holds no date; the note
// (local, 140 characters at most, shown on the card) says what it is for and how and when the goal
// was set up. The name is cut with "…" when the note would not fit.
const conceptOf = (name: string) => `Savings: ${name}`;
const dayOf = (date: string) => formatDate(`${date}T12:00:00Z`, false);
const setUpLine = (via: 'assistant' | 'plan', now: Date) =>
  `Set up ${via === 'assistant' ? 'with the assistant' : 'in Plan'} on ${dayOf(today(now))}.`;
function noteOf(name: string, targetCents: number, targetDate: string, setUp: string) {
  const note = (n: string) =>
    `For your goal ‘${n}’ (${money(targetCents)} by ${dayOf(targetDate)}). ${setUp}`;
  const chars = [...name],
    over = note(name).length - 140;
  return over > 0 ? note(`${chars.slice(0, chars.length - over - 1).join('')}…`) : note(name);
}
const refused = (result: ActionResult) =>
  new HttpError(409, String(result.error), {}, String(result.code));
const prepareFor = async (
  ctx: ToolContext,
  goalId: string,
  transfer: {
    fromAccountId: string;
    toAccountId: string;
    amountCents: number;
    concept: string;
    note: string | null;
  },
  monthDay: number,
  now: Date,
) => {
  const result = await prepareTransfer(
    ctx,
    { ...transfer, when: 'monthly', day: monthDay },
    now,
    goalId,
  );
  if (result.status !== 'prepared') throw refused(result);
  return result.prepared as PreparedView;
};
// POST /api/goals: the goal and its one monthly prepared transfer. Nothing is sent. `via`: who
// set it up, for the transfer's note (the chat's create_goal passes 'assistant').
export async function createGoal(
  ctx: ToolContext,
  body: unknown,
  view: BankView,
  now = new Date(),
  via: 'assistant' | 'plan' = 'plan',
) {
  const input = createBody.parse(body);
  dateIn(input.targetDate, now);
  if (view.accounts.length < 2) throw new HttpError(409, CAN_SAVE_REASON, {}, 'single_account');
  const own = (id: string) => view.accounts.some((a) => a.id === id);
  if (
    !own(input.fromAccountId) ||
    !own(input.toAccountId) ||
    input.fromAccountId === input.toAccountId
  )
    throw new HttpError(400, 'Choose two of your own accounts.');
  const { n } = appDb()
    .prepare("SELECT COUNT(*) n FROM goals WHERE user_id=? AND status='active'")
    .get(ctx.userId) as { n: number };
  if (n >= MAX_GOALS)
    throw new HttpError(
      409,
      `You already have ${MAX_GOALS} goals. Delete one first.`,
      {},
      'too_many',
    );
  const plan = planFor(
    input.targetCents,
    firstDue(today(now), input.day),
    input.day,
    input.targetDate,
  );
  const id = randomUUID();
  await prepareFor(
    ctx,
    id,
    {
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents: plan.monthlyCents,
      concept: conceptOf(input.name),
      note: noteOf(input.name, input.targetCents, input.targetDate, setUpLine(via, now)),
    },
    input.day,
    now,
  );
  insert('goals', {
    id,
    user_id: ctx.userId,
    name: input.name,
    target_cents: input.targetCents,
    target_date: input.targetDate,
    created_at: new Date().toISOString(),
  });
  return { status: 'created', goal: views(ctx.userId, view.accounts, now, id)[0] };
}
function owned(userId: string, id: string, accounts: Account[], now: Date) {
  const goal = load(userId, accounts, now, id)[0];
  if (!goal) throw new HttpError(404, 'Goal not found.');
  return goal;
}
// ponytail: per-process; two app instances could replace one goal's transfer at the same time.
const adjusting = new Set<string>();
// POST /api/goals/:id/adjust: a new monthly amount, or a new date (the amount is kept when it
// still reaches the target, else it becomes the required one). The new transfer is prepared
// first and the old one deleted after, so a bank error leaves the plan as it was.
export async function adjustGoal(
  ctx: ToolContext,
  id: string,
  body: unknown,
  view: BankView,
  now = new Date(),
) {
  const input = adjustBody.parse(body);
  const { view: goal, start, last } = owned(ctx.userId, id, view.accounts, now);
  const old = goal.prepared;
  const busy = (error: string) => new HttpError(409, error, {}, 'prepared_in_progress');
  if (goal.state === 'reached')
    throw new HttpError(409, 'This goal is already reached. Nothing changed.', {}, 'reached');
  if (adjusting.has(id) || old?.state === 'awaiting_confirmation' || old?.state === 'verifying')
    throw busy(
      'A payment of this goal is being sent. Confirm or cancel it first, then adjust. Nothing changed.',
    );
  const monthlyCents =
    'monthlyCents' in input
      ? input.monthlyCents
      : monthlyForDate(
          goal.remainingCents,
          planFor(goal.remainingCents, start, last.day, dateIn(input.targetDate, now)),
          last.amount_cents,
        );
  adjusting.add(id);
  try {
    const fresh = await prepareFor(
      ctx,
      id,
      {
        fromAccountId: goal.from.id,
        toAccountId: goal.to.id,
        amountCents: monthlyCents,
        concept: last.concept,
        // GL4: the new target date, and the original "Set up … on …" line. A goal made before
        // GL4 keeps the note it had (none).
        note:
          last.note &&
          noteOf(
            goal.name,
            goal.targetCents,
            'targetDate' in input ? input.targetDate : goal.targetDate,
            last.note.match(/Set up (with the assistant|in Plan) on [^.]+\.$/)?.[0] ?? '',
          ).trim(),
      },
      last.day,
      // prepareTransfer starts a monthly transfer at the first occurrence from its `now`: the
      // start day itself when this month is already paid.
      start > today(now) ? new Date(`${start}T12:00:00Z`) : now,
    );
    if (old) {
      const result = changePrepared(ctx, old.id, 'delete', now);
      // A send that started while the bank was read: the old plan stays, the new one goes.
      if (result.status !== 'deleted') {
        changePrepared(ctx, fresh.id, 'delete', now);
        throw busy(String(result.error));
      }
    }
    if ('targetDate' in input)
      appDb().prepare('UPDATE goals SET target_date=? WHERE id=?').run(input.targetDate, id);
  } finally {
    adjusting.delete(id);
  }
  return { status: 'adjusted', goal: views(ctx.userId, view.accounts, now, id)[0] };
}
// DELETE /api/goals/:id: the goal leaves the list and its prepared transfer is deleted with it.
// Nothing sent is undone. Needs no bank read.
export function deleteGoal(ctx: ToolContext, id: string, now = new Date()) {
  const goal = owned(ctx.userId, id, [], now).view;
  if (goal.prepared) {
    const result = changePrepared(ctx, goal.prepared.id, 'delete', now);
    if (result.status !== 'deleted') throw refused(result);
  }
  appDb().prepare("UPDATE goals SET status='deleted' WHERE id=?").run(id);
  return { status: 'deleted' };
}
