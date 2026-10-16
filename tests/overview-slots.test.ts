// CF3-ui slots: Overview `emptyText` and a full-width `toolbar` row; nothing changes without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../app/_components/Overview';
import type { Person } from '../src/types';

const movements = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  accountId: 'acc-me',
  amountCents: -100 * (i + 1),
  concept: `Coffee ${i}`,
  createdAt: `2026-09-2${i}T10:00:00.000Z`,
}));
const dashboard = {
  accounts: [
    { id: 'acc-me', label: 'Everyday', balanceCents: 1000 },
    { id: 'acc-sav', label: 'Savings', balanceCents: 500 },
  ],
  contacts: [],
  movements,
};
const noop = () => {};
const props = {
  current: { id: 'me', name: 'Lucía Pérez' } as Person,
  people: [] as Person[],
  dashboard,
  allActivity: false,
  onToggleAll: noop,
  onTab: noop,
  onOpenAccount: noop,
  onStartTransfer: noop,
};
const render = (extra = {}) =>
  renderToStaticMarkup(createElement(Overview, { ...props, ...extra }));
const toolbar = createElement('input', { id: 'dummy-search' });

test('CF3-ui: without the new props the table is unchanged', () => {
  const html = render();
  assert.match(html, /class="movements-head"/);
  assert.match(html, /View all/);
  assert.doesNotMatch(html, /activity-toolbar/);
  const empty = render({ rows: [] });
  assert.match(empty, /class="movements-head"/);
  assert.match(empty, /No transactions yet\./);
  // CF7 (round 6): passed rows are a search result, so View all is hidden.
  assert.doesNotMatch(empty, /View all/);
});

test('CF3-ui: emptyText replaces the text and hides the headers and View all', () => {
  const html = render({ rows: [], emptyText: 'No movements match these filters.' });
  assert.match(html, /<p class="empty-state">No movements match these filters\.<\/p>/);
  assert.doesNotMatch(html, /No transactions yet/);
  assert.doesNotMatch(html, /movements-head/);
  assert.doesNotMatch(html, /View all/);
  assert.match(html, /<h2>Transactions<\/h2>/);
  assert.match(html, /aria-label="Filter by account"/);
});

test('CF3-ui: emptyText with rows keeps the headers and View all', () => {
  const html = render({ emptyText: 'No movements match these filters.' });
  assert.match(html, /class="movements-head"/);
  assert.match(html, /View all/);
  assert.doesNotMatch(html, /No movements match/);
});

test('CF3-ui: the toolbar renders in its own row under the header, before the table', () => {
  const html = render({ toolbar });
  const top = html.match(/<div class="movements-top">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  assert.ok(top, 'header found');
  assert.doesNotMatch(top, /dummy-search/);
  assert.match(
    html,
    /<\/div><\/div><div class="activity-toolbar"><input id="dummy-search"\/><\/div><div class="movements-head"/,
  );
  const empty = render({ toolbar, rows: [], emptyText: 'None.' });
  assert.match(
    empty,
    /<div class="activity-toolbar"><input id="dummy-search"\/><\/div><p class="empty-state">None\.<\/p>/,
  );
});
