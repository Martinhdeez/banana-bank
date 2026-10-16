// Polish pass, PR 2 (Overview and spending card): one case per audit item that has markup or
// logic. The layout items (A21, A4, A3, A18, A20) are CSS: the browser probe in
// .scratch/after/fix-polish-overview/ checks them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountDrawer } from '../app/_components/AccountDrawer';
import { chatSuggestions } from '../app/_components/ChatInsights';
import { MovementFilters, emptyFilters } from '../app/_components/MovementFilters';
import { Overview } from '../app/_components/Overview';
import {
  CategoryChip,
  SpendingCard,
  rangeHint,
  whyText,
  type Insights,
} from '../app/_components/SpendInsights';
import type { Person } from '../src/types';
import { formatDate, formatDay, paidLine, type ActivityRow } from '../src/ui-helpers';

const noop = () => {};
const later = async () => {};
const accounts = [
  { id: 'acc-me', label: 'Aurora account', balanceCents: 1000, iban: 'ES9100000000000000004821' },
  { id: 'acc-sav', label: 'Personal savings', balanceCents: 500, iban: 'ES1200000000000000007305' },
];
const dashboard = {
  accounts,
  contacts: [{ id: 'acc-bruno', label: 'Horizon account', ownerId: 'bruno', ownerName: 'Bruno V' }],
  approvals: [],
  movements: [],
};
const overview = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      current: { id: 'me', name: 'Lucía Pérez' } as Person,
      people: [] as Person[],
      dashboard,
      allActivity: false,
      onToggleAll: noop,
      onTab: noop,
      onOpenAccount: noop,
      onStartTransfer: noop,
      ...extra,
    }),
  );
const summary = {
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
  today: '2026-10-04',
  windowDays: { from: '2026-08-01', to: '2026-10-01' },
  periods: [{ id: 'all', label: 'All movements', count: 36, partial: false }],
  unresolvedInPeriod: { count: 0, debitCents: 0 },
};
const insights = (over: object = {}) =>
  ({
    summary,
    rules: [],
    feedback: null,
    busy: false,
    setCategory: later,
    acceptOffer: later,
    dismiss: noop,
    removeRule: later,
    retry: later,
    ...over,
  }) as unknown as Insights;
