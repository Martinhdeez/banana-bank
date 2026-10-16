// The operator's "Where the AI cost goes": a Sankey of the selected period's priced cost, from the
// overview's totals to an area and on to each consumer (or to the top customers). Every figure is
// one of GET /api/usage; the tables under it stay the accessible source, the drawing is pointer only.
import { useEffect, useRef, useState } from 'react';
import type { Totals } from '../../src/usage/report';
import type { AnyRecord } from '../../src/ui-helpers';
import { consumerLabel, usd } from './AiUsage';

type CostTotals = Pick<Totals, 'requests' | 'costNanoUsd' | 'providerNanoUsd' | 'unpricedRequests'>;
export type SankeyInput = {
  id: string;
  label: string;
  t: CostTotals;
  children?: SankeyInput[];
  outside?: boolean; // drawn with its cost but left out of its siblings' shares
  share?: number; // tenths already apportioned by the caller (customers, over every row)
};
export type SankeyNode = {
  id: string;
  parent: string | null;
  column: number;
  x: number;
  y: number;
  h: number;
  label: string;
  value: number; // priced nano-dollars (0 when not priced)
  share: number | null; // tenths of a percent of the total; null: outside the shares
  partial: boolean; // part of its requests have no price
  stub: 'zero' | 'unpriced' | null; // no band: no requests, or requests and no priced cost
  main: boolean; // on the branch of the largest area
};
export type SankeyLink = {
  from: string;
  to: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  thickness: number;
  main: boolean;
};

const ZERO: CostTotals = { requests: 0, costNanoUsd: 0, providerNanoUsd: 0, unpricedRequests: 0 };
export const BAR = 10;
export const LABEL_W = 210; // room right of the last column's bars for its labels
export const HEAD = 34; // the column headings
export const PITCH = 38; // the least slot of a node: a two-line label fits
export const GAP = 14;
export const MIN_H = 3; // a band with a cost stays visible and hoverable
export const STUB_H = 16;

const valueOf = (t: CostTotals) => t.costNanoUsd ?? 0;
const stubOf = (t: CostTotals): SankeyNode['stub'] =>
  t.requests === 0 || t.costNanoUsd === 0 ? 'zero' : t.costNanoUsd === null ? 'unpriced' : null;

// Largest remainder: `whole` tenths split over `values`, the printed parts summing to it exactly.
export function apportion(whole: number, values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (!sum) return values.map(() => 0);
  const raw = values.map((v) => (v / sum) * whole);
  const parts = raw.map(Math.floor);
  let left = whole - parts.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => [r - parts[i], i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => left-- > 0 && parts[i]++);
  return parts;
}

// By priced cost, largest first; then "Not priced" before nothing; then the order given.
const order = (list: SankeyInput[]) =>
  list
    .map((n, i) => ({ n, i }))
    .sort(
      (a, b) =>
        valueOf(b.n.t) - valueOf(a.n.t) ||
        Number(stubOf(a.n.t) === 'zero') - Number(stubOf(b.n.t) === 'zero') ||
        a.i - b.i,
    )
    .map(({ n }) => n);

// Columns at fixed x, nodes stacked per column in their parent's order, bands ∝ priced cost.
// `height` is the total bar's height; the returned height is the whole drawing's.
export function sankeyLayout(root: SankeyInput, width: number, height: number) {
  type Tree = { input: SankeyInput; column: number; parent: Tree | null; kids: Tree[]; h: number };
  const grow = (input: SankeyInput, column: number, parent: Tree | null): Tree => {
    const tree: Tree = { input, column, parent, kids: [], h: 0 };
    tree.kids = order(input.children ?? []).map((c) => grow(c, column + 1, tree));
    return tree;
  };
  const top = grow(root, 0, null);
  const k = valueOf(root.t) > 0 ? height / valueOf(root.t) : 0;
  // A parent is as tall as its children's bands together, so the slices fill it exactly.
  const size = (t: Tree): number => {
    const own = stubOf(t.input.t) ? 0 : Math.max(MIN_H, valueOf(t.input.t) * k);
    const kids = t.kids.reduce((s, c) => s + size(c), 0);
    return (t.h = own && Math.max(own, kids));
  };
  size(top);
  const columns: Tree[][] = [];
  const walk = (t: Tree) => {
    (columns[t.column] ??= []).push(t);
    t.kids.forEach(walk);
  };
  walk(top);
  const shares = new Map<Tree, number | null>([[top, valueOf(root.t) > 0 ? 1000 : 0]]);
  // The siblings "outside" (staff and system) have no share: the others split the parent's.
  const share = (t: Tree) => {
    const parts = apportion(
      shares.get(t) ?? 0,
      t.kids.map((c) => (c.input.outside ? 0 : valueOf(c.input.t))),
    );
    t.kids.forEach(
      (c, i) => (shares.set(c, c.input.outside ? null : (c.input.share ?? parts[i])), share(c)),
    );
  };
  share(top);
  const mainArea = top.kids.find((c) => c.h > 0 && !c.input.outside);
  const isMain = (t: Tree): boolean =>
    !!mainArea && (t === mainArea || (!!t.parent && t.parent !== top && isMain(t.parent)));
  const slot = (t: Tree) => Math.max(t.h, PITCH);
  const heights = columns.map((c) => c.reduce((s, t) => s + slot(t), 0) + GAP * (c.length - 1));
  const body = Math.max(...heights);
  const span = columns.length > 1 ? (width - LABEL_W - BAR) / (columns.length - 1) : 0;
  const nodes: SankeyNode[] = [];
  const placed = new Map<Tree, SankeyNode>();
  columns.forEach((list, column) => {
    let y = HEAD + (body - heights[column]) / 2;
    for (const t of list) {
      const stub = stubOf(t.input.t);
      const h = stub ? STUB_H : t.h;
      const node: SankeyNode = {
        id: t.input.id,
        parent: t.parent?.input.id ?? null,
        column,
        x: Math.round(column * span),
        y: y + (slot(t) - h) / 2,
        h,
        label: t.input.label,
        value: valueOf(t.input.t),
        share: shares.get(t)!,
        partial: !stub && t.input.t.unpricedRequests > 0,
        stub,
        main: column === 0 || isMain(t),
      };
      nodes.push(node);
      placed.set(t, node);
      y += slot(t) + GAP;
    }
  });
  const links: SankeyLink[] = [];
  for (const [t, from] of placed) {
    let y0 = from.y;
    for (const c of t.kids) {
      const to = placed.get(c)!;
      if (from.stub || to.stub) continue;
      links.push({
        from: from.id,
        to: to.id,
        x0: from.x + BAR,
        x1: to.x,
        y0,
        y1: to.y,
        thickness: to.h,
        main: to.main,
      });
      y0 += to.h;
    }
  }
  return { nodes, links, width, height: HEAD + body + 4 };
}

