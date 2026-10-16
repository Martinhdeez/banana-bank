// SI7b: the assistant side of spend insights, rendered to a string (no browser): the attached
// movement, quick replies, cited movements, "Resolve in chat" and the suggestion list. The
// browser flows are in tests/e2e/insights-assistant.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Assistant } from '../app/_components/Assistant';
import {
  AttachedMovement,
  chatSuggestions,
  QuickReplies,
  askText,
  messageExtras,
} from '../app/_components/ChatInsights';
import { SpendingCard, type Insights } from '../app/_components/SpendInsights';
import type { SpendingSummary } from '../src/insights/summary';
import type { AnyRecord } from '../src/ui-helpers';

const noop = () => {};
const count = (html: string, needle: string) => html.split(needle).length - 1;
const html = (node: ReactNode) => renderToStaticMarkup(node);

const movement = {
  id: 'demo-m7',
  title: 'ESPAI NOU <img src=x onerror=alert(1)>',
  amountCents: -1850,
  createdAt: '2026-09-20T10:00:00.000Z',
};
const replies = [
  { label: 'Eating out & leisure', value: 'Eating out & leisure' },
  { label: 'Other', value: 'Another category' },
  { label: 'Skip', value: 'Skip' },
];
const cited = [
  { ...movement, id: 'c1', category: 'eating_out_leisure' },
  {
    id: 'c2',
    title: 'MERCADONA',
    amountCents: -4210,
    createdAt: '2026-09-21T10:00:00.000Z',
    category: 'groceries',
  },
];
const msg = (id: string, role: string, extras: AnyRecord | null = null): AnyRecord => ({
  id,
  role,
  content: `Message ${id}`,
  created_at: '2026-10-01T10:00:00.000Z',
  run_id: null,
  sources: [],
  extras,
});
const opts = { newest: true, busy: false, onReply: noop };

