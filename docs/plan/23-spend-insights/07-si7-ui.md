# 07 — SI7 UI: slots (designer), Overview (SI7a), chat (SI7b)

| | SI7-slots | SI7a | SI7b |
|---|---|---|---|
| Branch | `feat/si7-slots` | `feat/si7a-overview-ui` | `feat/si7b-chat-ui` |
| Owner | **designer** | ours | ours |
| Size | S | M | M |
| Priority | must | must | must |
| Depends on | — | SI5, SI7-slots | SI7a, SI6a; SI6b for the live flow |

## Designer contract (SI7-slots)

This section is self-contained: it is sent to the designer session as it is.

---

**Request: five optional props on `Overview` and `Assistant`. No visual change when they are absent.**

Round 7 adds spend categories. Our components bring their own markup and CSS (`app/_components/SpendInsights.tsx`, `app/styles/spend-insights.css`); you decide where the slots sit and how they are spaced. With every prop absent, both views must render exactly as today (the existing tests and e2e suites must pass unchanged). `Transfers` and `Shell` need nothing.

| # | File | Prop and type | Where it renders | What we put there |
|---|---|---|---|---|
| 1 | `app/_components/Overview.tsx` | `insights?: React.ReactNode` | a full-width block between the account grid (after `AttentionCard` when it is shown) and `section.overview-bottom`. Wrap it in an element with `data-testid="overview-insights"`. Render nothing (no wrapper) when the prop is absent | the spending breakdown card, the "Other — to review" list and the customer's rules |
| 2 | `app/_components/Overview.tsx` → `ActivityTable` | `rowExtra?: (row: ActivityRow) => React.ReactNode` | inside `.movement-main` of each row, after `.movement-sub`. Render nothing when the prop is absent or returns `null` | the category chip with its select, "why" and "Ask the assistant" |
| 3 | `app/_components/Assistant.tsx` | `composerExtra?: React.ReactNode` | inside `.composer-box`, above the `textarea`. Wrap it in an element with `data-testid="composer-extra"`. Nothing when absent | the movement attached to the next message, with a remove button |
| 4 | `app/_components/Assistant.tsx` | `messageExtra?: (m: AnyRecord, isLast: boolean) => React.ReactNode` | inside `.bubble` of every message (user and assistant), after the message body and the sources, before the date `small`. `isLast` is true for the last element of `messages` | the attached movement on a user message; cited movements and quick-reply buttons on an assistant message |
| 5 | `app/_components/Assistant.tsx` | `suggestions?: string[]` | replaces the built-in `SUGGESTIONS` list when given; same markup and behaviour | adds "Where did my money go?" |

Rules:

- `data-testid` ownership: **you own exactly two**, `overview-insights` and `composer-extra`, on the slot wrappers. Every other `data-testid` of this feature is inside our components.
- Do not change the row markup the e2e suites read (one `small` per movement row, the `.movement`, `.movement-main`, `.movement-sub`, `.movement-meta` structure).
- `ActivityRow` (from `src/ui-helpers.ts`) gains an optional `category` field in this round. Your markup does not need to read it. Please do not edit `src/ui-helpers.ts` between 5 and 9 Oct; one of our builders owns it then.
- The precedent for prop 2 is `rowAction` in `Transfers`; for props 1 and 3, `toolbar` in `Overview` and `topbarActions` in `Shell`.
- Our content in slot 2 is one line of small controls under the description; at 390 px it wraps inside `.movement-main`. Our content in slot 1 is a card as wide as `.movements`.
- Add a test in the style of `tests/overview-slots.test.ts`: each view rendered with and without the props.
- Branch `feat/si7-slots` from `origin/dev`, PR into `dev`, ports 3100/4101. It has no dependency and can merge on 4 Oct.

---

If SI7a starts and a slot is missing, the builder stops and reports; it never edits designer files (`Shell.tsx`, `Overview.tsx`, `Transfers.tsx`, `Assistant.tsx`, `overview.css`, `transfers.css`, `assistant.css`).

