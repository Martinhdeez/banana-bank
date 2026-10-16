// UI4: the savings-goal card of the chat, rendered to a string from GL3's own stored extras
// (tests/plan-fixtures/chat-goal-*.json are its evidence files, unchanged). The browser flow is
// .scratch/after/feat-ui4-chat-goal-card/probe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createdPlans, messageExtras } from '../app/_components/ChatInsights';
import { PlanPreview } from '../app/_components/plan/Goals';
import type { AnyRecord } from '../src/ui-helpers';

const fx = (name: string) =>
  JSON.parse(fs.readFileSync(`tests/plan-fixtures/${name}.json`, 'utf8')) as AnyRecord;
const planFx = fx('chat-goal-plan'),
  createdFx = fx('chat-goal-created');
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const render = (extras: AnyRecord | null, opts: AnyRecord = {}) =>
  renderToStaticMarkup(
    messageExtras(
      {
        id: 'm1',
        role: 'assistant',
        content: 'I can plan €9,999.99 a month for you.',
        created_at: '2026-10-07T10:00:00.000Z',
        extras,
      },
      { newest: true, busy: false, onReply() {}, onOpenGoal() {}, ...opts },
    ) as ReactNode,
  );
const withPlan = (patch: AnyRecord) => ({
  ...planFx,
  goalPlan: { ...planFx.goalPlan, ...patch },
});

test('UI4 plan card: every figure is the stored plan, in the form’s own preview block', () => {
  const html = render(planFx);
  assert.match(html, /data-testid="chat-goal-plan"/);
  // The same block as the "New goal" form, inside the card.
  assert.match(html, /class="goal-preview"[^>]*data-testid="goal-plan-preview"/);
  const t = text(html);
  assert.ok(t.includes('Savings goal'));
  assert.ok(t.includes('€1,200.00 by 31 Mar 2027'), t);
  assert.ok(t.includes('Aurora account → Personal savings · day 1 of each month'), t);
  assert.ok(t.includes('€240.00 a month · 5 payments'), t);
  assert.ok(t.includes('first on 1 Nov, last on 1 Mar 2027'), t);
  assert.ok(t.includes('Within what you usually have left each month (about €714.48).'), t);
  // Nothing from the answer's prose.
  assert.ok(!t.includes('9,999.99'));
});

test('UI4 plan card: over the room is said as a fact; no room, no comparison; one payment', () => {
  const over = text(render(withPlan({ fits: false, monthlyCents: 90000 })));
  assert.ok(over.includes('More than you usually have left each month (about €714.48).'), over);
  assert.ok(over.includes('€900.00 a month'));
  const none = text(render(withPlan({ fits: null, room: null, payments: 1 })));
  assert.ok(none.includes('Not enough history yet to compare'), none);
  assert.ok(none.includes('· 1 payment '), none);
  // A date in the year of `today` prints without its year.
  const near = text(render(withPlan({ targetDate: '2026-12-31', lastDue: '2026-12-01' })));
  assert.ok(near.includes('€1,200.00 by 31 Dec ') && near.includes('last on 1 Dec '), near);
});

