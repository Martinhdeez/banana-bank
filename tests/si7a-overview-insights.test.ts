// SI7a: the Overview side of spend insights, rendered to a string (no browser): the breakdown
// card, the review list, the rules, the chip of a movement row with its "why" and select, and
// the offer / learning notice. The browser flows are in tests/e2e/insights-overview.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CategoryChip,
  SpendingCard,
  categoryOptions,
  whyText,
  type Insights,
} from '../app/_components/SpendInsights';
import type { SpendingSummary } from '../src/insights/summary';
import type { ActivityRow, RowCategoryOut } from '../src/ui-helpers';

const noop = async () => {};
const summary: SpendingSummary = {
  range: { from: null, to: null },
  window: { returned: 29, oldestAt: '2026-08-04T06:00:00.000Z', mayBeTruncated: false },
  partial: false,
  spentCents: 30000,
  incomeCents: 185000,
  categories: [
    {
      id: 'groceries',
      label: 'Groceries',
      spentCents: 20000,
      count: 4,
      confirmedCents: 5000,
      estimatedCents: 15000,
    },
    {
      id: 'other',
      label: 'Other',
      spentCents: 10000,
      count: 5,
      confirmedCents: 10000,
      estimatedCents: 0,
    },
  ],
  unresolved: { count: 0, totalCents: 0, groups: [] },
  pending: 0,
  decider: 'none',
};
const insights = (over: Partial<Insights> = {}): Insights => ({
  summary,
  rules: [],
  feedback: null,
  busy: false,
  setCategory: noop,
  acceptOffer: noop,
  dismiss: () => {},
  removeRule: noop,
  retry: noop,
  ...over,
});
const card = (over: Partial<Insights> = {}) =>
  renderToStaticMarkup(createElement(SpendingCard, { insights: insights(over) }));
const withSummary = (s: Partial<SpendingSummary>) => card({ summary: { ...summary, ...s } });
const count = (html: string, needle: string) => html.split(needle).length - 1;

const category = (over: Partial<RowCategoryOut> = {}): RowCategoryOut => ({
  id: 'groceries',
  state: 'estimated',
  source: 'rule',
  reason: 'keyword:MERCADONA',
  confidence: null,
  threshold: null,
  candidates: [],
  merchantKey: 'MERCADONA',
  model: null,
  movementIds: ['m1'],
  ...over,
});
const row = (cat: Partial<RowCategoryOut> = {}, over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 'm1',
  kind: 'movement',
  title: 'MERCADONA 0412 VALENCIA',
  detail: '',
  amountCents: -4210,
  account: 'Everyday',
  accountId: 'acc-me',
  createdAt: '2026-09-20T10:00:00.000Z',
  direction: 'sent',
  category: category(cat),
  ...over,
});
const chip = (r: ActivityRow, over: Partial<Insights> = {}, onAsk?: () => void) =>
  renderToStaticMarkup(createElement(CategoryChip, { row: r, insights: insights(over), onAsk }));

test('SI7a card: one row per category with amount, count and the estimated part in words', () => {
  const html = card();
  assert.match(html, /data-testid="spending-card"/);
  assert.match(html, /Where your money went/);
  assert.equal(count(html, 'data-testid="spending-category"'), 2);
  assert.match(html, /data-category="groceries"/);
  assert.match(html, /€300\.00/); // total spent
  assert.match(html, /€200\.00/);
  assert.match(html, /4 movements/);
  assert.match(html, /€150\.00 estimated/);
  // `other` has no estimated part: no note for it.
  assert.equal(count(html, ' estimated'), 1);
  assert.match(html, /Income/);
  assert.match(html, /€1,850\.00/);
});