const card = (over: object, period?: string) =>
  renderToStaticMarkup(
    createElement(SpendingCard, {
      insights: insights({ summary: { ...summary, ...over } }),
      period,
      onAsk: noop,
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, '');

test('A9: one noun for the count, and the period said once: the focus block reads "Spent"', () => {
  for (const period of ['2026-09-07..2026-09-13', '2026-09']) {
    const html = card({ period }, period);
    assert.match(html, /<span class="si-focus-label">Spent<\/span>/, period);
    assert.doesNotMatch(html, /payment/, period);
  }
  assert.match(
    card({ period: '2026-09-07..2026-09-13' }, '2026-09-07..2026-09-13'),
    /data-testid="spending-period-note">7 Sep – 13 Sep 2026 · 2 movements</,
  );
});

test('A10: three-letter months in the shared date formats', () => {
  assert.equal(formatDate('2026-09-30T08:10:00', false), '30 Sep 2026');
  assert.match(formatDate('2026-09-30T08:10:00'), /^30 Sep 2026, 08:10$/);
  assert.equal(formatDay('2026-09-01', new Date('2026-10-05T12:00:00')), '1 Sep');
  assert.equal(formatDay('2025-09-01', new Date('2026-10-05T12:00:00')), '1 Sep 2025');
  assert.equal(
    paidLine(
      [{ id: 'a' }],
      [{ accountId: 'a', lastAt: '2026-09-23T10:00:00' }],
      new Date('2026-10-05T12:00:00'),
    ),
    'Paid 23 Sep',
  );
  // The other months are as they were.
  assert.equal(formatDate('2026-06-03T08:10:00', false), '3 Jun 2026');
});

test('A10: under "Transactions" the empty states say transactions', () => {
  const html = overview();
  assert.match(html, /<h2>Transactions<\/h2>/);
  assert.match(html, /<p class="empty-state">No transactions yet\.<\/p>/);
  const drawer = renderToStaticMarkup(
    createElement(AccountDrawer, {
      account: accounts[0],
      isMain: true,
      holder: 'Lucía Pérez',
      dashboard,
      onClose: noop,
      onTransferFrom: noop,
    }),
  );
  assert.match(drawer, /Recent transactions<\/h3><p class="empty-state">No transactions yet\.</);
  // A24c: the tile of the drawer has the icon of the account's row.
  assert.match(drawer, /<span class="drawer-tile" aria-hidden="true"><svg/);
});

test('A11: Recipients offers a transfer, not a list or a new recipient', () => {
  const html = overview();
  const recipients = html.match(/<section class="card recipients"[\s\S]*?<\/section>/)![0];
  assert.match(recipients, /<button class="text-link">New transfer<\/button>/);
  assert.doesNotMatch(recipients, /All recipients|recipient new/);
  assert.equal(recipients.match(/<button class="recipient"/g)?.length, 1);
  // A4: the row of recipients comes before the table, inside the bottom section.
  assert.match(html, /<section class="overview-bottom"><section class="card recipients"/);
  assert.ok(html.indexOf('card recipients') < html.indexOf('card movements'));
});

const row = (state: 'estimated' | 'needs_review', reason: string): ActivityRow =>
  ({
    id: 'm1',
    kind: 'movement',
    title: 'MERCADONA 0412',
    detail: '',
    amountCents: -4210,
    account: 'Everyday',
    accountId: 'acc-me',
    createdAt: '2026-09-20T10:00:00.000Z',
    direction: 'sent',
    category: {
      id: state === 'estimated' ? 'groceries' : 'other',
      state,
      source: 'rule',
      reason,
      confidence: null,
      threshold: null,
      candidates: [],
      merchantKey: 'MERCADONA',
      model: null,
      movementIds: ['m1'],
    },
  }) as ActivityRow;
const chip = (r: ActivityRow) =>
  renderToStaticMarkup(createElement(CategoryChip, { row: r, insights: insights() }));

test('A12: the button that confirms an estimate says "Confirm"', () => {
  assert.match(
    chip(row('estimated', 'keyword:MERCADONA')),
    /<button type="button" class="si-keep" aria-label="Confirm Groceries for MERCADONA 0412">Confirm<\/button>/,
  );
});

test('A23: a movement nobody could classify explains itself in customer words', () => {
  const why = whyText(row('needs_review', 'no_decider').category!);
  assert.equal(why, "We could not tell from the bank's text. Pick a category.");
  assert.match(chip(row('needs_review', 'no_decider')), /data-testid="category-why">We could not/);
});

test('A18: in a card to sort, the suggestions are one line and the select line is the last', () => {
  const group = (candidates: object[]) => ({
    merchantKey: 'BAR LA ESQUINA',
    title: 'TPV BAR LA ESQUINA',
    direction: 'debit',
    count: 2,
    totalCents: 3000,
    movementIds: ['m1', 'm2'],
    reason: 'below_threshold',
    candidates,
  });
  const html = (candidates: object[]) =>
    card({ unresolved: { count: 2, totalCents: 3000, groups: [group(candidates)] } }).match(
      /<li data-testid="unresolved-group"[\s\S]*?<\/li>/,
    )![0];
  const two = html([
    { category: 'eating_out_leisure', p: 0.62 },
    { category: 'groceries', p: 0.2 },
  ]);
  assert.match(
    two,
    /<\/span><span class="si-suggest">(<button type="button" class="si-candidate"[^>]*data-testid="unresolved-candidate"[\s\S]*?<\/button>){2}<\/span><span class="si-group-foot"><span class="si-group-select"><select aria-label="Category for BAR LA ESQUINA"/,
  );
  assert.match(two, /Resolve in chat<\/button><\/span><\/span><\/li>$/);
  // No suggestion: no empty line for them, the same last line.
  const none = html([]);
  assert.doesNotMatch(none, /si-suggest/);
  assert.match(none, /<span class="si-group-foot"><span class="si-group-select">/);
  assert.equal(text(none), 'BAR LA ESQUINA 2 movements · €30.00Not sure? Resolve in chat');
});

test('A24d: a reversed custom range says why it cannot be applied', () => {
  assert.equal(
    rangeHint('2026-09-20', '2026-09-10', '2026-08-01', '2026-10-04'),
    'From must be on or before To.',
  );
  assert.equal(rangeHint('2026-09-10', '2026-09-20', '2026-08-01', '2026-10-04'), null);
  assert.equal(rangeHint('2026-09-10', '2026-09-10', '2026-08-01', '2026-10-04'), null);
  assert.equal(rangeHint('2026-09-20', '', '2026-08-01', '2026-10-04'), null);
  // A day outside the history keeps its own hint.
  assert.equal(
    rangeHint('2026-09-20', '2026-07-01', '2026-08-01', '2026-10-04'),
    'Choose dates from 1 Aug 2026.',
  );
});

test('A24e: an empty search result has one control that clears it', () => {
  const filters = (rows: ActivityRow[]) =>
    renderToStaticMarkup(
      createElement(MovementFilters, {
        text: 'zzz',
        value: { ...emptyFilters, q: 'zzz' },
        onText: noop,
        onChange: noop,
        onClear: noop,
        busy: false,
        error: '',
        result: {
          rows,
          window: { limit: 100, returned: 3, oldestAt: null, mayBeTruncated: false },
        },
        exportHref: null,
      }),
    );
  const clears = (html: string) =>
    [...html.matchAll(/<button[^>]*>(Clear[^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(clears(filters([])), ['Clear filters']);
  assert.deepEqual(clears(filters([row('estimated', 'keyword:X')])), ['Clear']);
});

test('A24f: the Assistant starts with the suggestions of the Overview card, in its order', () => {
  const onOverview = [
    ...overview({ onAsk: noop })
      .match(/<div class="assistant-chips">(.*?)<\/div>/)![1]
      .matchAll(/<button>(.*?)<\/button>/g),
  ].map((m) => m[1]);
  assert.equal(onOverview.length, 3);
  assert.deepEqual(chatSuggestions(accounts), [...onOverview, 'I want to speak to a person']);
});
