'use client';
// SI7a: spend insights on Overview, on top of the insights API (SI5). Home only wires the hook
// below into the designer's two Overview slots: `insights` (the card) and `rowExtra` (the chip).
// The summary is `dashboard.insights`, so the card and the table always come from one bank read.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { genericKey } from '../../src/insights/normalize';
import {
  CATEGORY_IDS,
  allowedFor,
  categoryLabel,
  chipText,
  type CategoryId,
  type RowCategory,
} from '../../src/insights/taxonomy';
import type {
  PeriodEntry,
  PeriodSummary,
  SetCategoryResult,
  SpendingSummary,
} from '../../src/insights/summary';
import { formatDate, money, type ActivityRow, type AnyRecord } from '../../src/ui-helpers';
import { Icon } from './Icon';

type Rule = { merchantKey: string; category: CategoryId; createdAt: string };
// One line of feedback at a time, shown where the change was made: `at` is the first movement id
// of a row, or null for the card (review list, rules, retry).
type Feedback = { at: string | null } & (
  | {
      kind: 'offer';
      merchantKey: string;
      count: number;
      movementIds: string[];
      category: CategoryId;
    }
  | { kind: 'learned'; text: string; undoKey: string }
  | { kind: 'info' | 'error'; text: string }
);
// IT8-ui: the period fields are optional here: without `periods` (an older server, a fixture) the
// card has no period control and shows the summary as the whole window.
type Summary = SpendingSummary &
  Partial<
    Pick<
      PeriodSummary,
      'period' | 'periods' | 'unresolvedInPeriod' | 'today' | 'windowDays' | 'partialReason'
    >
  >;
