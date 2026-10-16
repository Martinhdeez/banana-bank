// Polish pass, PR 1 (Transfers page): A2, A6, A7, A8, A14, A15, A16, A24a, A24b, B4. One small
// check per item; the layout and the focus are proven in a browser by
// .scratch/after/fix-polish-transfers/probe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Approvals, settledResult } from '../app/_components/Approvals';
import { PreparedSection } from '../app/_components/Prepared';
import { Transfers, transferFormErrors } from '../app/_components/Transfers';
import type { PreparedView } from '../src/banking/prepared';
import type { Person } from '../src/types';
import { transferFeedback } from '../src/ui-helpers';

const noop = () => {};
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Bank order: the savings account first, as for Lucía.
const dashboard = {
  accounts: [
    { id: 'acc-sav', label: 'Personal savings', balanceCents: 500 },
    { id: 'acc-me', label: 'Aurora account', balanceCents: 1000 },
  ],
  contacts: [],
};
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
const payload = {
  amountCents: 500,
  toAccountId: 'acc-x',
  fromAccountId: 'acc-me',
  concept: 'Rent',
};
const approvals = (extra: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(Approvals, {
      dashboard: { ...dashboard, approvals: [] },
      confirmResult: null,
      confirming: '',
      onAct: noop,
      onDismissResult: noop,
      resultRef: { current: null },
      ...extra,
    }),
  );

test('A6 the main account is the first source tile, whatever the bank order', () => {
  const html = transfers();
  assert.ok(html.indexOf('Aurora account') < html.indexOf('Personal savings'));
});

test('A7 the form validates itself: rules, no browser bubble, a flagged negative balance', () => {
  const ok = { from: 'a', to: 'b', amount: '12,50', concept: 'Rent' };
  assert.deepEqual(Object.values(transferFormErrors(ok)).filter(Boolean), []);
  assert.equal(transferFormErrors({ ...ok, amount: '12.5' }).amount, '');
  for (const amount of ['1e3', '12,505', '-1', '1 2', '1234567890'])
    assert.match(transferFormErrors({ ...ok, amount }).amount, /two decimals/, amount);
  assert.equal(transferFormErrors({ ...ok, amount: '' }).amount, 'Enter an amount.');
  assert.ok(transferFormErrors({ ...ok, concept: '   ' }).concept);
  assert.ok(transferFormErrors({ ...ok, to: '' }).to);
  assert.ok(transferFormErrors({ ...ok, from: '' }).from);
  const html = transfers();
  assert.match(html, /<form[^>]*\snoValidate=""/i);
  // An untouched (or cleared) form shows no message (PR #128).
  assert.doesNotMatch(html, /field-error|aria-invalid/);
  assert.match(
    transfers({ amount: '10' }),
    /class="estimate"><span>€0\.00<\/span><small>Estimated/,
  );
  assert.match(
    transfers({ amount: '10,01' }),
    /class="estimate over"><span>-€0\.01<\/span><small>More than the available balance/,
  );
});

test('A8 a confirm result is not headed "Transfers to confirm" and names a real place', () => {
  const result = { ...transferFeedback({ status: 'completed' }), status: 'completed', payload };
  const alone = approvals({ confirmResult: result });
  assert.match(alone, /<h2 class="approvals-head">Transfer result<\/h2>/);
  assert.doesNotMatch(alone, /Transfers to confirm|<svg/);
  assert.match(result.text, /Your transfers/);
  assert.doesNotMatch(result.text, /activity/);
  // With a proposal still waiting, the result comes before the "to confirm" heading.
  const waiting = { id: 'ap1', expires_at: '2026-10-04T10:00:00.000Z', payload };
  const both = approvals({
    dashboard: { ...dashboard, approvals: [waiting] },
    confirmResult: result,
  });
  assert.ok(both.indexOf('confirm-result') < both.indexOf('Transfers to confirm'));
});

test('A14 + A24a one word for the description; one wording for the bank step', () => {
  const html = transfers();
  assert.match(html, /<dt>Description<\/dt>/);
  assert.match(html, /<span>Description<\/span>/);
  const receipt = read('app/_components/Receipt.tsx');
  assert.match(receipt, /<dt>Description<\/dt>/);
  // UI-1 (review): the status says "Completed by the bank" once; the time row is "Completed".
  assert.match(receipt, /'Completed by the bank'/);
  assert.match(receipt, /<dt>Completed<\/dt>/);
  assert.equal(receipt.match(/Completed by the bank/g)?.length, 1);
  assert.doesNotMatch(html + receipt, />Concept<|Executed by the bank/);
});

test('A24b on the Transfers page an unconfirmed result does not say "ask"', () => {
  const message =
    'The bank has not registered this transfer yet, but it may still be processing it. Do not repeat it: ask about its status again in a couple of minutes.';
  const result = {
    ...transferFeedback({ status: 'pending_verification', message }),
    status: 'pending_verification',
    payload,
  };
  const page = approvals({ confirmResult: result, variant: 'page' });
  assert.doesNotMatch(page, /\bask\b/i);
  assert.match(page, /Do not repeat it\..*checks with the bank again by itself/);
  // The chat has an assistant to ask: the server's wording stays.
  assert.ok(approvals({ confirmResult: result, variant: 'chat' }).includes(message));
});

