// Follow-up to UI1 (#189): the Overview without a brief card of its own, where the chart's
// labels may go, the "Prepared." line tied to its prepared transfer, a room that is not positive.
// `forecast-take-step3/4.json` are GET /api/dashboard → forecast of the real take (Lucía, demo
// bank): events on 10, 14, 19, 20, 25, 28, 31 Oct, and on the 24th after the second cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePlan } from '../app/_components/Plan';
import { MonthAhead } from '../app/_components/plan/Forecast';
import { GoalsSection } from '../app/_components/plan/Goals';
import {
  balanceScale,
  dayOf,
  eventLabels,
  fitsLine,
  frameOf,
  hasPrepared,
  placeLabels,
  PREPARED_LINE,
  roomWords,
  type Box,
} from '../app/_components/plan/logic';
import type { Brief, GoalsResponse, MonthForecast } from '../app/_components/plan/types';

const read = <T>(name: string) =>
  JSON.parse(fs.readFileSync(`tests/plan-fixtures/${name}.json`, 'utf8')) as T;
const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const step3 = read<MonthForecast>('forecast-take-step3');
const step4 = read<MonthForecast>('forecast-take-step4');

function plan(brief: Brief | null) {
  let got = {} as ReturnType<typeof usePlan>;
  function Host() {
    got = usePlan({
      api: async () => ({}),
      customerId: 'lucia',
      dashboard: { accounts: [], prepared: [], forecast: step3, brief },
      refresh: async () => {},
      active: true,
      goPlan: noop,
      goOverview: noop,
      openPrepared: noop,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Host));
  const html = (node: unknown) =>
    text(renderToStaticMarkup(createElement('main', null, node as React.ReactNode)));
  return { overview: html(got.overview), page: html(got.page) };
}

test('the Overview has no brief card: nothing with no finding, else the findings inside the Plan card', () => {
  const none = plan(read<Brief>('brief-0'));
  assert.ok(none.overview.includes('data-testid="plan-card"'));
  assert.ok(!none.overview.includes('plan-brief') && !none.overview.includes('plan-mini-brief'));
  assert.ok(!none.overview.includes('Nothing needs a look this month.'));
  // The Plan tab keeps its block, the zero state included.
  assert.ok(none.page.includes('data-testid="plan-brief"'));
  assert.ok(none.page.includes('aria-label="Nothing needs a look this month."'));

  for (const name of ['brief-1', 'brief-2', 'brief-up']) {
    const brief = read<Brief>(name);
    const { overview, page } = plan(brief);
    assert.equal(overview.split('<section').length - 1, 1, 'one card');
    assert.ok(!overview.includes('data-testid="plan-brief"'));
    const card = overview.slice(overview.indexOf('data-testid="plan-card"'));
    // Headline, then each finding with its link, then the two cells.
    const at = [
      `<p class="plan-mini-lead">${brief.headline}</p>`,
      ...brief.findings.map((f) => `<span class="brief-text">${f.text}</span><button`),
      'class="plan-mini-grid"',
    ].map((part) => card.indexOf(part));
    assert.ok(
      at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1])),
      `${name}: ${at.join()}`,
    );
    assert.equal(card.split('class="brief-text"').length - 1, brief.findings.length);
    assert.ok(page.includes('data-testid="plan-brief"'));
  }
  // No brief at all (a server without it): the card as before.
  assert.ok(!plan(null).overview.includes('plan-mini-brief'));
});

const plot: Box = { x1: 0, y1: 0, x2: 400, y2: 200 };
test('a chart label goes above-right of its dot, then above-left, then below, else it is dropped', () => {
  const dot = { x: 200, y: 100, width: 60 };
  const [free] = placeLabels([dot], plot, []);
  assert.deepEqual([free?.anchor, free?.x, free?.y], ['start', 208, 92]);
  // A vertical step of the line 30px to the right crosses the first place.
  const step: Box = { x1: 230, x2: 230, y1: 60, y2: 100 };
  const [left] = placeLabels([dot], plot, [step]);
  assert.deepEqual([left?.anchor, left?.x, left?.y], ['end', 192, 92]);
  // And one to the left: under the dot, centred.
  const before: Box = { x1: 170, x2: 170, y1: 60, y2: 99 };
  const [below] = placeLabels([dot], plot, [step, before]);
  assert.deepEqual([below?.anchor, below?.x, below?.y], ['middle', 200, 119]);
  // Nothing free: dropped.
  const under: Box = { x1: 150, x2: 250, y1: 115, y2: 115 };
  assert.deepEqual(placeLabels([dot], plot, [step, before, under]), [null]);
  // The plot's edge counts as taken; an absent label stays absent.
  const edge = placeLabels([null, { x: 380, y: 100, width: 60 }], plot, []);
  assert.deepEqual([edge[0], edge[1]?.anchor], [null, 'end']);
  // Two labels one day apart never share a place: the second gives way.
  const [a, b] = placeLabels([dot, { x: 215, y: 100, width: 60 }], plot, []);
  assert.deepEqual([a?.anchor, b?.anchor], ['start', 'middle']);
  assert.ok(b!.box.y1 > a!.box.y2);
});

