// FC2 (plan 28 §13): the customer's adjustments to the month forecast, stored per customer. An
// `exclude` names a usual item by its key; an `expect` is a charge the rule cannot see. Nothing
// here moves money, prepares a transfer, calls the bank or a model, or writes an event: the
// label is the customer's own text and stays in this table and in their own dashboard.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appDb, insert } from '../db';
import { HttpError } from '../auth';
import { stripBidi } from '../ui-helpers';
import { MAX_AMOUNT_CENTS } from '../banking/actions';
import { today } from '../banking/prepared';
import type { ForecastAdjustment } from './month';

export const MAX_ADJUSTMENTS = 20;
export const TOO_MANY_ADJUSTMENTS = `You already have ${MAX_ADJUSTMENTS} changes to your month ahead. Remove one before adding another.`;

const base = { accountId: z.string().min(1).max(120) };
// Trimmed, 1 to 40 characters. A control character or a bidirectional control (the set FX3
// strips from a transfer concept, src/ui-helpers.ts) is refused here, not removed: the customer
// reads this label back in a sentence about their money.
const label = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !/\p{Cc}/u.test(v) && stripBidi(v) === v);
const expect = {
  ...base,
  kind: z.literal('expect'),
  label,
  amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
  // RG1: an income the customer expects; absent or 'charge' is today's charge.
  direction: z.enum(['charge', 'income']).optional(),
};
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// A real calendar day: 2026-02-30 is not one.
const realDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v;
export const adjustmentBody = z.union([
  z
    .object({
      ...base,
      kind: z.literal('exclude'),
      // The form of src/insights/normalize.ts merchantKey(): nothing else can match a usual item.
      merchantKey: z.string().regex(/^[A-Z0-9& ]{1,40}$/),
    })
    .strict(),
  z
    .object({ ...expect, repeats: z.literal('monthly'), day: z.number().int().min(1).max(31) })
    .strict(),
  z.object({ ...expect, repeats: z.literal('once'), date: z.string().refine(realDate) }).strict(),
]);

type Row = {
  id: string;
  account_id: string;
  kind: 'exclude' | 'expect';
  merchant_key: string | null;
  label: string;
  amount_cents: number | null;
  repeats: 'monthly' | 'once' | null;
  day: number | null;
  date: string | null;
  direction: 'income' | null;
  created_at: string;
};
const view = (r: Row): ForecastAdjustment => ({
  id: r.id,
  kind: r.kind,
  accountId: r.account_id,
  ...(r.merchant_key !== null && { merchantKey: r.merchant_key }),
  label: r.label,
  ...(r.amount_cents !== null && { amountCents: r.amount_cents }),
  ...(r.repeats && { repeats: r.repeats }),
  ...(r.day !== null && { day: r.day }),
  ...(r.date !== null && { date: r.date }),
  ...(r.direction && { direction: r.direction }),
  createdAt: r.created_at,
});
// The customer's active adjustments, oldest first.
export const adjustmentsOf = (userId: string) =>
  (
    appDb()
      .prepare(
        'SELECT * FROM forecast_adjustments WHERE user_id=? AND removed_at IS NULL ORDER BY created_at,rowid',
      )
      .all(userId) as Row[]
  ).map(view);
// "DIGI SPAIN TELECOM" → "Digi Spain Telecom", as the forecast names a usual item.
const nameOf = (key: string) => key.toLowerCase().replace(/(^|[ &])[a-z]/g, (c) => c.toUpperCase());

// `accountIds`: the customer's own accounts, as the bank just returned them. Another customer's
// account is the same 404 as an unknown one. Synchronous: the cap and the insert cannot
// interleave with another request.
export function addAdjustment(
  userId: string,
  body: z.infer<typeof adjustmentBody>,
  accountIds: string[],
  now = new Date(),
): { adjustment: ForecastAdjustment; created: boolean } {
  if (!accountIds.includes(body.accountId)) throw new HttpError(404, 'Account not found.');
  const day = today(now);
  // A one-off from today to one year ahead, as a prepared transfer's date.
  if (
    body.kind === 'expect' &&
    body.repeats === 'once' &&
    (body.date < day || body.date > addDays(day, 366))
  )
    throw new HttpError(400, 'Invalid request data.');
  const active = adjustmentsOf(userId);
  // Leaving the same item out twice is one exclusion.
  const same =
    body.kind === 'exclude' &&
    active.find(
      (a) =>
        a.kind === 'exclude' &&
        a.accountId === body.accountId &&
        a.merchantKey === body.merchantKey,
    );
  if (same) return { adjustment: same, created: false };
  if (active.length >= MAX_ADJUSTMENTS)
    throw new HttpError(409, TOO_MANY_ADJUSTMENTS, {}, 'too_many');
  const id = randomUUID();
  insert('forecast_adjustments', {
    id,
    user_id: userId,
    account_id: body.accountId,
    kind: body.kind,
    created_at: now.toISOString(),
    ...(body.kind === 'exclude'
      ? { merchant_key: body.merchantKey, label: nameOf(body.merchantKey) }
      : {
          label: body.label,
          amount_cents: body.amountCents,
          repeats: body.repeats,
          ...(body.direction === 'income' && { direction: 'income' as const }),
          ...(body.repeats === 'monthly' ? { day: body.day } : { date: body.date }),
        }),
  });
  return { adjustment: adjustmentsOf(userId).find((a) => a.id === id)!, created: true };
}
// Owner only: another customer's id removes nothing and answers like an unknown one.
export const removeAdjustment = (userId: string, id: string, now = new Date()) =>
  appDb()
    .prepare(
      'UPDATE forecast_adjustments SET removed_at=? WHERE id=? AND user_id=? AND removed_at IS NULL',
    )
    .run(now.toISOString(), id, userId).changes > 0;
// RG1: the operations the app sent from a prepared transfer (their intent ids start `prepared:`),
// so the forecast leaves them out of the irregular spend.
export const preparedOperationIds = (userId: string) =>
  appDb()
    .prepare(
      "SELECT operation_id FROM intents WHERE user_id=? AND id LIKE 'prepared:%' AND operation_id IS NOT NULL",
    )
    .pluck()
    .all(userId) as string[];
// RG1b: the active goal each prepared transfer feeds, for the regular list's "Goal: <name>".
export const preparedGoals = (userId: string) =>
  appDb()
    .prepare(
      "SELECT p.id preparedId, g.id goalId, g.name FROM prepared_transfers p JOIN goals g ON g.id=p.goal_id WHERE g.user_id=? AND g.status='active' AND p.status='active'",
    )
    .all(userId) as { preparedId: string; goalId: string; name: string }[];