// FX1: the row's date is the transfer's own (`date`), not the time of its last step.
test('FX1 a row of "Your transfers" shows the transfer date, not the last step', () => {
  const row = (date?: string) =>
    transfers({
      dashboard: {
        ...dashboard,
        transfers: [
          {
            intentId: 'i1',
            status: 'completed',
            transfer: payload,
            ...(date ? { date } : {}),
            steps: [{ kind: 'verified', label: 'Verified', at: '2026-10-05T17:30:11.000Z' }],
          },
        ],
      },
    }).match(/class="transfer-meta".*?<time dateTime="([^"]+)"/)?.[1];
  assert.equal(row('2026-09-23T16:41:13.000Z'), '2026-09-23T16:41:13.000Z');
  assert.equal(row(), '2026-10-05T17:30:11.000Z');
});

test('A16 the prepared section has somewhere to put the focus after a delete', () => {
  const p = {
    id: 'p1',
    fromAccountId: 'acc-me',
    toAccountId: 'acc-x',
    to: 'Carla',
    amountCents: 100,
    concept: 'Rent',
    note: null,
    when: { kind: 'manual' },
    nextDue: null,
    state: 'ready',
    approvalId: null,
    expiresAt: null,
    lastAttempt: null,
    lastSentAt: null,
  } as PreparedView;
  const section = (items: PreparedView[]) =>
    renderToStaticMarkup(createElement(PreparedSection, { items, dashboard, onAct: noop }));
  assert.match(section([p]), /<h2 tabindex="-1">/);
  assert.match(section([]), /<section tabindex="-1"/);
});

test('A2, A15, B4 the style rules', () => {
  const transfersCss = read('app/styles/transfers.css');
  // A2: no row has a grid of its own.
  assert.doesNotMatch(transfersCss, /transfer-row:has\(\.row-action\)/);
  // A15: fields share the buttons' focus ring.
  assert.match(
    read('app/globals.css'),
    /input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible \{\s*outline: 2px solid var\(--focus\)/,
  );
  // B4: a long unbroken description wraps in the proposal card.
  assert.match(read('app/styles/approvals.css'), /\.proposal-meta \{[^}]*overflow-wrap: anywhere/);
  assert.match(transfersCss, /\.prepared-meta,[^{]*\{[^}]*overflow-wrap: anywhere/);
});

// Follow-up to #158.
test('3a an unconfirmed result follows its transfer once a dashboard read shows it settled', () => {
  const unknown = {
    ...transferFeedback({ status: 'pending_verification' }),
    status: 'pending_verification',
    intentId: 'i1',
    payload,
  };
  const row = (status: string, intentId = 'i1') => ({ intentId, status });
  const page = (status: string, intentId?: string) =>
    approvals({
      dashboard: { ...dashboard, approvals: [], transfers: [row(status, intentId)] },
      confirmResult: unknown,
    });
  assert.match(page('pending_verification'), /alert warning.*has not confirmed this transfer yet/);
  // Another transfer settling changes nothing.
  assert.match(page('completed', 'i2'), /has not confirmed this transfer yet/);
  const done = page('completed');
  assert.match(done, /alert notice confirm-result" role="status".*Transfer completed\./);
  assert.doesNotMatch(done, /has not confirmed|Do not repeat/);
  const failed = page('failed');
  assert.match(failed, /alert error confirm-result" role="alert".*no money moved\./);
  assert.doesNotMatch(failed, /has not confirmed|Do not repeat/);
  // A result that was already final is left as it is.
  const final = { ...unknown, status: 'failed', tone: 'error', text: 'Refused.' };
  assert.equal(settledResult(final, [row('completed')]), final);
});

test('3b with a proposal waiting, the page shows the result in its own neutral card', () => {
  const result = { ...transferFeedback({ status: 'completed' }), status: 'completed', payload };
  const waiting = { id: 'ap1', expires_at: '2026-10-04T10:00:00.000Z', payload };
  const both = (variant: string) =>
    approvals({
      dashboard: { ...dashboard, approvals: [waiting] },
      confirmResult: result,
      variant,
    });
  assert.match(
    both('page'),
    /^<section class="card approvals page settled"><h2 class="approvals-head">Transfer result<\/h2><div tabindex="-1" class="alert notice confirm-result".*?<\/div><\/section><section class="card approvals page"><h2 class="approvals-head"><svg/,
  );
  // The chat keeps one panel.
  assert.equal(both('chat').match(/<section/g)?.length, 1);
});

test('3c + 3d spaces around the amount are ignored; zero is refused under the field', () => {
  const ok = { from: 'a', to: 'b', concept: 'Rent' };
  for (const amount of [' 12', '12,50 ', ' 0.01 '])
    assert.equal(transferFormErrors({ ...ok, amount }).amount, '', amount);
  for (const amount of ['0', '0,00', ' 0.0 ', '000'])
    assert.equal(
      transferFormErrors({ ...ok, amount }).amount,
      'Enter an amount of at least €0.01.',
    );
  // The input's own pattern (what blocks the submit) agrees with the messages.
  const pattern = new RegExp(
    `^(?:${transfers().match(/pattern="([^"]*)" placeholder="0\.00"/)![1]})$`,
    'v',
  );
  for (const amount of [' 12', '12,50 ', '0.5', '10', '100.00'])
    assert.ok(pattern.test(amount), amount);
  for (const amount of ['0', '0,00', ' 0.0 ', '000', '1 2', '1e3', ''])
    assert.ok(!pattern.test(amount), amount);
});
