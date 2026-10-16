# 04 — SI4 Pipeline entry point and background classification

Branch `feat/si4-pipeline`. Size **M**. Priority **must**. Depends on SI2a, SI2b, SI3. Blocks SI5, SI8.

## Goal

Join rules, deciders, thresholds and the store behind **one** function, `classifyMovements`, and call it when the dashboard loads (D5): rules inside the request, deciders in the background. The dashboard never waits for a model, and a failing decider never leaves a movement "classifying" for ever.

> **As built (PR #98, orchestrator's decision).** SI4 also creates `src/insights/summary.ts` with `spendingSummary` (pure) and makes `dashboard()` return `movements[].category` (`RowCategory` plus `movementIds: [that movement's id]`) and `insights`, which this file first gave to SI5. So "the dashboard's response is byte-for-byte what it was" below no longer holds: the response is what it was **plus those two additions** (reviewer's comparison with the base: `.scratch/after/feat-si4-pipeline/review/compare-dev.txt`), and `dashboard-diff.txt` does not exist. SI5 keeps the rest of [05](05-si5-api.md): the `/api/insights/*` routes, `setCategory`, `removeRule`, `reclassify`, categories on `/api/movements` rows and on merged rows (`src/ui-helpers.ts`), audit events, the origin check. Other differences from the text below, all in the change note `.artifacts/tested/2026-10-04-feat-si4-pipeline.md`: `classifyMovements(input, now?)` has an optional clock as a second parameter; a stored `no_decider` row is classified again once a chain exists; decisions are saved per group as they arrive; `activeDecider()` and `merchantProfile` are exported; the `setupEnv` default was proven by the reviewer (`review/leak-check.txt`: with `DECIDER=auto` and a key, two test files ask a decider and one test fails).

## Files (owner: this item only)

| File | Change |
|---|---|
| `src/insights/classify.ts` (new) | `classifyMovements` (frozen), `resolveDecision` (pure, internal) |
| `src/banking/view.ts` (new) | `bankView` **moved here once** from `app/api/[...path]/route.ts`, same code, exported; it also calls `classifyMovements` |
| `app/api/[...path]/route.ts` | import `bankView` from its new home; delete the local copy and the `BankMovement` type. Nothing else |
| `tests/helpers/bank.ts` | `setupEnv`: `process.env.DECIDER ??= 'none'` |
| `README.md` | the e2e start line gains `DECIDER=none` |
| `tests/si4-pipeline.test.ts` (new) | unit tests |

`bankView` moves in this item so that SI5 (route resources) and SI6b (agent tools) both import it and never edit the same lines of `route.ts`.

## `classifyMovements`

Signature and observable behaviour: frozen in [contracts.md §1](contracts.md#pipeline-entry-point-srcinsightsclassifyts). Re-export `MovementInput`, `RowCategory`, `Candidate` from here (SI1 declares them in `src/insights/taxonomy.ts`).

Sync part (runs before the function's first `await`):

1. `storedCategories(userId, movements)`.
2. `ownPairOperationIds`: operation ids with two movements in `movements` whose `accountId`s are both own. Same predicate as `activityRows` (`src/ui-helpers.ts`, the `pair.length === 2` branch); extract nothing from there, it is two lines.
3. For each movement without a row: `applyRules`. A hit is collected.
4. No hit and `merchantKey === ''` → `other` · `needs_review` · source `none` · `no_merchant`.
5. No hit, empty chain → `other` · `needs_review` · source `none` · `no_decider`.
6. `saveCategories` once (one transaction) for 3–5.
7. The rest are `pending` in the returned map.

A row with reason `decider_unavailable` is treated as "no row" in step 1 only when its `updatedAt` is more than 24 hours old, or when it was deleted by the reclassify route (SI5).

Background part (one promise per customer; a second call while it runs joins nothing and starts nothing — the next call picks up what is left):

1. Group the undecided movements by `merchantKey + sign`. One `DecisionItem` per group: `{key, description: cleanDescription(first movement), direction, profile}`.
   - **Merchant profile** (`merchantProfile(movements)`, pure, in `classify.ts`): computed over **all** movements of that merchant key and sign in the bank answer (decided or not), with SI1's bucket functions and the rules of contracts.md §1 "Merchant profile" (two-thirds majority or `mixed`; `once` / `few` / `recurring_monthly` / `frequent`). With `profile: false`: `mixed`, `mixed`, `mixed`, `once`.
   - Still one decision per merchant key and sign: the profile describes the merchant, not one movement.
   - The stored reason of a model decision cites the non-`mixed` time and day labels: `model:late_night,weekend` (plain `model` when both are `mixed`).
2. For each item, walk the chain: `decider.classify(item)`; on `DeciderError` (the adapter has already spent its attempt budget) try the next decider.
3. A decision → `resolveDecision(decision, decider.threshold)`:
   - `confidence ≥ threshold` and top ≠ `other` → category · `estimated` · source `model` · reason `model`;
   - else → `other` · `needs_review` · source `model` · reason `below_threshold`; candidates kept.
   The stored row has `confidence`, `threshold`, `candidates`, `model`.
4. Every decider failed → `other` · `needs_review` · source `none` · reason `decider_unavailable`.
5. The decision of a group is saved for each movement of the group. `DECIDER_OPTIONS` has no `income`, and tier 5 decides every credit except a `ZZQXV …` one and one whose leading words are own-money wording with no account fact (SI2a as built, contracts.md version 2.6; for an abstention `ruleCandidates(m)` gives the candidates to store), so the sign rule can only fail for a credit answered `transfer_person`: `resolveDecision` takes the direction and treats a top option that `allowedFor` forbids as below the threshold (`other` · `needs_review` · `below_threshold`, forbidden candidates dropped). contracts.md §1.
6. `.catch` logs `classification_failed` with the error name; `.finally` releases the customer's slot.
7. One log line per run: `classification_run {items, decided, review, unavailable, ms}`. No ids, no text.

With `wait: true` the function awaits the customer's run (and one more pass if movements were left over by a run already in flight).

`saveCategories` never overwrites a confirmed row (SI2b), so a correction made during a run wins.

**Why a detached promise and not Next's `after()`:** the tests call route handlers and this function directly, outside a Next request scope, where `after()` is not available; the app runs as one long-lived Node process. The builder reads `node_modules/next/dist/docs/` on background work first (AGENTS.md) and says in the change note if a supported primitive fits both.

## `bankView`

```ts
// src/banking/view.ts
export async function bankView(userId: string, opts?: { classify?: 'background' | 'none' }) {
  // the three bank reads, sort, withCounterparties: unchanged
  // SI4: classifyMovements({userId, movements, ownAccountIds}) inside try/catch; never throws
  return { accounts, movements, contacts, categories }; // categories: Map<string, RowCategory>
}
```

In SI4 the route ignores `categories`: **the dashboard's response is byte-for-byte what it was.** SI5 attaches them. `classify: 'none'` skips the pipeline (not used yet).

## Tasks

1. Tests first.
2. `tests/helpers/bank.ts` default; run the whole suite to confirm nothing else changed.
3. Move `bankView`; run the suite and the e2e suites (no behaviour change).
4. `classify.ts`.
5. README e2e line.
6. Gates, including `npm run e2e`.

## Tests first (`tests/si4-pipeline.test.ts`)

Fake `Decider` objects passed through `deciders`; a temp `DATA_DIR`.

- `resolveDecision`: at the threshold, below it, top `other`.
- Sync: simulator-like movements are decided before the first `await` resolves; `pending` only for `ZZQXV …`.
- Own pair without an app record → both legs `savings_internal`.
- Background: decided above and below the threshold; chain fall-through; all fail → `decider_unavailable`, and a second call makes no decider call; after faking `updatedAt` to 25 hours ago, one more call is made.
- One call per merchant key and sign; an empty key makes none.
- `merchantProfile`, pure: three late weekend movements → `late_night`, `weekend`, `few`; a 2-of-3 majority counts, 1-of-2 is `mixed`; one per month in two months → `recurring_monthly`; four in a month → `frequent`; one → `once`; `profile: false` → the neutral labels. The fake decider receives the profile and no raw amount or time.
- Single-flight: two concurrent calls → one decider call per item.
- Confirmed wins: save a `user` row while a fake decider is waiting; release; the row is still the customer's.
- A store failure (closed DB) → every movement `pending`, no throw.
- The dashboard answers in under 500 ms while a fake decider hangs (through `callApi`).
- **Regression proof for the `setupEnv` default:** with `DECIDER=auto` and a fake OpenAI key, one existing chat test shows unexpected model requests after the route change; with the default it does not. Save both outputs.

**Must fail before:** module not found; the leak above.

e2e: no new suite; the existing ones pass with `DECIDER=none`.

## Evidence

`.scratch/after/feat-si4-pipeline/`: `unit-before.txt`, `auto-leak-before.txt`, `unit-after.txt`, `dashboard-latency.txt`, `dashboard-diff.txt` (response before and after: identical), `e2e.txt`, `verify.txt`, `alt-bank.txt`.

## Acceptance

- The dashboard's response is unchanged.
- No decider request without a stored-row miss; none with `DECIDER=none`; none repeated after a failure within 24 hours.
- Log lines carry counts only.
- Gates green; change note; id `SI4`.

## Verification (V-cycle)

`test/si4-core` tests REQ-CORE-1 … -22 through `classifyMovements` only, written from contracts.md by an independent test author. The SI8 harness measures the held-out set (REQ-HO-1 … -3). The builder does not write or edit `tests/acceptance/*`.
