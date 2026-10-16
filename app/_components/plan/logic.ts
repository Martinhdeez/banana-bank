// UI1 (plan 28): what the Plan tab works out in the browser. Presentation and previews only
// (D8): the ghost line of a cover option and the what-if of a goal are arithmetic over what the
// routes returned, and change no stored figure. No React here, so node:test reads it directly.
import { centsFromEuros, formatDate, formatDay, money } from '../../../src/ui-helpers';
import type {
  Brief,
  CoverOption,
  ForecastAccount,
  ForecastAdjustment,
  ForecastEvent,
  GoalState,
  GoalView,
  GoalsResponse,
  MonthForecast,
  Regular,
  RegularItem,
  Timeline,
  TimelineRange,
} from './types';

// §6.1, interface strings.
export const PREPARED_LINE = 'Prepared. Nothing is sent until you confirm it in Transfers.';

export const eur = money; // exact, as the server's texts print amounts
export const eurShort = (cents: number) => money(cents).replace(/\.00$/, ''); // axes and big figures
export const signed = (cents: number) => `${cents > 0 ? '+' : ''}${money(cents)}`;
export const day = (date: string) => formatDay(date, new Date(`${date.slice(0, 4)}-06-15`)); // "20 Oct"
// As the server's fixed texts print a day (GL1): with its year only when that is not the year of
// `today`: "7 Mar 2027" read in 2026, "7 Sep" read in the same year.
export const dayYear = (date: string, today: string) =>
  date.slice(0, 4) === today.slice(0, 4) ? day(date) : formatDate(`${date}T12:00:00Z`, false);
export const dayOf = (date: string) => Number(date.slice(8, 10));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthIndex = (date: string) =>
  Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const monthName = (i: number, year = false) =>
  `${MONTHS[i % 12]}${year ? ` ${Math.floor(i / 12)}` : ''}`;

// ── Feature detection: the branch is safe on a server without FC1, GL1 or PL1. ──
type Dash = Record<string, unknown> | null | undefined;
// `forecast` is absent on a server without FC1 and null when it could not be worked out.
export const forecastOf = (d: Dash) => d?.forecast as MonthForecast | null | undefined;
export const briefOf = (d: Dash) => (d?.brief ?? null) as Brief | null;
// GET /api/goals is asked only of a server of this round: on an older one it would be a 404 on
// every first load (tests/e2e/first-load: "no 4xx/5xx responses on first load").
export const asksGoals = (d: Dash) => !!d && ('forecast' in d || 'brief' in d);
// The nav entry and the tab: at least one of the two parts is there for this customer.
export const planParts = (d: Dash, goals: GoalsResponse | null | undefined) => ({
  forecast: forecastOf(d) !== undefined && !!d,
  goals: !!goals,
});
export const planAvailable = (d: Dash, goals: GoalsResponse | null | undefined) => {
  const parts = planParts(d, goals);
  return parts.forecast || parts.goals;
};

// ── Month ahead ──
export type Frame = {
  events: (ForecastEvent & { added?: boolean })[];
  lowest: { date: string; balanceCents: number };
  endCents: number;
};
// The server's order (src/forecast/month.ts): by day, debits before credits, then by label.
const inOrder = (a: ForecastEvent, b: ForecastEvent) =>
  a.date.localeCompare(b.date) ||
  Math.sign(a.amountCents) - Math.sign(b.amountCents) ||
  a.label.localeCompare(b.label);
