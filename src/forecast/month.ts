// FC1 (plan 28 §4.4, §5.1, §6.1; REQ-PL-18…24): the month ahead. Per account, the balance today,
// what is still to come before the month ends (prepared transfers, certain; usual charges and
// usual income, estimated from the last three full months) and the lowest point. Pure: no bank
// request, no database, no model, no categories, no clock (`today` is an argument). Every text
// is fixed server text; an estimate always says "estimate" (plan 28 D1, which amends plan 26 D3
// for this one kind). Nothing here sends or prepares anything.
import { MAX_ACTIVE, occurrence, type PreparedView } from '../banking/prepared';
import { movementWindow } from '../banking/movements';
import { merchantKey } from '../insights/normalize';

export type ForecastEvent = {
  date: string;
  label: string;
  amountCents: number;
  balanceAfterCents: number;
  // FC2 `expected_by_you`: a charge the customer added by hand; always estimated.
  source: 'prepared' | 'usual_charge' | 'usual_income' | 'expected_by_you';
  certainty: 'certain' | 'estimated';
  merchantKey?: string; // usual items: the key the rule grouped by; what an `exclude` names
  adjustmentId?: string; // FC2: the customer's own item, removed with this id
  seenOn?: string[]; // the three days it was seen on, oldest first
  usualDay?: number;
  late?: boolean;
  note?: string;
  preparedId?: string;
};
export type CoverOption = {
  id: string;
  title: string;
  consequence: string;
  change: { kind: 'add'; date: string; amountCents: number; label: string };
  // Exactly the body of the existing POST /api/prepared: it prepares, it never sends.
  prepare: {
    fromAccountId: string;
    toAccountId: string;
    amountCents: number;
    concept: string;
    when: 'on_date';
    date: string;
  };
};
export type ForecastAccount = {
  id: string;
  label: string;
  balanceCents: number;
  endCents: number;
  lowest: { date: string; balanceCents: number };
  shortfall: {
    date: string;
    shortCents: number;
    certainty: 'certain' | 'estimated';
    forLabel: string;
    preparedId?: string;
  } | null;
  headline: string;
  explanation: string;
  options: CoverOption[];
  events: ForecastEvent[];
  regular: RegularMoney;
  // RG1b: what falls in the first 7 days of next month (prepared transfers and regular items),
  // listed only: the projection still stops at the month's end.
  nextMonth: NextMonthItem[];
};
export type NextMonthItem = {
  date: string;
  label: string;
  amountCents: number;
  preparedId?: string;
  goalId?: string;
  adjustmentId?: string; // a monthly item the customer added
};
// RG1: what comes every month, all of it (already paid this month too), apart from what is still
// to come. Detected: the usual items of the three full months, less those the customer left out.
// Added: the customer's monthly `expect` adjustments (a one-off is not regular).
// RG1b: prepared: every active (not paused) monthly prepared transfer, a goal's included.
export type RegularItem = {
  id: string; // detected: its merchantKey (what an `exclude` names); added: the adjustment id;
  // prepared: the prepared transfer's id
  label: string;
  amountCents: number; // positive for income, negative for a charge
  usualDay: number;
  source: 'detected' | 'added_by_you' | 'prepared';
  seenOn?: string[];
  // next_month: a prepared transfer not sent this month whose next payment is after it
  thisMonth: 'done' | 'to_come' | 'late' | 'next_month';
  excludable: boolean;
  adjustmentId?: string;
  nextDue?: string; // prepared: its next payment, YYYY-MM-DD
  goalId?: string; // prepared: the savings goal it feeds
};
export type RegularMoney = {
  income: RegularItem[];
  charges: RegularItem[];
  // The average per month, over the history's full months, of the debits that are not a regular
  // charge, not a move between own accounts and not a prepared transfer. Positive. null with no
  // history.
  irregularSpend: { monthlyCents: number; months: string[] } | null;
};
// FC2 (plan 28 §13): what the customer changed in the forecast by hand. `exclude` takes the usual
// item with that key on that account out; `expect` adds a charge the rule cannot see. `label` of
// an `expect` is the customer's own text: printed as text, never sent to a model.
export type ForecastAdjustment = {
  id: string;
  kind: 'exclude' | 'expect';
  accountId: string;
  merchantKey?: string;
  label: string;
  amountCents?: number;
  repeats?: 'monthly' | 'once';
  direction?: 'charge' | 'income'; // RG1: of an `expect`; absent is a charge
  day?: number;
  date?: string;
  createdAt: string;
  // RG1e: a monthly `expect` listed once inside another regular item, its twin (RG1d, RG1e):
  // that item's label as the customer sees it. Absent otherwise. Never sent to the model.
  countedWith?: { label: string; source: 'prepared' | 'detected' };
};
export type MonthForecast = {
  adjustable: true; // FC2: this server takes adjustments (the screen's availability marker)
  today: string;
  until: string;
  history:
    | { months: string[] }
    | { months: null; reason: 'window_short' | 'no_history' | 'movements_unread' };
  income: 'counted' | 'none_regular';
  notes: string[];
  sourceLine: string;
  accounts: ForecastAccount[];
  notCounted: {
    label: string;
    reason:
      | 'paused'
      | 'no_date'
      | 'irregular'
      | 'excluded_by_you'
      | 'already_seen'
      | 'already_prepared'
      | 'usual_like_it'; // RG1f
    text: string;
    adjustmentId?: string; // FC2: the line goes away when this adjustment is removed
  }[];
  // FC2: every active adjustment of these accounts, oldest first. One that touches nothing this
  // month (a date in another month, a day already passed) is only here, so it can still be removed.
  adjustments: ForecastAdjustment[];
};
export type ForecastInput = {
  accounts: { id: string; label: string; balanceCents: number }[];
  // null: the movements were not read
  movements:
    | {
        accountId: string;
        amountCents: number;
        description: string;
        createdAt: string;
        operationId?: string | null;
        fromAccountId?: string; // the app's record of an operation it sent (withCounterparties)
        toAccountId?: string;
      }[]
    | null;
  prepared: PreparedView[];
  adjustments?: ForecastAdjustment[]; // FC2: passed in; this module reads no database
  preparedOperationIds?: string[]; // RG1: operations sent from a prepared transfer, passed in
  goals?: { preparedId: string; goalId: string; name: string }[]; // RG1b: the goal of each, passed in
  today: string; // 'YYYY-MM-DD', Europe/Madrid
};

