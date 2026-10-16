// RG2: "Regular money" in the Plan tab. The words and sums of the section (pure helpers), and the
// section as the Plan page renders it from GET /api/dashboard → forecast.accounts[].regular (RG1's
// contract): placed after "Month ahead", one list per direction with its monthly total, the
// irregular line, the empty states, and the actions only where the contract allows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePlan } from '../app/_components/Plan';
import {
  aroundDay,
  irregularWords,
  regularTotal,
  chipOf,
  seenWords,
} from '../app/_components/plan/logic';
import type { MonthForecast, Regular, RegularItem } from '../app/_components/plan/types';

const salary: RegularItem = {
  id: 'nomina-estudio',
  label: 'Salary',
  amountCents: 210000,
  usualDay: 28,
  source: 'detected',
  seenOn: ['2026-07-28', '2026-08-28', '2026-09-26'],
  thisMonth: 'to_come',
  excludable: true,
};
const rent: RegularItem = {
  id: 'alquiler',
  label: 'Rent',
  amountCents: -85000,
  usualDay: 1,
  source: 'detected',
  seenOn: ['2026-07-01', '2026-08-01', '2026-09-01'],
  thisMonth: 'done',
  excludable: false,
};
const gym: RegularItem = {
  id: 'adj-gym',
  label: 'Gym',
  amountCents: -3990,
  usualDay: 22,
  source: 'added_by_you',
  thisMonth: 'late',
  excludable: false,
  adjustmentId: 'adj-gym',
};
const full: Regular = {
  income: [salary],
  charges: [rent, gym],
  irregularSpend: { monthlyCents: 31240, months: ['2026-07', '2026-08', '2026-09'] },
};

test('a usual day reads as an English ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28, 31].map(aroundDay), [
    'around the 1st',
    'around the 2nd',
    'around the 3rd',
    'around the 4th',
    'around the 11th',
    'around the 12th',
    'around the 13th',
    'around the 21st',
    'around the 22nd',
    'around the 23rd',
    'around the 28th',
    'around the 31st',
  ]);
});

test('the source line: the months it was seen, or "added by you"', () => {
  assert.equal(seenWords(salary), 'detected · seen Jul, Aug, Sep');
  assert.equal(seenWords(gym), 'added by you');
  assert.equal(seenWords({ ...salary, seenOn: undefined }), 'detected');
});

test('a list totals its items to the cent; the chip of each state', () => {
  assert.equal(regularTotal([salary]), 210000);
  assert.equal(regularTotal([rent, gym]), -88990);
  assert.equal(regularTotal([]), 0);
  assert.deepEqual(chipOf(rent), { label: 'Done', tone: 'ok' });
  assert.deepEqual(chipOf(salary), { label: 'Coming', tone: 'quiet' });
  assert.deepEqual(chipOf(gym), { label: 'Late', tone: 'warn' });
});

// RG1b: a prepared transfer (a goal's or another) that is regular, possibly starting next month.
const goal: RegularItem = {
  id: 'prep-carla',
  label: 'Goal: Pagar a Carla',
  amountCents: -66667,
  usualDay: 1,
  source: 'prepared',
  nextDue: '2026-11-01',
  goalId: 'goal-carla',
  thisMonth: 'next_month',
  excludable: false,
};
test('a prepared item: its chip says when it starts, its tag says prepared (and goal)', () => {
  assert.deepEqual(chipOf(goal), { label: 'Starts 1 Nov', tone: 'quiet' });
  assert.deepEqual(chipOf({ ...goal, nextDue: undefined }), { label: 'Next month', tone: 'quiet' });
  assert.equal(seenWords(goal), 'prepared · goal');
  assert.equal(seenWords({ ...goal, goalId: undefined, label: 'To Ana' }), 'prepared');
});

test('the irregular line: about whole euros a month, over the first to the last month', () => {
  assert.equal(
    irregularWords(full.irregularSpend!),
    'Irregular spending: about €312 a month over Jul–Sep',
  );
  assert.equal(
    irregularWords({ monthlyCents: 4050, months: ['2026-09'] }),
    'Irregular spending: about €41 a month over Sep',
  );
  // RG1: 0 (history, no irregular debit) is said, not hidden.
  assert.equal(
    irregularWords({ monthlyCents: 0, months: ['2026-07', '2026-08', '2026-09'] }),
    'Irregular spending: about €0 a month over Jul–Sep',
  );
});

// The page as usePlan renders it, with a two-account forecast whose accounts carry `regular`.
const step3 = JSON.parse(
  fs.readFileSync('tests/plan-fixtures/forecast-take-step3.json', 'utf8'),
) as MonthForecast;
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
function page(regular: Regular | undefined, adjustable = true, nextMonth?: unknown[]) {
  const [a] = step3.accounts;
  const forecast = {
    ...step3,
    adjustable,
    accounts: [{ ...a, regular, nextMonth }],
  } as MonthForecast;
  let got = {} as ReturnType<typeof usePlan>;
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
    return null;
  }
  renderToStaticMarkup(createElement(Host));
  return text(renderToStaticMarkup(createElement('main', null, got.page as React.ReactNode)));
}
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;