// The account's projection with one more transfer coming in, applied by `t` (0: as it is, 1: all
// of it). The same sum as the server's: today's balance, then each event in order.
export function frameOf(
  account: ForecastAccount,
  today: string,
  change: CoverOption['change'] | null = null,
  t = 1,
): Frame {
  const events: Frame['events'] = account.events.map((e) => ({ ...e }));
  if (change && t > 0)
    events.push({
      date: change.date,
      label: change.label,
      amountCents: Math.round(change.amountCents * t),
      balanceAfterCents: 0,
      source: 'prepared',
      certainty: 'certain',
      added: true,
    });
  events.sort(inOrder);
  let balance = account.balanceCents;
  let lowest = { date: today, balanceCents: balance };
  for (const e of events) {
    e.balanceAfterCents = balance += e.amountCents;
    if (balance < lowest.balanceCents) lowest = { date: e.date, balanceCents: balance };
  }
  return { events, lowest, endCents: balance };
}
// The account without the events of one prepared transfer: what it was before "Prepare this",
// so Undo can play the line back from the server's own figures.
export const withoutPrepared = (account: ForecastAccount, preparedId: string): ForecastAccount => ({
  ...account,
  events: account.events.filter((e) => e.preparedId !== preparedId),
});
export const isEstimated = (account: ForecastAccount) =>
  account.events.some((e) => e.certainty === 'estimated');
// The readout of a previewed option. A figure worked out here from estimated items says so.
export const previewLine = (
  account: ForecastAccount,
  frame: Frame,
  estimate = isEstimated(account),
) => `${eur(frame.lowest.balanceCents)} with this change${estimate ? '. An estimate.' : ''}`;
// The first short account, else the first: whose verdict the Overview card prints (§6.4).
export const verdictAccount = (f: MonthForecast) =>
  f.accounts.find((a) => a.shortfall) ?? f.accounts[0];
const SOURCE = {
  prepared: 'Prepared transfer · you confirm it',
  usual_charge: 'Usual charge · an estimate',
  usual_income: 'Usual income · an estimate',
  expected_by_you: 'Added by you · estimated',
};
export const sourceWords = (e: ForecastEvent & { added?: boolean }) =>
  `${SOURCE[e.source]}${e.seenOn?.length ? ` · seen on ${e.seenOn.map(day).join(', ')}` : ''}`;
// "Prepare this" left a prepared transfer; its confirmation line (with Undo) holds only while
// the forecast still counts that transfer. Sent or deleted in Transfers, it is in no event.
export const hasPrepared = (f: MonthForecast, preparedId: string) =>
  f.accounts.some((a) => a.events.some((e) => e.preparedId === preparedId));

