// TL2b: follow-up of the balance timeline (TL2, #211) in Month ahead. The event dots leave the
// Tab order and the events are one list instead; the period picker has a native select for
// narrow cards; a month row that ends today says when its end counts today's pending items
// (TL1 rules 3–4, TL1b); every change made from the Plan goes through the one refresh that
// reads the dashboard and the timeline again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePlan } from '../app/_components/Plan';
import { MonthAhead, type TimelineView } from '../app/_components/plan/Forecast';
import { RegularMoney } from '../app/_components/plan/Regular';
import { TimelineChart } from '../app/_components/plan/charts';
import { day, signed } from '../app/_components/plan/logic';
import type { MonthForecast, Timeline } from '../app/_components/plan/types';

const step3 = JSON.parse(
  fs.readFileSync('tests/plan-fixtures/forecast-take-step3.json', 'utf8'),
) as MonthForecast;
const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

// 1 Aug – 31 Oct (Last 3 months), every day €1,000; three events that are dots and an everyday
// estimate that is not.
function days(from: string, to: string) {
  const out: string[] = [];
  for (let d = Date.parse(from); d <= Date.parse(to); d += 86_400_000)
    out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}
function timeline(today: string, octEnd: number): Timeline {
  return {
    accountId: step3.accounts[0].id,
    range: 'last_3_months',
    today,
    from: '2026-08-01',
    to: '2026-10-31',
    points: days('2026-08-01', '2026-10-31').map((date) => ({
      date,
      balanceCents: 100000,
      actual: date <= today,
    })),
    events: [
      {
        date: '2026-08-05',
        label: 'Gym',
        amountCents: -3000,
        source: 'movement',
        certainty: 'actual',
      },
      {
        date: '2026-09-28',
        label: 'Salary',
        amountCents: 215000,
        source: 'movement',
        certainty: 'actual',
      },
      {
        date: today,
        label: 'Locksmith',
        amountCents: -5000,
        source: 'expected_by_you',
        certainty: 'certain',
      },
      {
        date: '2026-10-30',
        label: 'Everyday spending (estimate)',
        amountCents: -2600,
        source: 'everyday',
        certainty: 'estimated',
      },
    ],
    months: [
      {
        month: '2026-08',
        from: '2026-08-01',
        to: '2026-08-31',
        startBalanceCents: 100000,
        endBalanceCents: 100000,
        incomeCents: 0,
        outCents: 0,
        actual: 'full',
      },
      {
        month: '2026-09',
        from: '2026-09-01',
        to: '2026-09-30',
        startBalanceCents: 100000,
        endBalanceCents: 100000,
        incomeCents: 0,
        outCents: 0,
        actual: 'full',
      },
      {
        month: '2026-10',
        from: '2026-10-01',
        to: '2026-10-31',
        startBalanceCents: 100000,
        endBalanceCents: octEnd,
        incomeCents: 0,
        outCents: 100000 - octEnd,
        actual: today === '2026-10-31' ? 'full' : 'partial',
      },
    ],
    lowest: null,
    shortfall: null,
    basis: null,
    notes: [],
  } as Timeline;
}
const view = (data: Timeline): TimelineView => ({
  range: data.range,
  onRange: noop,
  known: true,
  data,
  loading: false,
  error: '',
  onRetry: noop,
});
const month = (data: Timeline) =>
  text(
    renderToStaticMarkup(
      createElement(MonthAhead, {
        forecast: step3,
        accountId: step3.accounts[0].id,
        onAccount: noop,
        cover: null,
        error: '',
        onPrepare: noop,
        onUndo: noop,
        onOpenPrepared: noop,
        timeline: view(data),
      }),
    ),
  );