## Files (ours; one stream, SI7a then SI7b)

| File | SI7a | SI7b |
|---|---|---|
| `app/_components/SpendInsights.tsx` (new) | `useSpendInsights`, `SpendingCard`, `UnresolvedGroups`, `CategoryChip`, `RulesList` | `AttachedMovement`, `QuickReplies`, `CitedMovements` |
| `app/styles/spend-insights.css` (new) | yes | additions |
| `app/page.tsx` | hook; `Overview` props | attachment state; `send` with `movementId`; `Assistant` props |
| `tests/si7-insights-ui.test.ts`, `tests/e2e/spend-insights.e2e.mjs` (new) | Overview parts | chat parts |

`src/ui-helpers.ts` is not edited here (`chipText` is in `src/insights/taxonomy.ts`, SI1). DOM hooks: [contracts.md §8](contracts.md#8-dom-hooks).

## SI7a — Overview

```ts
export function useSpendInsights(api, personId: string | null, dashboard: AnyRecord | null, refresh: () => Promise<void>): {
  summary: SpendingSummary | null; // dashboard.insights: no fetch of its own
  rules: Rule[]; // GET /api/insights/rules, re-read after a change
  setCategory(movementIds: string[], category: CategoryId, applyToSimilar?: boolean): Promise<void>;
  offer: { merchantKey: string; count: number; movementIds: string[]; category: CategoryId } | null;
  acceptOffer(): Promise<void>; dismissOffer(): void;
  removeRule(merchantKey: string): Promise<void>;
  retry(): Promise<void>; // POST /api/insights/reclassify
  notice: { text: string; undoKey: string | null } | null;
  busy: boolean; error: string;
};
```

- **The summary comes from `dashboard.insights`.** No second request: the card and the table always agree.
- **Faster refresh while classifying:** while `summary.pending > 0`, call `refresh()` every 3 s, at most 10 times, then fall back to the page's 20 s refresh. After every change, `refresh()` once.
- **`SpendingCard`** (`insights` slot). "Where your money went"; the total spent; one row per category: a bar (CSS width from the share; decorative), the amount (`money()`), the count, "€X estimated" when `estimatedCents > 0`; a line for income. Always the window note: "Covers the N most recent movements the bank returned, since {formatDate(oldestAt)}." "Classifying N movements…" when `pending > 0`. When any unresolved group has reason `decider_unavailable`: "The classifier did not answer for N movements." with a "Try again" button (`retry`). Empty state: "No spending in these movements."
- **`UnresolvedGroups`** (inside the card, when `unresolved.count > 0`). "Other — to review (N movements, €X)". One line per merchant group: merchant key, count, total, and its candidates as buttons with the probability when there is one ("Shopping 48%"). A click sets the whole group (`movementIds`), then the offer. No extra select here: the chip on each row has one.
- **`CategoryChip`** (`rowExtra`). Text from `chipText`. The chip opens a native `select` with the categories `allowedFor` permits for the row's sign; a change posts `row.category.movementIds` (both legs for a merged internal row). A **"why" line** (`category-why`, shown on focus or tap of the chip, also its `title`): from `reason`, in words — "Matched MERCADONA", "Between your own accounts", "Transfer to a person", "Set by you", "Your rule for ESPAI NOU", "The model was 62% sure, below the 80% bar: Eating out 62%, Groceries 30%", "The classifier did not answer". **"Ask the assistant"** (`category-ask`) on every chip (wired in SI7b; hidden until then). Rows without a category (proposals) render nothing.
- **Similar offer.** After a change whose response has `similar[0].count > 0`: a `role="status"` line "Apply Groceries to the 4 other MERCADONA movements and to future ones?" with "Yes, apply to all" and "No, only this one". Once per change.
- **Learning notice.** After a rule is created: "Learned: MERCADONA is Groceries. 4 movements updated." with **"Undo"** (`insights-undo` → `removeRule`).
- **`RulesList`** (inside the card, when there are rules): "Your rules" — one `rule-item` per rule, "ESPAI NOU → Eating out & leisure", with a remove button.

## SI7b — chat

- State `attached: {id, title, amountCents, createdAt} | null` in Home.
- **"Ask the assistant"** on a chip → new conversation, `setAttached(row)`, go to the Assistant, and send at once: "Help me categorise this movement." for `needs_review`, otherwise "Why is this {label}?". From an unresolved group, the same with the group's first movement.
- `send(value)` posts `{content: value, movementId: attached?.id}` and clears `attached` after a successful post. A `404` (stale movement) shows the error and clears it.
- **`AttachedMovement`**: in `composerExtra` with a remove button; in `messageExtra` on user messages with `m.extras.movement`.
- **`QuickReplies`** (`messageExtra`, only when `isLast`, the message is the assistant's and no turn is in flight): one `button type="button"` per reply; a click calls `onSend(value)`. No movement id is sent with it: the server knows the target.
- **`CitedMovements`** (`messageExtra`, assistant messages with `extras.citedMovements`): a short list under the answer — title, date, amount, category.
- `suggestions`: the built-in three plus "Where did my money go?".
- After a chat turn `send` already calls `refresh()`, so a category set in chat is on Overview at once.

All new UI follows the redesign rules (`docs/plan/15-redesign/00-overview.md` 2–8): `money()`, `formatDate()`, native controls, `type="button"`, visible focus, nothing time- or locale-dependent in the first render, no horizontal overflow at 390 px, state never by colour alone.

## Tests first

`tests/si7-insights-ui.test.ts` (render to string, the pattern of `tests/cf3-search-ui.test.ts`): card with a fixture (amounts, estimated note, window note always, pending line, "Try again" line, empty state); groups with and without candidates; chip texts, "why" texts per reason, select options by sign; rules list; quick replies only when last; cited movements.

`tests/e2e/spend-insights.e2e.mjs` (app with `DECIDER=none`; default bank unless stated):

- Simulator: the "Groceries" row shows `Groceries · estimated`; the card lists Groceries; the window note is present.
- Simulator: change "Coffee shop" to Health from the chip → confirmed, survives a reload, the card moves the amount.
- Stubbed `**/api/dashboard` (a fixture with an unresolved group of three with candidates): group and buttons; a click posts the group's ids; the offer once; "Yes" posts `applyToSimilar: true`; notice with Undo; Undo calls DELETE.
- Stubbed dashboard with `pending: 2` → a second dashboard request within 5 s.
- SI7b, stubbed messages route: "Ask the assistant" opens the chat with the chip in the composer; the POST body has `movementId`; quick replies render and a click sends the value; cited movements render.
- 390 px: no overflow. No console errors or hydration warnings.
- Demo-bank checks (skipped with a `SKIP` line unless a movement id starts with `demo-`): the Other list is non-empty on first load; `ESPAI NOU` has four.

**Must fail before:** chip and card absent on `dev`.

## Evidence

`.scratch/after/feat-si7a-overview-ui/` and `…/feat-si7b-chat-ui/`: `unit-before.txt`, `e2e-before.txt`, `unit-after.txt`, `e2e.txt` (all suites), `shots/` (1280 and 390; dev and production: card, Other list, offer, notice, rules, chip "why", chat with attachment, quick replies, cited movements), `verify.txt`, `build.txt`.

## Acceptance

- No edit to a designer-owned file in SI7a or SI7b.
- On the default bank with no key, a chip, its "why" and "Ask the assistant" are visible on every movement.
- A category change made in chat is on Overview after the turn, and the reverse.
- All e2e suites pass on a production build.

## Verification (V-cycle)

`test/si7-insights-ui` tests REQ-SI7-1 … -12 with Playwright against the alt bank with the demo seed ([contracts.md §7](contracts.md#7-alt-bank-tests-and-demo-only)), using only the DOM hooks of contracts.md §8, written by an independent test author. The builders do not write or edit `tests/e2e/acceptance-*`.