// ── The chart of Month ahead: its scale, and where the few words beside a dot may go. Nothing is
// measured in the page: coordinates are the plotted ones, a text is as wide as its characters. ──
export type Box = { x1: number; y1: number; x2: number; y2: number };
export function balanceScale(width: number, today: string, until: string, [lo, hi]: number[]) {
  const d0 = dayOf(today),
    d1 = Math.max(dayOf(until), d0 + 1);
  const wide = width >= 520;
  const H = wide ? 340 : 270;
  const m = { l: 60, r: 24, t: 40, b: 32 };
  const range = hi - lo || 1;
  const yMin = lo - range * (lo < 0 ? 0.2 : 0.08),
    yMax = hi + range * 0.22;
  const x = (d: number) => m.l + ((d - d0) / (d1 - d0)) * (width - m.l - m.r);
  const linear = (cents: number) => H - m.b - ((cents - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  // A dip that is small beside the balance (€28 under €2,900) still has to be seen: anything
  // below zero is drawn at least 12px under the zero line. Its figure is in the tag and the list.
  const y = (cents: number) =>
    cents < 0 ? Math.max(linear(cents), linear(0) + 12) : linear(cents);
  return { d0, d1, wide, H, m, range, yMin, yMax, x, y };
}
export const LABEL_CHAR = 6.2; // px per character of the chart's 11px text
const LABEL_GAP = 8,
  LABEL_UP = 9, // the text's box around its baseline
  LABEL_DOWN = 3;
const overlaps = (a: Box, b: Box, pad = 3) =>
  a.x1 - pad < b.x2 && b.x1 < a.x2 + pad && a.y1 - pad < b.y2 && b.y1 < a.y2 + pad;
export type LabelPlace = { x: number; y: number; anchor: 'start' | 'end' | 'middle'; box: Box };
// Each label, in the order given (the first has the first choice): above-right of its dot, then
// above-left, then below. One that would still lie on something drawn (a segment of the line, a
// dot, another label, a tag) or leave the plot is dropped: null. The dot and its tooltip stay.
export function placeLabels(
  labels: ({ x: number; y: number; width: number } | null)[],
  plot: Box,
  drawn: Box[],
) {
  const taken = [...drawn];
  return labels.map((l) => {
    if (!l) return null;
    const up = l.y - LABEL_GAP,
      down = l.y + LABEL_GAP + LABEL_UP + 2;
    const tries: [LabelPlace['anchor'], number, number, number][] = [
      ['start', l.x + LABEL_GAP, l.x + LABEL_GAP, up],
      ['end', l.x - LABEL_GAP, l.x - LABEL_GAP - l.width, up],
      ['middle', l.x, l.x - l.width / 2, down],
    ];
    for (const [anchor, x, left, y] of tries) {
      const box = { x1: left, x2: left + l.width, y1: y - LABEL_UP, y2: y + LABEL_DOWN };
      if (box.x1 < plot.x1 || box.x2 > plot.x2 || box.y1 < plot.y1 || box.y2 > plot.y2) continue;
      if (taken.some((t) => overlaps(box, t))) continue;
      taken.push(box);
      return { x, y, anchor, box } as LabelPlace;
    }
    return null;
  });
}
// The labels of one frame of the chart. The key events carry a few words: prepared transfers,
// the lowest point, the large ones; the lowest point chooses first, then the order of the month.
export function eventLabels(
  frame: Frame,
  startCents: number,
  scale: ReturnType<typeof balanceScale>,
  width: number,
) {
  const { x, y, m, H, wide, range, d0, d1 } = scale;
  const low = frame.lowest;
  const drawn: Box[] = [{ x1: m.l, x2: width - m.r, y1: y(0), y2: y(0) }];
  let px = x(d0),
    py = y(startCents);
  for (const e of frame.events) {
    const ex = x(dayOf(e.date)),
      ey = y(e.balanceAfterCents);
    drawn.push(
      { x1: px, x2: ex, y1: py, y2: py },
      { x1: ex, x2: ex, y1: Math.min(py, ey), y2: Math.max(py, ey) },
      { x1: ex - 5, x2: ex + 5, y1: ey - 5, y2: ey + 5 },
    );
    px = ex;
    py = ey;
  }
  drawn.push({ x1: px, x2: x(d1), y1: py, y2: py });
  if (low.balanceCents < 0) {
    // The "€… short" tag under the lowest point.
    const cx = Math.max(m.l + 60, Math.min(width - m.r - 60, x(dayOf(low.date))));
    drawn.push({
      x1: cx - 60,
      x2: cx + 60,
      y1: y(low.balanceCents) + 12,
      y2: y(low.balanceCents) + 34,
    });
  }
  const text = (e: ForecastEvent) =>
    `${shortLabel(e.label)}${wide ? ` ${signed(e.amountCents)}` : ''}`;
  const key = (e: ForecastEvent) =>
    e.source === 'prepared' || e.date === low.date || (wide && Math.abs(e.amountCents) > range / 4);
  const order = frame.events
    .map((e, i) => i)
    .filter((i) => key(frame.events[i]))
    .sort(
      (a, b) =>
        Number(frame.events[b].date === low.date) - Number(frame.events[a].date === low.date),
    );
  const placed = placeLabels(
    order.map((i) => {
      const e = frame.events[i];
      return { x: x(dayOf(e.date)), y: y(e.balanceAfterCents), width: text(e).length * LABEL_CHAR };
    }),
    // Under the "Today" word, above the day numbers, right of the today line.
    { x1: m.l + 4, x2: width - m.r, y1: 22, y2: H - m.b - 2 },
    drawn,
  );
  const labels: (LabelPlace | null)[] = frame.events.map(() => null);
  order.forEach((i, n) => (labels[i] = placed[n]));
  return labels;
}
// The few words drawn beside a dot of the chart.
export const shortLabel = (label: string) => {
  const m = /^Prepared transfer (to|from) (\S+)/.exec(label);
  const text = m ? `${m[1] === 'to' ? 'To' : 'From'} ${m[2]}` : label;
  return text.length > 16 ? `${text.slice(0, 15).trimEnd()}…` : text;
};

// ── Goals (§5.2) ──
// The occurrence of anchor `day`, `months` after the month of `date`: day 31 is 30 Nov, 28 Feb.
export function occurrence(date: string, anchor: number, months = 0) {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + months, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(anchor, last))).toISOString().slice(0, 10);
}
// The monthly occurrences from the next due to the target date, at least 1.
export function paymentsLeft(nextDue: string, anchor: number, targetDate: string) {
  let n = 1;
  while (n < 600 && occurrence(nextDue, anchor, n) <= targetDate) n++;
  return n;
}
const anchorOf = (g: GoalView) =>
  g.prepared?.when.kind === 'monthly' ? g.prepared.when.day : dayOf(g.prepared?.nextDue ?? '01');
