// XS1: which offer fits a customer, and why (plan 24 §2, §3, basis templates of §4; REQ-XS-3…5).
// Pure over data the turn already read (D3): no bank request, no model call, no clock. Server
// only: the rules read the fee table of the catalogue.
import { genericKey, merchantKey } from '../insights/normalize';
import { categoryLabel } from '../insights/taxonomy';
import type { CategoryId, MovementInput, RowCategory } from '../insights/taxonomy';
import { OFFER_IDS, auroraWaiver, productFees } from './catalogue';
import type { OfferId } from './catalogue';

export type OfferInput = {
  accounts: { id: string; label: string; balanceCents: number }[];
  // null: movements not read this turn
  view: { movements: MovementInput[]; categories: ReadonlyMap<string, RowCategory> } | null;
  exclude: OfferId[]; // already shown to this customer
};

// The thresholds of plan 24 §2, in cents. The Aurora salary and the fees are documented facts and
// come from the catalogue instead.
export const THRESHOLDS = {
  minMainCents: 500_00, // below it nobody is offered anything
  planSalaryCents: 600_00,
  planMonths: 2,
  potBalanceCents: 3_000_00,
  homeCents: 300_00,
  repeatDays: 25,
  sameAmount: 0.05,
  billsKeys: 3,
  cashbackCents: 75_00,
  cashbackCount: 5,
  smallCents: 50_00,
  smallCount: 12,
  cloudFeeEuros: 3,
};

const SAVINGS = /saving/i;
const NOT_READ = 'movements were not read this turn';
// D5: a category signal counts a movement only when a rule or the customer decided it.
const COUNTED = new Set<RowCategory['source']>(['user', 'user_rule', 'rule']);
const NOT_SPEND = new Set<CategoryId>(['transfer_person', 'savings_internal']);
const DAY_MS = 86_400_000;

const madrid = (locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'Europe/Madrid', ...options });
const DAY_MONTH = madrid('en-GB', { day: 'numeric', month: 'short' }); // 4 Aug
const MONTH = madrid('en-GB', { month: 'long' });
const MONTH_KEY = madrid('en-CA', { year: 'numeric', month: '2-digit' }); // 2026-09
// Amounts of a basis are rounded to €10 (`|| 0`: never "-0").
const about = (cents: number) => `€${(Math.round(cents / 1000) * 10 || 0).toLocaleString('en-US')}`;
const sum = (list: { amountCents: number }[]) => list.reduce((s, m) => s + m.amountCents, 0);
const at = (m: MovementInput) => Date.parse(m.createdAt);

type Outcome = { why: string; basis?: string }; // a basis makes the offer eligible
const no = (why: string): Outcome => ({ why });

// Two of these movements at least 25 days apart, of the same amount (±5%) when asked.
// ponytail: any pair that far apart counts as "repeats every month"; a cadence check (28 to 35
// days between consecutive charges) if a window ever spans more than a few months.
function repeats(list: MovementInput[], sameAmount: boolean) {
  return list.some((a) =>
    list.some((b) => {
      const [x, y] = [Math.abs(a.amountCents), Math.abs(b.amountCents)];
      return (
        at(a) - at(b) >= THRESHOLDS.repeatDays * DAY_MS &&
        (!sameAmount || Math.abs(x - y) <= THRESHOLDS.sameAmount * Math.max(x, y))
      );
    }),
  );
}

