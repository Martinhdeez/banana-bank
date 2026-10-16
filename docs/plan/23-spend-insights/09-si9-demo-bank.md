# 09 — SI9 Demo bank: seed for Lucía and Bruno, inject route, `npm run demo`

Branch `feat/si9-demo-bank`. Size **S**. Priority **must**: it is the demo, and it is the server every test author uses. Depends on nothing; first wave.

## Goal

A bank whose movements look real: dirty ES/EN card strings, repeated merchants, merchants no rule knows. The simulator gives each customer five clean words that rules classify completely, so there is nothing to resolve. `simulator/` is never modified; the demo runs on the independent bank the repository already has (`tests/alt-bank/server.ts`), which also shows the feature on "another bank with the same contract".

## Data (already in the repository; do not re-specify)

[`inputs/demo-bank-dataset-proposal.md`](inputs/demo-bank-dataset-proposal.md): take the tables **`lucia`** (32 rows) and **`bruno`** (29 rows) as they are, and its "Loading" section. Not the other six personas. Differences from the proposal ([inputs/README.md](inputs/README.md), point 4): the expected labels of Lucía row 26 and Bruno rows 1 and 13 are `transfer_person`; scenario 5 is dropped.

## Files (owner: this item only)

| File | Change |
|---|---|
| `tests/alt-bank/demo-seed.json` (new) | Lucía's and Bruno's rows |
| `tests/alt-bank/server.ts` | `ALT_BANK_SEED_FILE` in `seed()`; `POST /_control/movement` |
| `scripts/demo.ts` (new) | starts the seeded alt bank and the app |
| `package.json` | `"demo": "node --import tsx scripts/demo.ts"` |
| `docs/testing-alt-bank.md` | the variable, the route, the seed |
| `README.md` | one Commands row |
| `tests/si9-demo-bank.test.ts` (new) | tests |

## Seed file

```json
{
  "openings": { "acc-lucia": 300000 },
  "movements": [
    { "id": "demo-lucia-001", "accountId": "acc-lucia", "amountCents": -95000,
      "description": "RECIBO ALQUILER INMOB. CASTELLANA 41 SL", "createdAt": "2026-08-04T06:00:00.000Z" }
  ],
  "transfers": [
    { "userId": "lucia", "reference": "demo-lucia-savings-08", "fromAccountId": "acc-lucia",
      "toAccountId": "acc-lucia-savings", "amountCents": 20000, "concept": "ahorro mensual",
      "createdAt": "2026-08-29T07:00:00.000Z" }
  ]
}
```

- Ids `demo-lucia-NNN`, `demo-bruno-NNN`, numbered as in the tables.
- **Dates are fixed** (the tables' local times in `Europe/Madrid`, stored as UTC; CEST is UTC+2 for the whole window, 2026-08-04 … 2026-10-02). Fixed ids and dates keep fingerprints stable, so categories confirmed in a demo survive a bank restart. The video asks about September and August, which the data covers.
- Rows with a counterparty in the roster (Lucía → her savings) go in `transfers` and are replayed through the existing `commit()`. The two EXISTING transfers of the default seed (`ref-historic-lucia`, `ref-historic-elena`) stay where they are and are not seeded twice. Movements created by `commit()` get random ids (the alt bank's behaviour); they are own transfers and person transfers, decided by rule on every start, so nothing is lost.
- Fictional people only; merchant names are ordinary public brand names used as card descriptors.

## Alt bank changes (additive; default behaviour unchanged)

1. In `seed()`: when `ALT_BANK_SEED_FILE` is set, for the accounts that have rows in the file, replace the `Card payment` loop with the file's movements (push each, add its amount to the balance), apply `openings`, and call `commit()` for each entry of `transfers`. Other customers keep the default seed. About 15 lines.
2. `POST /_control/movement {accountId, amountCents, description, createdAt?}`: push one movement with id `inj-<n>` (a counter), dated now unless given; adjust the balance; answer the state like the other control routes; unknown account → `404`. It is needed for "a new movement of a learned merchant" in the demo and for every acceptance test that needs an unknown movement (`ZZQXV …`).

Both are frozen in [contracts.md §7](contracts.md#7-alt-bank-tests-and-demo-only).

## `npm run demo`

`scripts/demo.ts`:

1. `DATA_DIR` = `DEMO_DATA_DIR` or `.data-demo`. **If it has no app database, run the setup step for it** (the same function `npm run setup` uses), so a fresh extract works with one command. Never `.data`.
2. Spawn `tests/alt-bank/server.ts` with `ALT_BANK_SEED_FILE=tests/alt-bank/demo-seed.json`, `ALT_BANK_MOVEMENTS_LIMIT=100`, `BANK_PORT` = `DEMO_BANK_PORT` or 4611.
3. Spawn `scripts/dev.ts` with `BANK_EXTERNAL=1`, `BANK_URL` to that bank, `APP_PORT` = `DEMO_APP_PORT` or 3610; `--production` is passed through.
4. Print the app URL and which decider is active (`systemone`, `openai` or `none`); stop both on exit.

`DECIDER` is left to the environment: with only `OPENAI_API_KEY` the OpenAI decider runs; with no key, rules only. `npm run demo` needs no decision-model key.

## Tests first (`tests/si9-demo-bank.test.ts`)

- Without the variable: `/v1/movements` for `lucia` has the `Card payment` rows.
- With it: ids start with `demo-`; counts match the file; balance = opening + movements; dates are the file's; a second start gives the same ids.
- The contract holds: a transfer commits and replays (one case of `tests/alt-bank.test.ts`).
- Inject: needs the control header; the movement appears for that customer only; the balance moves; unknown account → 404.
- `scripts/demo.ts` with a missing `DATA_DIR` creates and seeds it (run with temp ports, wait for `/api/health`, stop).
- No description of the seed is in `inputs/eval-set-dev.jsonl` with a different expected label (a consistency check on data, dev set only).

**Must fail before:** ids are `m-lucia-N`; no route; no script.

## Evidence

`.scratch/after/feat-si9-demo-bank/`: `unit-before.txt`, `unit-after.txt`, `alt-bank-3runs.txt`, `demo-start.txt` (fresh data dir, no key), `verify.txt`.

## Acceptance

- `git diff --stat origin/dev -- simulator/` is empty.
- `npm run test:alt-bank` and `BANK_IMPL=alt` runs are unchanged without the variable.
- `npm run demo` never touches `.data`, 3000 or 4001.
- Gates green; change note; id `SI9`.

## Verification (V-cycle)

`test/si9-demo-bank` tests REQ-SI9-1 … -6 against the alt bank, written from contracts.md §7 by an independent test author. The builder does not write or edit `tests/acceptance/*`.