// What a monthly amount does to a goal that has a monthly transfer: null without one.
export function whatIf(goal: GoalView, monthlyCents: number) {
  const nextDue = goal.prepared?.nextDue;
  if (!nextDue || monthlyCents <= 0 || goal.remainingCents <= 0) return null;
  const anchor = anchorOf(goal);
  const left = paymentsLeft(nextDue, anchor, goal.targetDate);
  const payments = Math.ceil(goal.remainingCents / monthlyCents);
  // §5.2: behind = remaining − monthly × payments left, never below 0; projected = target − behind.
  const shortCents = Math.max(0, goal.remainingCents - monthlyCents * left);
  return {
    day: anchor,
    payments,
    lastDue: occurrence(nextDue, anchor, payments - 1),
    monthsLate: payments - left, // negative: early
    shortCents,
    projectedCents: goal.targetCents - shortCents,
  };
}
export const lateWords = (months: number) =>
  months === 0
    ? 'on time'
    : `${Math.abs(months)} month${Math.abs(months) === 1 ? '' : 's'} ${months > 0 ? 'late' : 'early'}`;
// The slider's range: from a quarter of what the date asks to three times it, in whole €5.
export function sliderRange(goal: GoalView) {
  const base = goal.requiredMonthlyCents ?? goal.monthlyCents ?? 10000;
  const step = 500;
  const min = Math.max(
    step,
    Math.floor(Math.min(base, goal.monthlyCents ?? base) / 2 / step) * step,
  );
  const max = Math.max(
    min + step,
    Math.min(goal.remainingCents, Math.ceil((base * 2) / step) * step),
  );
  return { min, max, step };
}
// The amounts the rules name, as snap points of the slider.
export const snapPoints = (goal: GoalView) =>
  [
    ...new Set([
      goal.monthlyCents,
      ...[goal.suggestion, goal.alternative].map((s) =>
        s && 'monthlyCents' in s ? s.monthlyCents : null,
      ),
    ]),
  ].filter((c): c is number => !!c);
// A room of zero or less (more went out than came in over those months) is said in words: a
// figure with a minus sign is never presented as what was "left". No number is made up for it.
export const roomWords = (room: NonNullable<GoalsResponse['room']>) =>
  room.monthlyCents > 0
    ? null
    : `Over your last ${room.months} full ${room.months === 1 ? 'month' : 'months'} nothing was left over in a usual month.`;
export const fitsLine = (fits: boolean | null, room: GoalsResponse['room']) =>
  fits === null || !room
    ? 'Not enough history yet to compare with what you usually have left each month.'
    : fits
      ? `Within what you usually have left each month (about ${eurShort(room.monthlyCents)}).`
      : room.monthlyCents > 0
        ? `More than you usually have left each month (about ${eurShort(room.monthlyCents)}).`
        : 'More than you usually have left each month.';