// TL1: exported, so the balance timeline applies the same twin rule after this month.
export const RULES = {
  months: 3, // full months a usual item must appear in, once each
  days: 5, // its days of the month lie within this many of each other
  share: 0.15, // its amounts lie within this share of their median
  lateDays: 7, // a usual charge not seen yet is kept on today for this long
  roundCents: 10_00, // a cover option is rounded up to this
  options: 2,
};
export const FORECAST_SOURCE_LINE =
  'Worked out by fixed rules from your movements and your prepared transfers. No AI is involved in these figures.';
// FC2: with an adjustment of the customer's, the line says so.
export const FORECAST_SOURCE_LINE_ADJUSTED =
  'Worked out by fixed rules from your movements, your prepared transfers and what you added or left out. No AI is involved in these figures.';
const NOTES = {
  no_history: 'Not enough history to find usual charges: only your prepared transfers are counted.',
  window_short:
    'Not enough history to find usual charges: only your prepared transfers are counted.',
  movements_unread:
    'Your movements could not be read just now: only your prepared transfers are counted.',
  none_regular: 'No regular income found; none is counted.',
};

const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options });
const DAY_MONTH = utc({ day: 'numeric', month: 'short' }); // 20 Oct
const MONTH = utc({ month: 'long' });
const dayMonth = (date: string) => DAY_MONTH.format(new Date(`${date}T00:00:00Z`));
const monthName = (month: string) => MONTH.format(new Date(`${month}-15T00:00:00Z`));
// Exact, never rounded (the format of src/observations/detect.ts); a negative keeps its sign.
const euros = (cents: number) =>
  `${cents < 0 ? '-' : ''}€${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
// FC1's twin rule (§5.1): a prepared payment within 15% and 5 days of a usual charge is that
// charge. Both are charges (negative cents) of one account; the caller checks the account.
export const isTwin = (
  prepared: { amountCents: number; date: string },
  usual: { amountCents: number; date: string },
) =>
  prepared.amountCents < 0 &&
  usual.amountCents < 0 &&
  Math.abs(prepared.amountCents - usual.amountCents) <= RULES.share * -usual.amountCents &&
  Math.abs(daysBetween(prepared.date, usual.date)) <= RULES.days;
const monthsBack = (month: string, n: number) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 - n, 1)).toISOString().slice(0, 7);
};
const lastDayOf = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
};
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const list = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

// "NOMINA JULIO ACME" and "NOMINA AGOSTO ACME" are one payer: month words leave the key.
// ponytail: Spanish and English month names and their three-letter forms; a merchant whose name
// holds one ("MAR DE PLATA") only loses that word, in every month alike, so it still groups.
const MONTH_WORD =
  /\b(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|SEPT|OCT|NOV|DIC|JAN|APR|AUG|DEC)\b/g;
export const usualKey = (description: string) =>
  merchantKey(description).replace(MONTH_WORD, ' ').replace(/\s+/g, ' ').trim();
// "DIGI SPAIN TELECOM" → "Digi Spain Telecom": the key itself, never a guessed brand.
const nameOf = (key: string) => key.toLowerCase().replace(/(^|[ &])[a-z]/g, (c) => c.toUpperCase());

type Usual = {
  accountId: string;
  key: string;
  label: string;
  income: boolean;
  day: number;
  cents: number; // signed
  seenOn: string[];
};
type Planned = Omit<ForecastEvent, 'balanceAfterCents'> & { accountId: string };

// The usual charges and the usual income of the three full months before `today`'s, and the
// credits that came in at least two of them without passing the test (`irregular`).
function usualItems(
  movements: NonNullable<ForecastInput['movements']>,
  months: string[],
): { usual: Usual[]; irregular: string[] } {
  const groups = new Map<string, { accountId: string; key: string; rows: [string, number][] }>();
  for (const m of movements) {
    const day = MADRID_DAY.format(new Date(m.createdAt));
    const key = usualKey(m.description);
    // An operation id is a transfer the app sent: the customer's own act, not a usual charge.
    if (m.operationId || !key || !m.amountCents || !months.includes(day.slice(0, 7))) continue;
    const id = `${m.accountId}\n${m.amountCents < 0 ? '-' : '+'}\n${key}`;
    if (!groups.has(id)) groups.set(id, { accountId: m.accountId, key, rows: [] });
    groups.get(id)!.rows.push([day, m.amountCents]);
  }
  const usual: Usual[] = [],
    irregular: string[] = [];
  for (const { accountId, key, rows } of groups.values()) {
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const income = rows[0][1] > 0;
    const days = rows.map(([day]) => Number(day.slice(8)));
    const cents = rows.map(([, c]) => Math.abs(c));
    const mid = median(cents);
    const regular =
      rows.length === months.length &&
      months.every((month, n) => rows[n][0].startsWith(month)) &&
      Math.max(...days) - Math.min(...days) <= RULES.days &&
      cents.every((c) => Math.abs(c - mid) <= RULES.share * mid);
    if (regular)
      usual.push({
        accountId,
        key,
        label: nameOf(key),
        income,
        // The cautious side of each: a charge at its highest, an income at its lowest and latest.
        day: income ? Math.max(...days) : median(days),
        cents: income ? Math.min(...cents) : -Math.max(...cents),
        seenOn: rows.map(([day]) => day),
      });
    else if (income && rows.length > 1 && !irregular.includes(nameOf(key)))
      irregular.push(nameOf(key));
  }
  return { usual, irregular };
}

// Debits before credits within a day; then by label, so the same input gives the same order.
const inOrder = (a: Planned, b: Planned) =>
  a.date.localeCompare(b.date) ||
  Math.sign(a.amountCents) - Math.sign(b.amountCents) ||
  a.label.localeCompare(b.label);
function project(balanceCents: number, today: string, planned: Planned[]) {
  let balance = balanceCents;
  let lowest = { date: today, balanceCents };
  const events = [...planned].sort(inOrder).map(({ accountId: _, ...e }): ForecastEvent => {
    balance += e.amountCents;
    if (balance < lowest.balanceCents) lowest = { date: e.date, balanceCents: balance };
    return { ...e, balanceAfterCents: balance };
  });
  return { events, lowest, endCents: balance };
}

export function monthForecast(i: ForecastInput): MonthForecast {
  const { today } = i;
  const month = today.slice(0, 7);
  const until = `${month}-${String(lastDayOf(month)).padStart(2, '0')}`;
  const own = new Map(i.accounts.map((a) => [a.id, a]));
  const planned: Planned[] = [];
  const notCounted: MonthForecast['notCounted'] = [];

  // Prepared transfers, by state (plan 28 §5.1). Never "scheduled" in a text (plan 25 D1).
  for (const p of i.prepared) {
    const label = `Prepared transfer to ${p.to} (${euros(p.amountCents)})`;
    if (p.state === 'paused' || p.state === 'ready') {
      const reason = p.state === 'paused' ? 'paused' : 'no_date';
      notCounted.push({
        label,
        reason,
        text: `${label}: ${reason === 'paused' ? 'paused' : 'no date set'}, not counted.`,
      });
      continue;
    }
    const date = p.state === 'scheduled' ? p.nextDue! : today;
    if (date > until) continue; // v1 stops at the month's end
    const event = { date, source: 'prepared', certainty: 'certain', preparedId: p.id } as const;
    if (own.has(p.fromAccountId))
      planned.push({
        ...event,
        accountId: p.fromAccountId,
        label: `Prepared transfer to ${p.to}`,
        amountCents: -p.amountCents,
      });
    // Between own accounts: one is debited, the other credited. Accounts are never netted.
    if (own.has(p.toAccountId))
      planned.push({
        ...event,
        accountId: p.toAccountId,
        label: `Prepared transfer from ${own.get(p.fromAccountId)?.label ?? 'another account'}`,
        amountCents: p.amountCents,
      });
  }

  // Usual items, or the reason there are none (silence rules).
  const months = [3, 2, 1].map((n) => monthsBack(month, n));
  let history: MonthForecast['history'] = { months };
  let found: ReturnType<typeof usualItems> = { usual: [], irregular: [] };
  if (!i.movements) history = { months: null, reason: 'movements_unread' };
  else {
    const { oldestAt, mayBeTruncated } = movementWindow(i.movements);
    const oldest = oldestAt && MADRID_DAY.format(new Date(oldestAt)).slice(0, 7);
    // A full page that does not start before the third month back may be missing its movements
    // (the guard of `category_up`, src/observations/detect.ts).
    if (mayBeTruncated && !(oldest && oldest < months[0]))
      history = { months: null, reason: 'window_short' };
    else if (!oldest || oldest > months[0]) history = { months: null, reason: 'no_history' };
    else found = usualItems(i.movements, months);
  }
  const seenThisMonth = new Set(
    (i.movements ?? [])
      .filter((m) => MADRID_DAY.format(new Date(m.createdAt)).startsWith(month))
      .map((m) => `${m.accountId}\n${m.amountCents < 0 ? '-' : '+'}\n${usualKey(m.description)}`),
  );
  // FC2: the customer's adjustments, of these accounts only.
  const adjustments = (i.adjustments ?? []).filter((a) => own.has(a.accountId));
  const excluded = new Set(
    adjustments.filter((a) => a.kind === 'exclude').map((a) => `${a.accountId}\n${a.merchantKey}`),
  );
  let incomeFound = false;
  for (const u of found.usual) {
    if (!own.has(u.accountId)) continue;
    // An income the customer left out is still an income the rule found: `income` stays
    // 'counted' and the line under `notCounted` says this one is not.
    incomeFound ||= u.income;
    if (excluded.has(`${u.accountId}\n${u.key}`)) continue; // FC2: "this is not regular"
    if (seenThisMonth.has(`${u.accountId}\n${u.income ? '+' : '-'}\n${u.key}`)) continue;
    const expected = `${month}-${String(Math.min(u.day, lastDayOf(month))).padStart(2, '0')}`;
    const late = expected < today;
    // Late income is not counted; a late charge stays on today for a week, then is dropped.
    if (late && (u.income || daysBetween(expected, today) > RULES.lateDays)) continue;
    // No double counting: the customer already prepared this payment as a transfer.
    const preparedTwin = planned.some(
      (e) =>
        e.source === 'prepared' &&
        e.accountId === u.accountId &&
        isTwin(e, { amountCents: u.cents, date: expected }),
    );
    if (preparedTwin) continue;
    planned.push({
      accountId: u.accountId,
      date: late ? today : expected,
      label: u.label,
      amountCents: u.cents,
      source: u.income ? 'usual_income' : 'usual_charge',
      certainty: 'estimated',
      merchantKey: u.key,
      seenOn: u.seenOn,
      usualDay: u.day,
      ...(late && {
        late: true,
        note: `Usually around the ${ordinal(u.day)}, not seen yet this month. An estimate.`,
      }),
    });
  }
  for (const label of found.irregular)
    notCounted.push({ label, reason: 'irregular', text: `${label}: not regular, not counted.` });
  // FC2: every exclusion is listed, so it can always be counted again.
  for (const a of adjustments.filter((a) => a.kind === 'exclude'))
    notCounted.push({
      label: a.label,
      reason: 'excluded_by_you',
      adjustmentId: a.id,
      text: `${a.label}: left out by you, not counted.`,
    });
  // FC2: a charge the customer expects. This month's occurrence if its day has not passed; a
  // one-off on its date if that is inside the month. No double counting (§5.1): one that a
  // movement of this month or a prepared transfer from the same account already is (within 15%
  // and 5 days) is listed instead of counted.
  // RG1: an expected income is the same with the signs turned: a credit, never a prepared twin.
  const dayIn = (day: number) =>
    `${month}-${String(Math.min(day, lastDayOf(month))).padStart(2, '0')}`;
  const dateOf = (a: ForecastAdjustment) => (a.repeats === 'monthly' ? dayIn(a.day!) : a.date!);
  const like = (a: ForecastAdjustment, otherCents: number, otherDate: string) =>
    Math.abs(otherCents - a.amountCents!) <= RULES.share * a.amountCents! &&
    Math.abs(daysBetween(otherDate, dateOf(a))) <= RULES.days;
  const seenLike = (a: ForecastAdjustment) =>
    (i.movements ?? []).some((m) => {
      const day = MADRID_DAY.format(new Date(m.createdAt));
      return (
        m.accountId === a.accountId &&
        (a.direction === 'income' ? m.amountCents > 0 : m.amountCents < 0) &&
        day.startsWith(month) &&
        like(a, Math.abs(m.amountCents), day)
      );
    });
  for (const a of adjustments.filter((a) => a.kind === 'expect')) {
    const cents = a.amountCents!;
    const income = a.direction === 'income';
    const date = dateOf(a);
    if (date < today || date > until) continue;
    const seen = seenLike(a);
    const prepared =
      !income &&
      planned.some(
        (e) =>
          e.source === 'prepared' &&
          e.accountId === a.accountId &&
          e.amountCents < 0 &&
          like(a, -e.amountCents, e.date),
      );
    // RG1f: nor one that a usual charge still counted this month already is (FC1's twin rule on
    // their usual days, as `regular` lists them), so the projection and the list agree.
    const usual =
      !income &&
      planned.some(
        (e) =>
          e.source === 'usual_charge' &&
          e.accountId === a.accountId &&
          isTwin(
            { amountCents: -cents, date },
            { amountCents: e.amountCents, date: dayIn(e.usualDay!) },
          ),
      );
    if (seen || prepared || usual) {
      const label = `${a.label} (${euros(cents)}, added by you)`;
      notCounted.push({
        label,
        reason: seen ? 'already_seen' : prepared ? 'already_prepared' : 'usual_like_it',
        adjustmentId: a.id,
        text: seen
          ? `${label}: ${income ? 'an income' : 'a payment'} like it is already in your movements this month, not counted twice.`
          : prepared
            ? `${label}: a prepared transfer like it is already counted, not counted twice.`
            : `${label}: a usual charge like it is already counted, not counted twice.`,
      });
      continue;
    }
    planned.push({
      accountId: a.accountId,
      date,
      label: a.label,
      amountCents: income ? cents : -cents,
      source: 'expected_by_you',
      certainty: 'estimated',
      adjustmentId: a.id,
    });
  }

  // RG1: the regular money of each account, and its irregular spend.
  const byDay = (a: RegularItem, b: RegularItem) =>
    a.usualDay - b.usualDay || a.label.localeCompare(b.label);
  const stateOf = (done: boolean, day: number): RegularItem['thisMonth'] =>
    done ? 'done' : dayIn(day) < today ? 'late' : 'to_come';
  // Operations with two legs on own accounts: the test classify.ts and activityRows use.
  const legs = new Map<string, number>();
  for (const m of i.movements ?? [])
    if (m.operationId && own.has(m.accountId))
      legs.set(m.operationId, (legs.get(m.operationId) ?? 0) + 1);
  const preparedOps = new Set(i.preparedOperationIds ?? []);
  const countedWith = new Map<string, NonNullable<ForecastAdjustment['countedWith']>>();
  const regularOf = (accountId: string): RegularMoney => {
    const detected = found.usual
      .filter((u) => u.accountId === accountId && !excluded.has(`${accountId}\n${u.key}`))
      .map((u): RegularItem => ({
        id: u.key,
        label: u.label,
        amountCents: u.cents,
        usualDay: u.day,
        source: 'detected',
        seenOn: u.seenOn,
        thisMonth: stateOf(
          seenThisMonth.has(`${accountId}\n${u.income ? '+' : '-'}\n${u.key}`),
          u.day,
        ),
        excludable: true,
      }));
    const monthly = adjustments.filter(
      (a) => a.kind === 'expect' && a.repeats === 'monthly' && a.accountId === accountId,
    );
    const added = monthly.map((a): RegularItem => ({
      id: a.id,
      label: a.label,
      amountCents: a.direction === 'income' ? a.amountCents! : -a.amountCents!,
      usualDay: a.day!,
      source: 'added_by_you',
      thisMonth: stateOf(seenLike(a), a.day!),
      excludable: false,
      adjustmentId: a.id,
    }));
    // RG1b: the monthly prepared transfers, on each own account they touch. Managed in Transfers
    // and Goals, so never excludable. Paused ones are left out, as the projection leaves them.
    const fromPrepared = i.prepared.flatMap((p): RegularItem[] => {
      // `when?`: the FC1 tests pass views built without it.
      if (p.when?.kind !== 'monthly' || p.state === 'paused') return [];
      const goal = i.goals?.find((g) => g.preparedId === p.id);
      const sent = !!p.lastSentAt && MADRID_DAY.format(new Date(p.lastSentAt)).startsWith(month);
      const item = {
        id: p.id,
        usualDay: p.when.day,
        source: 'prepared',
        thisMonth: sent ? 'done' : p.nextDue! <= until ? 'to_come' : 'next_month',
        excludable: false,
        nextDue: p.nextDue!,
        ...(goal && { goalId: goal.goalId }),
      } as const;
      return [
        ...(p.fromAccountId === accountId
          ? [
              {
                ...item,
                label: goal ? `Goal: ${goal.name}` : `To ${p.to}`,
                amountCents: -p.amountCents,
              },
            ]
          : []),
        ...(p.toAccountId === accountId
          ? [
              {
                ...item,
                label: goal
                  ? `Goal: ${goal.name}`
                  : `From ${own.get(p.fromAccountId)?.label ?? 'another account'}`,
                amountCents: p.amountCents,
              },
            ]
          : []),
      ];
    });
    // RG1c: a detected charge the customer also prepared is listed once, as the prepared item.
    const twins = (p: RegularItem, d: RegularItem) =>
      isTwin(
        { amountCents: p.amountCents, date: dayIn(p.usualDay) },
        { amountCents: d.amountCents, date: dayIn(d.usualDay) },
      );
    // RG1d: so is a monthly charge the customer added (isTwin is false for an income).
    // RG1e: one twin of a detected charge is that charge, listed once as the detected item (it
    // carries this month's real state), unless the projection counts the added one on its own
    // this month (RG1f: only when the detected twin is not counted, e.g. dropped as too late).
    const kept = [
      ...detected,
      ...added.filter(
        (a) => planned.some((e) => e.adjustmentId === a.id) || !detected.some((d) => twins(a, d)),
      ),
    ];
    const all = [
      ...kept.filter((d) => !fromPrepared.some((p) => twins(p, d))),
      // RG1c: the kept item says what this month really did (rent paid on the 1st is done), so
      // a payment made every month is not "next month" for being prepared. Only a prepared item
      // that starts next month takes it: one sent or still to come this month keeps its own state.
      ...fromPrepared.map((p) => {
        const twin = kept.find((d) => twins(p, d));
        return twin && p.thisMonth === 'next_month' ? { ...p, thisMonth: twin.thisMonth } : p;
      }),
    ];
    // RG1e: where each hidden added item is listed (a detected twin may itself be a prepared one).
    const shownAs = (d: RegularItem) => fromPrepared.find((p) => twins(p, d)) ?? d;
    for (const a of added) {
      const into = kept.includes(a)
        ? fromPrepared.find((p) => twins(p, a))
        : shownAs(detected.find((d) => twins(a, d))!);
      if (into)
        countedWith.set(a.id, {
          label: into.label,
          source: into.source === 'prepared' ? 'prepared' : 'detected',
        });
    }
    const chargeKeys = new Set(detected.filter((r) => r.amountCents < 0).map((r) => r.id));
    const addedCharges = monthly.filter((a) => a.direction !== 'income');
    let irregularSpend: RegularMoney['irregularSpend'] = null;
    if (history.months) {
      const spent: { cents: number; day: string }[] = [];
      for (const m of i.movements!) {
        const day = MADRID_DAY.format(new Date(m.createdAt));
        if (m.accountId !== accountId || m.amountCents >= 0) continue;
        if (!history.months.includes(day.slice(0, 7))) continue;
        if (chargeKeys.has(usualKey(m.description))) continue;
        const ownMove =
          (!!m.fromAccountId &&
            own.has(m.fromAccountId) &&
            !!m.toAccountId &&
            own.has(m.toAccountId)) ||
          (!!m.operationId && legs.get(m.operationId) === 2);
        if (ownMove || (m.operationId && preparedOps.has(m.operationId))) continue;
        spent.push({ cents: -m.amountCents, day });
      }
      // A charge the customer added as monthly takes at most one movement of each calendar month
      // as its payment: the closest in amount, then in days, within 15% and 5 days of its day
      // (that month's, or the one before or after, so the 30th is near the 1st). RG1e.
      const taken = new Set<(typeof spent)[number]>();
      for (const a of addedCharges)
        for (const ym of history.months) {
          const gap = (s: (typeof spent)[number]) =>
            Math.min(
              ...[-1, 0, 1].map((k) =>
                Math.abs(daysBetween(occurrence(`${ym}-01`, a.day!, k), s.day)),
              ),
            );
          const off = (s: (typeof spent)[number]) => Math.abs(s.cents - a.amountCents!);
          const best = spent
            .filter(
              (s) =>
                !taken.has(s) &&
                s.day.startsWith(ym) &&
                off(s) <= RULES.share * a.amountCents! &&
                gap(s) <= RULES.days,
            )
            .sort((x, y) => off(x) - off(y) || gap(x) - gap(y))[0];
          if (best) taken.add(best);
        }
      const total = spent.reduce((sum, s) => (taken.has(s) ? sum : sum + s.cents), 0);
      irregularSpend = {
        monthlyCents: Math.round(total / history.months.length),
        months: history.months,
      };
    }
    return {
      income: all.filter((r) => r.amountCents > 0).sort(byDay),
      charges: all.filter((r) => r.amountCents < 0).sort(byDay),
      irregularSpend,
    };
  };

  // RG1b: the first 7 days of next month. Each regular item's occurrence there (a prepared one's
  // next payment when that is already next month's), and a one-off prepared transfer dated there.
  const nextFirst = `${monthsBack(month, -1)}-01`;
  const nextLast = addDays(nextFirst, 6);
  const nextMonthOf = (accountId: string, regular: RegularMoney): NextMonthItem[] => {
    const items = [...regular.income, ...regular.charges].map((r) => ({
      date:
        r.source === 'prepared' && r.nextDue! >= nextFirst
          ? r.nextDue!
          : occurrence(nextFirst, r.usualDay),
      label: r.label,
      amountCents: r.amountCents,
      ...(r.source === 'prepared' && { preparedId: r.id }),
      ...(r.goalId && { goalId: r.goalId }),
      ...(r.adjustmentId && { adjustmentId: r.adjustmentId }),
    }));
    for (const p of i.prepared)
      if (p.when?.kind === 'on_date' && p.state !== 'paused') {
        const leg = { date: p.nextDue!, preparedId: p.id };
        if (p.fromAccountId === accountId)
          items.push({ ...leg, label: `To ${p.to}`, amountCents: -p.amountCents });
        if (p.toAccountId === accountId)
          items.push({
            ...leg,
            label: `From ${own.get(p.fromAccountId)?.label ?? 'another account'}`,
            amountCents: p.amountCents,
          });
      }
    return (
      items
        .filter((n) => n.date >= nextFirst && n.date <= nextLast)
        // RG1c: a detected item twin of a prepared one (a one-off's included) is listed once.
        .filter(
          (n, _, all) =>
            n.preparedId || n.adjustmentId || !all.some((p) => p.preparedId && isTwin(p, n)),
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            Math.sign(a.amountCents) - Math.sign(b.amountCents) ||
            a.label.localeCompare(b.label),
        )
    );
  };

  const span = history.months
    ? `${monthName(history.months[0])}–${monthName(history.months.at(-1)!)}`
    : '';
  const of = (accountId: string, extra: Planned[] = []) =>
    project(own.get(accountId)!.balanceCents, today, [
      ...planned.filter((e) => e.accountId === accountId),
      ...extra,
    ]);
  const accounts = i.accounts.map((a): ForecastAccount => {
    const { events, lowest, endCents } = of(a.id);
    const base = { id: a.id, label: a.label, balanceCents: a.balanceCents, endCents, lowest };
    const regular = regularOf(a.id);
    const nextMonth = nextMonthOf(a.id, regular);
    const crossing = events.findIndex((e) => e.balanceAfterCents < 0);
    if (crossing < 0) {
      const yours = events.filter((e) => e.source === 'expected_by_you').length;
      const estimated = events.filter((e) => e.certainty === 'estimated').length - yours;
      const payments = (n: number) => (n === 1 ? 'payment' : 'payments');
      return {
        ...base,
        shortfall: null,
        headline: `Covered until ${dayMonth(until)}`,
        explanation:
          `Lowest point ${euros(lowest.balanceCents)} on ${dayMonth(lowest.date)}.` +
          // FC2: what the customer added is counted apart: it is not a "usual" payment.
          (estimated && yours
            ? ` An estimate: it counts ${estimated} usual ${payments(estimated)} and ${yours} added by you.`
            : estimated
              ? ` An estimate: it counts ${estimated} usual ${payments(estimated)}.`
              : yours
                ? ` An estimate: it counts ${yours} ${payments(yours)} added by you.`
                : ''),
        options: [],
        events,
        regular,
        nextMonth,
      };
    }
    // The first day below zero, at its lowest that day (debits come before credits), and the
    // item that took it there. Every figure of the sentence is an event of this account.
    const first = events[crossing];
    const { date } = first;
    const shortCents = -Math.min(
      ...events.filter((e) => e.date === date).map((e) => e.balanceAfterCents),
    );
    // Certain only when nothing estimated is counted up to that point: the figure is then the
    // prepared transfers' own. With a usual item before it, the figure depends on it: estimated.
    // "That point" is the day's lowest, which the figure is: a usual charge of the same day that
    // comes after the item that crossed is in the figure, so it is named too (FC1 review).
    const lowestAt = events.findIndex(
      (e) => e.date === date && e.balanceAfterCents === -shortCents,
    );
    const before = events.slice(0, lowestAt + 1).filter((e) => e.certainty === 'estimated');
    const forLabel =
      first.source === 'prepared'
        ? `your prepared transfer to ${first.label.replace(/^Prepared transfer to /, '')}`
        : first.source === 'expected_by_you'
          ? `${first.label}, added by you`
          : `${first.label}, a usual charge`;
    const short = euros(shortCents);
    // FC2: the usual items "come as in July–September"; what the customer added only "comes",
    // named as their own, so it never reads as something the bank saw.
    const come = (names: string[]) => `${list(names)} ${names.length === 1 ? 'comes' : 'come'}`;
    const usualNamed = before
      .filter((e) => e.source !== 'expected_by_you')
      .map(
        (e) =>
          `${e.source === 'usual_income' ? 'your income from ' : ''}${e.label} (${euros(Math.abs(e.amountCents))}, around the ${ordinal(e.usualDay!)})`,
      );
    const yoursNamed = before
      .filter((e) => e.source === 'expected_by_you')
      .map(
        (e) =>
          `${e.amountCents > 0 ? 'your income from ' : ''}${e.label} (${euros(Math.abs(e.amountCents))}, on the ${ordinal(Number(e.date.slice(8)))}, added by you)`,
      );
    const conditions = [
      ...(usualNamed.length ? [`${come(usualNamed)} as in ${span}`] : []),
      ...(yoursNamed.length ? [come(yoursNamed)] : []),
    ].join(' and ');
    const explanation = before.length
      ? `If ${conditions}, on ${dayMonth(date)} you would be ${short} short for ${forLabel}. An estimate.`
      : `On ${dayMonth(date)} you are ${short} short for ${forLabel}. Your prepared transfers alone take this account below zero.`;
    // Ways to cover it (plan 28 D11): the lowest point of the month, rounded up, moved the day
    // before from another own account that stays at or above zero with it. Computed, not sent.
    const amountCents = Math.ceil(-lowest.balanceCents / RULES.roundCents) * RULES.roundCents;
    const moveOn = [today, addDays(date, -1)].sort()[1];
    const move = { date: moveOn, source: 'prepared', certainty: 'certain' } as const;
    const anyEstimated = events.some((e) => e.certainty === 'estimated');
    const after = of(a.id, [{ ...move, accountId: a.id, label: '', amountCents }]).lowest;
    const options = i.accounts
      .filter(
        (b) =>
          b.id !== a.id &&
          // At the limit POST /api/prepared answers 409 `too_many`: no option is offered.
          i.prepared.length < MAX_ACTIVE &&
          // It must cover: a shortfall of today is not covered by a move of today (debits come
          // first within a day), so it gets no option; `prepared_uncovered` names that one.
          after.balanceCents >= 0 &&
          of(b.id, [{ ...move, accountId: b.id, label: '', amountCents: -amountCents }]).lowest
            .balanceCents >= 0,
      )
      .slice(0, RULES.options)
      .map((b): CoverOption => ({
        id: `move:${b.id}`,
        title: `Move ${euros(amountCents)} from ${b.label} on ${dayMonth(moveOn)}`,
        consequence: `Lowest point ${euros(after.balanceCents)} on ${dayMonth(after.date)}.${anyEstimated ? ' An estimate.' : ''}`,
        change: { kind: 'add', date: moveOn, amountCents, label: `From ${b.label}` },
        prepare: {
          fromAccountId: b.id,
          toAccountId: a.id,
          amountCents,
          concept: `Cover for ${dayMonth(date)}`,
          when: 'on_date',
          date: moveOn,
        },
      }));
    return {
      ...base,
      shortfall: {
        date,
        shortCents,
        certainty: before.length ? 'estimated' : 'certain',
        forLabel,
        ...(first.preparedId && { preparedId: first.preparedId }),
      },
      headline: `${short} short on ${dayMonth(date)}`,
      explanation,
      options,
      events,
      regular,
      nextMonth,
    };
  });
  // An account that goes short first (the earliest first), then the ones with most to come:
  // the bank's order of accounts is not fixed, and a page prints the first one's verdict.
  accounts.sort(
    (a, b) =>
      (a.shortfall?.date ?? '9').localeCompare(b.shortfall?.date ?? '9') ||
      b.events.length - a.events.length,
  );
  return {
    adjustable: true,
    today,
    until,
    history,
    income: incomeFound ? 'counted' : 'none_regular',
    notes: history.months ? (incomeFound ? [] : [NOTES.none_regular]) : [NOTES[history.reason]],
    sourceLine: adjustments.length ? FORECAST_SOURCE_LINE_ADJUSTED : FORECAST_SOURCE_LINE,
    accounts,
    notCounted,
    adjustments: adjustments.map((a) =>
      countedWith.has(a.id) ? { ...a, countedWith: countedWith.get(a.id) } : a,
    ),
  };
}
