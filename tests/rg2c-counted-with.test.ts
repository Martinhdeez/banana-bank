// RG2c: an added monthly charge listed once inside another regular item (RG1d: a prepared
// transfer; RG1e: a detected usual charge) says so under its words in "Your adjustments not in
// this month": "Counted once with <the other item's label>". Without `countedWith`, no hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MonthAhead } from '../app/_components/plan/Forecast';
import type { ForecastAdjustment, MonthForecast } from '../app/_components/plan/types';

const hidden = JSON.parse(
  fs.readFileSync('tests/plan-fixtures/forecast-adjust-hidden.json', 'utf8'),
) as MonthForecast;
const noop = () => {};
const adjust = {
  pending: null,
  busy: false,
  status: null,
  error: '',
  labelError: '',
  onExclude: noop,
  onExpect: async () => true,
  onRemove: noop,
};
const render = (adjustments: ForecastAdjustment[]) =>
  renderToStaticMarkup(
    createElement(MonthAhead, {
      forecast: { ...hidden, adjustments },
      accountId: hidden.accounts[0].id,
      onAccount: noop,
      cover: null,
      error: '',
      onPrepare: noop,
      onUndo: noop,
      onOpenPrepared: noop,
      adjust,
    }),
  );
// The words of each row of the adjustments list, tags removed.
const rows = (html: string) => {
  const list = html.split('data-testid="forecast-adjustments"')[1] ?? '';
  return [...list.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, '|')
      .replace(/\|+/g, '|')
      .replace(/^\||\|$/g, ''),
  );
};
const [nextMonth, dayPassed] = hidden.adjustments!;

test('RG2c: an added charge counted with a prepared transfer or a detected charge says so', () => {
  const html = render([
    { ...nextMonth, countedWith: { label: 'Goal: Pagar a Carla', source: 'prepared' } },
    { ...dayPassed, countedWith: { label: 'Alquiler Inmob Castellana', source: 'detected' } },
  ]);
  assert.deepEqual(rows(html), [
    'Expected once: Dentist, €180.00 on 12 Nov|Counted once with Goal: Pagar a Carla|Remove',
    'Expected: Gym, €39.90 on the 3rd of each month|Counted once with Alquiler Inmob Castellana|Remove',
  ]);
});

test('RG2c: without `countedWith` the rows are as before, no hint', () => {
  const html = render([nextMonth, dayPassed]);
  assert.ok(!html.includes('Counted once with'));
  assert.deepEqual(rows(html), [
    'Expected once: Dentist, €180.00 on 12 Nov|Remove',
    'Expected: Gym, €39.90 on the 3rd of each month|Remove',
  ]);
});

test('RG1f: a "Not counted" row of reason usual_like_it with an adjustment id has its Remove', () => {
  const text = 'Electricity is not counted again: Iberdrola Clientes is a usual charge like it.';
  const html = renderToStaticMarkup(
    createElement(MonthAhead, {
      forecast: {
        ...hidden,
        adjustments: [],
        notCounted: [{ label: 'Electricity', reason: 'usual_like_it', text, adjustmentId: 'a1' }],
      },
      accountId: hidden.accounts[0].id,
      onAccount: noop,
      cover: null,
      error: '',
      onPrepare: noop,
      onUndo: noop,
      onOpenPrepared: noop,
      adjust,
    }),
  );
  const list = html.split('Not counted · 1</summary>')[1] ?? '';
  const row = (list.match(/<li>(.*?)<\/li>/)?.[1] ?? '').replace(/<[^>]+>/g, '|');
  assert.equal(row, `${text}|Remove|`);
});