test('SI7a card: the window note is always there; pending, retry and empty lines when due', () => {
  const html = card();
  assert.match(
    html,
    /data-testid="spending-window-note"[^>]*>Covers the 29 most recent movements the bank returned, since 4 Aug 2026\./,
  );
  assert.doesNotMatch(html, /Classifying/);
  assert.doesNotMatch(html, /Try again/);
  assert.doesNotMatch(html, /No spending in these movements/);

  assert.match(withSummary({ pending: 3 }), /Classifying 3 movements…/);
  assert.match(withSummary({ pending: 1 }), /Classifying 1 movement…/);

  const empty = withSummary({
    categories: [],
    spentCents: 0,
    window: { returned: 0, oldestAt: null, mayBeTruncated: false },
  });
  assert.match(empty, /No spending in these movements\./);
  assert.match(empty, /data-testid="spending-window-note"/);
  assert.equal(count(empty, 'data-testid="spending-category"'), 0);

  const down = withSummary({
    unresolved: {
      count: 3,
      totalCents: 4500,
      groups: [
        {
          merchantKey: 'ESPAI NOU',
          title: 'SUMUP *ESPAI NOU',
          count: 2,
          totalCents: 3000,
          movementIds: ['a', 'b'],
          candidates: [],
          reason: 'decider_unavailable',
        },
        {
          merchantKey: 'ZZQXV ALPHA',
          title: 'ZZQXV ALPHA',
          count: 1,
          totalCents: 1500,
          movementIds: ['c'],
          candidates: [],
          reason: 'no_decider',
        },
      ],
    },
  });
  assert.match(down, /The classifier did not answer for 2 movements\./);
  assert.match(down, /<button type="button"[^>]*>Try again<\/button>/);
});

test('SI7a review list: one group per merchant, candidates as buttons, raw text escaped', () => {
  assert.doesNotMatch(card(), /unresolved-group/);
  assert.doesNotMatch(card(), /to review/);
  const html = withSummary({
    unresolved: {
      count: 4,
      totalCents: 7500,
      groups: [
        {
          merchantKey: 'ESPAI NOU',
          title: 'SUMUP *ESPAI NOU',
          count: 3,
          totalCents: 4500,
          movementIds: ['a', 'b', 'c'],
          candidates: [
            { category: 'eating_out_leisure', p: 0.62 },
            { category: 'groceries', p: null },
          ],
          reason: 'below_threshold',
        },
        {
          merchantKey: '',
          title: '<b>Card payment 12</b>',
          count: 1,
          totalCents: 3000,
          movementIds: ['d'],
          candidates: [],
          reason: 'no_merchant',
        },
      ],
    },
  });
  assert.match(html, /Other — to review/);
  // contracts.md 2.7: movements in review are counted under `other`; its row says how many.
  assert.match(html, /data-category="other".*5 movements<span class="si-review"> · 4 to review</);
  assert.match(html, /4 movements, €75\.00/);
  assert.equal(count(html, 'data-testid="unresolved-group"'), 2);
  assert.match(html, /data-merchant="ESPAI NOU"/);
  assert.match(html, /3 movements · €45\.00/);
  assert.equal(count(html, 'data-testid="unresolved-candidate"'), 2);
  assert.match(
    html,
    /data-testid="unresolved-candidate" data-category="eating_out_leisure"[^>]*>Eating out &amp; leisure 62%</,
  );
  assert.match(html, /data-category="groceries"[^>]*>Groceries</);
  // A group with no merchant key is named by the bank's text, as text.
  assert.match(html, /&lt;b&gt;Card payment 12&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Card payment/);
  // Every group can be set at once, also without candidates.
  assert.equal(count(html, 'class="si-group-select"'), 2);
});

test('SI7a rules: listed with a remove button each; absent without rules', () => {
  assert.doesNotMatch(card(), /Your rules/);
  const html = card({
    rules: [
      { merchantKey: 'ESPAI NOU', category: 'eating_out_leisure', createdAt: '2026-10-01T10:00Z' },
      { merchantKey: 'MERCADONA', category: 'groceries', createdAt: '2026-09-30T10:00Z' },
    ],
  });
  assert.match(html, /Your rules/);
  assert.equal(count(html, 'data-testid="rule-item"'), 2);
  assert.match(html, /data-testid="rule-item" data-merchant="ESPAI NOU"/);
  assert.match(html, /Eating out &amp; leisure/);
  assert.match(
    html,
    /<button type="button"[^>]*data-testid="rule-remove"[^>]*aria-label="Remove the rule for ESPAI NOU"/,
  );
});

