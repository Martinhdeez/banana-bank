// TL2: the balance timeline of Month ahead. The pure layout of the chart (past solid, future
// dashed, both meeting at Today; the zero line; the shortfall area; one dot per event; the
// preview of a change) and the words under it, from TL1's contract
// (GET /api/forecast/timeline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { basisWords, RANGES, timelineLayout } from '../app/_components/plan/logic';
import type { Timeline } from '../app/_components/plan/types';

// 1–31 Oct, today the 7th: €500 on the 1st, −€100 a day to the 5th, then flat; on the 20th
// −€800 (to −€400, a shortfall), on the 28th +€1,000.
const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const balance = (d: number) =>
  d <= 5 ? 50000 - (d - 1) * 10000 : d < 20 ? 10000 : d < 28 ? -70000 : 30000;
const t: Timeline = {
  accountId: 'acc',
  range: 'this_month',
  today: '2026-10-07',
  from: '2026-10-01',
  to: '2026-10-31',
  points: days.map((date, i) => ({
    date,
    balanceCents: balance(i + 1),
    actual: date <= '2026-10-07',
  })),
  events: [
    {
      date: '2026-10-03',
      label: 'Card',
      amountCents: -10000,
      source: 'movement',
      certainty: 'actual',
    },
    {
      date: '2026-10-20',
      label: 'Rent',
      amountCents: -80000,
      source: 'usual_charge',
      certainty: 'estimated',
    },
    {
      date: '2026-10-28',
      label: 'Salary',
      amountCents: 100000,
      source: 'usual_income',
      certainty: 'estimated',
    },
    // Spread over the days: never a dot.
    {
      date: '2026-10-29',
      label: 'Everyday spending (estimate)',
      amountCents: -2600,
      source: 'everyday',
      certainty: 'estimated',
    },
  ],
  months: [],
  lowest: { date: '2026-10-20', balanceCents: -70000 },
  shortfall: { date: '2026-10-20', shortCents: 70000, forLabel: 'Rent' },
  basis: null,
  notes: [],
};
const pts = (d: string) => [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [+m[1], +m[2]]);

test('the past line ends where the dashed future starts: at Today', () => {
  const l = timelineLayout(t, 800);
  const past = pts(l.actual),
    future = pts(l.projected);
  assert.equal(past.length, 7); // 1–7 Oct
  assert.equal(future.length, 25); // 7–31 Oct
  assert.deepEqual(past.at(-1), future[0]);
  assert.equal(past.at(-1)![0], l.todayX);
  assert.equal(past.at(-1)![1], l.todayY);
  // Left to right, inside the box.
  assert.ok(past[0][0] >= l.m.l && future.at(-1)![0] <= 800 - l.m.r);
  // The elapsed part, a band from the first day to Today.
  assert.deepEqual(l.elapsed, { x1: l.x('2026-10-01'), x2: l.todayX });
  // One month: its ends and Today on the axis, no month division.
  assert.deepEqual(
    l.xMarks.map((m) => m.label),
    ['1 Oct', '7 Oct', '31 Oct'],
  );
  assert.deepEqual(l.monthBands, []);
});

test('the zero line, the shortfall area below it, one dot per event at its day and balance', () => {
  const l = timelineLayout(t, 800);
  assert.equal(l.zeroY, l.y(0));
  assert.ok(l.y(-70000) > l.zeroY && l.y(30000) < l.zeroY);
  assert.ok(l.shortArea, 'a future below zero is shaded');
  assert.ok(l.shortArea!.endsWith('Z') && l.shortArea!.includes(`,${l.zeroY}`));
  assert.deepEqual(
    l.dots.map((d) => [d.event.label, d.x, d.y]),
    [
      ['Card', l.x('2026-10-03'), l.y(30000)],
      ['Rent', l.x('2026-10-20'), l.y(-70000)],
      ['Salary', l.x('2026-10-28'), l.y(30000)],
    ],
  );
  const covered = {
    ...t,
    points: t.points.map((p) => ({ ...p, balanceCents: Math.abs(p.balanceCents) })),
  };
  assert.equal(timelineLayout(covered, 800).shortArea, null);
});