export const STATES: Record<GoalState, { label: string; tone: string; icon: string }> = {
  on_track: { label: 'On plan', tone: 'ok', icon: 'check' },
  behind: { label: 'Behind plan', tone: 'warn', icon: 'alert' },
  no_plan: { label: 'No monthly transfer', tone: 'quiet', icon: 'pause' },
  date_passed: { label: 'Date passed', tone: 'warn', icon: 'calendar' },
  reached: { label: 'Reached', tone: 'done', icon: 'check' },
};
const ATTENTION: GoalState[] = ['behind', 'date_passed', 'no_plan', 'on_track', 'reached'];
export const topGoal = (goals: GoalView[]) =>
  [...goals].sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state))[0];
// What the plan asked for up to this month: where the "Today" pin of the track stands.
export const plannedSoFar = (g: GoalView) =>
  Math.min(
    g.targetCents,
    g.history.reduce((sum, h) => sum + h.plannedCents, 0),
  );
// Months confirmed in a row, newest first.
export function streak(g: GoalView) {
  let n = 0;
  for (let i = g.history.length - 1; i >= 0; i--) {
    const h = g.history[i];
    if (!h.plannedCents) continue; // a month with nothing due neither breaks nor counts
    if (h.savedCents < h.plannedCents) break;
    n++;
  }
  return n;
}
// The icon is the interface's (§6.4): from the words of the name, else the target.
const ICONS: [RegExp, string][] = [
  [/trip|travel|holiday|flight|japan|summer/i, 'plane'],
  [/emergenc|cushion|safety|rainy/i, 'shield'],
  [/bike|bicycle/i, 'bike'],
  [/sofa|couch|furniture|home|flat/i, 'sofa'],
  [/laptop|computer|phone|tablet/i, 'laptop'],
  [/camera|photo/i, 'camera'],
];
export const goalIcon = (name: string) => ICONS.find(([re]) => re.test(name))?.[1] ?? 'target';
// The state of the goal's prepared transfer in words (as the Transfers tab says it).
export function preparedWords(p: NonNullable<GoalView['prepared']>, today: string) {
  switch (p.state) {
    case 'verifying':
      return 'Sent · the bank has not confirmed it yet';
    case 'awaiting_confirmation':
      return 'Waiting for your confirmation in Transfers';
    case 'paused':
      return 'Paused · nothing becomes due until you resume';
    case 'due':
      return p.nextDue === today
        ? 'Due today · to confirm'
        : `Due since ${dayYear(p.nextDue!, today)} · to confirm`;
    default:
      return p.nextDue
        ? `Next due ${dayYear(p.nextDue, today)} · you confirm it`
        : 'Ready when you are';
  }
}

// ── Forecast adjustments (FC2): leave a usual item out, add an expected charge. ──
// Offered only when the server says so. Nothing else is a marker: FC1 sends `merchantKey` on
// every usual item and has no route to exclude one.
export const isAdjustable = (f: MonthForecast) => f.adjustable === true;
// The active adjustments that no row of the screen shows: not an event of any account, not a
// "Not counted" row (an expected charge dated next month, a monthly day already passed). They
// count against the cap of 20, so each is listed with its way out.
export function hiddenAdjustments(f: MonthForecast) {
  const shown = new Set(
    [...f.accounts.flatMap((a) => a.events), ...f.notCounted].map((x) => x.adjustmentId),
  );
  return (f.adjustments ?? []).filter((a) => !shown.has(a.id));
}
const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
// One adjustment in words.
export const adjustmentWords = (a: ForecastAdjustment, today: string) =>
  a.kind === 'exclude'
    ? `Left out: ${a.label}`
    : a.repeats === 'monthly'
      ? `Expected: ${a.label}, ${eur(a.amountCents ?? 0)} on the ${ordinal(a.day ?? 1)} of each month`
      : `Expected once: ${a.label}, ${eur(a.amountCents ?? 0)} on ${dayYear(a.date ?? today, today)}`;
