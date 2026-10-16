// TR2 (plan 27 §6, REQ-TR-10): the operator's AI usage view, rendered from TR1's real answers
// (.scratch/after/feat-tr1-ai-usage-recording/evidence-api-*.json.txt, a production build with
// stand-in providers). No server, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConversationLevel,
  costOf,
  count,
  CustomerLevel,
  requestCost,
  RunLevel,
  runUsageLine,
  UsageOverview,
  usageSourceLine,
  usd,
} from '../app/_components/AiUsage';
import { parseTab } from '../src/ui-helpers';
import type { Totals } from '../src/usage/report';

const evidence = (name: string) =>
  JSON.parse(
    readFileSync(
      `.scratch/after/feat-tr1-ai-usage-recording/evidence-api-${name}.json.txt`,
      'utf8',
    ),
  );
const overview = evidence('overview');
const customer = evidence('customer');
const run = evidence('run');
const noop = () => {};
// Markup as the text a reader sees: tags out, entities back.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const totals = (over: Partial<Totals>): Totals => ({
  requests: 3,
  failed: 0,
  inputTokens: 9870,
  cachedInputTokens: 0,
  outputTokens: 212,
  reasoningTokens: 0,
  costNanoUsd: 12_300_000,
  providerNanoUsd: 0,
  unpricedRequests: 0,
  unreportedRequests: 0,
  ...over,
});

test('TR2 nano-dollars become dollars a person can read, never scientific, never a false zero', () => {
  assert.equal(usd(42_100_000), '$0.0421');
  assert.equal(usd(1_234_560_000_000), '$1,234.56');
  assert.equal(usd(536_468), '$0.000536');
  assert.equal(usd(360), '$0.000000360');
  assert.equal(usd(1), '$0.000000001');
  assert.equal(usd(0), '$0.00');
  assert.equal(count(1234567), '1,234,567');
  assert.equal(count(null), '—');
});

test('TR2 the cost of a group: not priced is never $0, the basis is always said', () => {
  assert.deepEqual(costOf(totals({ costNanoUsd: null, unpricedRequests: 3 })), {
    text: 'Not priced',
    note: '',
  });
  // No requests: the API answers costNanoUsd 0; that is "nothing", not "free".
  assert.equal(costOf(totals({ requests: 0, costNanoUsd: 0 })).text, '—');
  assert.deepEqual(costOf(totals({})), { text: '$0.0123', note: 'estimated' });
  assert.equal(costOf(totals({ providerNanoUsd: 12_300_000 })).note, 'reported by the provider');
  // Part of it from the provider: still an estimate.
  assert.equal(costOf(totals({ providerNanoUsd: 5200 })).note, 'estimated');
  assert.match(costOf(totals({ unpricedRequests: 1 })).note, /^estimated · partly priced, 1 not/);
  assert.equal(requestCost({ costBasis: 'unpriced', costNanoUsd: null }), 'Not priced');
  assert.equal(requestCost(run.requests[0]), '$0.000002436 estimated');
  assert.equal(
    requestCost(run.requests.find((r: any) => r.costBasis === 'provider')),
    '$0.000002600 reported by the provider',
  );
});

test('TR2 the overview from TR1 answer: totals, the customer and consumer tables, sources', () => {
  const page = text(
    renderToStaticMarkup(createElement(UsageOverview, { data: overview, onCustomer: noop })),
  );
  // Totals: 14 requests, one of them not priced.
  assert.match(page, /Estimated cost \$0\.001187 estimated · partly priced, 1 not priced/);
  assert.match(page, /Requests 14 1 failed Input tokens 12,866 Cached tokens 2,048/);
  assert.match(page, /Output tokens 226 Reasoning tokens 92/);
  // By customer, in the API's order (by cost), with the share; staff outside the shares.
  assert.match(page, /Lucía Martín 7 6,663 2,048 141 \$0\.000536 62%/);
  assert.match(page, /Bruno Vidal 6 1 failed 3,193 0 44 \$0\.000329 .*1 not priced 38%/);
  assert.match(page, /Staff and system outside the shares 1 3,010 0 41 \$0\.000322 —/);
  // By consumer, in words.
  assert.match(page, /Assistant \(chat\) 4 1 failed 9,432/);
  assert.match(page, /System One decider \(Jev\) 7 406 0 7 \$0\.000017/);
  assert.match(page, /Embeddings \(document search\) 2 18 0 0 \$0\.000000360/);
  assert.match(page, /Operator preview 1 3,010/);
  assert.match(page, /list_accounts 2 2/);
  // The prices' source and date are on screen (REQ-TR-10).
  assert.equal(
    usageSourceLine(overview),
    'Estimated from token counts and list prices read 2026-10-05 · OpenAI pricing page, Typesafe models page',
  );
  // Built from the API's sources only: another source, no date, nothing invented.
  assert.equal(
    usageSourceLine({ prices: [{ source: 'AI_PRICES setting' }] }),
    'Estimated from token counts and list prices · AI_PRICES setting',
  );
  assert.equal(usageSourceLine({ prices: [] }), 'Estimated from token counts and list prices');
  assert.match(page, /gpt-6-luna \$0\.1 \$0\.01 \$0\.5 OpenAI pricing page/);
});