const rows = (html: string, table: string) =>
  [
    ...((html.split(`data-testid="${table}"`)[1] ?? '')
      .split('<tbody>')[1]
      ?.split('</tbody>')[0]
      .matchAll(/<tr[\s\S]*?<\/tr>/g) ?? []),
  ].map((m) =>
    m[0]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
const LABEL = "after today's pending items";

test("a month row that ends today, after today's pending items, says so next to its end only", () => {
  // 31 Oct, a €50 item still to come today: today's point €1,000, the October row ends at €950.
  const r = rows(month(timeline('2026-10-31', 95000)), 'timeline-months');
  assert.equal(r.length, 3);
  assert.ok(r[2].endsWith(`€950.00 ${LABEL}`), r[2]);
  assert.ok(!r[0].includes(LABEL) && !r[1].includes(LABEL));
  // The same row with nothing pending today ends at today's point: no label.
  assert.ok(!month(timeline('2026-10-31', 100000)).includes(LABEL));
  // A row that ends after today is a projection like any other: no label.
  assert.ok(!month(timeline('2026-10-07', 95000)).includes(LABEL));
});

test('the events are one list under the chart: date, label, amount, the same events as the dots', () => {
  const html = month(timeline('2026-10-31', 95000));
  assert.match(html, /<details[^>]*data-testid="timeline-events"/);
  assert.match(html, /<summary[^>]*>Events in this period \(3\)<\/summary>/);
  assert.deepEqual(rows(html, 'timeline-events'), [
    `${day('2026-08-05')} Gym ${signed(-3000)}`,
    `${day('2026-09-28')} Salary ${signed(215000)}`,
    `${day('2026-10-31')} Locksmith ${signed(-5000)}`,
  ]);
});

test('the dots are not tab stops; the chart keeps its text alternative', () => {
  const html = renderToStaticMarkup(
    createElement(TimelineChart, {
      width: 800,
      timeline: timeline('2026-10-31', 95000),
      label: 'Aurora',
      change: null,
    }),
  );
  const dots = html.match(/<circle[^>]*data-testid="timeline-dot"[^>]*>/g) ?? [];
  assert.equal(dots.length, 3);
  for (const d of dots) {
    assert.ok(!/tabindex|role=|aria-label/i.test(d), d);
  }
  assert.ok(!/tabindex/i.test(html));
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Balance of Aurora from [^"]+"/);
});

test('the period picker has a native select with every period, the chosen one selected', () => {
  const html = month(timeline('2026-10-31', 95000));
  const select = html.match(/<select[\s\S]*?<\/select>/)?.[0] ?? '';
  assert.equal((select.match(/<option/g) ?? []).length, 9);
  assert.match(select, /<option value="last_3_months" selected="">Last 3 months<\/option>/);
  assert.match(html, /<label[^>]*>[\s\S]*Period[\s\S]*<select/);
});

// Every change made from the Plan calls the one refresh that reads the dashboard and the
// timeline again (TL2's `replan`): the dashboard's `refresh` is its observable half here.
function findProps(node: ReactNode, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findProps(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (node.type === type) return props;
  return findProps(props.children as ReactNode, type);
}
test('every Plan mutation asks for the shared refresh of the dashboard and the timeline', async () => {
  const calls: string[] = [];
  let refreshes = 0;
  const api = async (path: string, _body?: unknown, method = 'POST') => {
    calls.push(`${method} ${path}`);
    if (path === 'prepared') return { status: 'prepared', prepared: { id: 'p1' } };
    if (path.startsWith('forecast/adjustments/')) return { removed: true };
    return { adjustment: { id: 'adj1' } };
  };
  const forecast = {
    ...step3,
    adjustable: true,
    accounts: [
      {
        ...step3.accounts[0],
        regular: { income: [], charges: [], irregularSpend: null },
      },
    ],
  } as unknown as MonthForecast;
  let got = {} as ReturnType<typeof usePlan>;
  function Host() {
    got = usePlan({
      api,
      customerId: 'lucia',
      dashboard: { accounts: [], prepared: [], forecast },
      refresh: async () => void refreshes++,
      active: true,
      goPlan: noop,
      goOverview: noop,
      openPrepared: noop,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Host));
  const m = findProps(got.page as ReactNode, MonthAhead) as unknown as Parameters<
    typeof MonthAhead
  >[0];
  const r = findProps(got.page as ReactNode, RegularMoney) as unknown as Parameters<
    typeof RegularMoney
  >[0];
  assert.ok(m?.adjust && r?.actions, 'Month ahead and Regular money take changes');
  const acc = forecast.accounts[0].id;
  const steps: [string, () => Promise<unknown> | void][] = [
    ['prepare', () => m.onPrepare(acc, [], { prepare: { amountCents: 1 } } as never)],
    [
      'expect (Month ahead)',
      () =>
        m.adjust!.onExpect({
          kind: 'expect',
          accountId: acc,
          label: 'Dentist',
          amountCents: 12000,
          repeats: 'once',
          date: '2026-10-25',
        }),
    ],
    [
      'exclude (Month ahead)',
      () => m.adjust!.onExclude(acc, { label: 'Gym', merchantKey: 'gym' } as never),
    ],
    ['remove (Month ahead)', () => m.adjust!.onRemove('adj1')],
    [
      'add (Regular money)',
      () =>
        r.actions!.onAdd({
          kind: 'expect',
          accountId: acc,
          label: 'Gym',
          amountCents: 3000,
          repeats: 'monthly',
          day: 5,
        }),
    ],
    [
      'exclude (Regular money)',
      () => r.actions!.onExclude(acc, { id: 'gym', label: 'Gym' } as never),
    ],
    ['remove (Regular money)', () => r.actions!.onRemove('adj1')],
  ];
  for (const [name, run] of steps) {
    const before = refreshes,
      sent = calls.length;
    await run();
    // The fire-and-forget ones settle on the next turns.
    for (let i = 0; i < 20 && refreshes === before; i++) await new Promise((ok) => setTimeout(ok));
    assert.equal(calls.length, sent + 1, `${name}: one call to the server`);
    assert.equal(refreshes, before + 1, `${name}: the dashboard and the timeline are read again`);
  }
});

// Item 6, TL1 rule 6 (TL1c): the lowest marker sits at the intra-day low of `lowest.date`, the
// line still follows the ends of day, and the axis reaches the marker.
test('the lowest marker is drawn at the low within its day, inside the axis; the line keeps the ends of day', async () => {
  const { timelineLayout } = await import('../app/_components/plan/logic');
  const base = timeline('2026-10-07', 95000);
  // 28 Oct: a €2,000 goal payment before the payroll; the day ends at €1,000, its low is -€1,000.
  const t: Timeline = {
    ...base,
    points: base.points.map((p) => (p.date === '2026-10-28' ? { ...p, lowCents: -100000 } : p)),
    lowest: { date: '2026-10-28', balanceCents: -100000 },
  };
  const l = timelineLayout(t, 800);
  assert.deepEqual(l.lowest, { x: l.x('2026-10-28'), y: l.y(-100000), cents: -100000 });
  assert.ok(l.lowest!.y <= l.H - l.m.b && l.lowest!.y >= l.m.t, 'inside the plot');
  // The line is the ends of day: flat at €1,000, never down to the low.
  assert.ok(!l.projected.includes(`,${l.y(-100000)}`));
  // A low equal to the day before's end (only money coming in): not a low of its own.
  const inOnly: Timeline = {
    ...base,
    points: base.points.map((p) =>
      p.date === '2026-10-28' ? { ...p, balanceCents: 300000, lowCents: 100000 } : p,
    ),
    lowest: { date: '2026-10-28', balanceCents: 100000 },
  };
  const k = timelineLayout(inOnly, 800);
  assert.deepEqual(k.lowest, { x: k.x('2026-10-28'), y: k.y(300000), cents: 300000 });
  assert.equal(timelineLayout({ ...base, lowest: null }, 800).lowest, null);
});
