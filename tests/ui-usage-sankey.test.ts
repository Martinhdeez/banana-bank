// The operator's "Where the AI cost goes" Sankey and the usage periods (30 days, custom range).
// Figures from TR1's real overview answer (a production build with stand-in providers) and
// hand-made totals; no server, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  UsageOverview,
  daysText,
  periodWords,
  rangeHint,
  rangeReady,
  usageQuery,
} from '../app/_components/AiUsage';
import {
  amountLine,
  apportion,
  byAreaTree,
  byCustomerTree,
  sankeyLayout,
  type SankeyInput,
} from '../app/_components/UsageSankey';

const overview = JSON.parse(
  readFileSync('.scratch/after/feat-tr1-ai-usage-recording/evidence-api-overview.json.txt', 'utf8'),
);
const t = (requests: number, costNanoUsd: number | null, unpricedRequests = 0) => ({
  requests,
  costNanoUsd,
  providerNanoUsd: 0,
  unpricedRequests,
});
// Total → two areas (one with a partly priced and a not-priced task) plus an idle area.
const tree: SankeyInput = {
  id: 'total',
  label: 'Total recorded',
  t: t(10, 3000, 3),
  children: [
    {
      id: 'a',
      label: 'A',
      t: t(6, 2000, 3),
      children: [
        { id: 'a1', label: 'A1', t: t(3, 2000, 1) },
        { id: 'a2', label: 'A2', t: t(2, null, 2) },
      ],
    },
    { id: 'idle', label: 'Idle', t: t(0, 0) },
    { id: 'b', label: 'B', t: t(4, 1000), children: [{ id: 'b1', label: 'B1', t: t(4, 1000) }] },
  ],
};
const byId = (nodes: { id: string }[]) => new Map(nodes.map((n) => [n.id, n]));

test('sibling shares are whole tenths that sum to their parent (largest remainder)', () => {
  assert.deepEqual(apportion(1000, [1, 1, 1]), [334, 333, 333]);
  const { nodes } = sankeyLayout(byAreaTree(overview), 880, 220);
  const total = nodes.find((n) => n.column === 0)!;
  assert.equal(total.share, 1000);
  for (const parent of nodes) {
    const kids = nodes.filter((n) => n.parent === parent.id);
    if (kids.length)
      assert.equal(
        kids.reduce((s, n) => s + n.share!, 0),
        parent.share,
        parent.id,
      );
  }
  // A real cost too small for 0.1 % is never printed as 0 %.
  const search = nodes.find((n) => n.id === 'area:search')!;
  assert.equal(search.share, 0);
  assert.match(amountLine(search), /· <0\.1%$/);
});

test('partial, not-priced and idle nodes; links fill their parent exactly', () => {
  const { nodes, links } = sankeyLayout(tree, 800, 200);
  const n = byId(nodes) as Map<string, (typeof nodes)[number]>;
  assert.equal(n.get('total')!.partial, true);
  assert.equal(amountLine(n.get('total')!), '$0.000003000 (partial) · 100%');
  assert.equal(n.get('a1')!.partial, true);
  assert.equal(n.get('a2')!.stub, 'unpriced');
  assert.equal(amountLine(n.get('a2')!), 'Not priced');
  assert.equal(n.get('idle')!.stub, 'zero');
  assert.equal(amountLine(n.get('idle')!), '$0.00 · 0%');
  // Stubs carry no band.
  assert.ok(!links.some((l) => l.to === 'a2' || l.to === 'idle'));
  for (const parent of nodes.filter((p) => !p.stub)) {
    const out = links.filter((l) => l.from === parent.id);
    if (out.length)
      assert.ok(Math.abs(out.reduce((s, l) => s + l.thickness, 0) - parent.h) < 1e-9, parent.id);
  }
  // Bands ∝ priced cost: A is twice B.
  assert.ok(Math.abs(n.get('a')!.h - 2 * n.get('b')!.h) < 1e-9);
});

test('deterministic order: by cost, not-priced before idle, labels never closer than two lines', () => {
  const a = sankeyLayout(tree, 800, 200),
    b = sankeyLayout(tree, 800, 200);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.nodes.filter((n) => n.column === 1).map((n) => n.id),
    ['a', 'b', 'idle'],
  );
  assert.deepEqual(
    a.nodes.filter((n) => n.column === 2).map((n) => n.id),
    ['a1', 'a2', 'b1'],
  );
  for (const column of [1, 2]) {
    const centres = a.nodes.filter((n) => n.column === column).map((n) => n.y + n.h / 2);
    for (let i = 1; i < centres.length; i++) assert.ok(centres[i] - centres[i - 1] >= 38);
  }
});