test('a previewed change moves the future from its day on, and nothing before it', () => {
  const l = timelineLayout(t, 800, { date: '2026-10-25', amountCents: 50000 });
  const ghost = pts(l.ghost!),
    future = pts(l.projected);
  assert.equal(ghost.length, future.length);
  assert.deepEqual(ghost.slice(0, 18), future.slice(0, 18)); // 7–24 Oct
  assert.equal(ghost.at(-1)![1], l.y(80000)); // 31 Oct: €300 + €500
  assert.equal(timelineLayout(t, 800, { date: '2026-11-02', amountCents: 50000 }).ghost, null);
});

test('a period without Today: no Today mark, no band; a past one has no dashed part', () => {
  // Last month, all of it past.
  const sep = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const past = timelineLayout(
    {
      ...t,
      range: 'last_month',
      from: '2026-09-01',
      to: '2026-09-30',
      points: sep.map((date) => ({ date, balanceCents: 40000, actual: true })),
      events: [],
      lowest: null,
      shortfall: null,
    },
    800,
  );
  assert.equal(pts(past.actual).length, 30);
  assert.equal(past.projected, '');
  assert.equal(past.todayX, null);
  assert.equal(past.elapsed, null);
  assert.equal(past.shortArea, null);
  const narrow = timelineLayout(t, 320);
  for (const [x] of [...pts(narrow.actual), ...pts(narrow.projected)])
    assert.ok(x >= 0 && x <= 320);
  for (const m of narrow.xMarks) assert.ok(m.x >= 0 && m.x <= 320);
});

test('more than one month is divided by month: a line at each first day, the names over them', () => {
  const all: string[] = [];
  for (let d = Date.parse('2026-10-01'); d <= Date.parse('2026-12-31'); d += 86_400_000)
    all.push(new Date(d).toISOString().slice(0, 10));
  const l = timelineLayout(
    {
      ...t,
      range: 'next_3_months',
      to: '2026-12-31',
      points: all.map((date) => ({ date, balanceCents: 30000, actual: date <= '2026-10-07' })),
    },
    800,
  );
  assert.deepEqual(
    l.monthBands.map((b) => [b.label, b.x1, b.boundary]),
    [
      ['Oct', l.x('2026-10-01'), false],
      ['Nov', l.x('2026-11-01'), true],
      ['Dec', l.x('2026-12-01'), true],
    ],
  );
  assert.equal(l.monthBands[2].x2, l.x('2026-12-31'));
  assert.deepEqual(l.xMarks, []);
});

test('the ranges, in the order of the control, and the "Based on" line', () => {
  assert.deepEqual(
    RANGES.map(([, label]) => label),
    [
      'This week',
      'Last week',
      'This month',
      'Last month',
      'Next month',
      'Last 3 months',
      'Next 3 months',
      'Last 6 months',
      'Next 6 months',
    ],
  );
  assert.equal(RANGES.find(([id]) => id === 'this_month')?.[1], 'This month');
  assert.equal(
    basisWords({
      regularIncomeMonthlyCents: 215000,
      regularChargesMonthlyCents: 177146,
      everydayMonthlyCents: 82004,
      months: ['2026-07', '2026-08', '2026-09'],
    }),
    'Based on regular income €2,150 a month, regular charges €1,771 a month and everyday spending of about €820 a month, from Jul–Sep.',
  );
  assert.equal(
    basisWords({
      regularIncomeMonthlyCents: 0,
      regularChargesMonthlyCents: 0,
      everydayMonthlyCents: 0,
      months: [],
    }),
    'Based on regular income €0 a month, regular charges €0 a month and everyday spending of about €0 a month.',
  );
});
