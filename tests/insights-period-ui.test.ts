// IT8c-ui: the period dropdown of the spending card (contracts.md 2.21, §8 `spending-period`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PeriodMenu,
  SpendingCard,
  beforeHistory,
  monthEnabled,
  periodLabel,
  periodPresets,
  previousPeriod,
  rangeHint,
  rangeText,
  weekOf,
  type Insights,
} from '../app/_components/SpendInsights';

const noop = async () => {};
const TODAY = '2026-10-04'; // a Sunday
const periods = [
  { id: '2026-10', label: 'Oct 2026', count: 1, partial: true, partialReason: 'in_progress' },
  { id: '2026-09', label: 'Sep 2026', count: 20, partial: false },
  { id: '2026-08', label: 'Aug 2026', count: 15, partial: false },
  { id: 'all', label: 'All movements', count: 36, partial: false },
] as const;
const base = {
  range: { from: null, to: null },
  window: { returned: 36, oldestAt: '2026-08-01T08:00:00.000Z', mayBeTruncated: false },
  partial: false,
  spentCents: 20000,
  incomeCents: 0,
  categories: [
    {
      id: 'groceries' as const,
      label: 'Groceries',
      spentCents: 20000,
      count: 2,
      confirmedCents: 0,
      estimatedCents: 20000,
    },
  ],
  unresolved: { count: 0, totalCents: 0, groups: [] },
  pending: 0,
  decider: 'none' as const,
};
const withPeriod = (period: string, over: object = {}) => ({
  ...base,
  period,
  today: TODAY,
  windowDays: { from: '2026-08-01', to: '2026-10-01' },
  periods,
  unresolvedInPeriod: { count: 0, debitCents: 0 },
  ...over,
});
const card = (summary: object, period?: string) =>
  renderToStaticMarkup(
    createElement(SpendingCard, {
      insights: {
        summary,
        rules: [],
        feedback: null,
        busy: false,
        setCategory: noop,
        acceptOffer: noop,
        dismiss: () => {},
        removeRule: noop,
        retry: noop,
      } as Insights,
      period,
    }),
  );
const menu = (applied: string, windowFrom: string | null = '2026-08-01') =>
  renderToStaticMarkup(
    createElement(PeriodMenu, {
      applied,
      today: TODAY,
      windowFrom,
      periods: [...periods],
      onPick() {},
    }),
  );
// Every option of a menu: [data-period, aria-pressed, disabled].
const options = (html: string) =>
  [...html.matchAll(/<button[^>]*data-testid="spending-period-option"[^>]*>/g)].map((m) => [
    m[0].match(/data-period="([^"]*)"/)![1],
    m[0].match(/aria-pressed="([^"]*)"/)![1],
    / disabled=""/.test(m[0]),
  ]);

test('weeks are Monday to Sunday, from a Monday, a Sunday, across a month end and a year end', () => {
  assert.equal(weekOf('2026-09-07'), '2026-09-07..2026-09-13'); // a Monday
  assert.equal(weekOf('2026-09-13'), '2026-09-07..2026-09-13'); // its Sunday
  assert.equal(weekOf('2026-10-01'), '2026-09-28..2026-10-04'); // across a month end
  assert.equal(weekOf('2027-01-01'), '2026-12-28..2027-01-03'); // across a year end
  assert.equal(weekOf('2024-03-01'), '2024-02-26..2024-03-03'); // over 29 February
});

test('the quick choices send this and last week, month and year, and all', () => {
  assert.deepEqual(periodPresets(TODAY), [
    { id: '2026-09-28..2026-10-04', label: 'This week' },
    { id: '2026-09-21..2026-09-27', label: 'Last week' },
    { id: 'current', label: 'This month' },
    { id: '2026-09', label: 'Last month' },
    { id: '2026', label: 'This year' },
    { id: '2025', label: 'Last year' },
    { id: 'all', label: 'All movements' },
  ]);
  // In January the month and the year before are those of the last year.
  const january = periodPresets('2027-01-05');
  assert.equal(january[3].id, '2026-12');
  assert.equal(january[5].id, '2026');
});