export type Insights = {
  summary: Summary | null;
  rules: Rule[];
  feedback: Feedback | null;
  busy: boolean;
  setCategory(movementIds: string[], category: CategoryId, at: string | null): Promise<void>;
  acceptOffer(): Promise<void>;
  dismiss(): void;
  removeRule(merchantKey: string, at: string | null): Promise<void>;
  retry(): Promise<void>;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (p: number) => `${Math.round(p * 100)}%`;
// A key that is only channel words (CARD PAYMENT, TPV, RECIBO, ADEUDO SEPA…) names no merchant:
// say what its rule covers instead of showing the bank's word as if it were a shop. Not "card
// payments": a direct debit has such a key too.
const GENERIC_NAME = 'Payments with no merchant name';
const GENERIC_RULE = ' The rule labels every such payment.';
const merchantName = (key: string) => (genericKey(key) ? GENERIC_NAME : key);
const learned = (merchantKey: string, category: CategoryId, updated: number) =>
  `Learned: ${genericKey(merchantKey) ? `${GENERIC_NAME.toLowerCase()} are` : `${merchantKey} is`} ${categoryLabel(category)}.${genericKey(merchantKey) ? GENERIC_RULE : ''}${updated ? ` ${plural(updated, 'movement')} updated.` : ''}`;

// ── Blocks: the categories as a proportional mosaic, a squarified treemap (Bruls, Huizing and
// van Wijk). The rectangle of each part, in the units of a `width` x `height` box: areas follow
// the amounts, largest first, and the rectangles tile the box exactly. Laid out row by row along
// the shorter side of what is left; a part joins the row while that does not worsen the row's
// worst aspect ratio. For the layout only, a part is at least `floor` of the total, so a tiny
// category is still a tile that can be seen and pointed at; the amounts and percentages shown
// stay the real ones. No spending: no rectangle. ──
export function blocksLayout<T>(
  parts: { id: T; cents: number }[],
  width: number,
  height: number,
  floor = 0.012,
): { id: T; x: number; y: number; w: number; h: number }[] {
  const real = parts.filter((p) => p.cents > 0);
  const total = real.reduce((sum, p) => sum + p.cents, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const raised = real.map((p) => Math.max(p.cents, total * floor));
  const unit = (width * height) / raised.reduce((sum, v) => sum + v, 0);
  // Largest first; equal parts keep the order they came in (the sort is stable).
  const items = real
    .map((p, i) => ({ id: p.id, area: raised[i] * unit }))
    .sort((a, b) => b.area - a.area);
  // The worst aspect ratio of a row of these areas laid along a side of this length.
  const worst = (areas: number[], side: number) => {
    const sum = areas.reduce((a, b) => a + b, 0);
    return Math.max(
      (side * side * Math.max(...areas)) / (sum * sum),
      (sum * sum) / (side * side * Math.min(...areas)),
    );
  };
  const out: { id: T; x: number; y: number; w: number; h: number }[] = [];
  let x = 0,
    y = 0,
    w = width,
    h = height;
  for (let at = 0; at < items.length;) {
    const side = Math.min(w, h);
    let end = at + 1;
    const areas = () => items.slice(at, end).map((i) => i.area);
    while (end < items.length && worst([...areas(), items[end].area], side) <= worst(areas(), side))
      end++;
    const thick = areas().reduce((a, b) => a + b, 0) / side;
    const tall = w >= h; // a wide box: the row is a column at its left
    let along = 0;
    for (const item of items.slice(at, end)) {
      const length = item.area / thick;
      out.push(
        tall
          ? { id: item.id, x, y: y + along, w: thick, h: length }
          : { id: item.id, x: x + along, y, w: length, h: thick },
      );
      along += length;
    }
    if (tall) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    at = end;
  }
  return out;
}
// The mosaic is laid out for the box it is drawn in (measured; these two are the box before the
// first measure and the nominal desktop and phone boxes of the unit tests).
export const BLOCKS = { WIDE: [720, 232], NARROW: [320, 200] } as const;
export const SMALLER = 'smaller';
// A tile a finger can hit: 24px on its short side, plus the 6px gap around it.
const MIN_SIDE = 30,
  // 8px drawn, and the 6px gap around it.
  MIN_DRAWN = 14,
  GROUP_UP_TO = 0.08,
  LAST_RAISE = 0.029;
// The share of a square tile of that side in a box.
export const minShare = (width: number, height: number) => (MIN_SIDE * MIN_SIDE) / (width * height);
// The tiles of the mosaic. Areas follow the amounts: a category too small for a tile of its own
// is not inflated; the smallest categories are merged into ONE tile ("Smaller categories",
// `id: 'smaller'`) whose area is their sum. First those under the box's smallest share (two or
// more: one alone stays its own tile); then, while the layout still has a tile thinner than a
// finger, the next smallest category joins the group, as long as it is a small one (under
// `GROUP_UP_TO` of the spending: a tenth of the money is not a "smaller category"). The floor is
// only the last resort (a single small category, or a group that is itself tiny): it is raised
// once, for the smallest tile alone (never up to the next one: no two amounts get one area) and
// by under 3 points of the box.
// Last, a tile that would still be a hairline (under 8px drawn: `MIN_DRAWN` with its gap) is not
// drawn at all: the layout is done again without it and the rest fill the box.
// ponytail: so the mosaic can leave a category out (a crumb beside big ones, or a tiny group:
// [90000, 300, 250, 200] on a phone drops its "Smaller categories" tile), and a drawn tile can be
// between 8 and 24px, thinner than a finger. The list row carries every category; the constants
// are tuned on the demo data.
export function blocksTiles<T extends string>(
  parts: { id: T; cents: number }[],
  width: number,
  height: number,
): {
  id: T | typeof SMALLER;
  cents: number;
  members: T[];
  x: number;
  y: number;
  w: number;
  h: number;
}[] {
  // Smallest first; equal amounts in the order given, reversed, so the result is deterministic.
  const real = parts.filter((p) => p.cents > 0).reverse();
  real.sort((a, b) => a.cents - b.cents);
  const total = real.reduce((sum, p) => sum + p.cents, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const min = minShare(width, height);
  let grouped = real.filter((p) => p.cents / total < min).length;
  if (grouped < 2) grouped = 0;
  for (let floor = min, raised = false; ;) {
    const tiles: { id: T | typeof SMALLER; cents: number; members: T[] }[] = real
      .slice(grouped)
      .map((p) => ({ id: p.id, cents: p.cents, members: [p.id] }));
    if (grouped)
      tiles.push({
        id: SMALLER,
        cents: real.slice(0, grouped).reduce((sum, p) => sum + p.cents, 0),
        // As the list has them: largest first.
        members: real
          .slice(0, grouped)
          .reverse()
          .map((p) => p.id),
      });
    // Largest first for the layout, in the order given among equals.
    tiles.reverse();
    const rects = blocksLayout(tiles, width, height, floor);
    const thin = rects.some((r) => Math.min(r.w, r.h) < MIN_SIDE - 1e-6);
    const next = Math.max(2, grouped + 1);
    if (thin && next < real.length && real[next - 1].cents / total < GROUP_UP_TO) grouped = next;
    else if (thin && !raised) {
      raised = true;
      const shares = tiles.map((t) => t.cents / total).sort((a, b) => a - b);
      floor = Math.max(floor, Math.min(shares[0] + LAST_RAISE, shares[1] ?? 1));
    } else {
      // A crumb with nothing to group (one big category and a few cents): a tile under 8px is a
      // hairline, not a tile. It is not drawn (its list row carries it) and the rest fill the box.
      const hair = rects.filter((r) => Math.min(r.w, r.h) < MIN_DRAWN);
      if (hair.length && rects.length > 1) {
        const gone = tiles.find((t) => t.id === hair[hair.length - 1].id)!.members;
        return blocksTiles(
          parts.filter((p) => !gone.includes(p.id)),
          width,
          height,
        );
      }
      return rects.map((r) => ({ ...tiles.find((t) => t.id === r.id)!, ...r }));
    }
  }
}
const percent = (n: number, of: number) => `${((n / of) * 100).toFixed(3)}%`;

// Category icons, drawn like app/_components/Icon.tsx (24 px grid, stroke only), in a tile tinted
// with the colour of the nearest `data-category` (app/styles/spend-insights.css).
const CATEGORY_ICONS: Record<CategoryId, ReactNode> = {
  home_utilities: (
    <>
      <path d="M4 11l8-7 8 7v9H4Z" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  groceries: (
    <>
      <path d="M5 9h14l-1.5 9.3a2 2 0 0 1-2 1.7H8.5a2 2 0 0 1-2-1.7Z" />
      <path d="M9 9l3-5 3 5" />
    </>
  ),
  shopping: (
    <>
      <path d="M6 8h12l1 12H5Z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </>
  ),
  work: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18" />
    </>
  ),
  eating_out_leisure: (
    <>
      <path d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10" />
      <path d="M17 3c-2 2-3 4-3 7h3v11" />
    </>
  ),
  transfer_person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  transport: (
    <>
      <rect x="4" y="3" width="16" height="14" rx="3" />
      <path d="M4 11h16M8 21l1-3M16 21l-1-3" />
    </>
  ),
  health: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />,
  other: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17h.01" />
    </>
  ),
  savings_internal: <path d="M4 7h15m-5-5 5 5-5 5M20 17H5m5 5-5-5 5-5" />,
  income: <path d="M17 7 7 17M7 8v9h9" />,
};
function CategoryTile({ id, size }: { id: CategoryId; size: number }) {
  return (
    <span className="si-tile" aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {CATEGORY_ICONS[id]}
      </svg>
    </span>
  );
}

// What a tile shows is what fits whole in it, never a cut text: its name (on up to two lines),
// amount and small line; else name and amount; else the name; else the amount under the icon
// (a name too long for the tile); else the icon; else colour only.
// Text width cannot be known from the tile's size, so each tile is tried from the richest level
// down and measured. Run before paint (and when the box or the fonts change): no clipped text is
// ever shown. Without a `data-show` (server markup) a tile is its icon.
const SHOW = ['sub', 'amount', 'name', 'figure', 'icon', 'none'] as const;
function fitTiles(root: HTMLElement) {
  for (const tile of root.querySelectorAll<HTMLElement>('.si-block')) {
    const inner = tile.firstElementChild as HTMLElement;
    const name = inner.querySelector<HTMLElement>('.si-block-name > :last-child')!;
    for (const level of SHOW) {
      tile.dataset.show = level;
      if (level === 'none') break;
      const { clientWidth: w, clientHeight: h } = inner;
      // The large tile of the design: only from this size on.
      if (level === 'sub' && (w < 234 || h < 144)) continue;
      if (level === 'icon' && (w < 28 || h < 28)) continue;
      const lines = name.offsetHeight / parseFloat(getComputedStyle(name).lineHeight);
      // Nothing wider or taller than the tile, and no line wider than its own box (a text that
      // only reaches into the tile's padding is cut too).
      const whole = [inner, ...inner.children].every(
        (e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight,
      );
      if (whole && lines < 2.5) break;
    }
  }
}

// What can be highlighted: a category, or the mosaic's tile of the smaller ones.
type Marked = CategoryId | typeof SMALLER;
// The category of the tile or the row an element of the card belongs to. A tile is its drawn
// part: the gap around it is no tile.
function categoryAt(card: Element | null, el: Element | null): Marked | null {
  if (!card || !el || !card.contains(el)) return null;
  const tile = el.closest('.si-block-in')?.parentElement;
  if (tile) return (tile.dataset.category as CategoryId | undefined) ?? SMALLER;
  const row = el.closest('.si-category')?.parentElement;
  return (row?.dataset.category as CategoryId | undefined) ?? null;
}
// The pin after a press in the card, by what pressed. A mouse never pins (its highlight is where
// the pointer is, and ends with it); a finger, a pen or the keyboard toggle the category pressed,
// and a press anywhere else clears it.
export const pinAfter = <T,>(pinned: T | null, pressed: T | null, by: string): T | null =>
  by === 'mouse' ? null : pressed !== null && pressed !== pinned ? pressed : null;

// The mosaic is a second view of the category list, for a pointer (the card reads what is under
// it); the list buttons are the keyboard control and every figure of a tile is in its row, so the
// chart is hidden from assistive technology.
export function Blocks({
  tiles,
  parts,
  lit,
  share,
  boxRef,
}: {
  tiles: ReturnType<typeof blocksTiles<CategoryId>>;
  parts: { id: CategoryId; label: string; cents: number; count: number }[];
  // The tiles that are highlighted (the others are dimmed); empty: none is.
  lit: (CategoryId | typeof SMALLER)[];
  share(cents: number): string;
  boxRef?: (el: HTMLDivElement | null) => void | (() => void);
}) {
  const root = useRef<HTMLDivElement | null>(null);
  // One ref for the life of the element: an inline one would be detached and attached again on
  // every render, and `boxRef` (the card's ResizeObserver) with it.
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      return boxRef?.(el);
    },
    [boxRef],
  );
  const box = tiles.map((t) => `${t.id} ${t.w.toFixed(1)} ${t.h.toFixed(1)}`).join();
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    fitTiles(el);
    // A web font that arrives later changes the widths.
    let live = true;
    window.document.fonts?.ready.then(() => live && fitTiles(el));
    return () => {
      live = false;
    };
  }, [box]);
  if (!tiles.length) return null;
  const width = tiles.reduce((max, t) => Math.max(max, t.x + t.w), 0),
    height = tiles.reduce((max, t) => Math.max(max, t.y + t.h), 0);
  return (
    <div className="si-blocks" aria-hidden="true" ref={setRoot}>
      {tiles.map((t) => {
        const group = t.id === SMALLER;
        const part = parts.find((p) => p.id === t.id);
        return (
          <div
            key={t.id}
            className="si-block"
            data-category={group ? undefined : t.id}
            data-group={group || undefined}
            data-on={lit.includes(t.id) || undefined}
            data-dim={(lit.length > 0 && !lit.includes(t.id)) || undefined}
            style={{
              left: percent(t.x, width),
              top: percent(t.y, height),
              width: percent(t.w, width),
              height: percent(t.h, height),
            }}
          >
            <div className="si-block-in">
              <span className="si-block-name">
                {t.id === SMALLER ? (
                  <b>{`+${t.members.length}`}</b>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {CATEGORY_ICONS[t.id]}
                  </svg>
                )}
                <span>{part?.label ?? 'Smaller categories'}</span>
              </span>
              <span className="si-block-amount">{money(t.cents)}</span>
              <span className="si-block-sub">{`${share(t.cents)} of spending · ${part ? plural(part.count, 'movement') : `${t.members.length} categories`}`}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function useSpendInsights(
  api: (path: string, body?: unknown, method?: string) => Promise<any>,
  personId: string | null,
  dashboard: AnyRecord | null,
  refresh: () => Promise<void>,
): Insights {
  const summary: Summary | null = (personId && dashboard?.insights) || null;
  const [rules, setRules] = useState<Rule[]>([]),
    [feedback, setFeedback] = useState<Feedback | null>(null),
    [busy, setBusy] = useState(false);
  // The person a change was started for, and one change at a time (a ref: no stale closure).
  const person = useRef(personId),
    running = useRef(false);
  person.current = personId;

  // The rules follow every dashboard read (after a change here or in the chat, and on the page's
  // refresh). No insights (operator, persona switch, older server): nothing is asked or kept.
  useEffect(() => {
    if (!summary) {
      setRules([]);
      setFeedback(null);
      return;
    }
    let live = true;
    api('insights/rules')
      .then((r) => live && setRules(r.rules))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [personId, dashboard]);

  // REQ-SI7-11: while movements are being classified, read again every 3 s (at most 12 times),
  // then the page's 20 s refresh takes over. IT6 (A14): 12, not 10: a decider that hangs settles
  // its row at about 32 s, after the tenth read.
  const classifying = (summary?.pending ?? 0) > 0;
  // One read at a time: a bank slower than 3 s must not get a queue of dashboard reads. A ref, so
  // a re-run of the effect (another person) cannot start a second read beside one on its way.
  const reading = useRef(false);
  useEffect(() => {
    if (!classifying) return;
    let left = 12;
    const timer = setInterval(() => {
      if (left-- <= 0) return clearInterval(timer);
      if (reading.current || window.document.visibilityState !== 'visible') return;
      reading.current = true;
      refresh()
        .catch(() => {})
        .finally(() => (reading.current = false));
    }, 3000);
    return () => clearInterval(timer);
  }, [classifying, personId]);

  // Every change: one request, its feedback (an error is shown where the change was made, and
  // nothing is shown as changed), then one dashboard read.
  async function act(at: string | null, work: () => Promise<Feedback | null>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let next: Feedback | null;
    try {
      next = await work();
    } catch (e) {
      next = { kind: 'error', at, text: (e as Error).message };
    }
    if (person.current === personId) {
      setFeedback(next);
      await refresh().catch(() => {});
    }
    running.current = false;
    setBusy(false);
  }

  return {
    summary,
    rules,
    feedback,
    busy,
    setCategory: (movementIds, category, at) =>
      act(at, async () => {
        const r: SetCategoryResult = await api('insights/categories', { movementIds, category });
        // REQ-SI7-6: the offer when the merchant has other movements. IT6 (A8): a whole review
        // group set from the card (`at` null) usually leaves none, so it could never teach: it
        // then offers the rule for future movements only. Whether a rule is possible is the
        // answer's: `similar` has an entry (its count can be 0) per merchant key a rule can
        // decide, and none for an empty key or a movement decided by structure (a transfer).
        const similar = r.similar.find((s) => s.count > 0) ?? (at === null ? r.similar[0] : null);
        if (similar)
          return {
            kind: 'offer',
            at,
            merchantKey: similar.merchantKey,
            count: similar.count,
            movementIds,
            category,
          };
        // No rule possible for this group: say what was done and what was not (a row's chip shows
        // its own change).
        return at === null
          ? {
              kind: 'info',
              at,
              text: `${plural(r.updated, 'movement')} set to ${categoryLabel(category)}. Only these: no rule was made for future ones.`,
            }
          : null;
      }),
    acceptOffer: async () => {
      if (feedback?.kind !== 'offer') return;
      const { at, merchantKey, count, movementIds, category } = feedback;
      await act(at, async () => {
        const r: SetCategoryResult = await api('insights/categories', {
          movementIds,
          category,
          applyToSimilar: true,
        });
        // IT6: the future-only offer was made without proof from `similar` movements; the rule
        // exists only if the answer says so.
        if (count === 0 && !r.rules.includes(merchantKey))
          return {
            kind: 'info',
            at,
            text: 'Only these: no rule can be made for this kind of movement.',
          };
        return {
          kind: 'learned',
          at,
          text: learned(merchantKey, category, r.updated),
          undoKey: merchantKey,
        };
      });
    },
    dismiss: () => setFeedback(null),
    removeRule: (merchantKey, at) =>
      act(at, async () => {
        const r = await api(
          `insights/rules/${encodeURIComponent(merchantKey)}`,
          undefined,
          'DELETE',
        );
        return {
          kind: 'info',
          at,
          text: r.removed
            ? `Rule for ${merchantName(merchantKey)} removed. ${plural(r.reclassified, 'movement')} classified again.`
            : `There was no rule for ${merchantName(merchantKey)}.`,
        };
      }),
    retry: () =>
      act(null, async () => {
        const r = await api('insights/reclassify', {});
        return {
          kind: 'info',
          at: null,
          // IT4: nothing queued is the one-minute cool-down of a retry, not a retry.
          text: r.queued
            ? `Trying again for ${plural(r.queued, 'movement')}.`
            : 'Already retried a moment ago. Try again in a minute.',
        };
      }),
  };
}

// The "why" of a category, from its stored reason (contracts.md §1 "Reasons").
export function whyText(c: RowCategory): string {
  const [kind, ...rest] = c.reason.split(':');
  const detail = rest.join(':');
  if (
    (kind === 'model' || kind === 'below_threshold') &&
    c.confidence != null &&
    c.threshold != null
  ) {
    const bar =
      kind === 'model'
        ? `above the ${pct(c.threshold)} bar`
        : c.confidence < c.threshold
          ? `below the ${pct(c.threshold)} bar`
          : 'but its answer does not fit this movement';
    const list = c.candidates
      .filter((x) => x.p != null)
      .map((x) => `${categoryLabel(x.category)} ${pct(x.p!)}`)
      .join(', ');
    return `The model was ${pct(c.confidence)} sure, ${bar}${list ? `: ${list}` : ''}`;
  }
  const texts: Record<string, string> = {
    own_account: 'Between your own accounts',
    person_transfer: 'Transfer to a person',
    opening_balance: 'Opening entry of the account',
    user: 'Set by you',
    user_rule: `Your rule for ${detail}`,
    keyword: `Matched ${detail}`,
    refund: `Refund from ${detail}`,
    tax_refund: 'Tax refund',
    credit: 'Money received',
    model: 'Decided by the model',
    below_threshold: 'The model was not sure enough',
    decider_unavailable: 'The classifier did not answer',
    // IT4: the customer's daily budget of automatic classifications is used up.
    decider_budget: 'Daily automatic classification limit reached; it will be classified later',
    // A23: in the customer's words (the stored reason is `no_decider`).
    no_decider: "We could not tell from the bank's text. Pick a category.",
    no_merchant: 'The description names no merchant',
    // IG1: a model answer that is the category the bank's own text names is not shown.
    named_in_text: "The bank's text names a category itself, so we did not guess. Pick a category.",
    pending: 'Being classified',
  };
  return texts[kind] ?? 'No reason recorded';
}

// REQ-SI7-5: the categories the sign rule allows. A merged "Between your accounts" row posts both
// legs, so it only offers what a debit and a credit may both hold.
const BOTH_SIGNS = CATEGORY_IDS.filter((id) => allowedFor('debit', id) && allowedFor('credit', id));
export function categoryOptions(row: ActivityRow): CategoryId[] {
  if ((row.category?.movementIds.length ?? 0) > 1) return BOTH_SIGNS;
  const direction = row.amountCents < 0 ? 'debit' : 'credit';
  return CATEGORY_IDS.filter((id) => allowedFor(direction, id));
}
// The names are `label` attributes, not text: a row's text (which the e2e suites and screen
// readers' row summaries read) must not hold every category name. Chrome's accessibility tree
// takes an option's name from its text only, so the name is also its `aria-label`.
const options = (ids: readonly CategoryId[]) =>
  ids.map((id) => (
    <option key={id} value={id} label={categoryLabel(id)} aria-label={categoryLabel(id)} />
  ));

// The offer, the learning notice or an error, at one place (`at`). When the control that was used
// is gone (an answered offer, a resolved group), the keyboard continues from this line.
function FeedbackLine({ insights, at }: { insights: Insights; at: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const f = insights.feedback?.at === at ? insights.feedback : null;
  useEffect(() => {
    if (f && window.document.activeElement === window.document.body)
      ref.current?.focus({ preventScroll: true });
  }, [f, insights.busy]);
  if (!f) return null;
  // The offer names what the rule would cover: the merchant, or every payment with no merchant.
  const generic = f.kind === 'offer' && genericKey(f.merchantKey);
  const covered = (n: number) =>
    f.kind !== 'offer'
      ? ''
      : generic
        ? `payment${n === 1 ? '' : 's'} with no merchant name`
        : `${f.merchantKey} movement${n === 1 ? '' : 's'}`;
  const close = (
    <button type="button" className="si-dismiss" aria-label="Dismiss" onClick={insights.dismiss}>
      <Icon name="close" size={12} />
    </button>
  );
  return (
    <div className={`si-feedback ${f.kind}`} ref={ref} tabIndex={-1}>
      {f.kind === 'offer' ? (
        <>
          <p role="status">
            {f.count
              ? `Apply ${categoryLabel(f.category)} to the ${f.count} other ${covered(f.count)} and to future ones?`
              : `Remember this for future ${covered(2)}?`}
            {generic && GENERIC_RULE}
          </p>
          <span className="si-actions">
            <button
              type="button"
              className="si-button primary"
              data-testid="similar-offer-yes"
              onClick={insights.acceptOffer}
            >
              {f.count ? 'Yes, apply to all' : 'Yes, remember it'}
            </button>
            <button
              type="button"
              className="si-button"
              data-testid="similar-offer-no"
              onClick={insights.dismiss}
            >
              {f.count ? 'No, only this one' : 'No, only these'}
            </button>
          </span>
        </>
      ) : f.kind === 'learned' ? (
        <div role="status" data-testid="insights-notice" className="si-learned">
          {f.text}
          <span className="si-actions">
            <button
              type="button"
              className="si-button"
              data-testid="insights-undo"
              onClick={() => insights.removeRule(f.undoKey, at)}
            >
              Undo
            </button>
            {close}
          </span>
        </div>
      ) : (
        <>
          <p role={f.kind === 'error' ? 'alert' : 'status'}>{f.text}</p>
          {close}
        </>
      )}
    </div>
  );
}

function UnresolvedGroups({
  insights,
  onAsk,
}: {
  insights: Insights;
  onAsk?: (movementId: string) => void;
}) {
  const u = insights.summary!.unresolved;
  const group = (g: (typeof u.groups)[number]) => {
    // A group with no merchant key is one movement, named by the bank's own text (A23: a
    // bank may send none).
    const generic = genericKey(g.merchantKey);
    const name = generic ? GENERIC_NAME : g.merchantKey || g.title || '(no description)';
    const set = (category: CategoryId) => insights.setCategory(g.movementIds, category, null);
    return (
      <li key={g.movementIds[0]} data-testid="unresolved-group" data-merchant={g.merchantKey}>
        <span className="si-group-head">
          <strong title={name}>{name}</strong>
          {/* In words, not only by its sign: this group is money that came back. */}
          {g.direction === 'credit' && <span className="si-refund">Refund</span>}
        </span>{' '}
        <span className="si-sub">
          {`${plural(g.count, 'movement')} · ${money(g.totalCents)}`}
          {generic && ` · the bank only says "${g.merchantKey}"`}
        </span>
        {/* A18: the suggestions on their own line; the select line is the card's last, so the
            selects of a row of cards line up. */}
        {g.candidates.length > 0 && (
          <span className="si-suggest">
            {g.candidates.map((c) => (
              <button
                type="button"
                className="si-candidate"
                key={c.category}
                data-testid="unresolved-candidate"
                data-category={c.category}
                onClick={() => set(c.category)}
              >
                {/* The text first: the tile is put before it by the stylesheet. */}
                {`${categoryLabel(c.category)}${c.p == null ? '' : ` ${pct(c.p)}`}`}
                <CategoryTile id={c.category} size={12} />
              </button>
            ))}
          </span>
        )}
        <span className="si-group-foot">
          {/* ponytail: this offers what both signs allow; "Transfers to people" and
                    "Income" are on each row's own chip. */}
          <span className="si-group-select">
            <select
              aria-label={`Category for ${name}`}
              value=""
              onChange={(e) => set(e.target.value as CategoryId)}
            >
              <option
                value=""
                disabled
                label="Choose a category…"
                aria-label="Choose a category…"
              />
              {options(BOTH_SIGNS)}
            </select>
            <Icon name="chevron" size={12} />
          </span>
          {/* SI7b: the assistant helps with the group's first movement, then offers the
                  others of the merchant. */}
          {onAsk && (
            <span className="si-unsure">
              <Icon name="sparkle" size={13} />
              <span className="si-unsure-q">Not sure? </span>
              <button
                type="button"
                className="si-resolve"
                aria-label={`Resolve ${name} in chat`}
                onClick={() => onAsk(g.movementIds[0])}
              >
                Resolve in chat
              </button>
            </span>
          )}
        </span>
      </li>
    );
  };
  return (
    <>
      <h3>
        Other — to review{' '}
        <span className="si-count">{`(${plural(u.count, 'movement')}, ${money(u.totalCents)})`}</span>
      </h3>
      {/* Every group of the summary is listed (A3, a limit of five, is not done: the acceptance
          suite reads each group from the page). */}
      <ul className="si-groups">{u.groups.map(group)}</ul>
    </>
  );
}

function RulesList({ insights }: { insights: Insights }) {
  return (
    <>
      <h3>Your rules</h3>
      <ul className="si-rules">
        {insights.rules.map((r) => {
          const name = merchantName(r.merchantKey);
          return (
            <li key={r.merchantKey} data-testid="rule-item" data-merchant={r.merchantKey}>
              <span className="si-rule-text" title={`${name} → ${categoryLabel(r.category)}`}>
                <strong>{name}</strong>
                <span aria-hidden="true"> → </span>
                <span className="sr-only">is </span>
                {categoryLabel(r.category)}
              </span>
              <button
                type="button"
                className="si-rule-remove"
                data-testid="rule-remove"
                aria-label={`Remove the rule for ${name}`}
                title="Remove this rule"
                onClick={() => insights.removeRule(r.merchantKey, null)}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── IT8c-ui: the period dropdown. Days are 'YYYY-MM-DD' strings and all the arithmetic is in UTC,
// so the browser's time zone never moves a day. A period is what the server takes: `all`,
// `current`, a month 'YYYY-MM', a year 'YYYY' or a day range 'YYYY-MM-DD..YYYY-MM-DD'. ──
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (month: string, n: number) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1))
    .toISOString()
    .slice(0, 7);
// The Monday-to-Sunday week of a day, as a range.
export function weekOf(day: string): string {
  const monday = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
  return `${monday}..${addDays(monday, 6)}`;
}
// The quick choices, with the value each one sends.
export function periodPresets(today: string): { id: string; label: string }[] {
  const year = Number(today.slice(0, 4));
  return [
    { id: weekOf(today), label: 'This week' },
    { id: weekOf(addDays(today, -7)), label: 'Last week' },
    { id: 'current', label: 'This month' },
    { id: addMonths(today.slice(0, 7), -1), label: 'Last month' },
    { id: String(year), label: 'This year' },
    { id: String(year - 1), label: 'Last year' },
    { id: 'all', label: 'All movements' },
  ];
}
const dayText = (day: string, year = true) =>
  `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}${year ? ` ${day.slice(0, 4)}` : ''}`;
const monthText = (month: string) =>
  `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
// "7 Sep – 13 Sep 2026": the year once when both days share it; one day is just that day.
export function rangeText(from: string, to: string): string {
  if (from === to) return dayText(from);
  return `${dayText(from, from.slice(0, 4) !== to.slice(0, 4))} – ${dayText(to)}`;
}
// The name of an applied period: "This month", "Last week"… when it is one of the quick choices
// (`relative`), else "Sep 2026", "2025" or the days of the range.
export function periodLabel(period: string, today: string, relative = true): string {
  if (period === 'all') return 'All movements';
  const quick =
    relative &&
    periodPresets(today).find((p) => (p.id === 'current' ? today.slice(0, 7) : p.id) === period);
  if (quick) return quick.label;
  const [from, to] = period.split('..');
  return to ? rangeText(from, to) : period.length === 4 ? period : monthText(period);
}
// A month can be chosen from the month of the bank's oldest movement to the current one.
export const monthEnabled = (month: string, windowFrom: string | null, today: string) =>
  month >= (windowFrom ?? today).slice(0, 7) && month <= today.slice(0, 7);
// A period that ends before the bank's oldest movement has nothing to show: its quick choice is
// disabled, like a month cell. Unknown history (no movement): nothing is ruled out.
export function beforeHistory(period: string, windowFrom: string | null): boolean {
  if (!windowFrom || period === 'all' || period === 'current') return false;
  const to = period.split('..')[1];
  return to ? to < windowFrom : period < windowFrom.slice(0, period.length);
}
// The period before one of the same kind (month, year, Monday-to-Sunday week), when the bank's
// history reaches it; none for another range and for `all`.
export function previousPeriod(period: string, windowFrom: string | null): string | null {
  if (!windowFrom) return null;
  const [from, to] = period.split('..');
  if (to) {
    const week = weekOf(addDays(from, -7));
    return period === weekOf(from) && week.split('..')[1] >= windowFrom ? week : null;
  }
  if (/^\d{4}$/.test(period))
    return String(Number(period) - 1) >= windowFrom.slice(0, 4) ? String(Number(period) - 1) : null;
  if (/^\d{4}-\d{2}$/.test(period))
    return addMonths(period, -1) >= windowFrom.slice(0, 7) ? addMonths(period, -1) : null;
  return null;
}
// The custom range: a day typed by hand is not held by the input's `min` / `max`, so both days
// are checked here: none before the bank's oldest movement (an empty card), none after the Sunday
// of the current week (the end of "This week"), and From not after To. The hint to show, or null
// when the days fit.
export function rangeHint(
  from: string,
  to: string,
  windowFrom: string | null,
  today: string,
): string | null {
  const last = weekOf(today).split('..')[1];
  const days = [from, to].filter(Boolean);
  if (windowFrom && days.some((d) => d < windowFrom))
    return `Choose dates from ${dayText(windowFrom)}.`;
  if (days.some((d) => d > last)) return `Choose dates up to ${dayText(last)}.`;
  // A24d: Apply is disabled for a reversed range; say why.
  if (from && to && from > to) return 'From must be on or before To.';
  return null;
}

// The opened dropdown: quick choices, any month of any year the bank's history reaches, and a
// range of days. Mounted only while open, so its year and dates start from the applied period.
export function PeriodMenu({
  applied,
  today,
  windowFrom,
  periods,
  onPick,
}: {
  applied: string;
  today: string;
  windowFrom: string | null;
  periods: PeriodEntry[];
  onPick(period: string): void;
}) {
  const thisYear = Number(today.slice(0, 4)),
    firstYear = Number((windowFrom ?? today).slice(0, 4));
  const [appliedFrom, appliedTo] = applied.split('..');
  const [year, setYear] = useState(
    Math.min(thisYear, Math.max(firstYear, Number(applied.slice(0, 4)) || thisYear)),
  );
  const [from, setFrom] = useState(appliedTo ? appliedFrom : ''),
    [to, setTo] = useState(appliedTo ?? '');
  const withMovements = new Set(periods.filter((p) => p.count > 0).map((p) => p.id));
  const lastDay = weekOf(today).split('..')[1],
    hint = rangeHint(from, to, windowFrom, today);
  // Arrow keys move between the options of a group (the quick choices are two columns, the months
  // four), past the disabled ones; Tab is unchanged.
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = (e.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-testid="spending-period-option"]',
    );
    const group = at?.parentElement;
    if (!at || !group) return;
    const cols = group.classList.contains('si-period-months') ? 4 : 2;
    const step = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols } as Record<string, number>
    )[e.key];
    if (!step) return;
    e.preventDefault();
    const all = [...group.querySelectorAll('button')];
    // Past the disabled ones, to the next enabled option that way. "All movements" is alone on
    // the last line of the quick choices: Down ends on it, from either column, when nothing
    // enabled is left below.
    const last = all.length - 1;
    for (let i = all.indexOf(at) + step; ; i += step) {
      if (cols === 2 && step === cols && i > last && at !== all[last]) i = last;
      if (!all[i]) return;
      if (!all[i].disabled) return all[i].focus();
      if (i === last) return;
    }
  };
  const option = (id: string, label: ReactNode, month = false) => {
    // `current` is the month of today; a month cell is its own id.
    const value = id === 'current' ? today.slice(0, 7) : id;
    const pressed = value === applied;
    return (
      <button
        type="button"
        key={id}
        data-testid="spending-period-option"
        data-period={id}
        aria-pressed={pressed}
        aria-label={month ? monthText(id) : undefined}
        disabled={month ? !monthEnabled(id, windowFrom, today) : beforeHistory(id, windowFrom)}
        onClick={() => onPick(id)}
      >
        {label}
        {month
          ? withMovements.has(id) && <i aria-hidden="true" />
          : pressed && <Icon name="check" size={13} />}
      </button>
    );
  };
  return (
    <div
      className="si-period-menu"
      data-testid="spending-period-menu"
      role="dialog"
      aria-label="Choose a period"
      // Focusable by a press, not by Tab: a press on a disabled option (or on plain text) puts the
      // focus here, inside the block, so the menu stays open instead of losing it to the page.
      tabIndex={-1}
      onKeyDown={arrows}
    >
      <section>
        <h3>Quick</h3>
        <div className="si-period-quick">
          {periodPresets(today).map((p) => option(p.id, p.label))}
        </div>
      </section>
      <section>
        <div className="si-period-year">
          <h3>Month</h3>
          <button
            type="button"
            aria-label="Previous year"
            disabled={year <= firstYear}
            onClick={() => setYear(year - 1)}
          >
            <Icon name="chevron" size={14} />
          </button>
          <span aria-live="polite">{year}</span>
          <button
            type="button"
            aria-label="Next year"
            disabled={year >= thisYear}
            onClick={() => setYear(year + 1)}
          >
            <Icon name="chevron" size={14} />
          </button>
        </div>
        <div className="si-period-months">
          {MONTHS.map((name, i) => option(`${year}-${String(i + 1).padStart(2, '0')}`, name, true))}
        </div>
      </section>
      <section>
        <h3>Custom range</h3>
        <div className="si-period-custom">
          <label>
            From
            <input
              type="date"
              data-testid="spending-period-from"
              value={from}
              min={windowFrom ?? undefined}
              max={lastDay}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              data-testid="spending-period-to"
              value={to}
              min={windowFrom ?? undefined}
              max={lastDay}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="si-button primary"
            data-testid="spending-period-apply"
            disabled={!from || !to || from > to || !!hint}
            onClick={() => onPick(`${from}..${to}`)}
          >
            Apply
          </button>
          {hint && (
            <p className="si-period-hint" role="status">
              {hint}
            </p>
          )}
        </div>
      </section>
      {windowFrom && (
        <p className="si-period-foot">{`The bank's history starts on ${dayText(windowFrom)}.`}</p>
      )}
    </div>
  );
}

// The `insights` slot of Overview: the total, the mosaic, the category list, the review panel (what is left
// to sort, and the customer's rules) and the window note.
export function SpendingCard({
  insights,
  period,
  onPeriod,
  onAsk,
  onAskSpending,
}: {
  insights: Insights;
  // IT8-ui: the period the customer chose ('current', 'YYYY-MM' or 'all') and how to change it.
  // The figures are those of `summary.period`; the two differ only while the new period loads.
  period?: string;
  onPeriod?: (id: string) => void;
  // SI7b: "Resolve in chat" on a review group opens the chat with that movement attached.
  onAsk?: (movementId: string) => void;
  // A5: the header action opens the Assistant and asks where the money went.
  onAskSpending?: () => void;
}) {
  const s = insights.summary;
  // "All movements are classified." is only said after a "Classifying…" line was shown.
  const wasClassifying = useRef(false);
  // A highlight never outlives what made it. Three sources, in this order:
  // - `pointed`: the tile or row under the mouse. It is not kept by enter / leave pairs (a leave
  //   is never sent when the element is re-rendered, moved or covered under a resting pointer):
  //   it is read from the pointer's place on every move, and checked again whenever what is
  //   under it can have changed (a render, a scroll); gone when the pointer leaves the card or
  //   the window.
  // - `focused`: the row that has the keyboard's focus.
  // - `pinned`: a tap (finger, pen) or Enter / Space on a row. Never a mouse click.
  const [pinned, setPinned] = useState<Marked | null>(null),
    [pointed, setPointed] = useState<Marked | null>(null),
    [focused, setFocused] = useState<CategoryId | null>(null);
  const cardEl = useRef<HTMLElement>(null),
    mouse = useRef<[number, number] | null>(null),
    pressedBy = useRef('mouse');
  // A recheck only ends a highlight (when its tile or row is no longer under the pointer); one
  // only starts when the mouse moves. So a period chosen in the menu, which closes over a tile,
  // shows the period's total, not the tile the pointer happens to rest on.
  const recheck = useCallback(() => {
    const at = mouse.current;
    const now = at
      ? categoryAt(cardEl.current, window.document.elementFromPoint(at[0], at[1]))
      : null;
    setPointed((was) => (was === now ? was : null));
  }, []);
  // After every render (a refresh, another layout, the period menu opening over a tile).
  useEffect(recheck);
  useEffect(() => {
    const gone = () => {
      mouse.current = null;
      setPointed(null);
    };
    // Capture: the page scrolls inside its shell, and that scroll does not bubble.
    window.addEventListener('scroll', recheck, true);
    window.addEventListener('blur', gone);
    return () => {
      window.removeEventListener('scroll', recheck, true);
      window.removeEventListener('blur', gone);
    };
  }, [recheck]);
  // The mosaic is laid out for its own box: measured when it mounts (before paint) and whenever
  // it is resized. Until then, the nominal wide box.
  const [box, setBox] = useState<readonly [number, number]>(BLOCKS.WIDE);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () =>
      setBox((was) =>
        was[0] === el.clientWidth && was[1] === el.clientHeight
          ? was
          : [el.clientWidth, el.clientHeight],
      );
    measure();
    // In step with the resize: rendered (and the labels fitted) before the frame is painted, so
    // the old labels are never shown in the new box.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // IT8c-ui: the period dropdown. It closes on Escape (focus back on its button), on a press
  // outside it and after a choice; opening it moves the focus inside.
  const [menu, setMenu] = useState(false);
  const periodBlock = useRef<HTMLDivElement>(null),
    periodTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const inside = (q: string) =>
      periodBlock.current?.querySelector<HTMLElement>(`.si-period-menu ${q}`);
    (inside('[aria-pressed="true"]:not(:disabled)') ?? inside('button:not(:disabled)'))?.focus();
    const outside = (e: PointerEvent) =>
      !periodBlock.current?.contains(e.target as Node) && setMenu(false);
    window.document.addEventListener('pointerdown', outside);
    return () => window.document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const closeMenu = () => {
    setMenu(false);
    periodTrigger.current?.focus();
  };
  // A pin does not outlive its period (the one asked for and the one shown): a category that
  // comes back later is not still highlighted and the focus block says "Spent".
  useEffect(() => setPinned(null), [period, s?.period]);
  if (!s) return null;
  if (s.pending > 0) wasClassifying.current = true;
  const unanswered = s.unresolved.groups
    .filter((g) => g.reason === 'decider_unavailable')
    .reduce((sum, g) => sum + g.count, 0);
  const w = s.window,
    u = s.unresolved;
  // A7: payments in review count under `other` (contracts.md 2.7) as part of its estimate. They
  // are said apart in that row's wording ("€X estimated · N to review"), never twice; the mosaic
  // has one tile for the whole of Other. A refund in review is in no spending total, so it is
  // not part of this amount.
  const other = s.categories.find((c) => c.id === 'other');
  // IT8-ui: of the period shown (`unresolvedInPeriod`); the review panel stays whole-window.
  const toSort = Math.max(
    0,
    Math.min(
      other?.estimatedCents ?? 0,
      s.unresolvedInPeriod?.debitCents ??
        u.groups.reduce((sum, g) => sum + (g.direction === 'credit' ? 0 : g.totalCents), 0),
    ),
  );
  const toReview = s.unresolvedInPeriod?.count ?? u.count;
  // IT8c-ui: the figures are those of the applied period (`s.period`). The button, the pressed
  // option and the caption follow the period that was SENT (`period`, the page's state), since a
  // range is echoed as given and `current` as its month: nothing is matched against `periods`.
  // The two differ only while a read is on its way. No control without `periods` and `today`
  // (older server, fixtures): the summary is then shown as the whole window, as before.
  const applied = s.periods?.length && s.today && s.period ? s.period : null;
  const today = s.today ?? '',
    windowFrom = s.windowDays?.from ?? null;
  const selected = !applied
    ? null
    : !period
      ? applied
      : period === 'current'
        ? today.slice(0, 7)
        : period === 'last' // DS2: the default, until the page holds the month the server named
          ? addMonths(today.slice(0, 7), -1)
          : period;
  const loading = selected !== applied;
  // `all` never has a reason of its own: its entry in `periods` says whether the window is cut.
  const reason = applied && applied !== 'all' ? s.partialReason : undefined;
  const previous = applied ? previousPeriod(applied, windowFrom) : null;
  const empty = s.categories.length === 0 || (!!applied && s.spentCents <= 0);
  const sinceAll = `${w.oldestAt ? `Since ${formatDate(w.oldestAt, false)} · ` : ''}${plural(w.returned, 'movement')}`;
  // The caption: a month and a year with their movements (from `periods`, the bank window's own
  // count); a range of days only as its dates, since the answer has no count of its movements.
  const counted = (prefix: string) =>
    plural(
      (s.periods ?? []).reduce((sum, p) => sum + (p.id.startsWith(prefix) ? p.count : 0), 0),
      'movement',
    );
  // A range of days has no movement count in the answer: its caption counts the movements that
  // make its spending (the categories' counts; income is not among them), once they are its own.
  // A9: "movements", the word of the focus block for the same count.
  const paid = loading ? 0 : s.categories.reduce((sum, c) => sum + c.count, 0);
  // The reason is the applied period's: it is said once the selected period is the one shown.
  const caption = !selected
    ? ''
    : selected === 'all'
      ? `${sinceAll}${s.periods?.find((p) => p.id === 'all')?.partialReason === 'window' ? ' · older movements are not included' : ''}`
      : `${periodLabel(selected, today, false)}${selected.includes('..') ? (paid > 0 ? ` · ${plural(paid, 'movement')}` : '') : ` · ${counted(selected)}`}${
          loading
            ? ''
            : reason === 'in_progress'
              ? ' · in progress'
              : reason === 'window' && windowFrom
                ? ` · the bank's history starts on ${dayText(windowFrom)}`
                : ''
        }`;
  const parts = s.categories.map((c) => ({
    id: c.id,
    label: c.label,
    cents: c.spentCents,
    count: c.count,
  }));
  const movements = s.categories.reduce((sum, c) => sum + c.count, 0);
  // What is pointed at (else focused, else pinned): a category, or the tile of the smaller ones. Then the rows
  // of its categories are highlighted and the others dimmed; a grouped row lights the group's tile.
  const tiles = blocksTiles(parts, box[0], box[1]);
  const smaller = tiles.find((t) => t.id === SMALLER);
  const focus = pointed ?? focused ?? pinned;
  const active = s.categories.find((c) => c.id === focus) ?? null;
  const group = focus === SMALLER ? smaller : undefined;
  const on: CategoryId[] = group ? group.members : active ? [active.id] : [];
  const lit: (CategoryId | typeof SMALLER)[] = group
    ? [SMALLER]
    : active
      ? [smaller?.members.includes(active.id) ? SMALLER : active.id]
      : [];
  // Only from the summary's own totals, for the movements shown, and said to be an estimate; not
  // when older movements are missing or no income came in. IT8c-ui: for the period shown; not when
  // the bank's history starts inside it. Nor for a period whose last month is still running ("All
  // movements", the current month): its rent is in and its salary is not, so the share reads as
  // overspending (109% for a customer who spends 90% of a full month's income).
  const ofIncome =
    s.incomeCents > 0 &&
    s.spentCents > 0 &&
    !!applied &&
    applied !== 'all' &&
    reason !== 'window' &&
    reason !== 'in_progress';
  const share = (cents: number) => (cents / Math.max(1, s.spentCents)) * 100;
  const shareText = (cents: number) => {
    const p = share(cents);
    // Never "100%" for a part that is not the whole (a crumb beside it has no tile).
    if (p >= 99.5 && cents < s.spentCents) return '>99%';
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };
  const sorted = Math.max(0, w.returned - u.count - s.pending);
  const ring = 2 * Math.PI * 16;
  return (
    <section
      className="card spend-insights"
      data-testid="spending-card"
      aria-labelledby="spend-insights-title"
      aria-busy={insights.busy || loading}
      ref={cardEl}
      onPointerMove={(e) => {
        if (e.pointerType !== 'mouse') return;
        mouse.current = [e.clientX, e.clientY];
        setPointed(categoryAt(e.currentTarget, e.target as Element));
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        mouse.current = null;
        setPointed(null);
      }}
      onPointerDown={(e) => {
        pressedBy.current = e.pointerType;
      }}
      onClick={(e) => {
        // A click with no pointer (`detail` 0) is Enter or Space on a button.
        const by = e.detail === 0 ? 'key' : pressedBy.current;
        const pressed = categoryAt(e.currentTarget, e.target as Element);
        // The keyboard only pins on a row; its other buttons leave the pin alone.
        if (by !== 'key' || pressed) setPinned(pinAfter(pinned, pressed, by));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setPinned(null);
      }}
    >
      <header className="si-head">
        <h2 id="spend-insights-title">Where your money went</h2>
        {applied ? (
          // The dropdown button and its caption are one block, so nothing (the Ask button, when
          // the header wraps) can come between them; the menu opens under the button.
          <div
            className="si-period-block"
            ref={periodBlock}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !menu) return;
              e.stopPropagation();
              closeMenu();
            }}
            // Focus that moves on (Tab or Shift+Tab past the menu) closes it: no open menu is left
            // behind. Focus going to the button or staying inside does not, nor does a blur with
            // no next element (a date input opening its picker, a press on plain text).
            onBlur={(e) =>
              menu &&
              e.relatedTarget &&
              !e.currentTarget.contains(e.relatedTarget as Node) &&
              setMenu(false)
            }
          >
            <button
              type="button"
              ref={periodTrigger}
              className="si-period-trigger"
              data-testid="spending-period"
              // The value sent for the period shown, readable without opening the menu.
              data-period={period ?? applied}
              aria-haspopup="dialog"
              aria-expanded={menu}
              aria-label={`Period: ${periodLabel(selected!, today)}`}
              onClick={() => setMenu(!menu)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="5" width="16" height="15" rx="3" />
                <path d="M4 10h16M9 3v4M15 3v4" />
              </svg>
              <span>{periodLabel(selected!, today)}</span>
              <Icon name="chevron" size={14} />
            </button>
            {menu && (
              <PeriodMenu
                applied={selected!}
                today={today}
                windowFrom={windowFrom}
                periods={s.periods ?? []}
                onPick={(id) => {
                  closeMenu();
                  onPeriod?.(id);
                }}
              />
            )}
            <p className="si-period-note" data-testid="spending-period-note">
              {caption}
            </p>
          </div>
        ) : (
          <span className="si-window">{sinceAll}</span>
        )}
        {onAskSpending && (
          <button type="button" className="si-ask-all" onClick={onAskSpending}>
            <Icon name="sparkle" size={14} />
            Ask about my spending
          </button>
        )}
      </header>
      <FeedbackLine insights={insights} at={null} />
      <div className="si-body">
        <div className="si-main">
          {/* The focus block: the total of the period, or the category pointed at or pinned. */}
          <div className="si-focus">
            <p>
              <span className="si-focus-label">
                {group
                  ? 'Smaller categories'
                  : active
                    ? active.label
                    : // A9: the period is said once, in the caption beside its button.
                      'Spent'}
              </span>
              <span className="si-focus-amount">
                {money(group ? group.cents : active ? active.spentCents : s.spentCents)}
              </span>
              {group ? (
                <span className="si-focus-sub">{`${shareText(group.cents)} of spending · ${group.members.length} categories`}</span>
              ) : active ? (
                <span className="si-focus-sub">{`${shareText(active.spentCents)} of spending · ${plural(active.count, 'movement')}`}</span>
              ) : ofIncome ? (
                <span
                  className="si-focus-sub"
                  title="Spending as a share of the income in these movements"
                >
                  {`about ${Math.round((s.spentCents / s.incomeCents) * 100)}% of income · estimate`}
                </span>
              ) : (
                <span className="si-focus-sub">{plural(movements, 'movement')}</span>
              )}
            </p>
            {s.incomeCents > 0 && (
              <p className="si-income">
                Income <strong>{money(s.incomeCents)}</strong>
              </p>
            )}
          </div>
          {!empty && (
            <Blocks tiles={tiles} parts={parts} lit={lit} share={shareText} boxRef={boxRef} />
          )}
          {empty ? (
            // IT8c-ui: a period with no spending (often the month that has just begun) says so and
            // offers the one before of its kind; the review panel beside it stays.
            <div className="si-empty">
              <p>
                {applied && applied !== 'all'
                  ? `No spending in ${periodLabel(applied, today, false)}${reason === 'in_progress' ? ' yet' : ''}.`
                  : 'No spending in these movements.'}
              </p>
              {reason === 'in_progress' && (
                <span>New movements show here as the bank reports them.</span>
              )}
              {previous && (
                <button
                  type="button"
                  className="si-button primary"
                  data-testid="spending-period-previous"
                  onClick={() => onPeriod?.(previous)}
                >
                  {`See ${periodLabel(previous, today, false)}`}
                </button>
              )}
            </div>
          ) : (
            <ul
              className="si-categories"
              // The focus leaving the list ends a pin made in it.
              onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPinned(null)}
            >
              {s.categories.map((c) => {
                const estimated = c.id === 'other' ? c.estimatedCents - toSort : c.estimatedCents;
                return (
                  <li key={c.id} data-testid="spending-category" data-category={c.id}>
                    <button
                      type="button"
                      className="si-category"
                      aria-pressed={pinned === c.id}
                      data-on={on.includes(c.id) || undefined}
                      data-dim={(on.length > 0 && !on.includes(c.id)) || undefined}
                      // Keyboard focus only: a mouse press focuses the button too, and that
                      // focus stays after the pointer has gone.
                      onFocus={(e) => e.currentTarget.matches(':focus-visible') && setFocused(c.id)}
                      onBlur={() => setFocused(null)}
                    >
                      <CategoryTile id={c.id} size={15} />
                      <span className="si-cat-name">{c.label}</span>
                      <span className="si-cat-amount">{money(c.spentCents)}</span>
                      <span className="si-cat-share">{shareText(c.spentCents)}</span>
                      <span className="si-cat-meta">
                        {/* The amount only when it is not the row's own amount again. */}
                        {`${plural(c.count, 'movement')}${estimated <= 0 ? '' : estimated === c.spentCents ? ' · estimated' : ` · ${money(estimated)} estimated`}`}
                        {/* contracts.md 2.7: a movement in review counts under `other`; say so. */}
                        {c.id === 'other' && toReview > 0 && (
                          <span className="si-review">{` · ${toReview} to review`}</span>
                        )}
                      </span>
                      {/* Decorative: the bar is the share of the total; its solid part is the
                          confirmed share, the pale part estimated (said in words above). */}
                      <span className="si-bar" aria-hidden="true">
                        <span
                          style={{ width: `${Math.max(2, Math.min(100, share(c.spentCents)))}%` }}
                        >
                          <i
                            style={{
                              width: `${Math.max(0, Math.min(100, (c.confirmedCents / Math.max(1, c.spentCents)) * 100))}%`,
                            }}
                          />
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="si-status" role="status">
            {s.pending > 0
              ? `Classifying ${plural(s.pending, 'movement')}…`
              : wasClassifying.current
                ? 'All movements are classified.'
                : ''}
          </p>
          {unanswered > 0 && (
            <p className="si-retry">
              {`The classifier did not answer for ${plural(unanswered, 'movement')}.`}{' '}
              <button type="button" className="si-button" onClick={insights.retry}>
                Try again
              </button>
            </p>
          )}
        </div>
        {w.returned > 0 && (
          // The slot is the grid item: beside the list it has no height of its own, so the panel
          // is at most as tall as the mosaic and the list, and its groups scroll inside it.
          <div className="si-panel-slot">
            <aside className="si-panel" aria-label="Movements to sort">
              <div className="si-progress">
                <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
                  <circle cx="20" cy="20" r="16" />
                  <circle
                    cx="20"
                    cy="20"
                    r="16"
                    strokeDasharray={`${(sorted / w.returned) * ring} ${ring}`}
                  />
                </svg>
                <p>
                  <strong>{u.count > 0 ? `${u.count} to sort` : 'Nothing to sort'}</strong>
                  <span>{`${sorted} of ${plural(w.returned, 'movement')} sorted`}</span>
                </p>
              </div>
              {u.count > 0 ? (
                <UnresolvedGroups insights={insights} onAsk={onAsk} />
              ) : (
                s.pending === 0 && (
                  <div className="si-done">
                    <span className="si-done-mark" aria-hidden="true">
                      <Icon name="check" size={22} />
                    </span>
                    <strong>All sorted</strong>
                    <span>{`${w.returned} of ${plural(w.returned, 'movement')} have a category.`}</span>
                  </div>
                )
              )}
              {insights.rules.length > 0 && <RulesList insights={insights} />}
            </aside>
          </div>
        )}
      </div>
      <p className="si-note" data-testid="spending-window-note">
        {`Covers the ${plural(w.returned, 'most recent movement')} the bank returned${w.oldestAt ? `, since ${formatDate(w.oldestAt, false)}` : ''}.${w.mayBeTruncated ? ' Older movements are not included.' : ''}`}
      </p>
    </section>
  );
}

// The `rowExtra` slot of a movement row: the chip (its "why" opens on click or keyboard focus),
// the select that changes the category, and the feedback of a change made here. Home returns
// null for rows without a category, so this always has one.
export function CategoryChip({
  row,
  insights,
  onAsk,
}: {
  row: ActivityRow;
  insights: Insights;
  // SI7b: "Ask the assistant" opens the chat with this movement attached.
  onAsk?: () => void;
}) {
  const c = row.category!;
  const at = c.movementIds[0];
  const whyId = useId();
  const [open, setOpen] = useState(false);
  // The value just chosen, shown while its request runs; afterwards the server's value again, so a
  // refused change falls back by itself and is never shown as confirmed.
  const [picked, setPicked] = useState<CategoryId | null>(null);
  const why = whyText(c);
  return (
    <div className="si-row" data-open={open || undefined}>
      <span className="si-pill" data-state={c.state}>
        <button
          type="button"
          className="si-chip"
          data-testid="category-chip"
          data-category={c.id}
          data-state={c.state}
          data-source={c.source}
          title={why}
          aria-expanded={open}
          aria-describedby={whyId}
          onClick={() => setOpen(!open)}
        >
          {/* Confirmed: the bare label (contracts.md §8) plus a mark, not only another colour. */}
          {c.state === 'confirmed' && (
            <span className="si-chip-mark">
              <Icon name="check" size={12} />
            </span>
          )}
          {chipText(c)}
        </button>
        <span className="si-change" title="Change category">
          <select
            data-testid="category-select"
            aria-label={`Change the category of ${row.title}`}
            aria-busy={picked !== null}
            value={picked ?? c.id}
            onChange={(e) => {
              const category = e.target.value as CategoryId;
              setPicked(category);
              insights.setCategory(c.movementIds, category, at).finally(() => setPicked(null));
            }}
          >
            {options(categoryOptions(row))}
          </select>
          <Icon name="chevron" size={12} />
        </span>
      </span>
      {/* A movement in review already holds `other`, so its select cannot say "it really is
          Other" (no change event). This confirms it and takes it out of the review list. */}
      {c.state === 'needs_review' && (
        <button
          type="button"
          className="si-keep"
          aria-label={`Keep as Other: ${row.title}`}
          onClick={() => insights.setCategory(c.movementIds, 'other', at)}
        >
          Keep as Other
        </button>
      )}
      {/* IT6 (A9): the same for an estimate that is right: the select only fires on a change, so
          this confirms the category the row already shows. */}
      {c.state === 'estimated' && (
        <button
          type="button"
          className="si-keep"
          aria-label={`Confirm ${categoryLabel(c.id)} for ${row.title}`}
          onClick={() => insights.setCategory(c.movementIds, c.id, at)}
        >
          Confirm
        </button>
      )}
      {onAsk && (
        <button type="button" className="si-ask" data-testid="category-ask" onClick={onAsk}>
          Ask the assistant
        </button>
      )}
      <span className="si-why" id={whyId} data-testid="category-why">
        {why}
      </span>
      <FeedbackLine insights={insights} at={at} />
    </div>
  );
}
