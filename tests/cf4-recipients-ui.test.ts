// CF4-ui: the optional slots render only when given (favourite toggle, ranked order, star).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Transfers } from '../app/_components/Transfers';
import { Overview } from '../app/_components/Overview';
import { groupRecipients } from '../src/banking/recipients';
import type { Person } from '../src/types';

const contacts = [
  { id: 'acc-carla', name: 'Carla Ríos', userId: 'carla' },
  { id: 'acc-bruno', name: 'Bruno Díaz', userId: 'bruno' },
];
const dashboard = { accounts: [{ id: 'acc-me', label: 'Everyday', balanceCents: 1000 }], contacts };
const people = [] as Person[];
const noop = () => {};
const base = {
  dashboard,
  people,
  from: '',
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
};
const isFav = (key: string) => key === 'bruno';

test('CF4-ui Transfers: no toggle without onToggleFavourite', () => {
  const html = renderToStaticMarkup(createElement(Transfers, base));
  assert.doesNotMatch(html, /favourite-toggle|chip-slot/);
});

test('CF4-ui Transfers: a sibling star toggle per chip with pressed state and labels', () => {
  const html = renderToStaticMarkup(
    createElement(Transfers, { ...base, favourite: isFav, onToggleFavourite: noop }),
  );
  const toggles = [...html.matchAll(/<button[^>]*class="favourite-toggle"[^>]*>/g)].map(
    (m) => m[0],
  );
  assert.equal(toggles.length, 2);
  assert.match(toggles[0], /aria-pressed="false"/);
  assert.match(toggles[0], /aria-label="Add Carla Ríos to favourites"/);
  assert.match(toggles[1], /aria-pressed="true"/);
  assert.match(toggles[1], /aria-label="Remove Bruno Díaz from favourites"/);
  // Sibling, not nested: the chip button closes before the toggle opens.
  assert.match(
    html,
    /<span class="chip-slot"><button[^>]*class="recipient-chip"[\s\S]*?<\/button><button[^>]*class="favourite-toggle"/,
  );
  assert.match(html, /Bruno<span class="sr-only">, favourite<\/span>/);
});

test('CF4-ui Overview: recipientList order and a star with an accessible name', () => {
  const current = { id: 'me', name: 'Lucía Pérez' } as Person;
  const props = {
    current,
    people,
    dashboard,
    allActivity: false,
    onToggleAll: noop,
    onTab: noop,
    onOpenAccount: noop,
    onStartTransfer: noop,
  };
  const names = (html: string) =>
    [...html.matchAll(/<button class="recipient">[\s\S]*?<\/span>([^<]+)/g)].map((m) => m[1]);
  const plain = renderToStaticMarkup(createElement(Overview, props));
  assert.deepEqual(names(plain), ['Carla', 'Bruno']);
  assert.doesNotMatch(plain, /class="fav"/);
  const ranked = groupRecipients(contacts).reverse();
  const html = renderToStaticMarkup(
    createElement(Overview, { ...props, recipientList: ranked, favourite: isFav }),
  );
  assert.deepEqual(names(html), ['Bruno', 'Carla']);
  assert.equal(html.match(/class="fav"/g)?.length, 1);
  assert.match(html, /Bruno<span class="sr-only">, favourite<\/span>/);
});
