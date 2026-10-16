// The mosaic of the "Where your money went" card (app/_components/SpendInsights.tsx): a
// squarified treemap, one tile per category, its area the share of the spending.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BLOCKS,
  Blocks,
  SMALLER,
  blocksLayout,
  SpendingCard,
  blocksTiles,
  pinAfter,
  minShare,
} from '../app/_components/SpendInsights';

const W = 720,
  H = 232;
// Lucía's September on the demo bank.
const demo = [106110, 20540, 12105, 8500, 4995, 4405, 2899, 1245].map((cents, i) => ({
  id: `c${i}`,
  cents,
}));
const area = (r: { w: number; h: number }) => r.w * r.h;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, b);
// The rectangles tile the box: all inside it, their areas add up to it, and no two overlap.
function tiles(rects: ReturnType<typeof blocksLayout>, w = W, h = H) {
  for (const r of rects) {
    assert.ok(r.w > 0 && r.h > 0 && r.x >= -1e-9 && r.y >= -1e-9, JSON.stringify(r));
    assert.ok(r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, JSON.stringify(r));
  }
  assert.ok(
    close(
      rects.reduce((sum, r) => sum + area(r), 0),
      w * h,
    ),
  );
  rects.forEach((a, i) =>
    rects.slice(i + 1).forEach((b) => {
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${String(a.id)} overlaps ${String(b.id)}`);
    }),
  );
}

test('areas follow the amounts and the rectangles tile the box', () => {
  const rects = blocksLayout(demo, W, H, 0);
  assert.equal(rects.length, demo.length);
  tiles(rects);
  const total = demo.reduce((sum, p) => sum + p.cents, 0);
  for (const r of rects) {
    const part = demo.find((p) => p.id === r.id)!;
    assert.ok(close(area(r) / (W * H), part.cents / total), `${r.id}`);
  }
  // Largest first: the big tile is at the left, as tall as the box; the rest are at its right.
  assert.deepEqual(
    rects.map((r) => r.id),
    demo.map((p) => p.id),
  );
  assert.ok(rects[0].x === 0 && rects[0].y === 0 && close(rects[0].h, H));
  for (const r of rects.slice(1)) assert.ok(r.x >= rects[0].w - 1e-6);
});

// The demo bank's figures (cents by category, largest first).
const DATA: Record<string, number[]> = {
  'Lucía, Sep 2026': [106110, 20540, 12105, 8500, 4995, 4405, 2899, 1245],
  'Lucía, All': [306843, 39339, 23644, 8500, 7675, 4995, 3998, 1245],
  'Bruno, All': [124000, 76058, 24900, 16479, 9910, 7000, 3901],
};
const named = (cents: number[]) => cents.map((c, i) => ({ id: `c${i}`, cents: c }));

test('areas follow the amounts in both boxes: no tile is more than 3 points off its share of the spending', () => {
  for (const [name, cents] of Object.entries(DATA))
    for (const [w, h] of [BLOCKS.WIDE, BLOCKS.NARROW]) {
      const total = cents.reduce((a, b) => a + b, 0);
      const rects = blocksTiles(named(cents), w, h);
      tiles(rects, w, h);
      // Every category is in exactly one tile, and a tile's amount is the sum of its categories.
      assert.deepEqual(
        rects.flatMap((r) => r.members).sort(),
        named(cents)
          .map((p) => p.id)
          .sort(),
      );
      for (const r of rects) {
        const sum = r.members.reduce((a, id) => a + cents[Number(id.slice(1))], 0);
        assert.equal(r.cents, sum);
        const off = Math.abs(area(r) / (w * h) - r.cents / total) * 100;
        assert.ok(off <= 3, `${name} ${w}x${h} ${r.id}: ${off.toFixed(2)} points off`);
        // A tile a finger can hit: 24px and its 6px gap.
        assert.ok(
          Math.min(r.w, r.h) >= 30 - 1e-6,
          `${name} ${w}x${h} ${r.id} is thin: ${r.w.toFixed(1)} x ${r.h.toFixed(1)}`,
        );
      }
      // Largest first, and never the same area for different amounts.
      rects.forEach((a, i) =>
        rects.slice(i + 1).forEach((b) => {
          assert.ok(a.cents >= b.cents, `${name} ${w}x${h}: order`);
          if (a.cents !== b.cents)
            assert.ok(area(a) - area(b) > 1e-6, `${name} ${w}x${h}: ${a.id} and ${b.id} tie`);
        }),
      );
    }
});

test('categories too small for a tile share ONE tile whose area is their sum; a single small one stays itself', () => {
  const [w, h] = BLOCKS.NARROW;
  const min = minShare(w, h);
  // Lucía, All, on a phone: five categories are under the smallest share.
  const cents = DATA['Lucía, All'];
  const total = cents.reduce((a, b) => a + b, 0);
  const rects = blocksTiles(named(cents), w, h);
  const group = rects.find((r) => r.id === SMALLER)!;
  assert.deepEqual(group.members, ['c3', 'c4', 'c5', 'c6', 'c7']);
  assert.equal(group.cents, 8500 + 7675 + 4995 + 3998 + 1245);
  assert.ok(close(area(group) / (w * h), group.cents / total)); // not inflated
  assert.deepEqual(
    rects.map((r) => r.id),
    ['c0', 'c1', SMALLER, 'c2'], // by amount: the group's sum is over Groceries,
  );
  // The big tile is what the amounts say (77%), not shrunk to make room.
  assert.ok(close(area(rects[0]) / (w * h), cents[0] / total));
  // A tenth of the money is never a "smaller category": with two big ones and a crumb there is
  // no group; the crumb is raised by the floor, the last resort, by under 3 points (in the wide
  // box; on a phone it would be a hairline and is not drawn: the last test).
  const crumb = blocksTiles(named([5000, 4900, 60]), ...BLOCKS.WIDE);
  assert.deepEqual(
    crumb.map((r) => r.id),
    ['c0', 'c1', 'c2'],
  );
  assert.ok(area(crumb[2]) / (720 * 232) - 60 / 9960 < 0.03);
  // Nothing small: no group. No spending: no tile.
  assert.ok(blocksTiles(named([500, 300, 200]), w, h).every((r) => r.id !== SMALLER));
  assert.deepEqual(blocksTiles(named([0, 0]), w, h), []);
  // The wide box needs a smaller share: fewer categories are grouped there.
  assert.ok(minShare(...BLOCKS.WIDE) < min);
  assert.deepEqual(
    blocksTiles(named(cents), ...BLOCKS.WIDE).find((r) => r.id === SMALLER)?.members,
    ['c6', 'c7'],
  );
});

test('a tiny part is raised to the floor for the layout; the others keep their proportions', () => {
  const parts = [
    { id: 'big', cents: 99_900 },
    { id: 'mid', cents: 50_000 },
    { id: 'tiny', cents: 100 }, // under 0.1%
  ];
  const rects = blocksLayout(parts, W, H, 0.012);
  tiles(rects);
  const of = (id: string) => area(rects.find((r) => r.id === id)!) / (W * H);
  assert.ok(of('tiny') > 0.0115, `tiny has ${of('tiny')}`);
  assert.ok(close(of('big') / of('mid'), 99_900 / 50_000));
  // Without a floor it is its real share.
  const bare = blocksLayout(parts, W, H, 0);
  assert.ok(close(area(bare.find((r) => r.id === 'tiny')!) / (W * H), 100 / 150_000));
});

test('one part is the whole box; no spending is no rectangle; nothing is NaN', () => {
  assert.deepEqual(blocksLayout([{ id: 'only', cents: 4200 }], W, H), [
    { id: 'only', x: 0, y: 0, w: W, h: H },
  ]);
  assert.deepEqual(blocksLayout([], W, H), []);
  assert.deepEqual(
    blocksLayout(
      [
        { id: 'a', cents: 0 },
        { id: 'b', cents: 0 },
      ],
      W,
      H,
    ),
    [],
  );
  // Parts with nothing spent (or a refund) get no tile.
  const some = blocksLayout(
    [
      { id: 'a', cents: 5 },
      { id: 'b', cents: 0 },
      { id: 'c', cents: -3 },
    ],
    W,
    H,
  );
  assert.deepEqual(
    some.map((r) => r.id),
    ['a'],
  );
  const many = blocksLayout(
    Array.from({ length: 40 }, (_, i) => ({ id: i, cents: 1 + (i % 3) })),
    W,
    H,
  );
  tiles(many);
  for (const r of many) assert.ok(Number.isFinite(r.x + r.y + r.w + r.h));
});

test('the layout is deterministic: the same parts give the same rectangles, ties in the order given', () => {
  assert.deepEqual(blocksLayout(demo, W, H), blocksLayout(demo, W, H));
  const ties = blocksLayout(
    ['a', 'b', 'c', 'd'].map((id) => ({ id, cents: 100 })),
    200,
    200,
  );
  assert.deepEqual(
    ties.map((r) => r.id),
    ['a', 'b', 'c', 'd'],
  );
  tiles(ties, 200, 200);
});

test('the mosaic: one tile per category; the lit one is marked, the others dimmed; hidden from assistive technology', () => {
  const parts: Parameters<typeof Blocks>[0]['parts'] = [
    { id: 'groceries' as const, label: 'Groceries', cents: 5000, count: 2 },
    { id: 'other' as const, label: 'Other', cents: 7000, count: 1 },
    { id: 'health' as const, label: 'Health', cents: 0, count: 0 },
  ];
  const render = (
    lit: ('other' | typeof SMALLER)[],
    p = parts,
    box: readonly [number, number] = BLOCKS.WIDE,
  ) =>
    renderToStaticMarkup(
      createElement(Blocks, {
        tiles: blocksTiles(p, ...box),
        parts: p,
        lit,
        share: () => '58%',
      }),
    );
  const html = render(['other']);
  assert.match(html, /^<div class="si-blocks" aria-hidden="true">/);
  const blocks = html.match(/<div class="si-block"[^>]*>/g) ?? [];
  assert.equal(blocks.length, 2); // nothing spent: no tile
  const other = blocks.filter((b) => /data-category="other"/.test(b));
  assert.equal(other.length, 1);
  assert.match(other[0], /data-on/);
  assert.doesNotMatch(other[0], /data-dim/);
  const groceries = blocks.find((b) => /data-category="groceries"/.test(b))!;
  assert.match(groceries, /data-dim/);
  assert.doesNotMatch(groceries, /data-on/);
  assert.match(other[0], /style="left:0\.000%;top:0\.000%;width:[\d.]+%;height:100\.000%"/);
  // The same count as the list row, in the same word.
  assert.match(html, /€70\.00<\/span><span class="si-block-sub">58% of spending · 1 movement</);
  assert.doesNotMatch(html, /payment/);
  assert.doesNotMatch(render([]), /data-on|data-dim/);
  assert.equal(render([]).match(/class="si-block"/g)?.length, 2);
  // No spending: no mosaic.
  assert.equal(render([], []), '');

  // The tile of the smaller categories: no category colour, "+N", its sum, lit as `smaller`.
  const many = [
    { id: 'home_utilities' as const, label: 'Home & utilities', cents: 90_000, count: 3 },
    { id: 'groceries' as const, label: 'Groceries', cents: 8000, count: 2 },
    { id: 'transport' as const, label: 'Transport', cents: 1200, count: 2 },
    { id: 'health' as const, label: 'Health', cents: 800, count: 1 },
  ];
  const grouped = render([SMALLER], many, BLOCKS.NARROW);
  const tile = (grouped.match(/<div class="si-block"[^>]*>/g) ?? []).filter((b) =>
    /data-group/.test(b),
  );
  assert.equal(tile.length, 1);
  assert.match(tile[0], /data-on/);
  assert.doesNotMatch(tile[0], /data-category/);
  assert.match(grouped, /<b>\+2<\/b><span>Smaller categories<\/span>/);
  assert.match(
    grouped,
    /€20\.00<\/span><span class="si-block-sub">58% of spending · 2 categories</,
  );
  assert.equal(grouped.match(/class="si-block"/g)?.length, 3);
});

test('a crumb with nothing to group is not drawn as a hairline: the rest fill the box', () => {
  // 14 units: 8px drawn and the 6px gap around a tile.
  const drawn = (rects: ReturnType<typeof blocksTiles>, w: number, h: number, total: number) => {
    tiles(rects, w, h); // what is drawn tiles the box exactly
    for (const r of rects) {
      assert.ok(Math.min(r.w, r.h) >= 14, `${w}x${h}: ${r.id} is ${r.w} x ${r.h}`);
      assert.ok(Math.abs(area(r) / (w * h) - r.cents / total) * 100 <= 3, `${w}x${h}: ${r.id}`);
    }
    return rects.map((r) => r.id);
  };
  for (const [w, h] of [BLOCKS.WIDE, BLOCKS.NARROW, [254, 200]] as const) {
    drawn(blocksTiles(named([100000, 150]), w, h), w, h, 100150);
    // Two big ones and a crumb: the two are always drawn.
    const two = drawn(blocksTiles(named([60000, 40000, 20]), w, h), w, h, 100020);
    assert.deepEqual(two.slice(0, 2), ['c0', 'c1']);
  }
  // On a phone the crumb has no tile at all; the big category is the whole box.
  assert.deepEqual(blocksTiles(named([100000, 150]), ...BLOCKS.NARROW), [
    { id: 'c0', cents: 100000, members: ['c0'], x: 0, y: 0, w: 320, h: 200 },
  ]);
  // A small category that still makes a real tile is drawn.
  assert.equal(blocksTiles(named([9000, 1000]), ...BLOCKS.NARROW).length, 2);
});

test('a share that rounds to 100 but is not the whole is ">99%", in the row, the tile and the focus block', () => {
  const noop = async () => {};
  const category = (id: 'home_utilities' | 'health', label: string, spentCents: number) => ({
    id,
    label,
    spentCents,
    count: 1,
    confirmedCents: spentCents,
    estimatedCents: 0,
  });
  const card = (cents: number[]) =>
    renderToStaticMarkup(
      createElement(SpendingCard, {
        insights: {
          summary: {
            range: { from: null, to: null },
            window: { returned: 2, oldestAt: '2026-08-04T06:00:00.000Z', mayBeTruncated: false },
            partial: false,
            spentCents: cents.reduce((a, b) => a + b, 0),
            incomeCents: 0,
            categories: [
              category('home_utilities', 'Home & utilities', cents[0]),
              ...(cents[1] ? [category('health', 'Health', cents[1])] : []),
            ],
            unresolved: { count: 0, totalCents: 0, groups: [] },
            pending: 0,
            decider: 'none',
          },
          rules: [],
          feedback: null,
          busy: false,
          setCategory: noop,
          acceptOffer: noop,
          dismiss: () => {},
          removeRule: noop,
          retry: noop,
        },
      }),
    );
  const crumb = card([99850, 150]);
  assert.match(crumb, /class="si-cat-share">&gt;99%</);
  assert.match(crumb, /class="si-block-sub">&gt;99% of spending/);
  assert.match(crumb, /class="si-cat-share">&lt;1%</);
  assert.doesNotMatch(crumb, />100%/);
  // The whole is 100%.
  assert.match(card([100000]), /class="si-cat-share">100%</);
});

test('the pin: a mouse click never pins; a finger, a pen or the keyboard toggle; a press elsewhere clears', () => {
  // A mouse: no pin, and a pin made otherwise is dropped.
  assert.equal(pinAfter(null, 'other', 'mouse'), null);
  assert.equal(pinAfter('other', 'other', 'mouse'), null);
  assert.equal(pinAfter('other', 'groceries', 'mouse'), null);
  for (const by of ['touch', 'pen', 'key']) {
    assert.equal(pinAfter(null, 'other', by), 'other');
    assert.equal(pinAfter('other', 'other', by), null); // the same one again
    assert.equal(pinAfter('other', 'groceries', by), 'groceries');
    assert.equal(pinAfter('other', null, by), null); // anywhere else in the card
    assert.equal(pinAfter(null, null, by), null);
  }
});
