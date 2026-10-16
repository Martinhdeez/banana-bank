// TL1: the balance of one account day by day over a calendar period, for the Plan chart. Days up
// to today are actual: end-of-day balances worked backwards from the bank's balance and its
// movements. Later days are projected: the current month is exactly the month ahead
// (monthForecast, same events, same lowest point and shortfall); after it, the regular money of
// RG1 on its days, the customer's added items, prepared transfers on their dates (monthly ones
// every month, a goal's until its target) and the irregular spend spread evenly over the days.
// Pure: no bank request, no database, no clock (`today` is an argument). Nothing is sent.
import { occurrence, today as madridDay } from '../banking/prepared';
import { movementWindow } from '../banking/movements';
import { isTwin, monthForecast, type ForecastInput } from './month';

export const TIMELINE_RANGES = [
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'next_month',
  'last_3_months',
  'next_3_months',
  'last_6_months',
  'next_6_months',
] as const;
export type TimelineRange = (typeof TIMELINE_RANGES)[number];
type Source =
  | 'movement'
  | 'usual_charge'
  | 'usual_income'
  | 'expected_by_you'
  | 'prepared'
  | 'goal'
  | 'everyday';
export type TimelineEvent = {
  date: string;
  label: string;
  amountCents: number;
  source: Source;
  certainty: 'actual' | 'certain' | 'estimated';
  preparedId?: string;
  goalId?: string;
};
export type TimelineInput = Omit<ForecastInput, 'goals'> & {
  accountId: string;
  range: TimelineRange;
  // RG1b's goal of each prepared transfer, with what is left to save: that stops its payments.
  goals?: { preparedId: string; goalId: string; name: string; remainingCents: number }[];
};

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const first = (date: string, months: number) => occurrence(date, 1, months);
const last = (date: string, months: number) => occurrence(date, 31, months);

// The period's first and last day, inclusive; null for an unknown range.
export function timelineRange(range: string, today: string) {
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const bounds: Record<TimelineRange, [string, string]> = {
    this_week: [monday, addDays(monday, 6)],
    last_week: [addDays(monday, -7), addDays(monday, -1)],
    this_month: [first(today, 0), last(today, 0)],
    last_month: [first(today, -1), last(today, -1)],
    next_month: [first(today, 1), last(today, 1)],
    last_3_months: [first(today, -2), last(today, 0)],
    next_3_months: [first(today, 0), last(today, 2)],
    last_6_months: [first(today, -5), last(today, 0)],
    next_6_months: [first(today, 0), last(today, 5)],
  };
  const b = bounds[range as TimelineRange];
  return b ? { from: b[0], to: b[1] } : null;
}

// Debits before credits within a day, then by label: the month ahead's order.
const inOrder = (a: TimelineEvent, b: TimelineEvent) =>
  a.date.localeCompare(b.date) ||
  Math.sign(a.amountCents) - Math.sign(b.amountCents) ||
  a.label.localeCompare(b.label);