test('SI7b attachment: title, date and amount as text; the remove button only in the composer', () => {
  const card = html(createElement(AttachedMovement, { movement }));
  assert.match(card, /data-testid="attached-movement" data-movement-id="demo-m7"/);
  // Bank text is text, never markup.
  assert.match(card, /ESPAI NOU &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(card, /<img/);
  assert.match(card, /20 Sept? 2026/);
  assert.match(card, /-€18\.50/);
  assert.doesNotMatch(card, /<button/);
  const composer = html(createElement(AttachedMovement, { movement, onRemove: noop }));
  assert.match(
    composer,
    /<button type="button"[^>]*aria-label="Remove the attached movement"[^>]*>/,
  );
});

test('SI7b messages: the attachment card on a user message that has one', () => {
  const out = html(messageExtras(msg('u1', 'user', { movement }), opts));
  assert.equal(count(out, 'data-testid="attached-movement"'), 1);
  assert.doesNotMatch(out, /<button/);
  // Nothing for a message without extras (a falsy return: the slot adds no wrapper).
  assert.equal(messageExtras(msg('u2', 'user'), opts), null);
  assert.equal(messageExtras(msg('a0', 'assistant'), opts), null);
  assert.equal(messageExtras(msg('a0', 'assistant', {}), opts), null);
});

test('SI7b quick replies: one button per reply under the newest assistant message only', () => {
  const m = msg('a1', 'assistant', { quickReplies: replies });
  const out = html(messageExtras(m, opts));
  assert.equal(count(out, 'data-testid="quick-reply"'), 3);
  assert.match(out, /role="group" aria-label="Quick replies"/);
  // The label is shown; the value is what a click sends, and is not in the markup.
  assert.match(out, /<button type="button"[^>]*data-testid="quick-reply"[^>]*>Other<\/button>/);
  assert.doesNotMatch(out, /Another category/);
  assert.doesNotMatch(out, /disabled/);
  assert.equal(messageExtras(m, { ...opts, newest: false }), null);
  // A user message never shows replies, whatever it carries.
  assert.equal(messageExtras(msg('u1', 'user', { quickReplies: replies }), opts), null);
});

test('SI7b quick replies: disabled while a turn runs; a click sends the value', () => {
  const m = msg('a1', 'assistant', { quickReplies: replies });
  assert.equal(count(html(messageExtras(m, { ...opts, busy: true })), 'disabled=""'), 3);
  const sent: string[] = [];
  // No hooks: the element tree is read directly and the second button ("Other") clicked.
  const group = QuickReplies({ replies, disabled: false, onSend: (v) => sent.push(v) });
  group.props.children[1].props.onClick();
  assert.deepEqual(sent, ['Another category']);
});

test('SI7b cited movements: title, date, category and amount per movement, as text', () => {
  const m = msg('a1', 'assistant', { citedMovements: cited });
  const out = html(messageExtras(m, { ...opts, newest: false }));
  assert.equal(count(out, 'data-testid="cited-movement"'), 2);
  assert.match(out, /data-movement-id="c1"/);
  assert.match(out, /Movements in this answer/);
  assert.match(out, /ESPAI NOU &lt;img/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /Eating out &amp; leisure/);
  assert.match(out, /Groceries/);
  assert.match(out, /-€42\.10/);
  // Cited movements stay on older messages; with replies both render, the list first.
  const both = html(
    messageExtras(
      msg('a2', 'assistant', { citedMovements: cited, quickReplies: replies.slice(1) }),
      opts,
    ),
  );
  assert.ok(both.indexOf('cited-movement') < both.indexOf('quick-reply'));
  assert.equal(count(both, 'data-testid="quick-reply"'), 2);
});

const assistant = (messages: AnyRecord[], extra: AnyRecord = {}) =>
  html(
    createElement(Assistant, {
      conversations: [],
      conversationId: messages.length ? 'c1' : null,
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
      suggestions: [],
      ...extra,
    }),
  );

test('SI7b in Assistant: replies only under the newest assistant message; no extras, no change', () => {
  const thread = [
    msg('u1', 'user', { movement }),
    msg('a1', 'assistant', { quickReplies: replies }),
    msg('u2', 'user'),
    msg('a2', 'assistant', { quickReplies: replies.slice(0, 2), citedMovements: cited }),
  ];
  const slot = (m: AnyRecord) => messageExtras(m, { ...opts, newest: m.id === 'a2' });
  const out = assistant(thread, { messageExtra: slot });
  assert.equal(count(out, 'data-testid="quick-reply"'), 2);
  assert.equal(count(out, 'data-testid="attached-movement"'), 1);
  assert.equal(count(out, 'data-testid="cited-movement"'), 2);
  // a1 (older replies) and u2 have nothing: two wrappers for four messages.
  assert.equal(count(out, 'class="message-extra"'), 2);
  // A thread without extras renders exactly as it does without the slot.
  const plain = [msg('u1', 'user'), msg('a1', 'assistant')];
  assert.equal(assistant(plain, { messageExtra: slot }), assistant(plain));
});

test('SI7b composer: the attachment sits in the composer slot with its remove button', () => {
  const out = assistant([], {
    composerExtra: createElement(AttachedMovement, { movement, onRemove: noop }),
  });
  assert.match(
    out,
    /data-testid="composer-extra">.*data-testid="attached-movement".*Remove the attached movement.*<textarea/s,
  );
});

// Polish A24f: "Where did my money go?" is first, as on the Overview's Assistant card (it was last).
test('SI7b suggestions: "Where did my money go?", then the list pinned per customer (AS1)', () => {
  const head = 'Where did my money go?';
  const tail = ['I want to speak to a person'];
  const aurora = { label: 'Aurora account' };
  const horizon = { label: 'Horizon account' };
  const savings = { label: 'Personal savings' };
  assert.deepEqual(chatSuggestions([aurora, savings]), [
    head,
    'What are the balances of my accounts?',
    'What is the fee of my Aurora account?',
    ...tail,
  ]);
  // One account, another product: its own name, never "Aurora", and no plural.
  assert.deepEqual(chatSuggestions([horizon]), [
    head,
    'What is the balance of my account?',
    'What is the fee of my Horizon account?',
    ...tail,
  ]);
  // The main account is the one named, not the first one.
  assert.equal(chatSuggestions([savings, horizon])[2], 'What is the fee of my Horizon account?');
  // No account: no product and no balance to ask about.
  assert.deepEqual(chatSuggestions([]), [head, ...tail]);
  const out = assistant([], { suggestions: chatSuggestions([horizon]) });
  assert.match(out, /<button type="button">What is the fee of my Horizon account\?<\/button>/);
  assert.doesNotMatch(out, /Aurora/);
});

test('SI7b question: help for a movement in review, "why" for a decided one', () => {
  assert.equal(
    askText({ id: 'other', state: 'needs_review' }),
    'Help me categorise this movement.',
  );
  assert.equal(askText({ id: 'other', state: 'pending' }), 'Help me categorise this movement.');
  assert.equal(askText({ id: 'groceries', state: 'estimated' }), 'Why is this Groceries?');
  assert.equal(
    askText({ id: 'eating_out_leisure', state: 'confirmed' }),
    'Why is this Eating out & leisure?',
  );
});

const summary: SpendingSummary = {
  range: { from: null, to: null },
  window: { returned: 9, oldestAt: '2026-08-04T06:00:00.000Z', mayBeTruncated: false },
  partial: false,
  spentCents: 7400,
  incomeCents: 0,
  categories: [
    {
      id: 'other',
      label: 'Other',
      spentCents: 7400,
      count: 4,
      confirmedCents: 0,
      estimatedCents: 7400,
    },
  ],
  unresolved: {
    count: 4,
    totalCents: 7400,
    groups: [
      {
        merchantKey: 'ESPAI NOU',
        title: 'ESPAI NOU',
        count: 3,
        totalCents: 5550,
        movementIds: ['m1', 'm2', 'm3'],
        candidates: [],
        reason: 'no_decider',
      },
      {
        merchantKey: '',
        title: 'Card payment 4471',
        count: 1,
        totalCents: 1850,
        movementIds: ['m9'],
        candidates: [],
        reason: 'no_merchant',
      },
    ],
  },
  pending: 0,
  decider: 'none',
};
const insights: Insights = {
  summary,
  rules: [],
  feedback: null,
  busy: false,
  setCategory: async () => {},
  acceptOffer: async () => {},
  dismiss: noop,
  removeRule: async () => {},
  retry: async () => {},
};

test('SI7b review list: "Resolve in chat" per group, only when it is wired', () => {
  assert.doesNotMatch(html(createElement(SpendingCard, { insights })), /Resolve in chat/);
  const out = html(createElement(SpendingCard, { insights, onAsk: noop }));
  assert.equal(count(out, '>Resolve in chat</button>'), 2);
  assert.match(out, /<button type="button"[^>]*aria-label="Resolve ESPAI NOU in chat"/);
  assert.match(out, /aria-label="Resolve Card payment 4471 in chat"/);
});
