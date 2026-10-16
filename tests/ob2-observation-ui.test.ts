// OB2 (plan 26 §6, REQ-OB-9): the "Worth a look" card from each kind of observation, and the
// Overview without one, which must render exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObservationCard, useObservation } from '../app/_components/Observation';
import { Overview } from '../app/_components/Overview';
import type { Observation } from '../src/observations/detect';
import type { Person } from '../src/types';

const noop = () => {};
const uncovered: Observation = {
  key: 'prepared_uncovered:p1:once',
  kind: 'prepared_uncovered',
  title: 'A prepared transfer is not covered',
  basis:
    'Your prepared transfer of €3,000.00 to Carla Ríos · Aurora account (ready to send) is more than the €2,937.61 in your Aurora account today.',
  movementIds: [],
  preparedId: 'p1',
};
const up: Observation = {
  key: 'category_up:eating_out_leisure:2026-09',
  kind: 'category_up',
  title: 'Eating out & leisure is up',
  basis: 'Eating out & leisure: €59.90 in September (3 payments), €39.20 in August (2).',
  movementIds: ['m1', 'm2'],
};
const card = (props: Parameters<typeof ObservationCard>[0]) =>
  renderToStaticMarkup(createElement(ObservationCard, props));
// The buttons of a card, in order: test id and label.
const buttons = (html: string) =>
  [...html.matchAll(/<button type="button"[^>]*data-testid="([a-z-]+)"[^>]*>([^<]*)</g)].map(
    (m) => `${m[1]}=${m[2]}`,
  );
// What the page passes to Overview's `insights` slot (app/page.tsx), with a stand-in for the
// spending card.
function Slot({ dashboard }: { dashboard: Record<string, unknown> }) {
  const observation = useObservation({
    api: async () => ({}),
    customerId: 'lucia',
    dashboard,
    refresh: async () => {},
    goTransfers: noop,
    ask: noop,
  });
  const spending = dashboard.insights ? createElement('section', { id: 'spending' }) : null;
  return createElement(Overview, {
    current: { id: 'lucia', name: 'Lucía Martín' } as Person,
    people: [] as Person[],
    dashboard,
    allActivity: false,
    onToggleAll: noop,
    onTab: noop,
    onOpenAccount: noop,
    onStartTransfer: noop,
    insights: (observation || spending) && createElement(Fragment, null, observation, spending),
  });
}
const accounts = [{ id: 'acc-lucia', label: 'Aurora account', balanceCents: 293761 }];
const overview = (extra = {}) =>
  renderToStaticMarkup(
    createElement(Slot, { dashboard: { accounts, contacts: [], movements: [], ...extra } }),
  );

test('OB2 prepared_uncovered: the server text as text, and the three buttons', () => {
  const html = card({ observation: uncovered });
  assert.match(
    html,
    /^<aside class="card observation" aria-label="Worth a look" aria-live="polite" data-testid="observation-card" data-kind="prepared_uncovered">/,
  );
  assert.match(html, /<p class="eyebrow">Worth a look<\/p><h2>A prepared transfer is not covered</);
  assert.ok(html.includes(`data-testid="observation-basis">${uncovered.basis}</p>`));
  assert.deepEqual(buttons(html), [
    'observation-action=See prepared transfer',
    'observation-dismiss=Dismiss',
    'observation-off=Don’t show these',
  ]);
  assert.match(html, /A fact from your movements, not advice\./);
});

test('OB2 category_up: the same card, the action asks the assistant', () => {
  const html = card({ observation: up });
  assert.match(html, /data-kind="category_up"/);
  // Server text is escaped, never markup.
  assert.match(html, /<h2>Eating out &amp; leisure is up<\/h2>/);
  assert.equal(buttons(html)[0], 'observation-action=Ask the assistant');
  assert.match(card({ observation: { ...up, title: '<b>x</b>' } }), /<h2>&lt;b&gt;x&lt;\/b&gt;</);
});

test('OB2 turned off: one status line and Undo, no card', () => {
  const html = card({ observation: uncovered, off: true });
  assert.doesNotMatch(html, /observation-card|observation-basis/);
  // The way back is the drawer (UI2), not a sentence to type to the assistant.
  assert.match(
    html,
    /role="status" data-testid="observation-off-status">Observations are off\. You can turn these back on in “What the assistant may do”\.</,
  );
  assert.deepEqual(buttons(html), ['observation-undo=Undo']);
});

test('OB2 no observation: nothing is rendered, and the Overview is as without the field', () => {
  assert.equal(card({ observation: null }), '');
  const before = overview();
  assert.doesNotMatch(before, /overview-insights|observation/);
  assert.equal(overview({ observation: null }), before);
  // With the spending card alone the slot holds only that card.
  assert.match(
    overview({ observation: null, insights: {} }),
    /data-testid="overview-insights"><section id="spending"><\/section><\/div>/,
  );
});

test('OB2 with an observation: the card is in the insights slot, above the spending card', () => {
  const html = overview({ observation: uncovered, insights: {} });
  assert.match(
    html,
    /data-testid="overview-insights"><aside class="card observation"[\s\S]*<\/aside><section id="spending">/,
  );
  // Without the spending card the slot holds the card alone.
  assert.match(overview({ observation: up }), /data-testid="overview-insights"><aside/);
});
