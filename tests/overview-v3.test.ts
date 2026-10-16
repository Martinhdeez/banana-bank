// Overview v3: the balance card (total, one row per account) and the side column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../app/_components/Overview';
import type { Person } from '../src/types';

const noop = () => {};
const dashboard = {
  accounts: [
    {
      id: 'acc-sav',
      label: 'Personal savings',
      balanceCents: 130000,
      iban: 'ES12 0000 0000 0000 7305',
    },
    {
      id: 'acc-me',
      label: 'Aurora account',
      balanceCents: 293761,
      iban: 'ES9100000000000000004821',
    },
    { id: 'acc-x', label: 'Travel', balanceCents: -250 },
  ],
  contacts: [],
  approvals: [
    {
      id: 'ap1',
      expires_at: '2026-10-04T10:00:00.000Z',
      payload: { amountCents: 500, toAccountId: 'acc-sav', concept: 'Rent' },
    },
  ],
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
const text = (html: string) => html.replace(/<[^>]+>/g, '');

test('v3: the balance card shows the total and one row per account, main first', () => {
  const html = overview();
  const card = html.match(/<section class="card balance-card">([\s\S]*?)<\/section>/)![1];
  // 1300.00 + 2937.61 - 2.50, to the cent, as one piece of text.
  assert.match(text(card), /^Total balance€4,235\.11· 3 accounts/);
  const rows = card
    .split('<button ')
    .slice(1)
    .map((r) => text(`<button ${r}`));
  assert.deepEqual(rows, [
    'Aurora accountCurrent account · ···· 4821Main€2,937.61',
    'Personal savingsSavings account · ···· 7305€1,300.00',
    // No IBAN in the data: the kind only.
    'TravelCurrent account-€2.50',
  ]);
  assert.equal(card.match(/class="account-card main"/g)?.length, 1);
  assert.equal(card.match(/class="badge-main"/g)?.length, 1);
  for (const label of ['Aurora account', 'Personal savings', 'Travel'])
    assert.ok(card.includes(`aria-label="${label} details"`), label);
  assert.match(
    overview({ dashboard: { ...dashboard, accounts: dashboard.accounts.slice(1, 2) } }),
    /· 1 account</,
  );
});

test('v3: "For you to do" and the Assistant card sit in the side column, before the slots', () => {
  const html = overview({ insights: createElement('p', { id: 'dummy-insights' }) });
  const side = html.match(
    /<div class="overview-side">([\s\S]*?)<\/div><\/section><div class="overview-insights"/,
  )![1];
  // "For you to do" first (a pending money task is on the first screen of a phone), then the
  // Assistant card; from 1240px the stylesheet draws them as left column and right column.
  assert.match(
    side,
    /^<section class="card attention"[^>]*><div class="attention-head"><h2 id="attention-title">For you to do<\/h2><span class="count-badge">1</,
  );
  assert.match(
    side,
    /<\/ul><\/section><section class="card assistant-card"[^>]*>.*<h2 id="assistant-card-title">Assistant<\/h2>.*<\/section>$/,
  );
  // Without onAsk the card only opens the chat: no composer, no suggestions.
  assert.doesNotMatch(side, /<form|assistant-chips/);
  assert.ok(html.indexOf('balance-card') < html.indexOf('overview-side'));
  assert.ok(html.indexOf('overview-insights') < html.indexOf('class="overview-bottom"'));
  const asking = overview({ onAsk: noop });
  assert.match(asking, /<form class="assistant-ask"><input aria-label="Ask about your money"/);
  assert.equal(
    asking.match(/<div class="assistant-chips">(.*?)<\/div>/)![1].match(/<button/g)?.length,
    3,
  );
  // Nothing to do: only the Assistant card.
  assert.match(
    overview({ dashboard: { ...dashboard, approvals: [] } }),
    /<div class="overview-side"><section class="card assistant-card"/,
  );
});

test('v3 nits: the suggestions name what the rendered customer holds', () => {
  const chips = (accounts: object[]) =>
    [
      ...overview({ onAsk: noop, dashboard: { ...dashboard, accounts } })
        .match(/<div class="assistant-chips">(.*?)<\/div>/)![1]
        .matchAll(/<button>(.*?)<\/button>/g),
    ].map((m) => m[1]);
  assert.deepEqual(chips(dashboard.accounts), [
    'Where did my money go?',
    'What are the balances of my accounts?',
    'What is the fee of my Aurora account?',
  ]);
  // One account, another product: its own name, and no plural.
  assert.deepEqual(chips([{ id: 'acc-b', label: 'Horizon account', balanceCents: 100 }]), [
    'Where did my money go?',
    'What is the balance of my account?',
    'What is the fee of my Horizon account?',
  ]);
  // The main account, not the first one or a savings account.
  assert.match(
    chips([
      { id: 's', label: 'Personal savings', balanceCents: 1 },
      { id: 'h', label: 'Horizon account', balanceCents: 1 },
    ])[2],
    /my Horizon account\?$/,
  );
  // No account: no product and no balance to ask about (AS1), and never "Aurora".
  assert.deepEqual(chips([]), ['Where did my money go?']);
});
