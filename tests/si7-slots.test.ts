// SI7-slots: five optional slots on Overview and Assistant; nothing changes without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Assistant } from '../app/_components/Assistant';
import { Overview } from '../app/_components/Overview';
import type { Person } from '../src/types';
import type { ActivityRow, AnyRecord } from '../src/ui-helpers';

const noop = () => {};
const dashboard = {
  accounts: [
    { id: 'acc-me', label: 'Everyday', balanceCents: 1000 },
    { id: 'acc-sav', label: 'Savings', balanceCents: 500 },
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
const rows: ActivityRow[] = [0, 1, 2].map((i) => ({
  id: `m${i}`,
  kind: 'movement',
  title: `Sent to Shop ${i}`,
  detail: `Coffee ${i}`,
  amountCents: -100 * (i + 1),
  account: 'Everyday',
  accountId: 'acc-me',
  createdAt: `2026-09-2${i}T10:00:00.000Z`,
  direction: 'sent',
}));
const overview = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      current: { id: 'me', name: 'Lucía Pérez' } as Person,
      people: [] as Person[],
      dashboard,
      rows,
      allActivity: false,
      onToggleAll: noop,
      onTab: noop,
      onOpenAccount: noop,
      onStartTransfer: noop,
      ...extra,
    }),
  );

const messages: AnyRecord[] = [
  { id: 'u1', role: 'user', content: 'Why is this Groceries?', created_at: '2026-10-01T10:00:00Z' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Because of the merchant.',
    created_at: '2026-10-01T10:00:05Z',
    sources: [{ id: 'c1', documentId: 'fees', title: 'Fees', version: 2, validFrom: '2026-01-01' }],
  },
  {
    id: 'a2',
    role: 'assistant',
    run_id: 'outcome:completed:t1',
    content: 'Transfer sent.',
    created_at: '2026-10-01T10:01:00Z',
  },
];
const assistant = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Assistant, {
      conversations: [],
      conversationId: 'c1',
      messages,
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
      suggestions: ['What is the balance of my account?'],
      ...extra,
    }),
  );

const rowsOf = (html: string) => html.split('<div class="movement movement">').slice(1);
const mainOf = (row: string) => row.slice(row.indexOf('<div class="movement-main">'));

test('SI7-slots: without the props neither view gains a wrapper', () => {
  const o = overview();
  assert.doesNotMatch(o, /overview-insights|movement-extra/);
  assert.equal(o, overview({ insights: undefined, rowExtra: undefined }));
  for (const row of rowsOf(o)) {
    // Title and detail only: the same children as before.
    assert.match(
      mainOf(row),
      /^<div class="movement-main"><strong>[^<]*<\/strong><span class="movement-sub">[^<]*<\/span><\/div><div class="movement-meta">/,
    );
  }
  const a = assistant();
  assert.doesNotMatch(a, /composer-extra|message-extra/);
  assert.equal(a, assistant({ composerExtra: undefined, messageExtra: undefined }));
  assert.match(a, /<div class="bubble">Why is this Groceries\?<\/div><small>/);
  assert.match(a, /<div class="composer-box"><textarea/);
});

test('SI7-slots: insights sits after the attention card and before the transactions', () => {
  const html = overview({ insights: createElement('p', { id: 'dummy-insights' }) });
  const slot = '<div class="overview-insights" data-testid="overview-insights">';
  assert.ok(
    html.includes(`${slot}<p id="dummy-insights"></p></div><section class="overview-bottom">`),
  );
  assert.ok(html.indexOf('class="account-grid"') < html.indexOf(slot));
  assert.ok(html.indexOf('class="card attention"') < html.indexOf(slot));
  assert.ok(html.indexOf('</section>' + slot) > 0, 'directly after the attention card');
});

test('SI7-slots: rowExtra renders per row inside .movement-main, after .movement-sub', () => {
  const seen: ActivityRow[] = [];
  const html = overview({
    rowExtra: (row: ActivityRow) => {
      seen.push(row);
      // The second row returns null: no wrapper for it.
      return seen.length === 2 ? null : createElement('button', { id: `x-${row.id}` });
    },
  });
  // The modifier that rebalances the row grid is there only with rowExtra.
  assert.match(html, /<section class="card movements has-row-extra">/);
  assert.match(overview(), /<section class="card movements">/);
  assert.doesNotMatch(overview(), /has-row-extra/);
  const found = rowsOf(html);
  assert.equal(found.length, 3);
  assert.deepEqual(seen, rows, 'called once per row, with the row');
  found.forEach((row, i) => {
    assert.equal(row.match(/<small/g)?.length, 1, 'one small per row');
    const main = row.slice(0, row.indexOf('<div class="movement-meta">'));
    if (i === 1) return assert.doesNotMatch(row, /movement-extra/);
    assert.match(
      main,
      new RegExp(`</span><div class="movement-extra"><button id="x-m${i}"></button></div></div>$`),
    );
    assert.ok(main.indexOf('movement-sub') < main.indexOf('movement-extra'));
    assert.ok(main.indexOf('movement-main') < main.indexOf('movement-extra'));
  });
});

test('SI7-slots: composerExtra renders inside .composer-box, above the textarea', () => {
  const html = assistant({ composerExtra: createElement('b', { id: 'dummy-attached' }) });
  assert.ok(
    html.includes(
      '<div class="composer-box"><div class="composer-extra" data-testid="composer-extra"><b id="dummy-attached"></b></div><textarea',
    ),
  );
});

test('SI7-slots: messageExtra renders in every bubble, after body and sources, before the date', () => {
  const calls: [string, boolean][] = [];
  const html = assistant({
    messageExtra: (m: AnyRecord, isLast: boolean) => {
      calls.push([m.id, isLast]);
      return createElement('i', { id: `x-${m.id}` });
    },
  });
  assert.deepEqual(calls, [
    ['u1', false],
    ['a1', false],
    ['a2', true],
  ]);
  const extra = (id: string) => `<div class="message-extra"><i id="x-${id}"></i></div>`;
  // User: inside the bubble after the text; the date stays outside the bubble.
  assert.ok(html.includes(`Why is this Groceries?${extra('u1')}</div><small>`));
  // Assistant: after the body and the sources, before the date.
  assert.match(html, new RegExp(`class="citations".*?</button></div>${extra('a1')}<small>`));
  assert.ok(html.indexOf('class="message-body"') < html.indexOf(extra('a1')));
  // Outcome message: after the .outcome line, before the date.
  assert.ok(html.includes(`Transfer sent.</p>${extra('a2')}<small>`));
  assert.doesNotMatch(assistant({ messageExtra: () => null }), /message-extra/);
});

// FX4-c: the prop is required (the built-in fallback list is gone): what the caller passes is
// the whole list, and an empty list renders no button.
test('SI7-slots: suggestions is the only list of starter questions', () => {
  const html = assistant({ messages: [], suggestions: ['Where did my money go?'] });
  assert.match(
    html,
    /<div class="suggestions"><button type="button">Where did my money go\?<\/button><\/div>/,
  );
  assert.match(assistant({ messages: [], suggestions: [] }), /<div class="suggestions"><\/div>/);
  // @ts-expect-error suggestions is required
  createElement(Assistant, { ...({} as Omit<Parameters<typeof Assistant>[0], 'suggestions'>) });
});