test('labels: the quick names, else the month, the year or the days', () => {
  assert.equal(periodLabel('2026-10', TODAY), 'This month');
  assert.equal(periodLabel('2026-09', TODAY), 'Last month');
  assert.equal(periodLabel('2026-08', TODAY), 'Aug 2026');
  assert.equal(periodLabel('2026', TODAY), 'This year');
  assert.equal(periodLabel('2025', TODAY), 'Last year');
  assert.equal(periodLabel('2024', TODAY), '2024');
  assert.equal(periodLabel('2026-09-28..2026-10-04', TODAY), 'This week');
  assert.equal(periodLabel('2026-09-21..2026-09-27', TODAY), 'Last week');
  assert.equal(periodLabel('2026-09-07..2026-09-13', TODAY), '7 Sep – 13 Sep 2026');
  assert.equal(periodLabel('all', TODAY), 'All movements');
  // Not relative: what the period is, whatever today is.
  assert.equal(periodLabel('2026-10', TODAY, false), 'Oct 2026');
  assert.equal(periodLabel('2026-09-28..2026-10-04', TODAY, false), '28 Sep – 4 Oct 2026');
  assert.equal(rangeText('2025-12-29', '2026-01-04'), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(rangeText('2026-09-07', '2026-09-07'), '7 Sep 2026');
});

test('a month can be chosen from the month of the oldest movement to the current one', () => {
  assert.equal(monthEnabled('2026-07', '2026-08-01', TODAY), false);
  assert.equal(monthEnabled('2026-08', '2026-08-31', TODAY), true);
  assert.equal(monthEnabled('2026-10', '2026-08-01', TODAY), true);
  assert.equal(monthEnabled('2026-11', '2026-08-01', TODAY), false);
  // No movement at all: only the current month.
  assert.equal(monthEnabled('2026-10', null, TODAY), true);
  assert.equal(monthEnabled('2026-09', null, TODAY), false);
});

test('the period before: a month, a year, a whole week; none before the history or for a range', () => {
  assert.equal(previousPeriod('2026-10', '2026-08-01'), '2026-09');
  assert.equal(previousPeriod('2027-01', '2026-08-01'), '2026-12');
  assert.equal(previousPeriod('2026-08', '2026-08-01'), null);
  assert.equal(previousPeriod('2026', '2025-11-20'), '2025');
  assert.equal(previousPeriod('2026', '2026-08-01'), null);
  assert.equal(previousPeriod('2026-09-28..2026-10-04', '2026-08-01'), '2026-09-21..2026-09-27');
  assert.equal(previousPeriod('2026-08-03..2026-08-09', '2026-08-01'), '2026-07-27..2026-08-02');
  assert.equal(previousPeriod('2026-07-27..2026-08-02', '2026-08-03'), null);
  assert.equal(previousPeriod('2026-09-08..2026-09-13', '2026-08-01'), null); // not a whole week
  assert.equal(previousPeriod('all', '2026-08-01'), null);
  assert.equal(previousPeriod('2026-10', null), null);
});

test('a quick choice that ends before the history is disabled; unknown history rules nothing out', () => {
  assert.equal(beforeHistory('2025', '2026-08-01'), true);
  assert.equal(beforeHistory('2026', '2026-08-01'), false);
  assert.equal(beforeHistory('2026-07', '2026-08-01'), true);
  assert.equal(beforeHistory('2026-08', '2026-08-31'), false);
  assert.equal(beforeHistory('2026-07-20..2026-07-26', '2026-08-01'), true);
  assert.equal(beforeHistory('2026-07-27..2026-08-02', '2026-08-01'), false); // reaches it
  assert.equal(beforeHistory('all', '2026-08-01'), false);
  assert.equal(beforeHistory('current', '2026-08-01'), false);
  assert.equal(beforeHistory('2025', null), false);
  // In the menu: "Last year" (2025) is disabled on a history that starts in August 2026.
  const quick = (html: string) => options(html).slice(0, 7);
  assert.deepEqual(
    quick(menu('2026-10'))
      .filter((o) => o[2])
      .map((o) => o[0]),
    ['2025'],
  );
  // A history that starts on 29 September: last week ended before it; last month reaches it.
  assert.deepEqual(
    quick(menu('2026-10', '2026-09-29'))
      .filter((o) => o[2])
      .map((o) => o[0]),
    ['2026-09-21..2026-09-27', '2025'],
  );
  assert.deepEqual(
    quick(menu('2026-10', null)).filter((o) => o[2]),
    [],
  );
});

test('the card: a dropdown button named by the applied period, closed, with its caption', () => {
  const html = card(
    withPeriod('2026-09', { range: { from: '2026-09-01', to: '2026-09-30' } }),
    '2026-09',
  );
  assert.match(
    html,
    /<button[^>]*data-testid="spending-period"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/,
  );
  assert.match(html, /<span>Last month<\/span>/);
  // The value sent is on the button: readable without opening the menu.
  assert.match(html, /<button[^>]*data-testid="spending-period"[^>]*data-period="2026-09"/);
  assert.match(
    card(withPeriod('2026-10'), 'current'),
    /<button[^>]*data-testid="spending-period"[^>]*data-period="current"/,
  );
  assert.match(card(withPeriod('all')), /data-testid="spending-period"[^>]*data-period="all"/);
  assert.doesNotMatch(html, /spending-period-menu|spending-period-option/);
  assert.match(html, /data-testid="spending-period-note">Sep 2026 · 20 movements</);
  assert.match(html, /aria-busy="false"/);
  // A week has no count of its own in the answer: its days only.
  const week = card(withPeriod('2026-09-07..2026-09-13'), '2026-09-07..2026-09-13');
  assert.match(week, /<span>7 Sep – 13 Sep 2026<\/span>/);
  // Its caption counts the movements of its spending (polish A9: one noun) (the fixture's one category has two); the
  // answer has no movement count for a range, and income is not among them.
  assert.match(week, /data-testid="spending-period-note">7 Sep – 13 Sep 2026 · 2 movements</);
  // Not while another period's figures are still shown.
  assert.match(
    card(withPeriod('2026-10'), '2026-09-07..2026-09-13'),
    /data-testid="spending-period-note">7 Sep – 13 Sep 2026</,
  );
  // A year: the movements of its months. All: as before.
  assert.match(card(withPeriod('2026'), '2026'), /spending-period-note">2026 · 36 movements</);
  assert.match(
    card(withPeriod('all'), 'all'),
    /spending-period-note">Since 1 Aug 2026 · 36 movements</,
  );
  // The whole window, cut by the bank: said from its entry in `periods` (it has no reason of its own).
  const cutAll = periods.map((p) =>
    p.id === 'all' ? { ...p, partial: true, partialReason: 'window' } : p,
  );
  assert.match(
    card(withPeriod('all', { periods: cutAll }), 'all'),
    /36 movements · older movements are not included</,
  );
  // The button and the caption follow the period that was sent, at once; the card is busy until
  // the figures are those of that period, and only then is its reason said.
  const waiting = card(
    withPeriod('2026-10', { partial: true, partialReason: 'in_progress' }),
    '2026-08',
  );
  assert.match(waiting, /<span>Aug 2026<\/span>/);
  assert.match(waiting, /spending-period-note">Aug 2026 · 15 movements</);
  // A range that is exactly a month stays a range: named by its days, not matched to a month.
  const asMonth = card(withPeriod('2026-09-01..2026-09-30'), '2026-09-01..2026-09-30');
  assert.match(asMonth, /<span>1 Sep – 30 Sep 2026<\/span>/);
  assert.match(asMonth, /aria-busy="false"/);
  assert.match(waiting, /aria-busy="true"/);
  assert.match(card(withPeriod('2026-10'), 'current'), /aria-busy="false"/);
});

test('the card: an empty period says so and offers the one before; partial periods say why', () => {
  const empty = { spentCents: 0, categories: [] };
  const now = card(
    withPeriod('2026-10', { ...empty, partial: true, partialReason: 'in_progress' }),
    'current',
  );
  assert.match(now, /<span>This month<\/span>/);
  assert.match(now, /spending-period-note">Oct 2026 · 1 movement · in progress</);
  assert.match(now, /No spending in Oct 2026 yet\./);
  // Polish follow-up: the noun is "movements", as everywhere else on the card.
  assert.match(now, /<span>New movements show here as the bank reports them\.<\/span>/);
  assert.match(now, /data-testid="spending-period-previous"[^>]*>See Sep 2026</);
  const past = card(withPeriod('2026-09-14..2026-09-20', empty), '2026-09-14..2026-09-20');
  assert.match(past, /No spending in 14 Sep – 20 Sep 2026\./);
  // No payment: the dates only.
  assert.match(past, /data-testid="spending-period-note">14 Sep – 20 Sep 2026</);
  assert.match(past, /spending-period-previous"[^>]*>See 7 Sep – 13 Sep 2026</);
  assert.doesNotMatch(
    card(withPeriod('2026-09-08..2026-09-10', empty)),
    /spending-period-previous/,
  );
  const cut = card(
    withPeriod('2026-08', {
      incomeCents: 50000,
      partial: true,
      partialReason: 'window',
      window: { ...base.window, mayBeTruncated: true },
    }),
  );
  assert.match(cut, /Aug 2026 · 15 movements · the bank&#x27;s history starts on 1 Aug 2026</);
  assert.doesNotMatch(cut, /of income/);
});

test('the share of income is shown only for a period that has ended', () => {
  const income = { incomeCents: 215000 };
  assert.match(card(withPeriod('2026-09', income)), /of income · estimate/);
  // The current month and "All movements" end in a month whose income may not have arrived.
  assert.doesNotMatch(
    card(withPeriod('2026-10', { ...income, partial: true, partialReason: 'in_progress' })),
    /of income/,
  );
  assert.doesNotMatch(card(withPeriod('all', income)), /of income/);
});

test('the menu: quick choices, the months of a year and a range, with the applied one pressed', () => {
  const html = menu('2026-09');
  assert.match(
    html,
    /data-testid="spending-period-menu" role="dialog" aria-label="Choose a period"/,
  );
  const all = options(html);
  assert.deepEqual(
    all.slice(0, 7).map((o) => o[0]),
    [
      '2026-09-28..2026-10-04',
      '2026-09-21..2026-09-27',
      'current',
      '2026-09',
      '2026',
      '2025',
      'all',
    ],
  );
  // Twelve months of the applied period's year; before August and after October: disabled.
  assert.deepEqual(
    all.slice(7).map((o) => o[0]),
    Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
  );
  assert.deepEqual(
    all
      .slice(7)
      .filter((o) => !o[2])
      .map((o) => o[0]),
    ['2026-08', '2026-09', '2026-10'],
  );
  // "Last month" and the September cell are the applied period; nothing else is.
  assert.deepEqual(
    all.filter((o) => o[1] === 'true').map((o) => o[0]),
    ['2026-09', '2026-09'],
  );
  // The history starts in 2026: no year before it, none after this one.
  assert.match(html, /aria-label="Previous year" disabled=""/);
  assert.match(html, /aria-label="Next year" disabled=""/);
  assert.match(
    html,
    /data-testid="spending-period-from"[^>]*min="2026-08-01"[^>]*max="2026-10-04"/,
  );
  assert.match(html, /data-testid="spending-period-apply"[^>]*disabled=""/);
  assert.match(html, /The bank&#x27;s history starts on 1 Aug 2026\./);
  // `current` is pressed for the month of today; a range fills the two dates.
  assert.equal(options(menu('2026-10'))[2][1], 'true');
  const range = menu('2026-09-07..2026-09-13');
  assert.match(range, /spending-period-from"[^>]*value="2026-09-07"/);
  assert.match(range, /spending-period-to"[^>]*value="2026-09-13"/);
  assert.doesNotMatch(range, /spending-period-apply"[^>]*disabled/);
  // With an older history the year before can be reached.
  assert.doesNotMatch(menu('2026-09', '2024-03-10'), /aria-label="Previous year" disabled/);
  assert.doesNotMatch(menu('all', null), /history starts/);
});

test('without periods: no control, the window chip as before', () => {
  const html = card(base);
  assert.doesNotMatch(html, /spending-period/);
  assert.match(html, /class="si-window">Since 1 Aug 2026 · 36 movements</);
});

// Nit 3: typed days are not held by the inputs' min / max.
test('the custom range: days before the history or after this week get a hint and cannot be applied', () => {
  const from = '2026-08-01',
    wednesday = '2026-09-30'; // its week ends on Sunday 4 Oct
  assert.equal(rangeHint('2026-09-07', '2026-09-13', from, wednesday), null);
  assert.equal(rangeHint('2026-08-01', '2026-10-04', from, wednesday), null); // both bounds fit
  assert.equal(rangeHint('', '', from, wednesday), null); // nothing typed yet
  assert.equal(
    rangeHint('2020-01-01', '2020-01-31', from, wednesday),
    'Choose dates from 1 Aug 2026.',
  );
  assert.equal(rangeHint('2026-07-31', '', from, wednesday), 'Choose dates from 1 Aug 2026.');
  assert.equal(
    rangeHint('2026-09-01', '2027-01-01', from, wednesday),
    'Choose dates up to 4 Oct 2026.',
  );
  assert.equal(
    rangeHint('2026-09-01', '2026-10-05', from, wednesday),
    'Choose dates up to 4 Oct 2026.',
  );
  // Unknown history: only the upper bound.
  assert.equal(rangeHint('2020-01-01', '2020-01-31', null, wednesday), null);
});

// DS2 (contracts.md 2.30): the card opens on the last full month. The page asks for `last` and
// then holds the month the server named, so everything shown derives from a value that was sent.
test('DS2 the default view: "Last month", named by its month, never "in progress"', () => {
  // The first paint and every one after it: `last` until the answer is in, then the month.
  for (const sent of ['last', '2026-09']) {
    const html = card(withPeriod('2026-09'), sent);
    assert.match(html, /aria-label="Period: Last month"/, sent);
    assert.match(html, /<span>Last month<\/span>/, sent);
    assert.match(html, /spending-period-note">Sep 2026 · 20 movements</, sent);
    assert.doesNotMatch(html, /in progress/, sent);
    assert.match(html, /aria-busy="false"/, sent);
  }
  assert.match(card(withPeriod('2026-09'), '2026-09'), /data-period="2026-09"/);
  // In the menu "Last month" and the September cell are pressed; "This month" is one option away.
  const pressed = options(menu('2026-09'));
  assert.deepEqual(
    pressed.filter((o) => o[1] === 'true').map((o) => o[0]),
    ['2026-09', '2026-09'],
  );
  assert.deepEqual(
    pressed.find((o) => o[0] === 'current'),
    ['current', 'false', false],
  );
  // No spending last month: the existing empty state, with the month before when the bank's
  // history reaches it, and with no shortcut when it does not.
  const empty = { spentCents: 0, categories: [] };
  const quiet = card(withPeriod('2026-09', empty), '2026-09');
  assert.match(quiet, /No spending in Sep 2026\./);
  assert.doesNotMatch(quiet, /yet\.|New movements show here/);
  assert.match(quiet, /data-testid="spending-period-previous"[^>]*>See Aug 2026</);
  const young = card(
    withPeriod('2026-09', { ...empty, windowDays: { from: '2026-10-01', to: '2026-10-01' } }),
    '2026-09',
  );
  assert.match(young, /No spending in Sep 2026\./);
  assert.doesNotMatch(young, /spending-period-previous/);
});