test('SI7a chip: text, state and source; estimated and confirmed differ in words and mark', () => {
  const estimated = chip(row());
  assert.match(
    estimated,
    /data-testid="category-chip" data-category="groceries" data-state="estimated"/,
  );
  assert.match(estimated, />Groceries · estimated</);
  const confirmed = chip(row({ state: 'confirmed', source: 'user', reason: 'user' }));
  assert.match(confirmed, /data-state="confirmed"/);
  assert.match(confirmed, />Groceries</);
  assert.doesNotMatch(confirmed, /estimated/i);
  assert.match(confirmed, /si-chip-mark/); // a check mark, not only another colour
  assert.doesNotMatch(estimated, /si-chip-mark/);
  assert.match(
    chip(row({ id: 'other', state: 'needs_review', source: 'none', reason: 'no_decider' })),
    />Other · to review</,
  );
  assert.match(
    chip(row({ id: 'other', state: 'pending', source: 'none', reason: 'pending' })),
    /data-state="pending"[^>]*>(<[^>]+>)*Classifying…/,
  );
  // Rows of the table keep one <small> each (the date): the chip adds none.
  assert.doesNotMatch(estimated, /<small/);
});

test('SI7a chip: the "why" line says the stored reason in words', () => {
  const why = (over: Partial<RowCategoryOut>) => whyText(category(over));
  assert.equal(why({}), 'Matched MERCADONA');
  assert.equal(why({ reason: 'own_account' }), 'Between your own accounts');
  assert.equal(why({ reason: 'person_transfer' }), 'Transfer to a person');
  assert.equal(why({ reason: 'user' }), 'Set by you');
  assert.equal(why({ reason: 'user_rule:ESPAI NOU' }), 'Your rule for ESPAI NOU');
  assert.equal(why({ reason: 'refund:ZARA' }), 'Refund from ZARA');
  assert.equal(why({ reason: 'decider_unavailable' }), 'The classifier did not answer');
  assert.equal(why({ reason: 'pending' }), 'Being classified');
  assert.equal(
    why({
      id: 'other',
      state: 'needs_review',
      source: 'model',
      reason: 'below_threshold',
      confidence: 0.62,
      threshold: 0.8,
      candidates: [
        { category: 'eating_out_leisure', p: 0.62 },
        { category: 'groceries', p: 0.3 },
      ],
    }),
    'The model was 62% sure, below the 80% bar: Eating out & leisure 62%, Groceries 30%',
  );
  assert.equal(
    why({
      id: 'eating_out_leisure',
      source: 'model',
      reason: 'model:late_night,weekend',
      confidence: 0.91,
      threshold: 0.8,
      candidates: [{ category: 'eating_out_leisure', p: 0.91 }],
    }),
    'The model was 91% sure, above the 80% bar: Eating out & leisure 91%',
  );
  // In the markup: the line itself and the chip's title.
  const html = chip(row());
  assert.match(html, /data-testid="category-why"[^>]*>Matched MERCADONA</);
  assert.match(html, /title="Matched MERCADONA"/);
});

test('SI7a chip: the select offers only what the sign rule allows', () => {
  assert.ok(!categoryOptions(row()).includes('income'));
  assert.ok(categoryOptions(row()).includes('transfer_person'));
  const credit = row({}, { amountCents: 5000, direction: 'received' });
  assert.ok(categoryOptions(credit).includes('income'));
  assert.ok(!categoryOptions(credit).includes('transfer_person'));
  // A merged "Between your accounts" row posts both legs: neither sign may be refused.
  const merged = row({ id: 'savings_internal', movementIds: ['d', 'c'] }, { kind: 'internal' });
  assert.ok(!categoryOptions(merged).includes('income'));
  assert.ok(!categoryOptions(merged).includes('transfer_person'));

  const html = chip(row());
  assert.match(html, /<select[^>]*data-testid="category-select"/);
  assert.match(html, /aria-label="Change the category of MERCADONA 0412 VALENCIA"/);
  const values = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(values, categoryOptions(row()));
  assert.equal(values.length, 10); // CAT1: `work`
  // Review of #101: the name is also the option's `aria-label` (Chrome's accessibility tree
  // does not name an option from `label`).
  assert.match(
    html,
    /<option value="groceries" label="Groceries" aria-label="Groceries" selected="">/,
  );
  assert.equal(count(html, ' aria-label="'), 10 + 2); // every option, the select, "Confirm" (IT6)
  // The names are attributes: the row's text does not hold every category name.
  assert.doesNotMatch(html, />Health</);
});

