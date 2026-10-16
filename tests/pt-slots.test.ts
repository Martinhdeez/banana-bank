// PT-slots: three optional slots for prepared transfers; nothing changes without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../app/_components/Overview';
import { Transfers } from '../app/_components/Transfers';
import type { Person } from '../src/types';

const noop = () => {};
const approval = {
  id: 'ap1',
  expires_at: '2026-10-04T10:00:00.000Z',
  payload: { amountCents: 500, toAccountId: 'acc-sav', concept: 'Rent' },
};
const dashboard = {
  accounts: [
    { id: 'acc-me', label: 'Everyday', balanceCents: 1000 },
    { id: 'acc-sav', label: 'Savings', balanceCents: 500 },
  ],
  contacts: [],
  approvals: [approval],
  movements: [],
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
      approvals: createElement('section', { id: 'approvals' }),
      ...extra,
    }),
  );
const overview = (extra = {}, approvals = [approval]) =>
  renderToStaticMarkup(
    createElement(Overview, {
      current: { id: 'me', name: 'Lucía Pérez' } as Person,
      people: [] as Person[],
      dashboard: { ...dashboard, approvals },
      allActivity: false,
      onToggleAll: noop,
      onTab: noop,
      onOpenAccount: noop,
      onStartTransfer: noop,
      ...extra,
    }),
  );
const item = (id: string) => ({
  id,
  title: `Title ${id}`,
  detail: `Detail ${id}`,
  actionLabel: `Open ${id}`,
  onAction: noop,
});
const itemHtml = (id: string) =>
  `<li class="attention-item"><i class="dot pending" aria-hidden="true"></i><span class="attention-text"><strong>Title ${id}</strong><small>Detail ${id}</small></span><button class="text-link">Open ${id}</button></li>`;

test('PT-slots: without the props (or with empty ones) the markup is unchanged', () => {
  const t = transfers();
  assert.ok(
    t.includes('<section id="approvals"></section><form class="transfer-form" noValidate="">'),
  );
  assert.match(t, /<\/button><p class="summary-note">/);
  for (const empty of [undefined, null, false, 0, ''])
    assert.equal(transfers({ prepared: empty, formExtra: empty }), t);
  const o = overview();
  assert.match(o, /<span class="count-badge">1<\/span><\/div><ul class="attention-list single">/);
  assert.equal(o.match(/class="attention-item"/g)?.length, 1);
  assert.equal(overview({ attention: undefined }), o);
  assert.equal(overview({ attention: [] }), o);
  assert.doesNotMatch(overview({ attention: [] }, []), /card attention/);
});

test('PT-slots: prepared renders between the approvals and the form, with no wrapper', () => {
  const html = transfers({ prepared: createElement('p', { id: 'dummy-prepared' }) });
  assert.ok(
    html.includes(
      '<section id="approvals"></section><p id="dummy-prepared"></p><form class="transfer-form" noValidate="">',
    ),
  );
});

test('PT-slots: formExtra renders between the review button and the summary note', () => {
  const html = transfers({ formExtra: createElement('b', { id: 'dummy-later' }) });
  assert.match(
    html,
    /Review transfer<svg.*?<\/svg><\/button><b id="dummy-later"><\/b><p class="summary-note">/,
  );
});

test('PT-slots: attention items follow the approvals and count in the badge', () => {
  const html = overview({ attention: [item('p1'), item('p2')] });
  assert.match(html, /<span class="count-badge">3<\/span><\/div><ul class="attention-list ">/);
  assert.ok(
    html.includes(`Review in Transfers →</button></li>${itemHtml('p1')}${itemHtml('p2')}</ul>`),
  );
});

test('PT-slots: attention items alone show the card', () => {
  const html = overview({ attention: [item('p1')] }, []);
  assert.ok(
    html.includes(
      `<span class="count-badge">1</span></div><ul class="attention-list single">${itemHtml('p1')}</ul></section>`,
    ),
  );
});