test('TR2 states: an empty period, a total with no price', () => {
  const zero = totals({ requests: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 });
  const empty = renderToStaticMarkup(
    createElement(UsageOverview, {
      data: {
        ...overview,
        totals: zero,
        byCustomer: [],
        byConsumer: [],
        byTool: [],
        staffAndSystem: zero,
      },
      onCustomer: noop,
    }),
  );
  assert.match(empty, /No AI usage recorded for this period\./);
  assert.doesNotMatch(empty, /\$|<table/);
  const unpriced = totals({ costNanoUsd: null, unpricedRequests: 3 });
  const page = text(
    renderToStaticMarkup(
      createElement(UsageOverview, {
        data: {
          ...overview,
          totals: unpriced,
          byCustomer: [{ ...unpriced, userId: 'lucia', name: 'Lucía Martín', sharePct: null }],
          byConsumer: [{ ...unpriced, consumer: 'assistant' }],
          byTool: [],
          prices: [],
          staffAndSystem: zero,
        },
        onCustomer: noop,
      }),
    ),
  );
  assert.match(page, /Estimated cost Not priced/);
  assert.match(page, /Lucía Martín 3 9,870 0 212 Not priced —/);
  assert.doesNotMatch(page, /\$/);
});

test('TR2 drill-down: conversations, turns and requests from TR1 answers, with no customer text', () => {
  const withCase = {
    ...customer,
    conversations: [
      { ...customer.conversations[0], caseId: 'case-1' },
      { ...customer.conversations[0], conversationId: 'gone', removed: true },
    ],
  };
  const level1 = renderToStaticMarkup(
    createElement(CustomerLevel, { data: withCase, onConversation: noop, onOpenCase: noop }),
  );
  assert.match(
    text(level1),
    /7 requests · 6,663 in \(2,048 cached\) \/ 141 out tokens \$0\.000536/,
  );
  assert.match(text(level1), /Conversation · 6 Oct 2026, \d\d:\d\d 1 turn Open case/);
  assert.equal(level1.match(/Open case/g)?.length, 1);
  assert.match(text(level1), /Conversation removed/);
  assert.match(text(level1), /Outside the chat No request outside a conversation\./);
  const level2 = text(
    renderToStaticMarkup(
      createElement(ConversationLevel, { conversation: customer.conversations[0], onRun: noop }),
    ),
  );
  assert.match(level2, /Turn · 6 Oct 2026, \d\d:\d\d completed 7 requests/);
  const level3 = text(renderToStaticMarkup(createElement(RunLevel, { data: run })));
  assert.equal(level3.match(/attempt 1/g)?.length, 7);
  assert.match(
    level3,
    /Assistant \(chat\) ok gpt-6-luna-standin · request 1, attempt 1 · 6 Oct 2026, \d\d:\d\d Input 3,010 Cached 0 Output 41 Reasoning 20 list_accounts \$0\.000322 estimated/,
  );
  // System One reports no cached or reasoning tokens: a dash, not a zero.
  assert.match(
    level3,
    /jev-1\.13\.0 .*? Input 58 Cached — Output 1 Reasoning — \$0\.000002436 estimated/,
  );
  const failed = text(
    renderToStaticMarkup(
      createElement(RunLevel, {
        data: {
          ...run,
          requests: [
            {
              ...run.requests[0],
              outcome: 'failed',
              inputTokens: null,
              outputTokens: null,
              costNanoUsd: null,
              costBasis: 'unpriced',
            },
          ],
        },
      }),
    ),
  );
  assert.match(failed, /failed .* Tokens not reported Not priced/);
  // The API has no title or text field, and the view reads none.
  const source = readFileSync('app/_components/AiUsage.tsx', 'utf8');
  assert.doesNotMatch(source, /\.(title|content|description|concept|merchant\w*)\b/);
});

test('TR2 the case detail line of an assistant turn', () => {
  assert.equal(runUsageLine(totals({})), '3 requests · 9,870 in / 212 out tokens · est. $0.0123');
  assert.equal(
    runUsageLine(totals({ requests: 1 })),
    '1 request · 9,870 in / 212 out tokens · est. $0.0123',
  );
  assert.match(runUsageLine(totals({ costNanoUsd: null, unpricedRequests: 3 }))!, /· Not priced$/);
  assert.match(
    runUsageLine(totals({ unpricedRequests: 1 }))!,
    /est\. \$0\.0123 \(partly priced\)$/,
  );
  assert.match(
    runUsageLine(totals({ providerNanoUsd: 12_300_000 }))!,
    /· \$0\.0123 reported by the provider$/,
  );
  assert.equal(runUsageLine(null), null);
  assert.equal(runUsageLine(totals({ requests: 0, costNanoUsd: 0 })), null);
  assert.match(readFileSync('app/_components/Cases.tsx', 'utf8'), /runUsageLine\(r\.usage\)/);
});

test('TR2 the tab exists for an operator only', () => {
  assert.equal(parseTab('?tab=usage', 'operator'), 'usage');
  assert.equal(parseTab('?tab=usage', 'customer'), 'overview');
  const shell = readFileSync('app/_components/Shell.tsx', 'utf8');
  const [customerNav, operatorNav] = shell.split('operator: [');
  assert.doesNotMatch(customerNav, /'usage'/);
  assert.match(operatorNav.split('};')[0], /\['usage', '\w+', 'AI usage'\]/);
  assert.match(readFileSync('app/page.tsx', 'utf8'), /tab === 'usage' && operator &&/);
});