// All eight offers, in catalogue order, each with the reason it is or is not eligible.
export function explainOffers(
  i: OfferInput,
): { id: OfferId; eligible: boolean; why: string; basis?: string }[] {
  const mains = i.accounts
    .filter((a) => !SAVINGS.test(a.label))
    .sort((a, b) => b.balanceCents - a.balanceCents);
  const savings = i.accounts.find((a) => SAVINGS.test(a.label));
  const blocked = !i.accounts.length
    ? 'no accounts'
    : sum(mains.map((a) => ({ amountCents: a.balanceCents }))) < THRESHOLDS.minMainCents
      ? 'the main accounts hold less than €500'
      : null;
  if (blocked) return OFFER_IDS.map((id) => ({ id, eligible: false, why: blocked }));

  const fees = productFees();
  const productOf = (label: string) =>
    fees.find((f) => new RegExp(`\\b${f.product}\\b`, 'i').test(label));
  const held = new Set(i.accounts.map((a) => productOf(a.label)?.product));
  const holds = (...products: string[]) => products.find((p) => held.has(p));
  const mainIds = new Set(mains.map((a) => a.id));
  const auroraIds = new Set(
    i.accounts.filter((a) => productOf(a.label)?.product === 'Aurora').map((a) => a.id),
  );

  // A bank may send a date that does not parse: such a movement is in no signal.
  const movements = (i.view?.movements ?? []).filter((m) => Number.isFinite(at(m)));
  const category = (m: MovementInput) => i.view?.categories.get(m.id);
  const decided = (m: MovementInput) => {
    const c = category(m);
    return !!c && COUNTED.has(c.source) && c.state !== 'needs_review';
  };
  const counted = (m: MovementInput, id: CategoryId) => decided(m) && category(m)?.id === id;
  // Debits exclude transfers to people, own transfers and anything sent through the app.
  const debits = movements.filter(
    (m) => m.amountCents < 0 && !m.operationId && !NOT_SPEND.has(category(m)?.id ?? 'other'),
  );
  const since = movements.length ? DAY_MONTH.format(Math.min(...movements.map(at))) : '';
  // Income credits of at least `min` on these accounts, newest first. A credit with an operation
  // is a transfer from another customer of the bank, not a salary.
  const salaries = (min: number, accountIds: Set<string>) =>
    movements
      .filter(
        (m) =>
          m.amountCents >= min &&
          !m.operationId &&
          accountIds.has(m.accountId) &&
          counted(m, 'income'),
      )
      .sort((a, b) => at(b) - at(a));
  const byKey = (list: MovementInput[]) => {
    const groups = new Map<string, MovementInput[]>();
    for (const m of list) {
      const key = category(m)?.merchantKey ?? merchantKey(m.description);
      if (key && !genericKey(key)) groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.values()];
  };
  const waiverCents = auroraWaiver().salaryEuros * 100;

  const rules: Record<OfferId, () => Outcome> = {
    'offer-aurora-fee-waiver': () => {
      if (!auroraIds.size) return no('no Aurora account');
      if (!i.view) return no(NOT_READ);
      const [salary] = salaries(waiverCents, auroraIds);
      if (!salary) return no('no income credit of €1,200 or more in the Aurora account');
      const month = MONTH.format(at(salary));
      return {
        why: `Aurora account and an income credit of ${about(salary.amountCents)} in ${month}`,
        basis: `A salary payment of about ${about(salary.amountCents)} arrived in ${month}. The Aurora fee is €0 only with that and three settled card purchases in the same month; this app cannot see whether your purchases were by card or whether the fee was charged.`,
      };
    },
    'offer-salary-plan': () => {
      if (auroraIds.size) return no('holds an Aurora account (the fee waiver serves it)');
      if (!i.view) return no(NOT_READ);
      // It may not be a salary (an invoice paid twice is income too): the basis says "income".
      // The newest such credit of each calendar month, newest month first.
      const months = new Map<string, MovementInput>();
      for (const m of salaries(THRESHOLDS.planSalaryCents, mainIds)) {
        const key = MONTH_KEY.format(at(m));
        if (!months.has(key)) months.set(key, m);
      }
      if (months.size < THRESHOLDS.planMonths)
        return no(`income credits of €600 or more in ${months.size} calendar month(s), needs 2`);
      const [last, previous] = [...months.values()];
      const names = `${MONTH.format(at(previous))} and in ${MONTH.format(at(last))}`;
      return {
        why: `income credits of €600 or more in ${months.size} calendar months`,
        basis: `Regular income arrived in ${names}, about ${about(sum([last, previous]) / 2)} each time. Only credits classified as income by a rule or confirmed by you are counted.`,
      };
    },
    'offer-savings-pot': () => {
      if (savings) return no(`holds a savings account (${savings.label})`);
      const total = sum(mains.map((a) => ({ amountCents: a.balanceCents })));
      if (total < THRESHOLDS.potBalanceCents) return no('the main accounts hold less than €3,000');
      const subject = mains.length === 1 ? `${mains[0].label} holds` : 'main accounts hold';
      return {
        why: 'no savings account and €3,000 or more in the main accounts',
        basis: `Your ${subject} more than €3,000 and you have no savings account with us.`,
      };
    },
    'offer-home-insurance': () => {
      if (!i.view) return no(NOT_READ);
      const home = debits.filter((m) => counted(m, 'home_utilities'));
      const total = -sum(home);
      if (total < THRESHOLDS.homeCents)
        return no(`counted Home & utilities payments total ${about(total)}, under €300`);
      if (!byKey(home).some((group) => repeats(group, false)))
        return no('no Home & utilities payment repeats at least 25 days apart');
      return {
        why: `${home.length} counted Home & utilities payments, ${about(total)}, one repeats`,
        basis: `${home.length} ${categoryLabel('home_utilities')} payments since ${since}, about ${about(total)}, and at least one repeats every month. Only movements classified by a rule or confirmed by you are counted. This app does not know whether you already have home insurance.`,
      };
    },
    'offer-bills-watch': () => {
      if (!i.view) return no(NOT_READ);
      const recurring = byKey(debits).filter((group) => repeats(group, true));
      if (recurring.length < THRESHOLDS.billsKeys)
        return no(`${recurring.length} merchant(s) with a repeating payment, needs 3`);
      // A month of them: the newest charge of each.
      const monthly = -sum(recurring.map((g) => g.reduce((a, b) => (at(b) > at(a) ? b : a))));
      return {
        why: `${recurring.length} merchants with a repeating payment`,
        basis: `${recurring.length} payments repeat every month in your movements since ${since}, about ${about(monthly)} a month.`,
      };
    },
    'offer-cashback-card': () => {
      if (!i.view) return no(NOT_READ);
      const leisure = debits.filter((m) => counted(m, 'eating_out_leisure'));
      const total = -sum(leisure);
      if (total < THRESHOLDS.cashbackCents || leisure.length < THRESHOLDS.cashbackCount)
        return no(
          `${leisure.length} counted Eating out & leisure payments, ${about(total)}; needs 5 and €75`,
        );
      return {
        why: `${leisure.length} counted Eating out & leisure payments, ${about(total)}`,
        basis: `About ${about(total)} in ${leisure.length} ${categoryLabel('eating_out_leisure')} payments since ${since}. Only movements classified by a rule or confirmed by you are counted.`,
      };
    },
    'offer-round-ups': () => {
      if (!savings) return no('no savings account');
      if (!i.view) return no(NOT_READ);
      const small = debits.filter((m) => -m.amountCents < THRESHOLDS.smallCents);
      if (small.length < THRESHOLDS.smallCount)
        return no(`${small.length} payments under €50, needs 12`);
      return {
        why: `a savings account and ${small.length} payments under €50`,
        basis: `${small.length} payments under €50 since ${since}, and you already have a savings account (${savings.label}).`,
      };
    },
    'offer-cloud-account': () => {
      const cheap = holds('Cloud', 'Young', 'Community');
      if (cheap) return no(`holds a ${cheap} account`);
      const main = productOf(mains[0].label);
      if (!main) return no('the main account has no documented fee');
      if (main.euros < THRESHOLDS.cloudFeeEuros) return no(`the ${main.product} fee is under €3`);
      if (main.product === 'Aurora') {
        // Its fee can be €0: say it costs €6 only when no salary that large is in sight.
        if (!i.view) return no(NOT_READ);
        // D5 the other way round (review of #114): the basis states a €6 fee, so a credit that
        // large which nobody decided (a model's estimate, a row in review) keeps the offer silent.
        const maybeSalary = movements.some(
          (m) =>
            m.amountCents >= waiverCents &&
            !m.operationId &&
            auroraIds.has(m.accountId) &&
            (!decided(m) || category(m)?.id === 'income'),
        );
        if (maybeSalary)
          return no('Aurora with a credit of €1,200 or more: the fee may already be €0');
      }
      return {
        why: `the ${main.product} fee is €${main.euros} and Cloud is €0`,
        basis: `Your ${main.product} account has a €${main.euros} monthly fee and the Cloud account's is €0. The documentation does not say whether or how you can change product.`,
      };
    },
  };
  return OFFER_IDS.map((id) => {
    const outcome = rules[id]();
    return { id, eligible: outcome.basis !== undefined, ...outcome };
  });
}

// The first eligible offer the customer has not been shown, or null.
export function selectOffer(i: OfferInput): { id: OfferId; basis: string } | null {
  const chosen = explainOffers(i).find((o) => o.eligible && !i.exclude.includes(o.id));
  return chosen ? { id: chosen.id, basis: chosen.basis! } : null;
}
