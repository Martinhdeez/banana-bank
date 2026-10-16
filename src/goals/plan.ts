// GL1 (plan 28 §5.2, §6.1): the arithmetic, the state and the fixed texts of a savings goal.
// Pure: it calls no database, no bank, no model, no clock (`today` is an argument, 'YYYY-MM-DD' in
// Europe/Madrid). Every figure a customer sees about a goal is computed here; the interface
// prints `headline`, `basis` and the suggestion texts verbatim.
import { firstDue, occurrence } from '../banking/prepared';
import type { PreparedView } from '../banking/prepared';

const parts = (date: string) => date.split('-').map(Number);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// One date rule: the occurrences of a goal's plan are those of its prepared transfer.
export { occurrence, firstDue };
// The occurrence a new transfer of the goal starts on: the next one from today that the customer
// has not already paid (a month paid early, or today, is not asked for a second time).
export function nextStart(today: string, day: number, paidThrough?: string) {
  let start = firstDue(today, day);
  while (paidThrough && start <= paidThrough) start = occurrence(start, day, 1);
  return start;
}
export const realDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && iso(Date.parse(`${date}T00:00:00Z`)) === date;

// §6.1 formats: amounts exact, never rounded; a day as `20 Oct`, with its year when that is not
// the year of `today` (a goal often ends in another year: "by 1 Jun" would be a false figure).
const euros = (cents: number) =>
  `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (date: string, today: string) => {
  const [y, m, d] = parts(date);
  return `${d} ${MONTHS[m - 1]}${date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${y}`}`;
};

export const CAN_SAVE_REASON =
  'A savings goal moves money between two accounts of yours. You have one account, so a goal cannot be set up yet.';

export type Plan = { monthlyCents: number; payments: number; firstDue: string; lastDue: string };
// Payments = the monthly occurrences from `first` to the target date, at least 1.
// Monthly = ceil(remaining / payments): the last payment never leaves a cent missing.
export function planFor(remainingCents: number, first: string, day: number, targetDate: string) {
  let payments = 1;
  while (occurrence(first, day, payments) <= targetDate) payments++;
  return {
    monthlyCents: Math.ceil(remainingCents / payments),
    payments,
    firstDue: first,
    lastDue: occurrence(first, day, payments - 1),
  } satisfies Plan;
}
// What a new target date does to the monthly amount: the amount the customer already has is kept
// when it reaches the target by then; otherwise the required one. One function for the `extend`
// text and for POST /api/goals/:id/adjust {targetDate}, so the button does what the text says.
export const monthlyForDate = (remainingCents: number, plan: Plan, lastMonthlyCents: number) =>
  lastMonthlyCents * plan.payments >= remainingCents ? lastMonthlyCents : plan.monthlyCents;

