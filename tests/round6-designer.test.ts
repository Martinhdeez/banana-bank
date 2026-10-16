// Round 6 designer items: CF7 (no View all over search rows), CF8 (the "Paid {date}" slot on the
// Transfers chips), PL1 (heading structure, one account-kind rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../app/_components/Overview';
import { Transfers } from '../app/_components/Transfers';
import { Assistant } from '../app/_components/Assistant';
import { accountKind, type ActivityRow } from '../src/ui-helpers';
import type { Person } from '../src/types';

const noop = () => {};
const movements = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  accountId: 'acc-me',
  amountCents: -100 * (i + 1),
  description: `Coffee ${i}`,
  createdAt: `2026-09-2${i}T10:00:00.000Z`,
}));
const dashboard = {
  accounts: [
    { id: 'acc-me', label: 'Aurora account', balanceCents: 1000 },
    { id: 'acc-sav', label: 'Savings', balanceCents: 500 },
    { id: 'acc-x', label: 'Travel', balanceCents: 200 },
  ],
  contacts: [
    { id: 'acc-carla', name: 'Carla Ríos', userId: 'carla' },
    { id: 'acc-bruno', name: 'Bruno Díaz', userId: 'bruno' },
  ],
  movements,
};
const overview = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      current: { id: 'me', name: 'Lucía Pérez' } as Person,
      people: [],
      dashboard,
      allActivity: false,
      onToggleAll: noop,
      onTab: noop,
      onOpenAccount: noop,
      onStartTransfer: noop,
      ...extra,
    }),
  );
const transfers = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Transfers, {
      dashboard,
      people: [],
      from: '',
      to: '',
      amount: '',
      concept: '',
      onFrom: noop,
      onTo: noop,
      onAmount: noop,
      onConcept: noop,
      busy: false,
      onSubmit: noop,
      approvals: null,
      ...extra,
    }),
  );
const row: ActivityRow = {
  id: 'r1',
  kind: 'movement',
  title: 'Coffee',
  detail: '',
  amountCents: -100,
  account: 'Aurora account',
  accountId: 'acc-me',
  createdAt: '2026-09-20T10:00:00.000Z',
  direction: 'sent',
};

test('CF7: View all is hidden whenever rows are passed; unchanged without them', () => {
  assert.match(overview(), /View all/);
  assert.doesNotMatch(overview({ rows: [row] }), /View all|Show less/);
  assert.doesNotMatch(overview({ rows: [row], allActivity: true }), /View all|Show less/);
  assert.doesNotMatch(overview({ rows: [] }), /View all/);
});

test('CF8: recentPaid adds a muted line under the chip name, as given', () => {
  const plain = transfers();
  assert.doesNotMatch(plain, /chip-paid/);
  const html = transfers({
    recentPaid: (k: string) => (k === 'bruno' ? 'Paid 23 Sept' : undefined),
  });
  assert.equal(html.match(/class="chip-paid"/g)?.length, 1);
  assert.match(html, /Bruno<small class="chip-paid">Paid 23 Sept<\/small><\/button>/);
  assert.match(html, /Carla<\/button>/);
});

test('PL1(b): the Overview h1 is only the greeting; Total balance labels the amount', () => {
  const html = overview();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  assert.equal(h1.replace(/<[^>]+>/g, ''), 'Hello, Lucía.');
  assert.match(
    html,
    /role="group" aria-labelledby="total-balance-label"><span id="total-balance-label"[^>]*>Total balance<\/span><div class="total-amount">/,
  );
});

test('PL1(a): the Assistant view has one visually hidden h1', () => {
  const html = renderToStaticMarkup(
    createElement(Assistant, {
      conversations: [],
      conversationId: null,
      messages: [],
      busyId: null,
      failed: null,
      text: '',
      onText: noop,
      onSend: noop,
      onRetry: noop,
      onOpenConversation: noop,
      onNewConversation: noop,
      onOpenSource: noop,
      messagesEndRef: { current: null },
      approvals: null,
      suggestions: [],
    }),
  );
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<div class="chat-layout"><h1 class="sr-only">Assistant<\/h1>/);
});

test('PL1(c): one account-kind rule for Overview and Transfers', () => {
  const [aurora, savings, travel] = dashboard.accounts;
  assert.equal(accountKind(savings), 'Savings account');
  assert.equal(accountKind(travel), 'Current account');
  assert.equal(accountKind(aurora), 'Current account');
  assert.equal(accountKind(aurora, 'acc-me'), 'Main account');
  assert.equal(accountKind(savings, 'acc-sav'), 'Savings account');
  // Overview: the Main badge names the main account, so its line stays "Current account".
  const ov = overview();
  assert.match(ov, /Aurora account<\/span><span class="account-sub">Current account</);
  assert.match(ov, /Travel<\/span><span class="account-sub">Current account</);
  // Transfers: a non-main, non-savings tile now says "Current account" (was empty).
  const tr = transfers();
  assert.match(tr, /Aurora account<\/strong><small>Main account<\/small>/);
  assert.match(tr, /Savings<\/strong><small>Savings account<\/small>/);
  assert.match(tr, /Travel<\/strong><small>Current account<\/small>/);
});
