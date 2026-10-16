// XS4 (plan 24 §6, REQ-XS-20): the product suggestion in the chat, rendered to a string from
// hand-made extras (the shape XS3 stores), as tests/si7b-assistant-insights.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { messageExtras } from '../app/_components/ChatInsights';
import type { OfferExtras } from '../src/offers/catalogue';

const count = (html: string, needle: string) => html.split(needle).length - 1;
const opts = { newest: true, busy: false, onReply: () => {} };
const offer: OfferExtras = {
  offer: {
    id: 'offer-savings-pot',
    name: 'Savings Pot',
    text: 'A suggestion: a separate account to set money aside <b>x</b>.',
    basis: 'Your Horizon account holds more than €3,000 and you have no savings account with us.',
  },
  offerSources: [
    {
      id: 'offer-savings-pot',
      title: 'Savings Pot',
      version: 1,
      validFrom: '2026-10-01',
      text: '# Savings Pot\n\n## Terms\n\n- Fee €0, no minimum balance.\n\nVersion 1. Valid from 2026-10-01.',
    },
  ],
};
const quickReplies = [
  { label: 'Tell me more', value: 'Tell me more about this suggestion' },
  { label: 'Not interested', value: 'Not interested' },
  { label: "Don't suggest products", value: "Don't suggest products to me" },
];
const render = (extras: object | null, o = opts) =>
  renderToStaticMarkup(messageExtras({ id: 'a1', role: 'assistant', extras }, o));

test('XS4 block: name, text, basis, sheet and replies from extras, inside one aside', () => {
  const out = render({ ...offer, quickReplies });
  assert.match(
    out,
    /^<aside[^>]*aria-label="Product suggestion"[^>]*data-testid="offer-card" data-offer-id="offer-savings-pot">.*<\/aside>$/s,
  );
  assert.match(out, />Suggestion<.*<strong>Savings Pot<\/strong>.*A suggestion: a separate/s);
  // Server text is text, never markup.
  assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(out, /data-testid="offer-basis">Why you see this: Your Horizon account holds/);
  assert.match(
    out,
    /<details[^>]*data-testid="offer-sheet"[^>]*><summary>Product sheet · v1 · demonstration content<\/summary>/,
  );
  // The sheet's Markdown: no title line, sections in bold, the list as a list.
  assert.match(out, /<strong>Terms<\/strong>.*<li>Fee €0, no minimum balance\.<\/li>/s);
  assert.doesNotMatch(out, /# /);
  assert.match(out, /Nothing is contracted in this chat\./);
  assert.equal(count(out, '<button type="button"'), 3);
  assert.equal(count(out, 'data-testid="quick-reply"'), 3);

  // An older message keeps its block and loses its replies.
  const older = render({ ...offer, quickReplies }, { ...opts, newest: false });
  assert.equal(count(older, 'data-testid="offer-card"'), 1);
  assert.doesNotMatch(older, /<button/);

  // "Tell me more": sheets without an offer show only the sheets (and the replies).
  const sheets = render({ offerSources: offer.offerSources, quickReplies: quickReplies.slice(1) });
  assert.equal(count(sheets, 'data-testid="offer-sheet"'), 1);
  assert.equal(count(sheets, 'data-testid="quick-reply"'), 2);
  assert.doesNotMatch(sheets, /offer-card|offer-basis|Suggestion<|Nothing is contracted/);
});

test('XS4 unchanged: a message without offer extras renders as on dev', () => {
  assert.equal(messageExtras({ id: 'a0', role: 'assistant', extras: {} }, opts), null);
  assert.equal(
    messageExtras({ id: 'a0', role: 'assistant', extras: { offerSources: [] } }, opts),
    null,
  );
  // Round-7 replies alone: the group as before, no wrapper around it.
  assert.equal(
    render({ quickReplies: quickReplies.slice(1, 2) }),
    '<div class="si-chat si-replies" role="group" aria-label="Quick replies"><button type="button" class="si-reply" data-testid="quick-reply">Not interested</button></div>',
  );
  // A user message never shows a suggestion, whatever it carries.
  assert.equal(messageExtras({ id: 'u1', role: 'user', extras: offer }, opts), null);
});