export type Suggestion = (
  | { kind: 'raise'; monthlyCents: number }
  | { kind: 'extend'; targetDate: string }
  | { kind: 'prepare_again'; monthlyCents: number }
) & { text: string };
export type GoalState = 'on_track' | 'behind' | 'no_plan' | 'date_passed' | 'reached';
export type GoalFigures = {
  state: GoalState;
  remainingCents: number;
  behindCents: number; // 0 unless `behind` with a gap
  monthlyCents: number | null;
  requiredMonthlyCents: number | null;
  headline: string;
  basis: string;
  suggestion: Suggestion | null;
  alternative: Suggestion | null;
};
export function goalFigures(f: {
  targetCents: number;
  targetDate: string;
  savedCents: number;
  reachedAt?: string;
  // The goal's active prepared transfer, as the Transfers tab shows it; null when it was deleted.
  prepared: Pick<PreparedView, 'amountCents' | 'nextDue' | 'state'> | null;
  // The goal's newest prepared transfer, deleted or not: what a replacement is modelled on.
  // `paidThrough`: the latest occurrence of the goal the customer has paid.
  last: { amountCents: number; day: number; paidThrough?: string };
  today: string;
}): GoalFigures {
  const { targetCents: target, targetDate, savedCents: saved, last, today } = f;
  const remaining = Math.max(0, target - saved);
  const d = (date: string) => dayText(date, today);
  const savedOf = `${euros(saved)} of ${euros(target)} saved`;
  // A paused transfer adds nothing and cannot be sent: for the goal it is no plan (its view is
  // still in `prepared`, so the interface can offer Resume).
  const live = f.prepared && f.prepared.state !== 'paused' ? f.prepared : null;
  const base = {
    remainingCents: remaining,
    behindCents: 0,
    monthlyCents: live?.amountCents ?? null,
    requiredMonthlyCents: null,
    suggestion: null,
    alternative: null,
  };
  if (saved >= target)
    return {
      ...base,
      state: 'reached',
      headline: `Reached on ${d(f.reachedAt ?? today)}`,
      // The goal's transfer is not deleted for the customer: while it exists the text says so,
      // so a finished goal is not paid into month after month unnoticed.
      basis: `${euros(saved)} saved, with the transfers you confirmed.${f.prepared ? ` Its monthly transfer of ${euros(f.prepared.amountCents)} is still in Transfers and stays there until you delete it.` : ''}`,
    };
  // A replacement (adjust) starts at the next unpaid occurrence of the same day, from today.
  const next = nextStart(today, last.day, last.paidThrough);
  const extend = (): Extract<Suggestion, { kind: 'extend' }> | null => {
    const payments = Math.ceil(remaining / last.amountCents);
    // Past the 30 years a target date may have (the adjust would refuse it): no such offer.
    if (payments > 360) return null;
    const date = occurrence(next, last.day, payments - 1);
    return {
      kind: 'extend',
      targetDate: date,
      text: `${euros(last.amountCents)} a month reaches ${euros(target)} by ${d(date)}.`,
    };
  };
  if (targetDate < today)
    return {
      ...base,
      state: 'date_passed',
      headline: 'The date has passed',
      basis: `${savedOf} by ${d(targetDate)}. ${euros(remaining)} remains.`,
      suggestion: extend(),
    };
  const fresh = planFor(remaining, next, last.day, targetDate);
  if (!live)
    return {
      ...base,
      state: 'no_plan',
      requiredMonthlyCents: fresh.monthlyCents,
      headline: 'No monthly transfer',
      basis: `${savedOf}. No monthly transfer is set up for this goal, so nothing more is added.`,
      suggestion: {
        kind: 'prepare_again',
        monthlyCents: fresh.monthlyCents,
        text: `A monthly transfer of ${euros(fresh.monthlyCents)} reaches ${euros(target)} by ${d(targetDate)}.`,
      },
    };
  const monthly = live.amountCents;
  const plan = planFor(remaining, live.nextDue!, last.day, targetDate);
  const figures = { ...base, requiredMonthlyCents: plan.monthlyCents };
  // target − behind = saved + monthly × payments left: the {projected} of §6.1.
  // planFor counts at least one payment; with no occurrence left on or before the date nothing
  // more arrives by then, so the goal is behind by all that remains (never "On plan").
  const left = live.nextDue! > targetDate ? 0 : plan.payments;
  const behind = Math.max(0, remaining - monthly * left);
  if (behind > 0) {
    const later = extend();
    return {
      ...figures,
      state: 'behind',
      behindCents: behind,
      headline: `${euros(behind)} behind plan`,
      basis: `${savedOf}. At ${euros(monthly)} a month you reach ${euros(target - behind)} by ${d(targetDate)}, ${euros(behind)} short.`,
      // Both are worked out on the replacement's dates (an overdue occurrence is dropped by a
      // replacement); an adjustment that would not be one (no raise, no later date) is not offered.
      suggestion:
        fresh.monthlyCents > monthly && next <= targetDate
          ? {
              kind: 'raise',
              monthlyCents: fresh.monthlyCents,
              text: `${euros(fresh.monthlyCents)} a month reaches ${euros(target)} by ${d(targetDate)}.`,
            }
          : null,
      alternative: later && later.targetDate > targetDate ? later : null,
    };
  }
  // An occurrence whose day has passed and is not sent: the action is Send in `prepared`, not an
  // adjustment. One due today is on plan (the Transfers tab shows it as due).
  if (live.nextDue! < today && live.state !== 'verifying')
    return {
      ...figures,
      state: 'behind',
      headline: 'A payment is waiting',
      basis: `${savedOf}. The payment of ${d(live.nextDue!)} is waiting for your confirmation.`,
    };
  return {
    ...figures,
    state: 'on_track',
    headline: 'On plan',
    basis: `${savedOf}. ${euros(monthly)} a month, ${plan.payments} ${plan.payments === 1 ? 'payment' : 'payments'} left, the last on ${d(plan.lastDue)}.`,
  };
}

export type HistoryMonth = { month: string; plannedCents: number; savedCents: number };
// One entry per month from the goal's first month to the current one. `savedCents`: what the
// customer confirmed in that month. `plannedCents`: the amount of the goal's occurrences of that
// month: those that fell due while their prepared transfer existed (a deleted one stops counting
// on the day it was deleted) and those the customer paid; a skipped occurrence is not planned.
// ponytail: a month spent paused still counts as planned; read the paused/resumed events if the
// chart must show that.
export function goalHistory(
  firstMonth: string,
  today: string,
  contributions: { day: string; amountCents: number }[],
  rows: {
    amountCents: number;
    day: number;
    firstDue: string;
    deletedDay?: string;
    skipped: string[];
    paid: string[]; // the occurrences of this transfer the customer paid
  }[],
): HistoryMonth[] {
  const current = today.slice(0, 7);
  const months = new Map<string, HistoryMonth>();
  for (let m = `${firstMonth}-01`; m.slice(0, 7) <= current; m = occurrence(m, 1, 1))
    months.set(m.slice(0, 7), { month: m.slice(0, 7), plannedCents: 0, savedCents: 0 });
  for (const c of contributions) {
    const entry = months.get(c.day.slice(0, 7));
    if (entry) entry.savedCents += c.amountCents;
  }
  for (const row of rows) {
    const due = new Set(row.paid);
    for (let k = 0; ; k++) {
      const date = occurrence(row.firstDue, row.day, k);
      if (date.slice(0, 7) > current || (row.deletedDay && date >= row.deletedDay)) break;
      if (!row.skipped.includes(date)) due.add(date);
    }
    for (const date of due) {
      const entry = months.get(date.slice(0, 7));
      if (entry) entry.plannedCents += row.amountCents;
    }
  }
  return [...months.values()];
}