// Everything the chart draws that a label must not lie on, worked out here on its own.
function chart(f: MonthForecast, width: number) {
  const account = f.accounts[0];
  const frame = frameOf(account, f.today);
  const cents = [account.balanceCents, ...frame.events.map((e) => e.balanceAfterCents)];
  const scale = balanceScale(width, f.today, f.until, [
    Math.min(0, ...cents),
    Math.max(1, ...cents),
  ]);
  const labels = eventLabels(frame, account.balanceCents, scale, width);
  const lines: Box[] = [];
  let px = scale.x(scale.d0),
    py = scale.y(account.balanceCents);
  for (const e of frame.events) {
    const ex = scale.x(dayOf(e.date)),
      ey = scale.y(e.balanceAfterCents);
    lines.push({ x1: px, x2: ex, y1: py, y2: py });
    lines.push({ x1: ex, x2: ex, y1: Math.min(py, ey), y2: Math.max(py, ey) });
    px = ex;
    py = ey;
  }
  const by = (day: number) => labels[frame.events.findIndex((e) => dayOf(e.date) === day)];
  return { frame, scale, labels, lines, by };
}
const crosses = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

test('the take: no label of the chart lies on the line, on another label or outside the plot', () => {
  for (const [name, f] of [
    ['step 3', step3],
    ['step 4', step4],
  ] as const)
    for (const width of [250, 324, 330, 520, 700, 760, 1000, 1100]) {
      const { labels, lines, scale } = chart(f, width);
      const boxes = labels.flatMap((l) => (l ? [l.box] : []));
      for (const box of boxes) {
        assert.ok(!lines.some((l) => crosses(box, l)), `${name} at ${width}: on the line`);
        assert.ok(box.x1 >= scale.m.l && box.x2 <= width - scale.m.r, `${name} at ${width}: edge`);
        assert.ok(
          boxes.every((o) => o === box || !crosses(box, o)),
          `${name} at ${width}: labels`,
        );
      }
    }
  // A phone (the chart is 324px wide at 390): "Car insurance" on the 25th, the lowest point, is
  // 5 days after the drop of the 20th. It is drawn clear of that drop, or not at all.
  const phone = chart(step3, 324);
  const car = phone.by(25);
  const drop = phone.lines.find((l) => l.x1 === l.x2 && l.x1 === phone.scale.x(20))!;
  assert.ok(!car || !crosses(car.box, drop));
  // Fewer labels on a phone than on a desktop, never more.
  const desk = chart(step4, 1100);
  assert.ok(chart(step4, 324).labels.filter(Boolean).length <= desk.labels.filter(Boolean).length);
  // 1440: "From Personal +€420.00" on the 24th is not crossed by the line of the 20th.
  const from = desk.by(24);
  const drop20 = desk.lines.find((l) => l.x1 === l.x2 && l.x1 === desk.scale.x(20))!;
  assert.ok(!from || !crosses(from.box, drop20));
  // The lowest point keeps its words where there is room for them.
  assert.ok(chart(step3, 1100).by(25));
});

test('the "Prepared." line and its Undo last only while the forecast counts that prepared transfer', () => {
  const [account] = step4.accounts;
  const id = account.events.find((e) => e.preparedId && e.amountCents === 42000)!.preparedId!;
  assert.equal(hasPrepared(step4, id), true);
  assert.equal(hasPrepared(step4, 'sent-or-deleted'), false);
  const option = step3.accounts[0].options[0];
  const month = (preparedId: string) =>
    text(
      renderToStaticMarkup(
        createElement(MonthAhead, {
          forecast: step4,
          accountId: account.id,
          onAccount: noop,
          cover: {
            accountId: account.id,
            options: [option],
            option,
            preparedId,
            phase: 'done' as const,
          },
          error: '',
          onPrepare: noop,
          onUndo: noop,
          onOpenPrepared: noop,
        }),
      ),
    );
  const held = month(id);
  assert.ok(held.includes(PREPARED_LINE) && held.includes('data-testid="forecast-undo"'));
  const gone = month('sent-or-deleted');
  assert.ok(!gone.includes(PREPARED_LINE) && !gone.includes('data-testid="forecast-undo"'));
  assert.ok(!gone.includes('data-testid="forecast-cover-option"'));
});

test('a room of zero or less is said in words, never as a figure "left"', () => {
  const empty = read<GoalsResponse>('goals-empty');
  const section = (room: GoalsResponse['room']) =>
    text(
      renderToStaticMarkup(
        createElement(GoalsSection, {
          data: { ...empty, room },
          fresh: '',
          note: null,
          onOpen: noop,
          onCreate: noop,
          onOpenPrepared: noop,
          onResume: noop,
        }),
      ),
    );
  // The independent bank's default seed: one full month, more out than in.
  const negative = { monthlyCents: -10900, months: 1 };
  assert.equal(
    roomWords(negative),
    'Over your last 1 full month nothing was left over in a usual month.',
  );
  assert.equal(
    roomWords({ monthlyCents: 0, months: 3 }),
    'Over your last 3 full months nothing was left over in a usual month.',
  );
  assert.equal(roomWords(empty.room!), null);
  for (const room of [negative, { monthlyCents: 0, months: 3 }]) {
    const html = section(room);
    assert.ok(html.includes(roomWords(room)!));
    assert.ok(!/-€|−€|€0|left each month/.test(html), html.match(/.{30}(-€|€0).{30}/)?.[0]);
    // The server's `fits` is false for any plan then: the sentence carries no figure.
    assert.equal(fitsLine(false, room), 'More than you usually have left each month.');
  }
  assert.ok(
    section(empty.room).includes('you had about <strong>€714.48</strong> left each month.'),
  );
  assert.equal(
    fitsLine(false, empty.room),
    'More than you usually have left each month (about €714.48).',
  );
});