export function balanceTimeline(i: TimelineInput) {
  const { accountId, range, today } = i;
  const { from, to } = timelineRange(range, today)!;
  const forecast = monthForecast(i);
  const account = forecast.accounts.find((a) => a.id === accountId)!;
  const until = forecast.until;
  const label = (id: string) => i.accounts.find((a) => a.id === id)?.label ?? 'another account';
  const goalOf = new Map((i.goals ?? []).map((g) => [g.preparedId, g]));

  // The current month: the month ahead's own events. TL1c: a goal's transfer is named as the
  // goal, as RG1b names it in `regular` (the customer's own name; this route goes to no model).
  const projected: TimelineEvent[] = account.events.map((e) => {
    const goal = e.preparedId ? goalOf.get(e.preparedId) : undefined;
    return {
      date: e.date,
      label: goal ? `Goal: ${goal.name}` : e.label,
      amountCents: e.amountCents,
      source: goal ? 'goal' : e.source,
      certainty: e.certainty,
      ...(e.preparedId && { preparedId: e.preparedId }),
      ...(goal && { goalId: goal.goalId }),
    };
  });

  // After the current month, up to the period's end. Prepared transfers first, as the month
  // ahead counts them: paused and undated ones are not; a due one is today; a monthly one comes
  // back every month, a goal's until what is left is paid.
  const later: TimelineEvent[] = [];
  for (const p of i.prepared) {
    if (p.state === 'paused' || p.state === 'ready') continue;
    if (p.fromAccountId !== accountId && p.toAccountId !== accountId) continue;
    const goal = goalOf.get(p.id);
    const day = p.when.kind === 'monthly' ? p.when.day : 0;
    // TL1b: a later monthly date inside the current month (a transfer overdue by more than a
    // month) is not drawn, as the month ahead counts it once, so it is not a payment either.
    const dates: string[] = [];
    for (let n = 0; ; n++) {
      if (goal && dates.length * p.amountCents >= goal.remainingCents) break;
      const date =
        n === 0 ? (p.state === 'scheduled' ? p.nextDue! : today) : occurrence(p.nextDue!, day, n);
      if (date > to || (n > 0 && !day)) break;
      if (n === 0 || date > until) dates.push(date);
    }
    for (const date of dates.filter((d) => d > until)) {
      const event = {
        date,
        source: goal ? 'goal' : 'prepared',
        certainty: 'certain',
        preparedId: p.id,
        ...(goal && { goalId: goal.goalId }),
      } as const;
      if (p.fromAccountId === accountId)
        later.push({
          ...event,
          label: goal ? `Goal: ${goal.name}` : `Prepared transfer to ${p.to}`,
          amountCents: -p.amountCents,
        });
      if (p.toAccountId === accountId)
        later.push({
          ...event,
          label: goal ? `Goal: ${goal.name}` : `Prepared transfer from ${label(p.fromAccountId)}`,
          amountCents: p.amountCents,
        });
    }
  }
  // FC1's twin rule: a charge the customer also prepared as a transfer from this account (within
  // 15% and 5 days) is counted once, as the transfer.
  const preparedDebits = later.filter((e) => e.amountCents < 0);
  const twin = (e: TimelineEvent) => preparedDebits.some((p) => isTwin(p, e));
  const estimated: TimelineEvent[] = [];
  const { regular } = account;
  for (let k = 1; first(today, k) <= to; k++) {
    // RG1b's `prepared` items are the transfers above.
    for (const r of [...regular.income, ...regular.charges])
      if (r.source !== 'prepared')
        estimated.push({
          date: occurrence(first(today, k), r.usualDay),
          label: r.label,
          amountCents: r.amountCents,
          source:
            r.source === 'added_by_you'
              ? 'expected_by_you'
              : r.amountCents > 0
                ? 'usual_income'
                : 'usual_charge',
          certainty: 'estimated',
        });
    // ponytail: spread exactly (the days' shares add up to the month); a per-weekday pattern
    // would need more than three months of history.
    const monthly = regular.irregularSpend?.monthlyCents ?? 0;
    const days = Number(last(today, k).slice(8));
    for (let d = 1; monthly && d <= days; d++)
      later.push({
        date: occurrence(first(today, k), d),
        label: 'Everyday spending (estimate)',
        amountCents: -(Math.round((monthly * d) / days) - Math.round((monthly * (d - 1)) / days)),
        source: 'everyday',
        certainty: 'estimated',
      });
  }
  for (const a of forecast.adjustments)
    if (
      a.kind === 'expect' &&
      a.repeats === 'once' &&
      a.accountId === accountId &&
      a.date! > until &&
      a.date! <= to
    )
      estimated.push({
        date: a.date!,
        label: a.label,
        amountCents: a.direction === 'income' ? a.amountCents! : -a.amountCents!,
        source: 'expected_by_you',
        certainty: 'estimated',
      });
  later.push(...estimated.filter((e) => !twin(e)));
  projected.push(...later.sort(inOrder));

  // The past: the account's movements, Madrid days. With a page that may miss older movements,
  // the line starts on the oldest day the bank returned.
  const moves = (i.movements ?? [])
    .filter((m) => m.accountId === accountId)
    .map((m) => ({ ...m, date: madridDay(new Date(m.createdAt)) }));
  const notes = [...forecast.notes];
  let start = from;
  const { oldestAt, mayBeTruncated } = movementWindow(i.movements ?? []);
  const oldest = oldestAt && madridDay(new Date(oldestAt));
  if (mayBeTruncated && oldest && oldest > from && oldest <= today) {
    start = oldest;
    notes.push(`Your bank history starts on ${oldest} here: the line starts there.`);
  }
  // End-of-day balance of a day: actual before today, then today's balance plus every projected
  // item up to that day. TL1b: an item dated today (a late charge, a due transfer) is still to
  // come, so today ends after it, as in the month ahead and in months[]; today's point alone is
  // the bank's balance (actual), and the item shows from the next day's point.
  const endOf = (date: string) =>
    date < today
      ? moves.filter((m) => m.date > date).reduce((b, m) => b - m.amountCents, account.balanceCents)
      : projected
          .filter((e) => e.date <= date)
          .reduce((b, e) => b + e.amountCents, account.balanceCents);
  // TL1c: the lowest balance within a projected day, from its opening balance through each of
  // its items in the month ahead's order (debits first). `lowest` is worked out the same way, so
  // the day it names carries it, as its end or as this low.
  const lowOf = (date: string) => {
    let balance = date === today ? account.balanceCents : endOf(addDays(date, -1));
    let low = balance;
    for (const e of projected) if (e.date === date) low = Math.min(low, (balance += e.amountCents));
    return low;
  };
  const points: { date: string; balanceCents: number; lowCents?: number; actual: boolean }[] = [];
  for (let d = start; d <= to; d = addDays(d, 1)) {
    const balanceCents = d === today ? account.balanceCents : endOf(d);
    const low = d >= today ? lowOf(d) : balanceCents;
    points.push({
      date: d,
      balanceCents,
      ...(low !== balanceCents && { lowCents: low }),
      actual: d <= today,
    });
  }

  const events: TimelineEvent[] = [
    ...moves
      .filter((m) => m.date >= start && m.date <= to)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m): TimelineEvent => ({
        date: m.date,
        label: m.description,
        amountCents: m.amountCents,
        source: 'movement',
        certainty: 'actual',
      })),
    ...projected.filter((e) => e.date >= from && e.date <= to),
  ];

  // The lowest point and the first shortfall of the projected part, worked out as the month
  // ahead does: from the balance where the projection starts, item by item.
  let lowest: { date: string; balanceCents: number } | null = null;
  let shortfall: { date: string; shortCents: number } | null = null;
  if (to >= today) {
    const begin = from > today ? from : today;
    let balance = from > today ? endOf(addDays(from, -1)) : account.balanceCents;
    lowest = { date: begin, balanceCents: balance };
    const after: { date: string; balanceCents: number }[] = [];
    for (const e of projected.filter((e) => e.date >= begin && e.date <= to)) {
      balance += e.amountCents;
      after.push({ date: e.date, balanceCents: balance });
      if (balance < lowest.balanceCents) lowest = { date: e.date, balanceCents: balance };
    }
    const crossing = after.find((a) => a.balanceCents < 0);
    if (crossing)
      shortfall = {
        date: crossing.date,
        shortCents: -Math.min(
          ...after.filter((a) => a.date === crossing.date).map((a) => a.balanceCents),
        ),
      };
  }

  // One entry per calendar month the line covers: what lets the chart be read month by month.
  const months = [];
  for (let m = start; m <= to; m = first(m, 1)) {
    const mTo = [last(m, 0), to].sort()[0];
    const inMonth = events.filter((e) => e.date >= m && e.date <= mTo);
    months.push({
      month: m.slice(0, 7),
      from: m,
      to: mTo,
      startBalanceCents: endOf(addDays(m, -1)),
      endBalanceCents: endOf(mTo),
      incomeCents: inMonth.filter((e) => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0),
      outCents: -inMonth.filter((e) => e.amountCents < 0).reduce((s, e) => s + e.amountCents, 0),
      actual: mTo <= today ? 'full' : m > today ? 'none' : 'partial',
    } as const);
  }
  if (to > until && regular.irregularSpend?.monthlyCents)
    notes.push(
      'After this month, everyday spending is an estimate: your average of the last full months, spread evenly over the days.',
    );

  return {
    accountId,
    range,
    today,
    from,
    to,
    points,
    events,
    months,
    lowest,
    shortfall,
    basis: {
      regularIncomeMonthlyCents: regular.income.reduce((s, r) => s + r.amountCents, 0),
      regularChargesMonthlyCents: -regular.charges.reduce((s, r) => s + r.amountCents, 0),
      everydayMonthlyCents: regular.irregularSpend?.monthlyCents ?? 0,
      months: regular.irregularSpend?.months ?? forecast.history.months ?? [],
    },
    notes,
  };
}