test('the section comes right after Month ahead, with both lists, their totals and the irregular line', () => {
  const html = page(full);
  const month = html.indexOf('data-testid="plan-forecast"'),
    regular = html.indexOf('data-testid="plan-regular"');
  assert.ok(month >= 0 && regular > month);
  assert.match(html, /<h2[^>]*>Regular money<\/h2>/);
  assert.ok(html.includes('Regular income') && html.includes('Regular charges'));
  assert.ok(html.includes('+€2,100.00 a month'));
  assert.ok(html.includes('−€889.90 a month') || html.includes('-€889.90 a month'));
  assert.ok(html.includes('around the 28th') && html.includes('detected · seen Jul, Aug, Sep'));
  assert.ok(html.includes('added by you'));
  assert.deepEqual(
    [...html.matchAll(/data-this-month="([a-z_]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]),
    [
      ['to_come', 'Coming'],
      ['done', 'Done'],
      ['late', 'Late'],
    ],
  );
  assert.ok(html.includes('Irregular spending: about €312 a month over Jul–Sep'));
  // "Not regular" only on the excludable detected item; "Remove" only on the customer's own.
  assert.equal(count(html, 'regular-exclude'), 1);
  assert.match(html, /data-testid="regular-exclude" aria-label="Salary is not regular"/);
  assert.equal(count(html, 'regular-remove'), 1);
  assert.equal(count(html, 'regular-add-income') + count(html, 'regular-add-charge'), 2);
});

test('empty states: no history at all, or one list without items; none without the irregular line', () => {
  const none = page({ income: [], charges: [], irregularSpend: null });
  assert.ok(none.includes('after a few full months of movements'));
  assert.ok(!none.includes('Irregular spending'));
  const oneEmpty = page({ ...full, income: [] });
  assert.ok(!oneEmpty.includes('after a few full months of movements'));
  assert.ok(oneEmpty.includes('No regular income found yet.'));
  assert.ok(!oneEmpty.includes('No regular charges found yet.'));
});

test('no `regular` on the account: no section; not adjustable: no actions', () => {
  assert.equal(count(page(undefined), 'plan-regular'), 0);
  const quiet = page(full, false);
  assert.equal(count(quiet, 'plan-regular'), 1);
  for (const id of [
    'regular-exclude',
    'regular-remove',
    'regular-add-income',
    'regular-add-charge',
  ])
    assert.equal(count(quiet, id), 0, id);
});

test('a prepared item has no action but a link to its goal; "Early next month" under Month ahead', () => {
  const html = page({ ...full, charges: [...full.charges, goal] }, true, [
    {
      date: '2026-11-01',
      label: 'Goal: Pagar a Carla',
      amountCents: -66667,
      preparedId: 'prep-carla',
      goalId: 'goal-carla',
    },
  ]);
  assert.equal(count(html, 'regular-exclude'), 1);
  assert.equal(count(html, 'regular-remove'), 1);
  assert.match(html, /data-this-month="next_month"[^>]*>Starts 1 Nov</);
  assert.ok(html.includes('around the 1st · prepared · goal'));
  assert.match(
    html,
    /data-testid="regular-open" aria-label="Open the goal of Goal: Pagar a Carla"/,
  );
  const early = html.indexOf('data-testid="forecast-next-month"');
  assert.ok(early > html.indexOf('data-testid="plan-forecast"'));
  assert.ok(early < html.indexOf('data-testid="plan-regular"'));
  assert.ok(html.includes('Early next month'));
  assert.match(html, /1 Nov<\/span><span[^>]*>Goal: Pagar a Carla<\/span><span[^>]*>-€666\.67</);
  // RG1b: a nextMonth item the customer added has its Remove; the others none.
  const added = page(full, true, [
    { date: '2026-11-01', label: 'Alquiler Inmob Castellana', amountCents: -95000 },
    { date: '2026-11-03', label: 'Car loan', amountCents: -12050, adjustmentId: 'adj-car' },
  ]);
  const list = added.slice(
    added.indexOf('data-testid="forecast-next-month"'),
    added.indexOf('data-testid="plan-regular"'),
  );
  assert.equal((list.match(/aria-label="Remove /g) ?? []).length, 1);
  assert.match(list, /aria-label="Remove Car loan"/);
  // A goal's payment as income on the account it reaches: the same tag.
  assert.equal(seenWords({ ...goal, amountCents: 66667 }), 'prepared · goal');
  for (const none of [undefined, []])
    assert.equal(count(page(full, true, none), 'forecast-next-month'), 0);
});
