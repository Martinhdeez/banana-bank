// PT2 (plan 25 §6, REQ-PT-10, 12): one render check per state of a prepared transfer card, and the
// Transfers screen with nothing prepared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrepareLater, PreparedSection, madridDay } from '../app/_components/Prepared';
import { Transfers } from '../app/_components/Transfers';
import type { PreparedView } from '../src/banking/prepared';
import type { Person } from '../src/types';

const noop = () => {};
const dashboard = {
  accounts: [{ id: 'acc-me', label: 'Main account', balanceCents: 100000 }],
  contacts: [],
  approvals: [],
};
const base: PreparedView = {
  id: 'p1',
  fromAccountId: 'acc-me',
  toAccountId: 'acc-marta',
  to: 'Marta García',
  amountCents: 85000,
  concept: 'Rent',
  note: 'until I get the keys',
  when: { kind: 'manual' },
  nextDue: null,
  state: 'ready',
  approvalId: null,
  expiresAt: null,
  lastAttempt: null,
  lastSentAt: null,
};
const monthly = { when: { kind: 'monthly', day: 1 }, nextDue: '2099-11-01' } as const;
const section = (items: PreparedView[], extra = {}) =>
  renderToStaticMarkup(createElement(PreparedSection, { items, dashboard, onAct: noop, ...extra }));
// The test ids of the buttons a card shows, in order, with `!` on a disabled one.
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*data-testid="(prepared-[a-z-]+)"([^>]*)>/g)].map(
    (m) => m[1] + (/ disabled=""/.test(m[0]) ? '!' : ''),
  );
const card = (p: Partial<PreparedView>, extra = {}) => section([{ ...base, ...p }], extra);

test('PT2 ready: the amount, source, concept and note, and Send and Delete', () => {
  const html = card({});
  assert.match(html, /data-testid="prepared-card" data-prepared-id="p1" data-state="ready"/);
  assert.match(html, /<strong>€850.00<\/strong> to <bdi>Marta García<\/bdi>/);
  assert.match(html, /From <bdi>Main account<\/bdi> · <bdi>Rent<\/bdi></);
  assert.match(html, /data-testid="prepared-note">“<bdi>until I get the keys<\/bdi>”</);
  assert.match(html, /<\/i>Ready when you are</);
  assert.match(html, /<\/svg>Send<\/button>/);
  assert.deepEqual(buttons(html), ['prepared-send', 'prepared-delete']);
  assert.doesNotMatch(html, /prepared-empty|prepared-due-count/);
});

test('PT2 due: the state in words, counted in the head; a monthly one can be skipped or paused', () => {
  const today = madridDay();
  const once = card({ state: 'due', when: { kind: 'on_date', date: today }, nextDue: today });
  assert.match(once, /data-state="due"/);
  assert.match(once, /<\/i>Due today</);
  assert.match(once, /data-testid="prepared-due-count">1 due</);
  assert.deepEqual(buttons(once), ['prepared-send', 'prepared-delete']);
  const late = card({ state: 'due', when: { kind: 'monthly', day: 1 }, nextDue: '2020-10-01' });
  assert.match(late, /<\/i>Due since 1 Oct 2020</);
  assert.match(late, /<bdi>Rent<\/bdi> · every month on day 1</);
  assert.match(late, /<\/svg>Skip October<\/button>/);
  assert.deepEqual(buttons(late), [
    'prepared-send',
    'prepared-skip',
    'prepared-pause',
    'prepared-delete',
  ]);
});

test('PT2 scheduled: the date, and Send now before it', () => {
  const html = card({
    state: 'scheduled',
    when: { kind: 'on_date', date: '2099-10-11' },
    nextDue: '2099-10-11',
  });
  assert.match(html, /<\/i>Due on 11 Oct 2099</);
  assert.match(html, /<\/svg>Send now<\/button>/);
  assert.deepEqual(buttons(html), ['prepared-send', 'prepared-delete']);
  assert.match(card({ state: 'scheduled', ...monthly }), /<\/i>Next due 1 Nov 2099</);
});