test('the four areas are always there; by customer is total → customer', () => {
  const tiny = {
    ...overview,
    totals: t(3, 100_000),
    byConsumer: [{ consumer: 'decider:systemone', ...t(3, 100_000) }],
    byCustomer: [],
    staffAndSystem: t(0, 0),
  };
  const { nodes } = sankeyLayout(byAreaTree(tiny), 880, 220);
  assert.deepEqual(
    nodes.filter((n) => n.column === 1).map((n) => [n.label, n.stub]),
    [
      ['Classification', null],
      ["Customers' assistant", 'zero'],
      ['Document search', 'zero'],
      ['Operator', 'zero'],
    ],
  );
  const customers = byCustomerTree(overview);
  assert.deepEqual(
    customers.children!.map((c) => c.label),
    ['Lucía Martín', 'Bruno Vidal', 'Staff and system'],
  );
  // As the table's "Share of cost": the customers split 100 % of the customers' cost; staff and
  // system keeps its bar and cost but carries no share.
  const split = sankeyLayout(customers, 880, 220);
  const people = split.nodes.filter((n) => n.id.startsWith('customer:'));
  assert.equal(
    people.reduce((s, n) => s + n.share!, 0),
    1000,
  );
  for (const n of people) {
    const row = overview.byCustomer.find(
      (c: { userId: string }) => `customer:${c.userId}` === n.id,
    );
    assert.equal(n.share! / 10, row.sharePct, n.id);
  }
  const staff = split.nodes.find((n) => n.id === 'staff')!;
  assert.equal(staff.share, null);
  assert.equal(staff.value, overview.staffAndSystem.costNanoUsd);
  assert.match(amountLine(staff), / · outside the shares$/);
  assert.ok(split.links.some((l) => l.to === 'staff'));
  assert.equal(split.nodes.find((n) => n.id === 'total')!.share, 1000);
});

test('by customer: the top five read the table shares when "Others" groups the rest', () => {
  // The seeded 7-day period of the probe: apportioned over the seven nodes, Diego read 17.7 %.
  const rows = [
    ['lucia', 1062668, 35],
    ['elena', 541324, 17.8],
    ['carla', 538888, 17.8],
    ['diego', 538888, 17.8],
    ['bruno', 323936, 10.7],
    ['omar', 12508, 0.4],
    ['hugo', 9908, 0.3],
    ['ines', 7472, 0.2],
  ] as const;
  const byCustomer = rows.map(([userId, costNanoUsd, sharePct]) => ({
    userId,
    name: userId,
    sharePct,
    ...t(1, costNanoUsd),
  }));
  const total = rows.reduce((s, r) => s + r[1], 0);
  const { nodes } = sankeyLayout(
    byCustomerTree({ totals: t(8, total), byCustomer, staffAndSystem: t(0, 0) }),
    880,
    220,
  );
  for (const c of byCustomer.slice(0, 5))
    assert.equal(nodes.find((n) => n.id === `customer:${c.userId}`)!.share! / 10, c.sharePct);
  assert.equal(nodes.find((n) => n.id === 'customer:others')!.share, 9);
});

test('the overview renders the diagram with its summary; an empty period has none', () => {
  const html = renderToStaticMarkup(
    createElement(UsageOverview, { data: overview, onCustomer() {} }),
  );
  assert.match(html, /Where the AI cost goes/);
  assert.match(
    html,
    /<svg role="img" aria-label="AI cost for All, since 6 Oct 2026: \$0\.001187 \(partial\) · 100%\. Customers&#x27; assistant: \$0\.000848 \(partial\) · 71\.4%;/,
  );
  assert.ok(html.indexOf('Where the AI cost goes') < html.indexOf('By customer'));
  const empty = renderToStaticMarkup(
    createElement(UsageOverview, {
      data: { ...overview, totals: { ...overview.totals, requests: 0 } },
      onCustomer() {},
    }),
  );
  assert.doesNotMatch(empty, /<svg/);
  assert.match(empty, /No AI usage recorded for this period/);
});

test('custom range: both days, From ≤ To, none after today', () => {
  const today = '2026-10-07';
  assert.equal(rangeHint('', '', today), null);
  assert.equal(rangeReady('', '2026-10-01', today), false);
  assert.equal(rangeReady('2026-10-01', '2026-10-07', today), true);
  assert.equal(rangeReady('2026-10-07', '2026-10-07', today), true);
  assert.equal(rangeHint('2026-10-05', '2026-10-01', today), 'From must be on or before To.');
  assert.equal(rangeHint('2026-10-01', '2026-10-08', today), 'Choose dates up to 7 Oct 2026.');
  assert.equal(rangeReady('2026-10-01', '2026-10-08', today), false);
  assert.equal(
    usageQuery({ period: 'range', from: '2026-10-01', to: '2026-10-07' }),
    'period=range&from=2026-10-01&to=2026-10-07',
  );
  assert.equal(usageQuery({ period: '30d' }), 'period=30d');
});

test('the period in words, from since/until of the answer', () => {
  assert.equal(daysText('2026-10-01', '2026-10-07'), '1–7 Oct 2026');
  assert.equal(daysText('2026-09-28', '2026-10-04'), '28 Sep – 4 Oct 2026');
  assert.equal(daysText('2025-12-29', '2026-01-04'), '29 Dec 2025 – 4 Jan 2026');
  // Madrid midnights as UTC instants (CEST: 22:00 UTC the day before).
  assert.equal(
    periodWords({ period: 'today', since: '2026-10-06T22:00:00.000Z', until: null }),
    'Today, 7 Oct 2026',
  );
  assert.equal(
    periodWords({ period: '7d', since: '2026-09-30T22:00:00.000Z', until: null }),
    'Last 7 days (1–7 Oct 2026)',
  );
  assert.equal(
    periodWords({ period: '30d', since: '2026-09-07T22:00:00.000Z', until: null }),
    'Last 30 days (8 Sep – 7 Oct 2026)',
  );
  assert.equal(
    periodWords({
      period: 'range',
      since: '2026-09-27T22:00:00.000Z',
      until: '2026-10-04T22:00:00.000Z',
      from: '2026-09-28',
      to: '2026-10-04',
    }),
    '28 Sep – 4 Oct 2026',
  );
  assert.equal(
    periodWords({ period: 'all', since: null, firstRecordAt: '2026-10-06T14:22:23.564Z' }),
    'All, since 6 Oct 2026',
  );
});