// Review of #101: the select of a movement in review already holds `other`, so choosing "Other"
// there is no change. The row says it in one button, which posts `other` for the row's ids.
test('SI7a chip: a movement in review can be kept as Other; no other state shows the button', () => {
  const review = row({ id: 'other', state: 'needs_review', source: 'none', reason: 'no_decider' });
  assert.match(
    chip(review),
    /<button type="button" class="si-keep" aria-label="Keep as Other: MERCADONA 0412 VALENCIA">Keep as Other<\/button>/,
  );
  for (const state of ['estimated', 'confirmed', 'pending'] as const)
    assert.doesNotMatch(chip(row({ id: 'other', state })), /Keep as Other/);
});

// IT6 (A9): an estimate that is right can be confirmed (the select only fires on a change).
// Polish A12: its visible text is "Confirm" (it was "Correct"), as its accessible name says.
test('IT6 chip: an estimate has "Confirm", named by category and movement; no other state has it', () => {
  assert.match(
    chip(row()),
    /<button type="button" class="si-keep" aria-label="Confirm Groceries for MERCADONA 0412 VALENCIA">Confirm<\/button>/,
  );
  for (const state of ['needs_review', 'confirmed', 'pending'] as const)
    assert.doesNotMatch(chip(row({ state })), /Confirm/);
});

// IT6: IT4's reason in words; a reason this UI does not know is a safe sentence.
test('IT6 chip: the daily limit is said in words; an unknown reason is never shown raw', () => {
  assert.equal(
    whyText(category({ reason: 'decider_budget' })),
    'Daily automatic classification limit reached; it will be classified later',
  );
  assert.equal(whyText(category({ reason: 'zzqxv_new:detail' })), 'No reason recorded');
});

test('SI7a chip: "Ask the assistant" is a seam for SI7b, absent until it is wired', () => {
  assert.doesNotMatch(chip(row()), /category-ask/);
  assert.match(
    chip(row(), {}, () => {}),
    /<button type="button"[^>]*data-testid="category-ask"[^>]*>Ask the assistant<\/button>/,
  );
});

test('SI7a offer and learning notice show where the change was made, once', () => {
  const offer = {
    kind: 'offer' as const,
    merchantKey: 'MERCADONA',
    count: 4,
    movementIds: ['m1'],
    category: 'groceries' as const,
  };
  const text = 'Apply Groceries to the 4 other MERCADONA movements and to future ones?';
  // From a row: in that row, not in the card and not in another row.
  const inRow = chip(row(), { feedback: { ...offer, at: 'm1' } });
  assert.match(inRow, new RegExp(`role="status"[^>]*>${text.replace('?', '\\?')}`));
  assert.match(
    inRow,
    /<button type="button"[^>]*data-testid="similar-offer-yes"[^>]*>Yes, apply to all</,
  );
  assert.match(
    inRow,
    /<button type="button"[^>]*data-testid="similar-offer-no"[^>]*>No, only this one</,
  );
  assert.doesNotMatch(card({ feedback: { ...offer, at: 'm1' } }), /similar-offer/);
  assert.doesNotMatch(
    chip(row({ movementIds: ['m2'] }), { feedback: { ...offer, at: 'm1' } }),
    /similar-offer/,
  );
  // From the review list: in the card.
  assert.match(card({ feedback: { ...offer, at: null } }), /similar-offer-yes/);
  assert.match(
    card({ feedback: { ...offer, at: null, count: 1 } }),
    /Apply Groceries to the 1 other MERCADONA movement and to future ones\?/,
  );

  const learned = card({
    feedback: {
      kind: 'learned',
      at: null,
      text: 'Learned: MERCADONA is Groceries. 4 movements updated.',
      undoKey: 'MERCADONA',
    },
  });
  assert.match(
    learned,
    /data-testid="insights-notice"[^>]*>Learned: MERCADONA is Groceries\. 4 movements updated\./,
  );
  assert.match(learned, /role="status"[^>]*data-testid="insights-notice"/);
  assert.match(learned, /<button type="button"[^>]*data-testid="insights-undo"[^>]*>Undo</);

  const failed = chip(row(), {
    feedback: { kind: 'error', at: 'm1', text: 'Movement not found.' },
  });
  assert.match(failed, /role="alert"[^>]*>Movement not found\./);
  // A refused change leaves the chip as the server last said: not confirmed.
  assert.match(failed, /data-state="estimated"/);
});
