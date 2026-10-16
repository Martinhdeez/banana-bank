// UI2 (plan 28 §6.1–6.3, REQ-PL-29): "What the assistant may do", rendered from the two real
// answers of GET/POST /api/assistant-settings (AC1,
// .scratch/after/feat-ac1-assistant-settings/api-excerpts.txt), and its two openers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  appliedAfterFailure,
  ControlsBody,
  ControlsButton,
  type AssistantSettings,
  type ControlsState,
} from '../app/_components/AssistantControls';
import { Assistant } from '../app/_components/Assistant';
import { Shell } from '../app/_components/Shell';
import { shortRef } from '../src/ui-helpers';
import type { Person } from '../src/types';

const noop = () => {};
// Lucía, fresh seed.
const fresh: AssistantSettings = {
  suggestions: { enabled: true, changedAt: null },
  observations: { enabled: true, changedAt: null },
  rules: [],
  recorded: [],
};
// Lucía after a rule, three offer events, a dismissal and {"suggestions": false}.
const used: AssistantSettings = {
  suggestions: { enabled: false, changedAt: '2026-10-06T16:08:01.803Z' },
  observations: { enabled: true, changedAt: null },
  rules: [
    {
      merchantKey: 'COFFEE SHOP',
      name: 'COFFEE SHOP',
      category: 'shopping',
      categoryLabel: 'Shopping',
      createdAt: '2026-10-06T16:08:01.795Z',
    },
  ],
  recorded: [
    {
      at: '2026-10-06T16:08:01.802Z',
      kind: 'observation_dismissed',
      text: 'You dismissed: Groceries is up',
    },
    {
      at: '2026-10-06T16:08:01.801Z',
      kind: 'suggestion_declined',
      text: 'You declined: Round-ups',
    },
    {
      at: '2026-10-06T16:08:01.796Z',
      kind: 'interest_noted',
      text: 'Interest noted: Savings Pot. A support case was opened.',
      incidentId: 'fe80fc09-4126-4051-ba41-223a5d77e783',
    },
    { at: '2026-10-06T16:08:01.796Z', kind: 'suggestion_shown', text: 'Suggested: Savings Pot' },
  ],
};
const state = (p: Partial<ControlsState>): ControlsState => ({
  settings: null,
  loadError: '',
  pending: null,
  switchError: null,
  removing: '',
  ruleNote: null,
  ...p,
});
const body = (p: Partial<ControlsState>) =>
  renderToStaticMarkup(
    createElement(ControlsBody, { state: state(p), onToggle: noop, onRemove: noop, onRetry: noop }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, '');
// One switch: its row, cut at the next one or at the end of its card.
const setting = (html: string, key: string) =>
  html.split(`data-key="${key}"`)[1].split(/data-key="|<\/section>/)[0];
const section = (html: string, id: string) =>
  html.split(`aria-labelledby="${id}"`)[1].split('</section>')[0];

test('UI2 both switches: role, state word, "since" from changedAt, and what Off means', () => {
  const html = body({ settings: used });
  assert.equal(html.match(/data-testid="assistant-setting"/g)?.length, 2);
  const s = setting(html, 'suggestions'),
    o = setting(html, 'observations');
  assert.match(s, /<button type="button" role="switch" aria-checked="false"/);
  assert.match(s, />Off since 6 Oct</);
  assert.ok(
    text(s).includes(
      'Off: The assistant does not suggest products. If you ask about one, it answers from the product’s sheet and records nothing.',
    ),
  );
  assert.match(o, /role="switch" aria-checked="true"/);
  // Never changed: the state word alone.
  assert.match(o, />On</);
  assert.doesNotMatch(o, /since/);
  assert.ok(
    text(o).includes(
      'Off: No “Worth a look” card and no observation in the chat. The month ahead and your goals are not affected.',
    ),
  );
  // In flight: both switches wait. A failure is said on its own switch.
  const busy = body({
    settings: used,
    pending: 'observations',
    switchError: { key: 'suggestions', text: 'Too many requests. Wait a moment and try again.' },
  });
  assert.equal(busy.match(/role="switch"[^>]*disabled=""/g)?.length, 2);
  assert.match(
    setting(busy, 'suggestions'),
    /role="alert">Not changed\. Too many requests\. Wait a moment and try again\.</,
  );
  assert.doesNotMatch(setting(busy, 'observations'), /role="alert"/);
});

test('UI2 a switch the bank has off: "Not available right now", not operable; absent = on', () => {
  const html = body({
    settings: {
      ...used,
      suggestions: { enabled: true, changedAt: '2026-10-06T16:08:01.803Z', available: false },
      observations: { enabled: true, changedAt: null, available: true },
    },
  });
  const s = setting(html, 'suggestions'),
    o = setting(html, 'observations');
  assert.match(s, /^ data-available="false"/);
  assert.match(s, /role="switch" aria-checked="false"[^>]*aria-disabled="true" disabled=""/);
  assert.match(s, /data-testid="assistant-setting-state">Not available right now</);
  assert.doesNotMatch(s, /since/);
  // The label and the consequence line stay.
  assert.ok(text(s).includes('Product suggestions in the chat'));
  assert.ok(text(s).includes('Off: The assistant does not suggest products.'));
  assert.match(o, /^ data-available="true"/);
  assert.doesNotMatch(o, /disabled|Not available/);
  // The field absent (the fixtures above): a live switch.
  assert.doesNotMatch(body({ settings: used }), /Not available|aria-disabled/);
});

test('UI2 the record: server text verbatim, the case reference, and no control at all', () => {
  const html = body({ settings: used });
  const record = section(html, 'controls-recorded');
  assert.match(record, /<ul class="controls-list recorded" data-testid="assistant-record">/);
  for (const r of used.recorded) assert.ok(record.includes(`<strong>${r.text}</strong>`), r.text);
  assert.equal(record.match(/<li /g)?.length, 4);
  assert.equal(
    record.match(/Support request [^<]+/g)?.join(),
    `Support request ${shortRef('fe80fc09-4126-4051-ba41-223a5d77e783')}`,
  );
  assert.ok(
    record.includes('Kept as the bank’s record of what was shown to you. It cannot be edited.'),
  );
  // Read-only (plan 28 D3): nothing to press, type or follow in this section.
  assert.doesNotMatch(record, /<(button|a|input|select|textarea)\b/);
  assert.doesNotMatch(record, /Showing the latest/);
  const full = body({ settings: { ...used, recorded: Array(50).fill(used.recorded[0]) } });
  assert.ok(section(full, 'controls-recorded').includes('Showing the latest 50.'));
});

test('UI2 rules: name → category, since, one Remove each; the row waits while removing', () => {
  const rules = section(body({ settings: used }), 'controls-rules');
  assert.match(rules, /<li data-merchant="COFFEE SHOP">/);
  assert.match(text(rules), /COFFEE SHOP\s*is always\s*Shopping/);
  assert.ok(rules.includes('<small>since 6 Oct</small>'));
  assert.equal(
    rules.match(/<button[^>]*>([^<]*)</g)?.join(),
    '<button type="button" class="controls-link" aria-label="Remove the rule for COFFEE SHOP">Remove<',
  );
  assert.match(rules, /role="status"><\/p>/);
  const removing = section(body({ settings: used, removing: 'COFFEE SHOP' }), 'controls-rules');
  assert.match(removing, /disabled="">Removing…</);
  const done = section(
    body({
      settings: { ...used, rules: [] },
      ruleNote: { kind: 'done', text: 'Removed the rule for COFFEE SHOP.' },
    }),
    'controls-rules',
  );
  assert.match(
    done,
    /class="controls-note done" role="status">.*Removed the rule for COFFEE SHOP\./,
  );
});

test('UI2 empty, loading and error states; the "never" list is always there', () => {
  const empty = body({ settings: fresh });
  assert.ok(section(empty, 'controls-rules').includes('No rules yet.'));
  assert.ok(
    section(empty, 'controls-recorded').includes('<p class="controls-empty">Nothing yet.</p>'),
  );
  assert.doesNotMatch(empty, /<li (data-merchant|data-kind)/);
  const loading = body({});
  assert.match(loading, /role="status" aria-label="Loading your settings"/);
  assert.doesNotMatch(loading, /assistant-setting/);
  const failed = body({ loadError: 'The request could not be completed (500).' });
  assert.match(failed, /class="card load-error" role="alert"/);
  assert.match(failed, /The request could not be completed \(500\)\.<\/p><button[^>]*>Retry</);
  for (const html of [empty, loading, failed])
    assert.equal(
      [...section(html, 'controls-never').matchAll(/<\/span>([^<]+)<\/li>/g)]
        .map((m) => m[1])
        .join('|'),
      'Send money without your confirmation|See another customer’s balances or movements|Change a limit or a fee',
    );
});

test('UI2 openers: the Assistant header and the sidebar user block; none for an operator', () => {
  const opener = (label: boolean) => createElement(ControlsButton, { onClick: noop, label });
  const person = (role: Person['role']) =>
    ({ id: 'x', name: 'X', initials: 'X', color: '#000', role }) as Person;
  const shell = (role: Person['role']) =>
    renderToStaticMarkup(
      createElement(Shell, {
        operator: role === 'operator',
        tab: role === 'operator' ? 'cases' : 'overview',
        onTab: noop,
        collapsed: false,
        onToggleSidebar: noop,
        people: [],
        current: person(role),
        personId: 'x',
        onPerson: noop,
        conversations: [],
        conversationId: null,
        onOpenConversation: noop,
        onNewConversation: noop,
        // The page passes none for an operator; the shell refuses one all the same.
        footAction: opener(false),
        children: null,
      }),
    );
  const foot = (html: string) => html.split('class="sidebar-foot"')[1].split('</aside>')[0];
  assert.match(
    foot(shell('customer')),
    /<button type="button" class="controls-button icon" aria-label="What the assistant may do"/,
  );
  assert.doesNotMatch(shell('operator'), /What the assistant may do|controls-button/);
  // No new nav entry.
  assert.equal(shell('customer').match(/class="nav-item/g)?.length, 4);

  const chat = renderToStaticMarkup(
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
      headerExtra: opener(true),
    }),
  );
  const header = chat.split('class="chat-header-actions"')[1].split('role="log"')[0];
  assert.match(
    header,
    /^><button type="button" class="controls-button" aria-label="What the assistant may do"><svg.*<\/svg><span>What the assistant may do<\/span><\/button><button type="button" class="secondary-button">\+ New conversation</,
  );
});

test('UI2 a switch whose POST failed: one re-read decides between the new state and "Not changed."', async () => {
  let reads = 0;
  const server = (settings: AssistantSettings | Error) => async (path: string) => {
    assert.equal(path, 'assistant-settings');
    reads++;
    if (settings instanceof Error) throw settings;
    return settings;
  };
  // Applied, the answer was lost: `used` holds suggestions off, the screen thought it was on.
  assert.equal(await appliedAfterFailure(server(used), 'suggestions', true), used);
  // Not applied (a 429, a 5xx): the old value stands and the inline message is kept.
  assert.equal(await appliedAfterFailure(server(fresh), 'suggestions', true), null);
  assert.equal(await appliedAfterFailure(server(used), 'observations', true), null);
  // The re-read fails too: nothing is known to have changed.
  assert.equal(await appliedAfterFailure(server(new Error('offline')), 'suggestions', true), null);
  assert.equal(reads, 4); // once per failure
});
