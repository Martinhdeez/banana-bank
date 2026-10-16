// RG2b: "Regular money" follow-up. (a) A list's "a month" total is what this month holds: a goal
// payment whose first payment is next month is said on its own "From next month" line, on both
// sides of the transfer. (b) The section follows the account chosen in Month ahead's switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePlan } from '../app/_components/Plan';
import { MonthAhead } from '../app/_components/plan/Forecast';
import { RegularMoney } from '../app/_components/plan/Regular';
import type { MonthForecast, Regular, RegularItem } from '../app/_components/plan/types';

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/−/g, '-');
const item = (over: Partial<RegularItem> & Pick<RegularItem, 'id' | 'label'>): RegularItem => ({
  amountCents: 0,
  usualDay: 1,
  source: 'detected',
  thisMonth: 'done',
  excludable: false,
  ...over,
});
const salary = item({ id: 'nomina', label: 'Salary', amountCents: 210000, thisMonth: 'to_come' });
const rent = item({ id: 'alquiler', label: 'Rent', amountCents: -85000 });
const gym = item({ id: 'gym', label: 'Gym', amountCents: -3990, thisMonth: 'late' });
// Lucía's goal "Pagar a Carla": €666.67 a month from 1 Nov, out of one account, into the other.
const carla = (amountCents: number) =>
  item({
    id: 'prep-carla',
    label: 'Goal: Pagar a Carla',
    amountCents,
    source: 'prepared',
    nextDue: '2026-11-01',
    goalId: 'goal-carla',
    thisMonth: 'next_month',
  });
const section = (regular: Regular) =>
  text(
    renderToStaticMarkup(
      createElement(RegularMoney, {
        regular,
        accountId: 'acc',
        accountLabel: 'Aurora account',
        today: '2026-10-07',
        onOpenGoal: () => {},
        onOpenPrepared: () => {},
      }),
    ),
  );
const testid = (html: string, id: string) =>
  html.match(new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`))?.[1];

test('a goal payment that starts next month is left out of "a month" and said on its own line', () => {
  const html = section({
    income: [salary, carla(66667)],
    charges: [rent, gym, carla(-66667)],
    irregularSpend: null,
  });
  assert.equal(testid(html, 'regular-charge-total'), '-€889.90 a month');
  assert.equal(testid(html, 'regular-charge-next'), 'From next month: -€666.67');
  assert.equal(testid(html, 'regular-income-total'), '+€2,100.00 a month');
  assert.equal(testid(html, 'regular-income-next'), 'From next month: +€666.67');
  // The item itself is still listed in both lists.
  assert.equal(html.split('<strong>Goal: Pagar a Carla</strong>').length - 1, 2);
});

test('no next-month item: no "From next month" line; only next-month items: no monthly total', () => {
  const plain = section({ income: [salary], charges: [rent], irregularSpend: null });
  assert.equal(testid(plain, 'regular-charge-next'), undefined);
  assert.equal(testid(plain, 'regular-income-next'), undefined);
  const onlyNext = section({ income: [carla(66667)], charges: [rent], irregularSpend: null });
  assert.equal(testid(onlyNext, 'regular-income-total'), undefined);
  assert.equal(testid(onlyNext, 'regular-income-next'), 'From next month: +€666.67');
});

// (b) The Plan page as usePlan renders it, after the customer picks the second account in Month
// ahead's switch (a render-phase update, which the server renderer applies before it finishes).
const step3 = JSON.parse(
  fs.readFileSync('tests/plan-fixtures/forecast-take-step3.json', 'utf8'),
) as MonthForecast;
function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const el = node as { type: unknown; props: { children?: ReactNode } & Record<string, unknown> };
  return el.type === type ? el : find(el.props.children, type);
}
function planAfterSwitch(to: string | null) {
  const [a, b] = step3.accounts;
  const forecast = {
    ...step3,
    adjustable: true,
    accounts: [
      { ...a, regular: { income: [], charges: [rent], irregularSpend: null } },
      { ...b, regular: { income: [salary], charges: [gym], irregularSpend: null } },
    ],
  } as MonthForecast;
  let got = {} as ReturnType<typeof usePlan>;
  let switched = to === null;
  function Host() {
    got = usePlan({
      api: async () => ({}),
      customerId: 'lucia',
      dashboard: { accounts: [], prepared: [], forecast },
      refresh: async () => {},
      active: true,
      goPlan: () => {},
      goOverview: () => {},
      openPrepared: () => {},
    });
    if (!switched) {
      switched = true;
      (find(got.page as ReactNode, MonthAhead)!.props.onAccount as (id: string) => void)(to!);
    }
    return null;
  }
  renderToStaticMarkup(createElement(Host));
  const html = text(renderToStaticMarkup(createElement('main', null, got.page as ReactNode)));
  return html.slice(html.indexOf('data-testid="plan-regular"'));
}

test('Regular money shows the account chosen in the Month ahead switch, not the first one', () => {
  const [a, b] = step3.accounts;
  const first = planAfterSwitch(null);
  assert.ok(first.includes(`${a.label} · what comes in`));
  assert.ok(first.includes('Rent') && !first.includes('Gym'));
  const second = planAfterSwitch(b.id);
  assert.ok(second.includes(`${b.label} · what comes in`), 'the label of the chosen account');
  assert.ok(second.includes('Gym') && second.includes('Salary'), 'its items');
  assert.ok(!second.includes('Rent'), 'none of the first account');
});
