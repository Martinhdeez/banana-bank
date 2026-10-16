// UI3 (plan 28 §6.1): the daily AI limit in the operator's AI usage view, on TR1's real overview
// answer; the fields are SC1's (`cap`, `byCustomer[].capped`). No server, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { capLine, costOf, UsageOverview, usd } from '../app/_components/AiUsage';
import { Assistant } from '../app/_components/Assistant';

const overview = JSON.parse(
  readFileSync('.scratch/after/feat-tr1-ai-usage-recording/evidence-api-overview.json.txt', 'utf8'),
);
const noop = () => {};
const render = (data: object) =>
  renderToStaticMarkup(createElement(UsageOverview, { data, onCustomer: noop }));
const cap = { dailyNanoUsd: 500_000_000, unpricedTokens: 1_000_000, dayStart: '' };

test('UI3 no limit configured, or a server without the field: no line, no tag', () => {
  assert.equal('cap' in overview, false);
  assert.equal(capLine(overview.cap), null);
  assert.equal(capLine(null), null);
  assert.doesNotMatch(render(overview), /limit/i);
  assert.doesNotMatch(render({ ...overview, cap: null }), /limit/i);
});

test('UI3 the limit line: dollars, tokens and the reset time dayStart implies in Madrid', () => {
  // Madrid midnight is 22:00 UTC in summer and 23:00 UTC in winter.
  assert.equal(
    capLine({ ...cap, dayStart: '2026-10-05T22:00:00.000Z' }),
    'Daily limit per customer: $0.5000 · 1,000,000 tokens for requests with no price · resets at 00:00 Europe/Madrid',
  );
  assert.match(capLine({ ...cap, dayStart: '2026-12-01T23:00:00.000Z' })!, /resets at 00:00 /);
  // Computed, not written: another instant reads as another time.
  assert.match(capLine({ ...cap, dayStart: '2026-10-06T02:30:00.000Z' })!, /resets at 04:30 /);
  assert.match(
    capLine({ ...cap, dailyNanoUsd: 500, dayStart: '2026-10-05T22:00:00.000Z' })!,
    /: \$0\.000000500 ·/,
  );
});

test('UI3 one customer at the limit: exactly one tag, with "today", after the name', () => {
  const html = render({
    ...overview,
    cap: { ...cap, dayStart: '2026-10-05T22:00:00.000Z' },
    byCustomer: overview.byCustomer.map((c: { userId: string }) => ({
      ...c,
      capped: c.userId === 'lucia',
    })),
  });
  assert.equal(html.match(/Daily limit reached · today/g)?.length, 1);
  // Inside Lucía's row header, outside her button.
  assert.match(
    html,
    /<bdi>Lucía Martín<\/bdi><svg[^>]*>.*?<\/svg><\/button><span class="usage-tag capped" role="note" title="Reached today&#x27;s AI limit\. The assistant answers without the model until the day resets\."/,
  );
  assert.match(html, /aria-label="Reached today&#x27;s AI limit\./);
});

test('UI3 the number of decimals is chosen after rounding', () => {
  assert.equal(usd(9_999_999), '$0.0100');
  assert.equal(usd(10_000_000), '$0.0100');
  assert.equal(usd(999_999_999), '$1.00');
  assert.equal(usd(1_000_000_000), '$1.00');
  assert.equal(usd(9_999), '$0.000009999');
  assert.equal(usd(1), '$0.000000001');
  // Just under a step and not rounding up to it: the finer step stays.
  assert.equal(usd(9_999_499), '$0.009999');
  assert.equal(usd(999_949_999), '$0.9999');
  const t = { requests: 0, costNanoUsd: 0, providerNanoUsd: 0, unpricedRequests: 0 };
  assert.equal(costOf(t).text, '—');
  assert.equal(costOf({ ...t, requests: 2, costNanoUsd: null }).text, 'Not priced');
});

// Point 4 (verify only): the chat offers support on any `extras.turnFailed` value, so SC1's
// `ai_daily_limit` shows the server's sentence and the button with no change to the chat.
test('UI3 customer side: a turn stopped by the daily limit offers human support, no figure', () => {
  const sentence =
    'The assistant is not available for the rest of today. Your accounts, transfers and confirmations still work from the other tabs, and you can ask for human support here.';
  const message = (id: string, role: string, content: string, extras: object | null = null) => ({
    id,
    role,
    content,
    created_at: '2026-10-06T10:00:00.000Z',
    run_id: null,
    sources: [],
    extras,
  });
  const html = renderToStaticMarkup(
    createElement(Assistant, {
      conversations: [],
      conversationId: 'c1',
      messages: [
        message('u', 'user', 'Hi'),
        message('a', 'assistant', sentence, { turnFailed: 'ai_daily_limit' }),
      ],
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
      onAskSupport: noop,
    } as unknown as Parameters<typeof Assistant>[0]),
  );
  assert.match(html, /The assistant is not available for the rest of today\./);
  assert.match(html, />Ask for human support</);
  assert.doesNotMatch(html, /Not sent|\$|tokens|limit/i);
});
