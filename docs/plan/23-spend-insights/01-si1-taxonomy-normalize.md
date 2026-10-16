# 01 — SI1 Taxonomy, sign rule, description cleaning, merchant key

Branch `feat/si1-taxonomy`. Size **S**. Priority **must**. Depends on nothing. Blocks SI2a, SI2b, SI3.

> **The builder of this item must not open `docs/plan/23-spend-insights/inputs/heldout/`.** It is the blind evaluation set. Use `inputs/eval-set-dev.jsonl` only.

## Goal

The closed list of categories with its sign rule, and the pure functions that turn a bank description into (a) the **cleaned description** the rules and the decider read and (b) the **merchant key** that rules and "apply to similar" group by. Nothing here reads the database, the bank or a model, so the browser can import it.

## Files (owner: this item only)

| File | Change |
|---|---|
| `src/insights/taxonomy.ts` (new, pure) | categories, labels, `DECIDER_OPTIONS`, `allowedFor`, `chipText`; the shared types `MovementInput`, `Candidate`, `RowCategory` |
| `src/insights/normalize.ts` (new, pure) | `cleanDescription`, `matchText`, `merchantKey`, `timeBucket`, `dayBucket`, `amountBucket` |
| `tests/si1-taxonomy-normalize.test.ts` (new) | unit tests |

## Taxonomy

Exports exactly as frozen in [contracts.md §1](contracts.md#taxonomy-srcinsightstaxonomyts-pure): `CategoryId`, `CATEGORY_IDS`, `CATEGORIES`, `isCategory`, `categoryLabel`, `DECIDER_OPTIONS`, `allowedFor`.

Also here: the types `MovementInput`, `Candidate` and `RowCategory`, copied from contracts.md §1 "Pipeline entry point" (type-only). SI2a, SI2b and SI3 are built in parallel before `classify.ts` exists and import them from here; SI4 re-exports them from `classify.ts`, the frozen path.

Also here (not frozen, used by SI7a): `chipText(category: { id; state }): string` → `Groceries · estimated`, `Groceries`, `Other · to review`, `Classifying…`. It lives here and not in `src/ui-helpers.ts`, which the designer's views import and which only SI5 edits in this round.

`DECIDER_OPTIONS` also carries, per option, the English description sent to the decider (`OPTION_CRITERIA: Record<CategoryId, string>`): one or two lines with Spanish and English example words, e.g. `groceries`: "Supermarkets and food shops: supermercado, fruteria, panaderia, grocery store". Write them so they separate the options from each other (research note, "Best practice"). SI8 may adjust wording and order.

## Normalisation

Start from `light`, `WRAPPER` and `merchantKey` in [`inputs/gen-spend-data.mjs`](inputs/gen-spend-data.mjs) and the steps in [`inputs/rules-dictionary-proposal.md`](inputs/rules-dictionary-proposal.md) ("Normalisation"). They were run over 388 rows.

```ts
// Step 1: NFKD, strip accents, upper case, collapse whitespace. What the regex dictionary matches.
export function matchText(description: string): string;
// What a decider is sent: matchText without the bank's transfer wrapper, only [A-Z0-9& ], at most 80 chars.
export function cleanDescription(description: string): string;
// All steps. What rules and "apply to similar" group by.
export function merchantKey(description: string): string;
```

Bucket functions (pure; boundaries frozen in contracts.md §1 "Merchant profile"; time and day in `Europe/Madrid` through `Intl.DateTimeFormat`):

```ts
export function timeBucket(createdAt: string): 'late_night' | 'morning' | 'midday' | 'evening';
export function dayBucket(createdAt: string): 'weekday' | 'weekend';
export function amountBucket(amountCents: number): 'small' | 'medium' | 'large';
```

They turn time and amount into labels, because the decision model is weak with numbers and dates. SI4 builds the merchant profile from them. Motivating dev-set case: `LA ESQUINA SL`, a name with no keyword, at 02:55 on a weekend night.

Changes to the generator's `merchantKey`:

1. Output alphabet `[A-Z0-9& ]`, at most 40 characters, cut at a token boundary.
2. **A key with no letter is `''`** (`Card payment 12` → after the prefix strip → `12` → `''`). The generator keeps a leading number of up to three digits; keep that only when a letter token follows (`100 MONTADITOS`).
3. Add `CARD PAYMENT`, `PURCHASE` to the stripped leading prefixes (the alt bank's default rows).

Fixed examples (frozen): contracts.md §1 "Merchant key". The known limits listed in the dictionary proposal (noisy keys for `E.S. REPSOL … KM 212`, a stray `REF`) are accepted: the keys are stable, so grouping works.

## Tasks

1. Tests first; save the failing output.
2. `taxonomy.ts`.
3. `normalize.ts`, ported from the generator.
4. Run the port against the dev set: every row's key matches `/^[A-Z0-9& ]{0,40}$/`; print the 136 keys to the evidence folder for the reviewer.
5. `npm run verify`, `npm run build`.

## Tests first (`tests/si1-taxonomy-normalize.test.ts`)

- Ten ids in the frozen order; labels in both languages; `isCategory('x')` false.
- `DECIDER_OPTIONS`: eight ids, no `savings_internal`, no `income`, `other` not first; every option has a criteria text.
- `allowedFor`: debit × `income` false; credit × `transfer_person` false; everything else true.
- `merchantKey`: the frozen examples; the table "Before and after" of the dictionary proposal; `Card payment 12` → `''`; `'1234567'` → `''`; `''` → `''`; 500 characters of junk → length ≤ 40.
- Three dirty forms of one merchant → one key.
- `cleanDescription`: accents folded, punctuation gone, wrapper removed (`To acc-bruno: Team dinner` → `TEAM DINNER`), ≤ 80 characters.
- `chipText`: the four texts.
- Buckets: 05:59 and 06:00 local, 11:59/12:00, 16:59/17:00; `2026-09-12T22:55:00Z` is `late_night` on a `weekend` day in Madrid (00:55 Sunday); 1499/1500 and 9999/10000 cents; a credit uses its absolute amount.

**Must fail before:** module not found.

## Evidence

`.scratch/after/feat-si1-taxonomy/`: `unit-before.txt`, `unit-after.txt`, `dev-set-keys.txt`, `verify.txt`.

## Acceptance

- Both modules are pure (no import from `src/db`, `src/config`, `node:*`, a bank client or `src/ui-helpers`).
- Gates green; change note; id `SI1` at the change sites.

## Verification (V-cycle)

No test branch of its own. The core is judged from outside: REQ-CORE-1, -6, -17 through `classifyMovements` (`test/si4-core`) and the held-out bars (REQ-HO-1, -2). See [requirements.md](requirements.md).