// The account without one usual item: the line while the server answers an exclude.
export const withoutEvent = (account: ForecastAccount, event: ForecastEvent): ForecastAccount => ({
  ...account,
  events: account.events.filter(
    (e) =>
      !(e.merchantKey === event.merchantKey && e.date === event.date && e.label === event.label),
  ),
});
// ── Regular money (RG2): the words and sums of the section; every figure is the server's. ──
export const aroundDay = (n: number) => `around the ${ordinal(n)}`;
const shortMonth = (date: string) => monthName(monthIndex(date));
export const seenWords = (item: RegularItem) =>
  item.source === 'prepared'
    ? `prepared${item.goalId ? ' · goal' : ''}`
    : item.source === 'added_by_you'
      ? 'added by you'
      : `detected${item.seenOn?.length ? ` · seen ${item.seenOn.map(shortMonth).join(', ')}` : ''}`;
// RG2b: "a month" is what this month holds; an item that starts next month is summed apart.
const sum = (items: RegularItem[]) => items.reduce((s, i) => s + i.amountCents, 0);
export const regularTotal = (items: RegularItem[]) =>
  sum(items.filter((i) => i.thisMonth !== 'next_month'));
export const fromNextMonth = (items: RegularItem[]) =>
  sum(items.filter((i) => i.thisMonth === 'next_month'));
const THIS_MONTH: Record<RegularItem['thisMonth'], { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'ok' },
  to_come: { label: 'Coming', tone: 'quiet' },
  late: { label: 'Late', tone: 'warn' },
  next_month: { label: 'Next month', tone: 'quiet' },
};
// The this-month chip; a prepared item that starts next month names its first day.
export const chipOf = (item: RegularItem) =>
  item.thisMonth === 'next_month' && item.nextDue
    ? { label: `Starts ${day(item.nextDue)}`, tone: 'quiet' }
    : THIS_MONTH[item.thisMonth];
export function irregularWords({ monthlyCents, months }: NonNullable<Regular['irregularSpend']>) {
  const first = shortMonth(months[0]),
    last = shortMonth(months[months.length - 1]);
  return `Irregular spending: about ${eurShort(Math.round(monthlyCents / 100) * 100)} a month over ${first === last ? first : `${first}–${last}`}`;
}

// Only if a 400 came with no sentence at all.
export const LABEL_HINT = 'Use plain letters, numbers and punctuation in the name.';
export type ExpectForm = {
  label: string;
  amount: string;
  repeats: 'once' | 'monthly';
  date: string;
  day: string;
};
const plusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const lastExpectDate = (today: string) => plusDays(today, 366);
// The form's own checks, in the order of its fields; the server checks again.
export function expectErrors(form: ExpectForm, today: string) {
  const cents = centsFromEuros(form.amount);
  const dayNumber = Number(form.day);
  return {
    // A name the server refuses (a control or bidirectional-override character, 400) is said
    // in the server's words under this field, not guessed here.
    label: form.label.trim() ? '' : 'Give it a name, for example Car insurance.',
    amount: cents && cents > 0 ? '' : 'Enter an amount in euros, for example 420 or 12.50.',
    date:
      form.repeats !== 'once' || (form.date >= today && form.date <= lastExpectDate(today))
        ? ''
        : 'Choose a date from today to one year ahead.',
    day:
      form.repeats !== 'monthly' ||
      (/^\d{1,2}$/.test(form.day.trim()) && dayNumber >= 1 && dayNumber <= 31)
        ? ''
        : 'A day of the month from 1 to 31.',
  };
}
// The request body of a valid form, and where the item falls in this month's forecast (null:
// outside it, so there is nothing to preview).
export function expectOf(form: ExpectForm, f: MonthForecast, accountId: string) {
  if (Object.values(expectErrors(form, f.today)).some(Boolean)) return null;
  const amountCents = centsFromEuros(form.amount)!;
  const label = form.label.trim();
  const date = form.repeats === 'once' ? form.date : occurrence(f.today, Number(form.day));
  return {
    body:
      form.repeats === 'once'
        ? { kind: 'expect' as const, accountId, label, amountCents, repeats: 'once' as const, date }
        : {
            kind: 'expect' as const,
            accountId,
            label,
            amountCents,
            repeats: 'monthly' as const,
            day: Number(form.day),
          },
    change:
      date >= f.today && date <= f.until
        ? { kind: 'add' as const, date, amountCents: -amountCents, label }
        : null,
  };
}