// A band: two curves and the straight ends between them.
export function ribbon(l: SankeyLink) {
  const m = (l.x0 + l.x1) / 2;
  const b0 = l.y0 + l.thickness,
    b1 = l.y1 + l.thickness;
  return `M${l.x0},${l.y0}C${m},${l.y0} ${m},${l.y1} ${l.x1},${l.y1}L${l.x1},${b1}C${m},${b1} ${m},${b0} ${l.x0},${b0}Z`;
}

// A real cost under 0.05 % rounds to nothing: "<0.1%", never "0%" beside an amount.
export const pct = (tenths: number, value = 0) =>
  tenths === 0 && value > 0 ? '<0.1%' : `${tenths / 10}%`;
// The second line of a node: "$0.016591 (partial) · 10%", "Not priced", "$0.00 · 0%".
// Under a total with no price at all, an idle node is "No requests": a $0 beside "Not priced"
// would read as a price.
export function amountLine(
  n: Pick<SankeyNode, 'stub' | 'value' | 'partial' | 'share'>,
  priced = true,
) {
  if (n.stub === 'unpriced') return 'Not priced';
  if (n.stub === 'zero') return priced ? `${usd(0)} · 0%` : 'No requests';
  return `${usd(n.value)}${n.partial ? ' (partial)' : ''} · ${n.share === null ? 'outside the shares' : pct(n.share, n.value)}`;
}

// The four areas are always drawn (a zero stub when idle), so the shape stays the same.
const AREAS: [string, string, string[]][] = [
  ['assistant', "Customers' assistant", ['assistant', 'voice']],
  ['classification', 'Classification', ['decider:systemone', 'decider:openai']],
  ['search', 'Document search', ['embeddings']],
  ['operator', 'Operator', ['operator_preview']],
];
export function sumTotals(list: CostTotals[]): CostTotals {
  const s = list.reduce(
    (a, t) => ({
      requests: a.requests + t.requests,
      costNanoUsd: (a.costNanoUsd ?? 0) + (t.costNanoUsd ?? 0),
      providerNanoUsd: a.providerNanoUsd + t.providerNanoUsd,
      unpricedRequests: a.unpricedRequests + t.unpricedRequests,
    }),
    ZERO,
  );
  return s.requests > 0 && s.unpricedRequests === s.requests ? { ...s, costNanoUsd: null } : s;
}
export function byAreaTree(data: AnyRecord): SankeyInput {
  const rows: (CostTotals & { consumer: string })[] = data.byConsumer ?? [];
  const known = AREAS.flatMap(([, , keys]) => keys);
  const area = (id: string, label: string, list: typeof rows): SankeyInput => ({
    id: `area:${id}`,
    label,
    t: sumTotals(list),
    children: list.map((r) => ({
      id: `task:${r.consumer}`,
      label: consumerLabel(r.consumer),
      t: r,
    })),
  });
  const other = rows.filter((r) => !known.includes(r.consumer));
  return {
    id: 'total',
    label: 'Total recorded',
    t: data.totals,
    children: [
      ...AREAS.map(([id, label, keys]) =>
        area(
          id,
          label,
          rows.filter((r) => keys.includes(r.consumer)),
        ),
      ),
      ...(other.length ? [area('other', 'Other', other)] : []),
    ],
  };
}
// Total → customer: the top five by cost, the rest as "Others", then staff and system. The API
// does not split a customer by area, so this view has no middle column. As in the table, the
// customers' shares are of the customers' cost: staff and system is outside them.
export function byCustomerTree(data: AnyRecord): SankeyInput {
  const customers: (CostTotals & { userId: string; name: string })[] = data.byCustomer ?? [];
  const rest = customers.slice(5);
  // Apportioned over every customer row, as the table's shares are, then "Others" sums its rows:
  // the top five read the table's figures.
  const parts = apportion(
    1000,
    customers.map((c) => c.costNanoUsd ?? 0),
  );
  const tenths = (from: number) => parts.slice(from).reduce((a, b) => a + b, 0);
  return {
    id: 'total',
    label: 'Total recorded',
    t: data.totals,
    children: [
      ...customers
        .slice(0, 5)
        .map((c, i) => ({ id: `customer:${c.userId}`, label: c.name, t: c, share: parts[i] })),
      ...(rest.length
        ? [
            {
              id: 'customer:others',
              label: `Others (${rest.length})`,
              t: sumTotals(rest),
              share: tenths(5),
            },
          ]
        : []),
      ...(data.staffAndSystem?.requests > 0
        ? [{ id: 'staff', label: 'Staff and system', t: data.staffAndSystem, outside: true }]
        : []),
    ],
  };
}

