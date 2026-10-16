# 02 — SI2a Rules and dictionary · SI2b Store and migrations

Two PRs with disjoint files, built in parallel after SI1.

| | SI2a | SI2b |
|---|---|---|
| Branch | `feat/si2a-rules` | `feat/si2b-store` |
| Size | M | S |
| Priority | must | must |
| Depends on | SI1 | SI1 (types only) |
| Blocks | SI4 | SI4, SI6a (migration order) |

---

## SI2a — regex dictionary (data) and rule tiers

> **The builder of this item must not open `docs/plan/23-spend-insights/inputs/heldout/`.** Tune on `inputs/eval-set-dev.jsonl` only.

### Goal

The deterministic part of the pipeline: facts and an ordered regex dictionary decide what they can; everything else is left to the decider. Rules never guess between themselves.

### Files (owner: this item only)

| File | Change |
|---|---|
| `src/insights/dictionary.ts` (new, pure data) | the regex entries, as data |
| `src/insights/rules.ts` (new, pure) | `applyRules` |
| `tests/si2a-rules.test.ts` (new) | unit tests, including the whole dev set |

> **As built (PR #91, after the blind review).** The "Dictionary" and "Rule tiers" text below is the first plan. The merged design differs where the held-out measurement required it; [`contracts.md`](contracts.md) §1 (version 2.6) and the change note `.artifacts/tested/2026-10-04-feat-si2a-rules.md` are the reference. In short: the generator's arrays are split into strong `RULES` / `PRIORITY` (brands and institutions, which decide anywhere in the merchant part) and weak `VOCABULARY` (generic words, which decide only as the first word of the merchant name); the engine adds the word boundaries; only the merchant part (before any free-text separator, at most six words) decides; there is no savings entry (`savings_internal` comes from account facts only, own-money wording abstains on either sign); generic transfer wording on a debit without an account fact abstains; `ABONO` is a refund only next to exactly one recognised merchant and no income word; the sentinel blocks only the global dictionary (facts and the customer's rule still apply); and the extra export `ruleCandidates(m)` returns up to three sign-checked candidates for an abstention.

### Dictionary

Port the arrays of [`inputs/gen-spend-data.mjs`](inputs/gen-spend-data.mjs) as they are: `PRIORITY` (6 overrides), `RULES` (212 entries by category), `TRANSFER_PERSON`, `OPENING`, `INCOME`. Shape: `[category, regex source, note]`, compiled once. It is data: no logic in this file. The regexes carry their own word boundaries and anchors (`\bBAR\b`, never bare `DIA`, `UBER\s*\*?\s*EATS` before `UBER`); do not replace them with token lists.

Add:

- `REFUND = 'DEVOLUCION|REFUND|REEMBOLSO|ABONO'` and `TAX = 'AEAT|AGENCIA TRIBUTARIA|HACIENDA'`;
- `SENTINEL = '^ZZQXV '`: a description matching it is never decided by a rule (frozen in contracts.md; tests rely on it);
- entries for the simulator's and the alt bank's seed words if missing: `GROCERIES`, `INTERNET BILL`, `COFFEE SHOP`, `TRANSPORT`, `SALARY`.

### Rule tiers

```ts
export type RuleHit = {
  category: CategoryId;
  source: 'user_rule' | 'rule';
  state: 'confirmed' | 'estimated';
  reason: string; // contracts.md §1 "Reasons"
  candidates: { category: CategoryId; p: null }[]; // tier 2 only
};
export type RuleContext = {
  ownAccountIds: ReadonlySet<string>;
  ownPairOperationIds: ReadonlySet<string>; // operations with two legs on own accounts in this bank answer
  userRules: ReadonlyMap<string, CategoryId>; // merchant key → category
};
export function applyRules(m: MovementInput, ctx: RuleContext): RuleHit | null;
```

First hit wins. This is the final order (contracts.md §1 "Labelling rules"); it differs from the generator's `ruleDecision` in tiers 2 and 5.

| # | Condition | Result |
|---|---|---|
| 0 | description matches `SENTINEL` | `null` |
| 1 | **own account**: `fromAccountId` and `toAccountId` both own; or `operationId` in `ownPairOperationIds`; or the description's transfer wrapper names an own account id (`TO ACC-…` / `FROM ACC-…`) | `savings_internal` · reason `own_account` |
| 2 | **person transfer**: `toAccountId` / `fromAccountId` set and not own; or the description matches the transfer wrapper or a `TRANSFER_PERSON` entry | debit → `transfer_person` · `person_transfer`, with up to 3 candidates = the categories the dictionary matches in the concept; credit → `income` · `credit` |
| 3 | `OPENING` | `other` · `opening_balance` |
| 4 | non-empty merchant key in `userRules`, and the sign rule allows it | that category · `user_rule` · `confirmed` · `user_rule:<key>` |
| 5 | **credit**: `TAX` and `REFUND` → `other` · `tax_refund`; `REFUND` and exactly one dictionary category matches → that category · `refund:<match>`; `REFUND` otherwise → `other` · `refund:<match>`; a savings entry matches → `savings_internal` · `keyword:<match>`; else → `income` · `credit` | |
| 6 | **debit**: a `PRIORITY` entry matches → its category · `keyword:<match>`; else collect the categories of matching `RULES` entries: exactly one → it; two or more → `null` | |
| 7 | nothing | `null` |

All rule results are `estimated` except tier 4. Matching is on `matchText(description)`; for tier 2 candidates and tiers 5–6 on app transfers, on the concept.

Notes:

- Tier 1 before everything: a transfer to own savings with the concept "cena viernes" or "nómina" is `savings_internal` (dev rows ev-100, ev-104).
- Tier 2 before the customer's rules and the dictionary: a person transfer stays `transfer_person` whatever its concept; the customer can still set one movement by hand. The candidates are what the assistant uses to ask "what was it for?".
- A debit can never reach `income`: no tier leads there.
- The wrappers (`Transfer · `, `To acc-…: `, `From acc-…: `) are the two known banks' wording. On another bank they simply do not match, and the facts from the app's own record (`withCounterparties`) and from own pairs still work.

`ownPairOperationIds` is computed by SI4 with the same predicate `activityRows` uses (`src/ui-helpers.ts`: two movements with one `operationId`, both on own accounts). SI2a only consumes it.

### Tests first (`tests/si2a-rules.test.ts`)

- Each tier, and the order between tiers (own beats person beats user rule beats dictionary).
- The simulator's descriptions (contracts.md).
- Overrides: `UBER *EATS` vs `UBER *TRIP`; `REPSOL LUZ` vs `E.S. REPSOL`; `EL CORTE INGLES` alone → `null`; `te debo lo del otro dia` does not hit `DIA`.
- Sign: every debit of the dev set gets a category other than `income`; every credit other than `transfer_person`.
- `ZZQXV ALPHA` → `null`.
- **The whole dev set** (`inputs/eval-set-dev.jsonl`): for every row where `applyRules` decides, the category is `expected` or in `acceptable`. Print coverage (rows decided) and the list of undecided rows. Target: 0 contradictions, as the generator had.

**Must fail before:** module not found.

### Evidence

`.scratch/after/feat-si2a-rules/`: `unit-before.txt`, `unit-after.txt`, `dev-set-rules.txt` (coverage, contradictions = 0, undecided rows), `verify.txt`.

### Acceptance

- `dictionary.ts` and `rules.ts` are pure. No row of the dev set is contradicted.
- The change note states the dev-set coverage. It cites no held-out row.

---

## SI2b — store, migrations 7–8, reset wipe

### Files (owner: this item only)

| File | Change |
|---|---|
| `src/insights/store.ts` (new, server) | reads and writes of the two tables, `fingerprint` |
| `src/db.ts` | append migrations 7 and 8 (DDL in [00-overview](00-overview.md#data-model)); `Rows` is not touched |
| `src/seed.ts` | wipe list: `DELETE FROM movement_categories; DELETE FROM category_rules;` |
| `tests/si2b-store.test.ts` (new) | tests |

### Functions (internal; not frozen)

```ts
export type StoredCategory = RowCategory & { movementId: string; fingerprint: string; updatedAt: string };
export function fingerprint(m: MovementInput): string;
// Rows whose fingerprint matches the given movement; mismatches are left out.
export function storedCategories(userId: string, movements: MovementInput[]): Map<string, StoredCategory>;
// Upsert. A confirmed row with the same fingerprint is kept unless row.source is 'user' or 'user_rule'.
export function saveCategories(userId: string, rows: StoredCategory[]): number; // one transaction
export function deleteCategories(userId: string, movementIds: string[]): number;
export function userRules(userId: string): Map<string, CategoryId>;
export function listRules(userId: string): { merchantKey: string; category: CategoryId; createdAt: string }[];
export function setUserRule(userId: string, merchantKey: string, category: CategoryId): void; // throws on ''
export function removeUserRule(userId: string, merchantKey: string): boolean;
```

`RowCategory` and `MovementInput` are the frozen types of contracts.md; import them from `src/insights/taxonomy.ts` (SI1 declares them there; SI4 re-exports them from `classify.ts`). SI2a imports `MovementInput` from the same place.

- Prepared statements with named columns; upsert with `ON CONFLICT(user_id,movement_id) DO UPDATE … WHERE movement_categories.state<>'confirmed' OR movement_categories.fingerprint<>excluded.fingerprint OR excluded.source IN ('user','user_rule')`.
- `saveCategories` wraps the batch in one `db.transaction` (a dashboard read may write 100 rows).
- `storedCategories` reads with `movement_id IN (SELECT value FROM json_each(?))`, the pattern of `withCounterparties`.
- There is no "apply to all stored rows of a merchant" function: similar movements are computed from the current bank answer by SI5.

### Tests first (`tests/si2b-store.test.ts`)

- A fresh database has both tables and the index, recorded as versions 7 and 8; a database at version 6 migrates and keeps its data.
- Round trip of every field, including `reason`, candidates with `p: null`, and `model`.
- A `confirmed` row is not overwritten by source `model` or `rule`; it is by `user`.
- A changed fingerprint hides the old row; the next save replaces it.
- Rows of `lucia` are never returned for `bruno` with the same movement id.
- Rules: set, replace, list newest first, remove (`false` for an unknown key), empty key throws.
- Reset: one row in each table, `seedApp()`, both empty. Prove once that the test fails with the migration but without the wipe line.

**Must fail before:** `no such table`; the reset test without the wipe.

### Evidence

`.scratch/after/feat-si2b-store/`: `unit-before.txt`, `reset-before.txt`, `unit-after.txt`, `migrate-from-6.txt`, `verify.txt`, `alt-bank.txt`.

### Acceptance

- `schema_migrations` on a fresh database ends with `7 si2-movement-categories`, `8 si2-category-rules`. No new column on an existing table.
- `npm run reset` leaves both tables empty.

---

## Verification (V-cycle)

No test branch for SI2a or SI2b. Judged from outside by `test/si4-core` (REQ-CORE-2 … -5, -15, -16, -21) and by the held-out bars (REQ-HO-1, -2). The builders do not write or edit `tests/acceptance/*`.
