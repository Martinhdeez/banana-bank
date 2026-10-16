// OB1: spending observations, "Worth a look" (plan 26 §2, §3; REQ-OB-1…4). One fact in the
// customer's own data, with its figures and what was counted: never advice. Pure over what a
// dashboard load or a chat turn already read: no bank request, no model call, no clock (`today`
// is an argument). Server only at run time; a browser file may import the types.
import { movementWindow } from '../banking/movements';
import type { PreparedView } from '../banking/prepared';
import { monthForecast, type MonthForecast } from '../forecast/month';
import { MADRID_MONTH, safe } from '../insights/classify';
import { spendingSummary } from '../insights/summary';
import type { MovementInput, RowCategory } from '../insights/taxonomy';

// FC1: `month_shortfall` is the one kind that is an estimate (plan 28 D1 amends plan 26 D3).
export const MONTH_SHORTFALL_TITLE = 'Short before the month ends'; // also in what was recorded (AC1)
const OBSERVATION_KINDS = ['prepared_uncovered', 'month_shortfall', 'category_up'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export type Observation = {
  key: string; // what a dismissal names
  kind: ObservationKind;
  title: string;
  basis: string; // server text: the figures and what was counted
  movementIds: string[]; // the movements behind it, newest first, at most 8
  preparedId?: string;
};
export type ObservationInput = {
  accounts: { id: string; label: string; balanceCents: number }[];
  // null: movements not read
  view: { movements: MovementInput[]; categories: ReadonlyMap<string, RowCategory> } | null;
  prepared: PreparedView[];
  today: string; // 'YYYY-MM-DD', Europe/Madrid
  // FC1: the month forecast of the same read. Left out, `month_shortfall` is never found: a
  // caller opts in (the chat does not until its instructions allow an estimate, GL3).
  forecast?: MonthForecast | null;
};

// The thresholds of plan 26 §2, in cents.
const THRESHOLDS = {
  dueDays: 7, // a scheduled prepared transfer is looked at this many days ahead
  monthCents: 50_00, // counted spend of the category in the last full month
  monthCount: 3, // and its movements
  previousCents: 20_00, // counted spend in the month before
  upRatio: 0.25, // the increase, as a share of the month before
  upCents: 15_00, // and in money
  movements: 8,
};

// D4: a category figure counts a movement only when a rule or the customer decided it.
// ponytail: the counted test of src/offers/select.ts:38 and :100 written a second time (that file
// is not edited in round 10); export it from there if a third user appears.
const COUNTED = new Set<RowCategory['source']>(['user', 'user_rule', 'rule']);
// Review of #137: `category_up` never names a bucket that is not spending. "Other is up" or
// "Transfers to people is up" is noise, not an observation.
const NOT_SPENDING = new Set<string>(['other', 'transfer_person', 'savings_internal']);

const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options });
const DAY_MONTH = utc({ day: 'numeric', month: 'short' }); // 9 Oct
const MONTH = utc({ month: 'long' });
// Exact, never rounded: every figure of a basis can be recomputed from the input.
const euros = (cents: number) =>
  `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthBefore = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 7);
};
const monthName = (month: string) => MONTH.format(new Date(`${month}-15T00:00:00Z`));

type Outcome = { why: string; found: Observation[] };

// A prepared transfer that is due, ready, or scheduled within 7 days, for more than the balance
// of its own source account in this read. Paused, awaiting confirmation (the proposal already
// checked the balance) and verifying never fire; an amount equal to the balance is covered.
// ponytail: each transfer is compared on its own; two that each fit but not together are not
// reported. Sum per account and date if that matters.
function preparedUncovered(i: ObservationInput): Outcome {
  const accounts = new Map(i.accounts.map((a) => [a.id, a]));
  const until = addDays(i.today, THRESHOLDS.dueDays);
  const near = i.prepared.filter(
    (p) =>
      p.state === 'due' ||
      p.state === 'ready' ||
      (p.state === 'scheduled' && !!p.nextDue && p.nextDue <= until),
  );
  const found = near
    .flatMap((p) => {
      const account = accounts.get(p.fromAccountId);
      return account && p.amountCents > account.balanceCents ? [{ p, account }] : [];
    })
    // By due date, a manual one (no date) last.
    .sort(
      (a, b) =>
        (a.p.nextDue ?? '9').localeCompare(b.p.nextDue ?? '9') || a.p.id.localeCompare(b.p.id),
    )
    .map(({ p, account }): Observation => {
      const when =
        p.state === 'ready' || !p.nextDue
          ? 'ready to send'
          : p.nextDue === i.today
            ? 'due today'
            : `due on ${DAY_MONTH.format(new Date(`${p.nextDue}T00:00:00Z`))}`;
      return {
        key: `prepared_uncovered:${p.id}:${p.nextDue ?? 'once'}`,
        kind: 'prepared_uncovered',
        title: 'A prepared transfer is not covered',
        basis: `Your prepared transfer of ${euros(p.amountCents)} to ${p.to} (${when}) is more than the ${euros(account.balanceCents)} in your ${account.label} today.`,
        movementIds: [],
        preparedId: p.id,
      };
    });
  return {
    why: !i.prepared.length
      ? 'no prepared transfers'
      : `${near.length} of ${i.prepared.length} prepared transfer(s) due, ready or scheduled within ${THRESHOLDS.dueDays} days; ${found.length} above the balance of its source account`,
    found,
  };
}

// A category whose counted spend went up from the month before the last full month (P) to the
// last full month (M). Both months must be whole inside the bank window.
function categoryUp(i: ObservationInput): Outcome {
  if (!i.view) return { why: 'movements were not read', found: [] };
  const { movements, categories } = i.view;
  const M = monthBefore(i.today.slice(0, 7)),
    P = monthBefore(M);
  const monthOf = (createdAt: string) => safe(() => MADRID_MONTH.format(new Date(createdAt)));
  // REQ-OB-3: a full page that does not start before P may be missing movements of P. Stricter
  // than the plan's "oldest day <= the 1st of P": movements of that same first day could be cut
  // too, as `periodSummary` assumes (src/insights/summary.ts, `window`).
  const { oldestAt, mayBeTruncated } = movementWindow(movements);
  const oldest = oldestAt && monthOf(oldestAt);
  if (mayBeTruncated && !(oldest && oldest < P))
    return {
      why: `the bank returned a full page that starts in ${oldest ?? 'an unknown month'}: ${monthName(P)} may be incomplete`,
      found: [],
    };
  const decided = (m: MovementInput) => {
    const c = categories.get(m.id);
    return !!c && COUNTED.has(c.source) && c.state !== 'needs_review';
  };
  const [rowsM, rowsP] = [M, P].map((month) =>
    movements.filter((m) => monthOf(m.createdAt) === month),
  );
  // The spending card's own arithmetic over the counted movements of one month, so refunds, own
  // transfers and income are treated as in the card.
  const totals = (rows: MovementInput[]) =>
    new Map(
      spendingSummary({ movements: rows.filter(decided), categories }, {}, 'none').categories.map(
        (c) => [c.id, c],
      ),
    );
  const [now, before] = [totals(rowsM), totals(rowsP)];
  // OB4: every payment of the two months that is in no figure, whatever the reason (estimated by
  // a model, still being classified, in review, never classified). It was the movements in review
  // only, so the number changed with the decider's progress and two surfaces could state
  // different ones for the same data. A function of the movement and of `decided` alone: credits
  // and movements with an operation id (the app's own transfers) are no payment to a merchant.
  const uncounted = [...rowsM, ...rowsP].filter(
    (m) => !decided(m) && m.amountCents < 0 && !m.operationId,
  ).length;
  // The movements of a category figure (never `other`, the one category where spendingSummary
  // leaves a credit out of the total).
  const behind = (id: string) =>
    [...rowsM, ...rowsP]
      .filter((m) => decided(m) && categories.get(m.id)!.id === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const T = THRESHOLDS;
  const compared = [...now.values()].map((m) => {
    const p = before.get(m.id);
    return { m, p, up: m.spentCents - (p?.spentCents ?? 0) };
  });
  const found = compared
    .filter(
      ({ m, p, up }) =>
        !NOT_SPENDING.has(m.id) &&
        m.spentCents >= T.monthCents &&
        m.count >= T.monthCount &&
        !!p &&
        p.spentCents >= T.previousCents &&
        up >= T.upCents &&
        up >= T.upRatio * p.spentCents,
    )
    .sort((a, b) => b.up - a.up || a.m.id.localeCompare(b.m.id))
    .map(({ m, p }): Observation => {
      const rows = behind(m.id);
      // A refund lowers the figure and is one of its movements: then they are not all payments.
      const noun = rows.some((r) => r.amountCents > 0) ? 'movements' : 'payments';
      const review =
        uncounted === 0
          ? ''
          : uncounted === 1
            ? ' 1 movement of those months is not classified by a rule or by you and is not in these figures.'
            : ` ${uncounted} movements of those months are not classified by a rule or by you and are not in these figures.`;
      return {
        key: `category_up:${m.id}:${M}`,
        kind: 'category_up',
        title: `${m.label} is up`,
        basis: `${m.label}: ${euros(m.spentCents)} in ${monthName(M)} (${m.count} ${noun}), ${euros(p!.spentCents)} in ${monthName(P)} (${p!.count}). Only movements classified by a rule or confirmed by you are counted.${review}`,
        movementIds: rows.slice(0, T.movements).map((r) => r.id),
      };
    });
  const list = compared
    .sort((a, b) => b.m.spentCents - a.m.spentCents)
    .map(
      ({ m, p }) =>
        `${m.label} ${euros(m.spentCents)} (${m.count}) after ${euros(p?.spentCents ?? 0)} (${p?.count ?? 0})`,
    )
    .join('; ');
  return {
    why: !compared.length
      ? `nothing counted in ${monthName(M)}`
      : `counted in ${monthName(M)} after ${monthName(P)}: ${list}; ${found.length} over the thresholds`,
    found,
  };
}

// FC1 (plan 28 §4.4, §5.1): an account the month forecast takes below zero before the month ends.
// The basis is the forecast's own sentence, which says "An estimate." unless prepared transfers
// alone cause it. Silent when `prepared_uncovered` already names that transfer.
function monthShortfall(i: ObservationInput, named: Observation[]): Outcome {
  if (!i.forecast) return { why: 'no month forecast in this read', found: [] };
  // FC2: a shortfall that counts a charge the customer added names it by the customer's own
  // label. An observation's basis is told in the chat (a model) and recorded for the operator,
  // and that label goes to neither. So with such a charge the observation is worked out again
  // from the same read without what the customer added (what they left out stays out): no label
  // can be in it, a shortfall only their charge causes stays on the Plan page, and one that
  // exists without it is still found, in the forecast's own sentence (FC2 review).
  const forecast = i.forecast.adjustments.some((a) => a.kind === 'expect')
    ? monthForecast({
        accounts: i.accounts,
        movements: i.view?.movements ?? null,
        prepared: i.prepared,
        adjustments: i.forecast.adjustments.filter((a) => a.kind !== 'expect'),
        today: i.today,
      })
    : i.forecast;
  const short = forecast.accounts.filter((a) => a.shortfall);
  const found = short
    .filter((a) => !named.some((o) => o.preparedId && o.preparedId === a.shortfall!.preparedId))
    .map((a): Observation => ({
      key: `month_shortfall:${a.id}:${i.today.slice(0, 7)}`,
      kind: 'month_shortfall',
      title: MONTH_SHORTFALL_TITLE,
      basis: a.explanation,
      movementIds: [],
      ...(a.shortfall!.preparedId && { preparedId: a.shortfall!.preparedId }),
    }));
  return {
    why: `${short.length} account(s) below zero before ${forecast.until}; ${short.length - found.length} already named by a prepared transfer that is not covered`,
    found,
  };
}

// The kinds, in order, each with what it found and why.
export function explainObservations(
  i: ObservationInput,
): { kind: ObservationKind; why: string; found: Observation[] }[] {
  const uncovered = preparedUncovered(i);
  return [
    { kind: 'prepared_uncovered', ...uncovered },
    { kind: 'month_shortfall', ...monthShortfall(i, uncovered.found) },
    { kind: 'category_up', ...categoryUp(i) },
  ];
}

// The first observation found whose key is not excluded, or null. `not`: kinds left out.
export function pickObservation(
  i: ObservationInput,
  exclude: string[],
  not: ObservationKind[] = [],
): Observation | null {
  return (
    explainObservations(i)
      .flatMap((k) => k.found)
      .find((o) => !exclude.includes(o.key) && !not.includes(o.kind)) ?? null
  );
}