export function UsageSankey({ data, periodName }: { data: AnyRecord; periodName: string }) {
  const [mode, setMode] = useState<'agent' | 'customer'>('agent');
  const [hot, setHot] = useState<string | null>(null);
  const [width, setWidth] = useState(880);
  const box = useRef<HTMLDivElement>(null);
  // Laid out at the card's own width (never under 640: the card scrolls sideways then), so the
  // text keeps its size.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.max(640, Math.floor(e.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tree = mode === 'agent' ? byAreaTree(data) : byCustomerTree(data);
  const { nodes, links, height } = sankeyLayout(tree, width, 220);
  const heads =
    mode === 'agent' ? ['Total recorded', 'Area', 'Task'] : ['Total recorded', 'Customer'];
  // The path of the hovered node: itself, its ancestors and its descendants.
  const lit = new Set<string>();
  if (hot) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (let n = byId.get(hot); n; n = n.parent ? byId.get(n.parent) : undefined) lit.add(n.id);
    const down = (id: string) =>
      nodes.filter((n) => n.parent === id).forEach((n) => (lit.add(n.id), down(n.id)));
    down(hot);
  }
  const dim = (id: string) => (hot && !lit.has(id) ? ' is-dim' : '');
  const [total, ...rest] = nodes;
  const priced = total.stub !== 'unpriced';
  const summary = `AI cost for ${periodName}: ${amountLine(total)}. ${rest
    .filter((n) => n.column === 1)
    .map((n) => `${n.label}: ${amountLine(n, priced)}`)
    .join('; ')}.`;
  return (
    <section className="card usage-card usage-flow">
      <div className="usage-flow-head">
        <h2>Where the AI cost goes</h2>
        <div className="segmented" role="group" aria-label="Split the cost">
          {(
            [
              ['agent', 'By agent'],
              ['customer', 'By customer'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="usage-flow-scroll"
        ref={box}
        role="region"
        aria-label="Where the AI cost goes, diagram"
        tabIndex={0}
      >
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onPointerLeave={() => setHot(null)}
        >
          {heads.map((h, i) => (
            <text
              key={h}
              className="usage-flow-col"
              x={nodes.find((n) => n.column === i)?.x ?? 0}
              y={12}
            >
              {h}
            </text>
          ))}
          {links.map((l) => (
            <path
              key={l.to}
              className={`usage-flow-band${l.main ? ' is-main' : ''}${dim(l.to)}`}
              d={ribbon(l)}
              onPointerEnter={() => setHot(l.to)}
            />
          ))}
          {nodes.map((n) => (
            <g
              key={n.id}
              className={`usage-flow-node${n.main ? ' is-main' : ''}${n.column === 0 ? ' is-total' : ''}${dim(n.id)}`}
              onPointerEnter={() => setHot(n.id)}
            >
              {n.stub ? (
                <line
                  className="usage-flow-stub"
                  x1={n.x - 2}
                  x2={n.x + BAR + 2}
                  y1={n.y + n.h / 2}
                  y2={n.y + n.h / 2}
                />
              ) : (
                <rect x={n.x} y={n.y} width={BAR} height={n.h} rx={2} />
              )}
              <text x={n.x + BAR + 8} y={n.y + n.h / 2 - 3}>
                <tspan className="usage-flow-name">{n.label}</tspan>
                <tspan className="usage-flow-amount" x={n.x + BAR + 8} dy={17}>
                  {amountLine(n, priced)}
                </tspan>
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}
