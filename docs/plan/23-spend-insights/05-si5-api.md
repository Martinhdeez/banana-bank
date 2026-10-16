# 05 — SI5 API: categories on rows, summary, set category, rules, audit

Branch `feat/si5-insights-api`. Size **M**. Priority **must**. Depends on SI4. Blocks SI6b, SI7a.

## Goal

Expose the stored categories and let the customer change them: a category on every movement and table row, the spending summary inside the dashboard response and on its own route, one write route with "apply to similar" (D9), the customer's rules with undo, a "try again" for failed classification, and an audit event for every change.

> **As built (PR #98).** `src/insights/summary.ts` already exists with `spendingSummary(view, range, decider)`, and `dashboard()` already returns `category` on movements and `insights`: SI4 delivered both on the orchestrator's decision ([04](04-si4-pipeline.md), "As built"). SI5 adds `setCategory`, `removeRule` and `reclassify` to that file and everything else below.

## Files (owner: this item only)

| File | Change |
|---|---|
| `src/insights/summary.ts` (new, server) | `spendingSummary`, `setCategory`, `removeRule`, `reclassify` |
| `src/ui-helpers.ts` | `Movement` and `ActivityRow` gain optional `category`; `activityRows` copies it |
| `app/api/[...path]/route.ts` | `dashboard()` returns `category` on movements and `insights`; `movementsRoute` passes categories through; new `insights` resource; `routes` entry; `DELETE` export; origin check on every non-GET |
| `src/banking/movements.ts` | export the `when` parsers; nothing else (the filter and the CSV are SI11) |
| `src/http.ts` | `routeLabel`: `insights/…` paths keep their fixed segments and hide the merchant key |
| `src/operator/view.ts` | `describeEvent`: one line each for `category.set`, `rule.created`, `rule.removed` (so a case timeline does not show a raw kind) |
| `docs/integration-surface.md` | routes, shapes, the audit events |
| `tests/si5-insights-api.test.ts` (new) | unit and route tests |

## Shapes and routes

Frozen in [contracts.md §3](contracts.md#3-http): `RowCategoryOut`, `SpendingSummary`, `SetCategoryResult`, the seven routes, the totals rules, the audit events.

### Categories on rows

- `dashboard()`: each movement gets `category = {...categories.get(m.id), movementIds: [m.id]}`.
- `activityRows` (`src/ui-helpers.ts`): a row built from a movement copies `m.category`. For a **merged internal pair** (row id = the operation id), the row takes the debit leg's category with `movementIds` = both legs' ids, so a change from the chip posts both. For one account's view of an internal move (the `between` rows), `movementIds` is that leg only. Proposal rows have no category. Additive: existing fields and their order stay.
- `movementsRoute` (search, CSV): `bankView(userId, {classify: 'background'})` already carries categories; rows get them through `activityRows`. No new parameter here (SI11).

### Summary

`spendingSummary(view, range)` is pure over a `bankView` result, so the dashboard computes `insights` from **the same bank read** as its rows (no second read, no disagreement between the card and the table). `GET /api/insights/spending` exists for `from`/`to` and for the agent tool; it reads the bank itself.

- Window: `{returned, oldestAt, mayBeTruncated}` from `movementWindow`, without the hard-coded `limit` (the alt bank pages lower than 100). `partial` when `from` is earlier than `oldestAt`.
- Query parsing reuses the `when` parsers of `src/banking/movements.ts` (export them) and the existing error text "The start date is after the end date.".

### Set category

`setCategory(userId, view, {movementIds, category, applyToSimilar}, audit)`:

1. Ownership: every id in `view.movements`, else `404`, nothing written.
2. Sign rule (`allowedFor`) for every id, else `400 "This category does not fit this movement."`, nothing written.
3. One transaction: each movement → `confirmed` · `user` · reason `user`.
4. `similar`: for each distinct non-empty merchant key, the **other movements of `view`** with that key and sign that are not already that category and confirmed. Stored rows of vanished ids are not looked at.
5. With `applyToSimilar`: `setUserRule` per key; the similar movements → `confirmed` · `user_rule` · reason `user_rule:<key>`.
6. Audit events (below).

### Rules and reclassify

- `GET /api/insights/rules` → `listRules`.
- `DELETE /api/insights/rules/:merchantKey` → `removeRule`: delete the rule; delete the stored rows of movements in `view` whose source is `user_rule` and merchant key is that key; call `classifyMovements` for them (rules now, decider in the background). `reclassified` = their count. Rows with source `user` stay.
- `POST /api/insights/reclassify` → delete the stored rows in `view` with reason `decider_unavailable`, call `classifyMovements`. `queued` = their count.

Route plumbing the code needs:

- `app/api/[...path]/route.ts` exports only `GET` and `POST`: add `export const DELETE = handle`.
- `handler()` checks `sameOrigin` only for `POST`: change to every method other than `GET`.
- `proxy.ts` and `next.config.ts`: check that nothing there assumes GET/POST only (SC1's path guard, the CSP). Note the result in the change note.
- No SEC1 bucket for these routes (no money, no model call in the request, bounded writes), as round 5 decided for favourites.

### Audit

`recordEvent` (`src/telemetry.ts`, hash-chained) with `{userId, conversationId: null, runId: randomUUID(), intentId: randomUUID()}` for the UI channel; the agent passes its own context (SI6b). `setCategory` and `removeRule` take `audit: {ctx: ToolContext; channel: 'ui' | 'chat'}` so both channels share one code path.

- `category.set` per changed movement: `{channel, movementId, from, to, source}` (`from` is the previous category or `null`).
- `rule.created` / `rule.removed`: `{channel, merchantKey, category}`.

Events hold movement ids and merchant keys (they are the customer's audit record, like transfer events hold account ids). Log lines do not.

Check that the CF5 notification derivation ignores the new kinds.

## Tasks

1. Tests first.
2. `ui-helpers.ts`.
3. `summary.ts` (pure summary first, with fixtures).
4. Route: dashboard fields, `insights` resource, `DELETE`, origin check, `routeLabel`.
5. Audit events and `describeEvent` lines.
6. `docs/integration-surface.md`.
7. Gates.

## Tests first (`tests/si5-insights-api.test.ts`)

Simulator and `BANK_IMPL=alt`; `DECIDER=none` unless stated.

- Summary, pure: a fixture with debits, a refund, an own transfer, an opening row, a salary → the totals of contracts.md "Totals".
- Dashboard: categories on movements; `insights` equals `GET /api/insights/spending`.
- Merged internal row: `savings_internal` with two `movementIds`; posting them changes both legs.
- Set, similar (current view only: a stored row for an id the bank no longer returns is not counted), apply to similar, a later movement of that merchant.
- Ownership 404, sign rule 400, validation 400s, operator 403, anonymous 401, foreign origin on POST and DELETE 403.
- Rules: list, delete (movements back to review; hand-set ones stay), delete unknown → `removed: false`.
- Reclassify: with a decider that fails, rows are `decider_unavailable`; after the route, a working decider classifies them.
- Audit: one `category.set` per movement with `from`/`to`; `rule.created`; `rule.removed`; the audit chain still verifies.
- Access-log label: `DELETE insights/rules/ESPAI%20NOU` is logged as `insights/rules/:key`.
- Existing suites green (rows gained an optional field only).

**Must fail before:** 404 "Route not found.", `category` undefined, `insights` undefined.

## Evidence

`.scratch/after/feat-si5-insights-api/`: `unit-before.txt`, `unit-after.txt`, `authz.txt`, `summary-sample.json`, `audit-events.txt`, `e2e.txt`, `verify.txt`, `alt-bank.txt`.

## Acceptance

- The dashboard and movements responses change only by the added fields.
- No write for a movement id that is not the actor's; no write that breaks the sign rule.
- Every change leaves an event.
- Gates green; change note; id `SI5`.

## Verification (V-cycle)

`test/si5-insights-api` tests REQ-SI5-1 … -14 against the alt bank with the demo seed and the inject route ([contracts.md §7](contracts.md#7-alt-bank-tests-and-demo-only)), written from contracts.md by an independent test author. The builder does not write or edit `tests/acceptance/*`.