// ── Balance timeline (TL2): the range control, the chart's layout and the line under it. ──
export const RANGES: [TimelineRange, string][] = [
  ['this_week', 'This week'],
  ['last_week', 'Last week'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['next_month', 'Next month'],
  ['last_3_months', 'Last 3 months'],
  ['next_3_months', 'Next 3 months'],
  ['last_6_months', 'Last 6 months'],
  ['next_6_months', 'Next 6 months'],
];
const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const line = (xy: [number, number][]) =>
  xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
// Where everything of the chart goes, from the route's points alone: the past (actual) as one
// line, the future from Today on as another, so both meet at Today; the future below zero as an
// area closed on the zero line; a dot per event at its day's balance. `change` previews one more
// amount from its day on (a cover option, an expected item), as the same daily sum.
export function timelineLayout(
  t: Timeline,
  width: number,
  change: { date: string; amountCents: number } | null = null,
) {
  const H = width >= 520 ? 320 : 260;
  const m = { l: 56, r: 16, t: 28, b: 30 };
  const span = Math.max(1, (Date.parse(t.to) - Date.parse(t.from)) / DAY);
  const x = (date: string) =>
    r1(m.l + ((Date.parse(date) - Date.parse(t.from)) / DAY / span) * (width - m.l - m.r));
  const future = t.points.filter((p) => p.date >= t.today);
  const ghostOn = !!change && change.date >= t.today && change.date <= t.to && future.length > 0;
  const shifted = (p: Timeline['points'][number]) =>
    p.balanceCents + (ghostOn && p.date >= change!.date ? change!.amountCents : 0);
  // TL2b item 6, TL1 rule 6: the lowest point can fall inside its day (debits before credits):
  // the marker goes to that day's `lowCents`, unless it is only the day before's end (a day of
  // money coming in), where it stays on the line. The line itself keeps the ends of day.
  const lowIdx = t.lowest ? t.points.findIndex((p) => p.date === t.lowest!.date) : -1;
  const lowPoint = t.points[lowIdx];
  const lowCents =
    lowPoint &&
    (lowPoint.lowCents !== undefined && lowPoint.lowCents !== t.points[lowIdx - 1]?.balanceCents
      ? lowPoint.lowCents
      : lowPoint.balanceCents);
  const values = [
    0,
    ...t.points.map((p) => p.balanceCents),
    ...(ghostOn ? future.map(shifted) : []),
    ...(lowPoint ? [lowCents!] : []),
  ];
  const lo = Math.min(...values),
    hi = Math.max(1, ...values);
  const range = hi - lo || 1;
  const yMin = lo - range * (lo < 0 ? 0.15 : 0.06),
    yMax = hi + range * 0.12;
  const y = (cents: number) => r1(H - m.b - ((cents - yMin) / (yMax - yMin)) * (H - m.t - m.b));
  const xy = (p: Timeline['points'][number], cents = p.balanceCents): [number, number] => [
    x(p.date),
    y(cents),
  ];
  const actual = t.points.filter((p) => p.actual && p.date <= t.today);
  const today = t.points.find((p) => p.date === t.today);
  const zeroY = y(0);
  const below = future.some((p) => p.balanceCents < 0);
  const projected = line(future.map((p) => xy(p)));
  const step =
    [5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1000000].find(
      (s) => range / s <= 4,
    ) ?? 2000000;
  const yTicks: { y: number; label: string }[] = [];
  for (let v = Math.ceil(yMin / step) * step; v < yMax; v += step)
    if (v !== 0 && Math.abs(y(v) - zeroY) > 14) yTicks.push({ y: y(v), label: eurShort(v) });
  // A period of more than one month is divided by month: a line at each first day, the month's
  // name over its part. A shorter one has its two ends and Today on the axis.
  const firsts = t.points.map((p) => p.date).filter((d) => d.endsWith('-01') && d > t.from);
  const multi = span > 31; // a week across two months stays one piece
  const starts = [t.from, ...firsts];
  const monthBands = multi
    ? starts.map((d, i) => {
        const x1 = x(d),
          x2 = i + 1 < starts.length ? x(starts[i + 1]) : x(t.to);
        return { x1, x2, label: monthName(monthIndex(d)), boundary: i > 0 };
      })
    : [];
  const xMarks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[] = [];
  if (!multi) {
    xMarks.push({ x: x(t.from), label: day(t.from), anchor: 'start' });
    if (
      t.today > t.from &&
      t.today < t.to &&
      x(t.today) - x(t.from) >= 52 &&
      x(t.to) - x(t.today) >= 52
    )
      xMarks.push({ x: x(t.today), label: day(t.today), anchor: 'middle' });
    xMarks.push({ x: x(t.to), label: day(t.to), anchor: 'end' });
  }
  const balanceOn = new Map(t.points.map((p) => [p.date, p.balanceCents]));
  return {
    H,
    m,
    width,
    x,
    y,
    zeroY,
    actual: line(actual.map((p) => xy(p))),
    projected,
    todayX: today ? x(today.date) : null,
    todayY: today ? y(today.balanceCents) : null,
    // The elapsed part, from the start to Today: a quiet band, like a progress bar.
    elapsed: today && t.today > t.from ? { x1: x(t.from), x2: x(today.date) } : null,
    monthBands,
    shortArea:
      below && future.length
        ? `${projected}L${x(future[future.length - 1].date)},${zeroY}L${x(future[0].date)},${zeroY}Z`
        : null,
    ghost: ghostOn ? line(future.map((p) => xy(p, shifted(p)))) : null,
    lowest: lowPoint ? { x: x(lowPoint.date), y: y(lowCents!), cents: lowCents! } : null,
    dots: timelineEvents(t).map((event) => ({
      event,
      x: x(event.date),
      y: y(balanceOn.get(event.date)!),
    })),
    yTicks,
    xMarks,
  };
}
// The events drawn as dots and listed under the chart (TL2b). Everyday spending is spread over
// every day (an estimate): no dot of its own.
export function timelineEvents(t: Timeline) {
  const on = new Set(t.points.map((p) => p.date));
  return t.events.filter((e) => e.source !== 'everyday' && on.has(e.date));
}
// TL2b, TL1 rule 3: a month that ends today ends after today's pending items, so its end can
// differ from today's point (the bank balance); said only then.
export function endsAfterPending(t: Timeline, mo: Timeline['months'][number]) {
  const today = t.points.find((p) => p.date === t.today);
  return mo.to === t.today && !!today && mo.endBalanceCents !== today.balanceCents;
}
const about = (cents: number) => eurShort(Math.round(cents / 100) * 100);
export const basisWords = (b: NonNullable<Timeline['basis']>) => {
  const first = b.months.length ? monthName(monthIndex(b.months[0])) : '',
    last = b.months.length ? monthName(monthIndex(b.months[b.months.length - 1])) : '';
  const over = !first ? '' : `, from ${first === last ? first : `${first}–${last}`}`;
  return `Based on regular income ${about(b.regularIncomeMonthlyCents)} a month, regular charges ${about(b.regularChargesMonthlyCents)} a month and everyday spending of about ${about(b.everydayMonthlyCents)} a month${over}.`;
};
