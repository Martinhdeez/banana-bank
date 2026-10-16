// UI1 (plan 28 §4.3–§4.5): the payloads the Plan tab reads, as the plan states them. Types only,
// safe in the browser. When FC1 and GL1 export theirs from `src/`, this file becomes re-exports.
import type { PreparedView } from '../../../src/banking/prepared';

// GET /api/dashboard → forecast (§4.4)
export type ForecastEvent = {
  date: string;
  label: string;
  amountCents: number;
  balanceAfterCents: number;
  // `expected_by_you`: a charge the customer added (FC2, draft).
  source: 'prepared' | 'usual_charge' | 'usual_income' | 'expected_by_you';
  certainty: 'certain' | 'estimated';
  seenOn?: string[];
  usualDay?: number;
  late?: boolean;
  note?: string;
  preparedId?: string;
  // Usual items (FC1): the key the rule grouped by, which FC2's exclude will take.
  merchantKey?: string;
  // FC2: on an `expected_by_you` event, the customer's own item.
  adjustmentId?: string;
};
export type CoverOption = {
  id: string;
  title: string;
  consequence: string;
  change: { kind: 'add'; date: string; amountCents: number; label: string };
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
  // RG1: the account's regular money. Absent on a server without RG1: no section.
  regular?: Regular;
  // RG1b: what is due in the first 7 days of next month. Absent or empty: no list.
  nextMonth?: {
    date: string;
    label: string;
    amountCents: number;
    preparedId?: string;
    goalId?: string;
    // An item the customer added (FC2): Remove deletes it.
    adjustmentId?: string;
  }[];
};
// RG1 (GET /api/dashboard → forecast.accounts[].regular).
export type RegularItem = {
  // A detected item's merchant key ("Not regular" excludes it by this id).
  id: string;
  label: string;
  // + income, − charges.
  amountCents: number;
  usualDay: number;
  // RG1b: 'prepared', a prepared transfer (a goal's, or "To <recipient>").
  source: 'detected' | 'added_by_you' | 'prepared';
  seenOn?: string[];
  // RG1b: 'next_month', a prepared item whose first payment is next month.
  thisMonth: 'done' | 'to_come' | 'late' | 'next_month';
  excludable: boolean;
  adjustmentId?: string;
  // RG1b, on a prepared item.
  nextDue?: string;
  goalId?: string;
  preparedId?: string;
};
export type Regular = {
  income: RegularItem[];
  charges: RegularItem[];
  irregularSpend: { monthlyCents: number; months: string[] } | null;
};
export type MonthForecast = {
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
    // RG1f (#220): 'usual_like_it', an added charge that twins a detected usual charge to come.
    reason:
      | 'paused'
      | 'no_date'
      | 'irregular'
      | 'excluded_by_you'
      | 'already_seen'
      | 'already_prepared'
      | 'usual_like_it';
    text?: string;
    // FC2: the customer's adjustment behind this row; DELETE that id undoes it.
    adjustmentId?: string;
  }[];
  // FC2: the server takes forecast adjustments. The ONLY key of the adjustment actions.
  adjustable?: boolean;
  // FC2: every active adjustment of these accounts, oldest first, also the ones that are not in
  // this month's events (a one-off of next month, a monthly day already passed).
  adjustments?: ForecastAdjustment[];
};
export type ForecastAdjustment = {
  id: string;
  kind: 'exclude' | 'expect';
  accountId: string;
  merchantKey?: string;
  label: string;
  amountCents?: number;
  repeats?: 'monthly' | 'once';
  day?: number;
  date?: string;
  // RG2c: an expect adjustment listed once inside another regular item (RG1d, RG1e): that
  // item's label and where it comes from.
  countedWith?: { label: string; source: 'prepared' | 'detected' };
  createdAt: string;
};

// GET /api/goals and its routes (§4.3)
export type Suggestion = (
  | { kind: 'raise'; monthlyCents: number }
  | { kind: 'extend'; targetDate: string }
  | { kind: 'prepare_again'; monthlyCents: number }
) & { text: string };
export type GoalState = 'on_track' | 'behind' | 'no_plan' | 'date_passed' | 'reached';
export type GoalView = {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string;
  savedCents: number;
  remainingCents: number;
  behindCents: number;
  state: GoalState;
  monthlyCents: number | null;
  requiredMonthlyCents: number | null;
  prepared: PreparedView | null;
  from: { id: string; label: string };
  to: { id: string; label: string };
  headline: string;
  basis: string;
  suggestion: Suggestion | null;
  alternative: Suggestion | null;
  reachedAt?: string;
  history: { month: string; plannedCents: number; savedCents: number }[];
};
export type GoalsResponse = {
  today: string;
  canSave: boolean;
  canSaveReason: string | null;
  accounts: { id: string; label: string }[];
  room: { monthlyCents: number; months: number } | null;
  goals: GoalView[];
};
export type PlanDryRun = {
  monthlyCents: number;
  payments: number;
  firstDue: string;
  lastDue: string;
  fits: boolean | null;
};

// GET /api/dashboard → brief (§4.5)
export type Brief = {
  headline: string;
  findings: {
    kind: 'forecast_shortfall' | 'goal_behind' | 'category_up';
    text: string;
    accountId?: string;
    goalId?: string;
  }[];
};

// TL1 (GET /api/forecast/timeline?accountId&range): the account's balance by day, the real past
// and the projected future, with the events behind it.
export type TimelineRange =
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'next_month'
  | 'last_3_months'
  | 'next_3_months'
  | 'last_6_months'
  | 'next_6_months';
export type TimelineEvent = {
  date: string;
  label: string;
  amountCents: number;
  source:
    | 'movement'
    | 'usual_charge'
    | 'usual_income'
    | 'expected_by_you'
    | 'prepared'
    | 'goal'
    | 'everyday';
  certainty: 'actual' | 'certain' | 'estimated';
  preparedId?: string;
  goalId?: string;
};
export type Timeline = {
  accountId: string;
  range: TimelineRange;
  today: string;
  from: string;
  to: string;
  // One per day; `actual` for date <= today.
  // TL1c: `lowCents`, the low within the day when it differs from its end (from today on).
  points: { date: string; balanceCents: number; lowCents?: number; actual: boolean }[];
  events: TimelineEvent[];
  // One per calendar month the line covers; `actual`: how much of it is past.
  months: {
    month: string;
    from: string;
    to: string;
    startBalanceCents: number;
    endBalanceCents: number;
    incomeCents: number;
    outCents: number;
    actual: 'full' | 'partial' | 'none';
  }[];
  // The future part only.
  lowest: { date: string; balanceCents: number } | null;
  shortfall: { date: string; shortCents: number; forLabel?: string } | null;
  basis: {
    regularIncomeMonthlyCents: number;
    regularChargesMonthlyCents: number;
    everydayMonthlyCents: number;
    months: string[];
  } | null;
  notes: string[];
};
