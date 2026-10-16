# 11 — SI11 Category filter and CSV columns (optional, last)

Branch `feat/si11-filter-csv`. Size **S**. Priority **could**: built only if every other item is merged and time remains. Depends on SI5 and SI7a. No demo scene uses it.

## Goal

Filter the movement search by category and add the category to the CSV export.

## Files

| File | Change |
|---|---|
| `src/banking/movements.ts` | `category` in `movementFilters` (strict enum of the taxonomy ids); `filterRows` keeps rows whose `category?.id` matches; CSV header gains `,category,category_state` **at the end** |
| `app/_components/MovementFilters.tsx` | a category `select` in "More filters" (all ten, plus "All") |
| `tests/cf2-movements-export.test.ts` | the `HEADER` constant |
| `tests/si11-filter-csv.test.ts` (new) | tests |
| `docs/integration-surface.md` | the parameter and the columns |

- Appending keeps existing column positions. Text cells go through `csvField(…, true)` (formula guard).
- `category=other` returns the review list and confirmed "other".
- An unknown id → `400 "Invalid request data."`.

## Tests first

- `?category=groceries` returns only those rows; `?category=nope` → 400.
- CSV: header and one row with its two cells; a merchant starting with `=` is still guarded.
- The select sends the parameter and "All" removes it (render test, the pattern of `tests/cf3-search-ui.test.ts`).

## Evidence

`.scratch/after/feat-si11-filter-csv/`: `unit-before.txt`, `unit-after.txt`, `e2e.txt`, `verify.txt`.

## Verification (V-cycle)

No test branch. The reviewer checks REQ-SI11-1 and -2. If it is not built, SI10b lists it as pending.