test('UI4 plan card: the name is text; the two actions are the ordinary quick replies', () => {
  const html = render(withPlan({ name: '<img src=x onerror=alert(1)>' }));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img'));
  const card = html.slice(html.indexOf('data-testid="chat-goal-plan"'), html.indexOf('si-replies'));
  assert.ok(card && !card.includes('<button'), 'no button inside the card');
  assert.deepEqual(
    [...html.matchAll(/data-testid="quick-reply"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ['Create this goal', 'Change something'],
  );
  // Not the newest answer: the card stays, the replies go.
  const old = render(planFx, { newest: false });
  assert.ok(old.includes('chat-goal-plan') && !old.includes('quick-reply'));
});

test('UI4 created block: name, monthly amount, first day, the fixed line, the link by id', () => {
  let opened = '';
  const node = messageExtras(
    { id: 'm2', role: 'assistant', created_at: '2026-10-07T10:00:00.000Z', extras: createdFx },
    { newest: true, busy: false, onReply() {}, onOpenGoal: (id) => (opened = id) },
  ) as ReactNode;
  const html = renderToStaticMarkup(node);
  const t = text(html);
  assert.match(html, /data-testid="chat-goal-created"/);
  assert.ok(t.includes('Savings goal') && t.includes('€240.00 a month · first on 1 Nov '), t);
  // GL3's review: the target and `today` come with the goal (no guess from the message's date).
  assert.ok(t.includes('€1,200.00 by 31 Mar 2027'), t);
  const later = text(render({ goalCreated: { ...createdFx.goalCreated, today: '2027-01-02' } }));
  assert.ok(later.includes('first on 1 Nov 2026') && later.includes('by 31 Mar '), later);
  assert.ok(t.includes('Prepared. Nothing is sent until you confirm it in Transfers.'), t);
  assert.match(html, /<button type="button" class="plan-link">See it in Plan<\/button>/);
  // The link's action carries the stored id.
  const find = (n: AnyRecord): AnyRecord | null =>
    !n || typeof n !== 'object'
      ? null
      : n.props?.goal
        ? n
        : ([n.props?.children].flat().map(find).find(Boolean) ?? null);
  const block = find(node as AnyRecord)!;
  block.props.onOpen(block.props.goal.id);
  assert.equal(opened, createdFx.goalCreated.id);
  // No way to open the Plan (no handler): no link.
  assert.ok(!render(createdFx, { onOpenGoal: undefined }).includes('See it in Plan'));
});

test('UI4 feature detection: without the two extras nothing is added', () => {
  assert.equal(
    messageExtras({ role: 'assistant', extras: {} }, { newest: true, busy: false, onReply() {} }),
    null,
  );
  const replies = render({ quickReplies: planFx.quickReplies });
  assert.ok(replies.includes('quick-reply') && !replies.includes('chat-goal'));
});

test('UI4 failed turn: a message marked `turnFailed` never draws a card', () => {
  const html = render({ ...planFx, ...createdFx, turnFailed: 'no_answer' });
  assert.ok(!html.includes('chat-goal'), html);
  assert.equal(render({ turnFailed: 'no_answer' }), '');
});

// UI5 follow-up 1: the form's plan block is a live region; inside a chat message it is not (the
// message list would re-announce it). The "Your plan" label stays in both.
test('UI4 follow-up: the plan block is live in the form, not in the chat card', () => {
  const p = planFx.goalPlan;
  const form = renderToStaticMarkup(
    createElement(PlanPreview, {
      plan: p,
      targetCents: p.targetCents,
      targetDate: p.targetDate,
      today: p.today,
      room: p.room,
    }),
  );
  assert.match(form, /data-testid="goal-plan-preview"/);
  assert.match(form, /aria-live="polite"/);
  const card = render(planFx);
  assert.match(card, /data-testid="goal-plan-preview"/);
  assert.ok(!card.includes('aria-live'), card);
  assert.ok(text(card).includes('Your plan'));
});

// UI5 follow-up 2: the plan answered by the creation that followed it carries a "Created" mark.
const msg = (id: string, role: string, extras: AnyRecord | null = null) => ({
  id,
  role,
  content: '',
  created_at: '2026-10-07T10:00:00.000Z',
  extras,
});
const renderThread = (thread: AnyRecord[]) => {
  const created = createdPlans(thread);
  return thread.map((m) =>
    renderToStaticMarkup(
      messageExtras(m, {
        newest: false,
        busy: false,
        onReply() {},
        planCreated: created.has(m.id),
      }) as ReactNode,
    ),
  );
};
const marked = (html: string) => /data-created="true"/.test(html) && text(html).includes('Created');

test('UI4 follow-up: the plan the customer then created is marked, its figures kept', () => {
  const [plan, , created] = renderThread([
    msg('a1', 'assistant', planFx),
    msg('u1', 'user'),
    msg('a2', 'assistant', createdFx),
  ]);
  assert.ok(marked(plan), plan);
  assert.ok(text(plan).includes('€240.00 a month · 5 payments'), plan);
  assert.ok(!marked(created));
  // Without a later creation, no mark.
  const [alone] = renderThread([msg('a1', 'assistant', planFx)]);
  assert.ok(alone.includes('chat-goal-plan') && !marked(alone), alone);
});

test('UI4 follow-up: only the plan right before the creation is marked', () => {
  const out = renderThread([
    msg('a0', 'assistant', planFx),
    msg('u0', 'user'),
    msg('a1', 'assistant', planFx),
    msg('u1', 'user'),
    msg('a2', 'assistant', createdFx),
    msg('u2', 'user'),
    msg('a3', 'assistant', planFx),
  ]);
  assert.deepEqual(
    out.map((h) => marked(h)),
    [false, false, true, false, false, false, false],
  );
  // A failed creation marks nothing.
  const failed = renderThread([
    msg('a1', 'assistant', planFx),
    msg('u1', 'user'),
    msg('a2', 'assistant', { ...createdFx, turnFailed: 'no_answer' }),
  ]);
  assert.ok(!marked(failed[0]));
});