test('PT2 awaiting confirmation: only "Review above" (REQ-PT-12)', () => {
  const html = card({
    state: 'awaiting_confirmation',
    approvalId: 'ap1',
    expiresAt: '2026-10-04T10:40:00.000Z',
    ...monthly,
  });
  assert.match(html, /<\/i>Waiting for your confirmation above · expires \d\d:\d\d</);
  assert.deepEqual(buttons(html), ['prepared-review']);
});

test('PT2 verifying: no action at all, and the words not to send again (REQ-PT-12)', () => {
  const html = card({ state: 'verifying', ...monthly });
  assert.match(html, /Sent · the bank has not confirmed it yet\. Do not send it again\./);
  assert.deepEqual(buttons(html), []);
});

test('PT2 paused: Resume and Delete, no Send or Skip', () => {
  const html = card({ state: 'paused', ...monthly });
  assert.match(html, /<\/i>Paused · nothing becomes due until you resume</);
  assert.match(html, />Resume<\/button>/);
  assert.deepEqual(buttons(html), ['prepared-pause', 'prepared-delete']);
});

test('PT2 while a request runs every action is disabled; its result shows on the card', () => {
  const busy = card({ state: 'due', ...monthly }, { busy: 'send:p1' });
  assert.match(busy, /Preparing review…/);
  assert.deepEqual(buttons(busy), [
    'prepared-send!',
    'prepared-skip!',
    'prepared-pause!',
    'prepared-delete!',
  ]);
  const text = 'Insufficient funds. No money moved.';
  const failed = card({}, { message: { id: 'p1', tone: 'error', text } });
  assert.match(failed, new RegExp(`role="status"[^>]*>${text}<`));
  assert.match(failed, new RegExp(`<p class="prepared-feedback error">${text}</p>`));
  assert.match(card({ lastAttempt: 'expired' }), /The last review expired without your confirm/);
});

test('PT2 nothing prepared: the Transfers screen as before, plus the hint and one button', () => {
  const transfers = (extra = {}) =>
    renderToStaticMarkup(
      createElement(Transfers, {
        dashboard,
        people: [] as Person[],
        from: 'acc-me',
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
  const empty = section([]);
  const later = renderToStaticMarkup(
    createElement(PrepareLater, { open: false, onToggle: noop, onSave: noop }),
  );
  assert.match(empty, /data-testid="prepared-empty"/);
  assert.match(empty, /Prepare for later.*until you get the keys.*until you tap Send and confirm/);
  assert.doesNotMatch(empty, /<h2|prepared-card/);
  // Closed, the form gains one button that cannot submit it, and no field.
  assert.match(
    later,
    /^<div class="prepare-later"><button type="button"[^>]*>.*<\/button><\/div>$/,
  );
  assert.match(later, /data-testid="prepare-later" aria-expanded="false"/);
  assert.doesNotMatch(later, /<input|<select/);
  const html = transfers({
    prepared: createElement(PreparedSection, { items: [], dashboard, onAct: noop }),
    formExtra: createElement(PrepareLater, { open: false, onToggle: noop, onSave: noop }),
  });
  assert.equal(html.replace(empty, '').replace(later, ''), transfers());
});

test('PT2 "Prepare for later" open: three choices, the note, Save; no control submits the form', () => {
  const html = renderToStaticMarkup(
    createElement(PrepareLater, { open: true, onToggle: noop, onSave: noop }),
  );
  assert.match(html, /<legend>When should it be ready\?<\/legend>/);
  assert.deepEqual(
    [...html.matchAll(/<span>([^<]+)<\/span><\/label>/g)].map((m) => m[1]),
    ['When I say', 'On a date', 'Every month'],
  );
  assert.match(html, /checked="" value="manual"/);
  assert.match(html, /data-testid="prepare-note"[^>]*placeholder="e.g. until I get the keys"/);
  assert.match(html, /data-testid="prepare-save"[^>]*>Save prepared transfer</);
  assert.match(html, /Nothing is sent until you tap Send and confirm\./);
  for (const [tag] of html.matchAll(/<button[^>]*>/g)) assert.match(tag, /type="button"/);
  for (const [tag] of html.matchAll(/<(input|select)[^>]*>/g))
    assert.match(tag, /form="prepare-later-detached"/);
});
