# Testing against an independent bank

`docs/contracts.md` says evaluation "may use an independent implementation of this contract". `tests/alt-bank/server.ts` is such an implementation, written from the contract text only (it imports nothing from `src/` or `simulator/`). Running the app against it shows which behaviour depends on the contract and which depends on simulator details.

## Run

```sh
npm run test:alt-bank        # tests/alt-bank.test.ts only: 22 tests (also part of `npm test`, offline, about 15 s)
BANK_IMPL=alt npm test       # whole suite with startSimulator() starting the alt bank (see "Coupled tests")
```

App and UI against the alt bank, e.g. alt bank on 4611 and app on 3610:

```sh
BANK_PORT=4611 node --import tsx tests/alt-bank/server.ts
DATA_DIR=$PWD/.scratch/alt-data npm run setup
DATA_DIR=$PWD/.scratch/alt-data APP_PORT=3610 BANK_URL=http://127.0.0.1:4611 BANK_EXTERNAL=1 npm run dev
APP_URL=http://127.0.0.1:3610 BANK_URL=http://127.0.0.1:4611 node tests/e2e/transfer-experience.e2e.mjs
```

`BANK_EXTERNAL=1` stops `scripts/dev.ts` from starting the bundled simulator (a `BANK_URL` on another port than `BANK_PORT` does the same); it waits for the alt bank's `/health` instead (DV1, fixes ALT-2). The alt bank uses `BANK_SERVICE_SECRET` from the environment only (not `.env.local`), default `banana-local-service`.

## Control API (tests only)

Not part of the contract and never used by the app. Header `x-alt-control: alt-control` (`ALT_BANK_CONTROL_TOKEN`).

| Route | Effect |
|---|---|
| `POST /_control/reset` | Reseed, clear faults and options |
| `POST /_control/config {…}` | Merge options below |
| `POST /_control/reveal` | End the read lag: every operation committed so far is visible now |
| `POST /_control/balance {accountId, balanceCents}` | Set a balance |
| `POST /_control/movement {accountId, amountCents, description, createdAt?}` | Add one movement that is not a transfer (SI9): id `inj-<n>`, dated now unless `createdAt` is given; the balance changes by `amountCents` (an integer, negative for a payment). A body that is empty, malformed or not a JSON object → `400` (IT2); unknown account → `404`; a non-integer amount, a missing description, or a `createdAt` that is not an ISO date-time with `Z` or `±HH:MM` → `400` |
| `GET /_control/state` | Accounts, operations, options |

Every control route answers the state (accounts, operations, options).

| Option | Default | Meaning |
|---|---|---|
| `faults` | `[]` | Queue consumed by each valid `POST /v1/transfers`, new or replay: `reject-before` (503, no effects), `drop` (commit, then close the socket), `gateway-504` (commit, then 504 with an HTML body) |
| `commitDelayMs` | 0 | Delay inside the transfer lock before the atomic commit; concurrent transfers wait |
| `respondDelayMs` | 0 | Delay after the commit, before the response |
| `readLagMs` | 0 | An operation committed now is invisible to `GET /v1/operations/:ref` and the operator listing for this long (404 / absent) |
| `readFaults` | 0 | Next N operation lookups answer 503 |
| `movementsLimit` | 25 | Movements page size (simulator: 100) |
| `movementsOrder` | `newest` | `oldest` returns the most recent page oldest first |
| `operatorLimit` | 20 | Operations in `/v1/operator/customer`, newest first, plus `hasMore` |

## Demo seed (SI9)

The default seed gives each customer 30 rows `Card payment <d>`. For the demo the bank loads realistic movements instead, for every customer since DS2:

```sh
npm run demo                    # seeded alt bank on 4611 + app on 3610, data in .data-demo
npm run demo -- --production    # the same on the production build (`npm run build` first)
npm run demo -- --fresh         # first removes the app database of the demo directory (rules, confirmed categories, conversations)
```

`npm run demo` (`scripts/demo.ts`) creates and seeds its data directory when it has no app database, starts the alt bank with the seed file and `ALT_BANK_MOVEMENTS_LIMIT=100`, then the app with `BANK_EXTERNAL=1`, and stops both on exit. It prints the app URL and the active decider (`systemone`, `openai` or `none`). It needs no key: with only `OPENAI_API_KEY` the OpenAI decider runs, with no key the rules alone. It never uses `.data`, 3000 or 4001. `--fresh` (IT7) removes only `app.sqlite` and its `-wal` / `-shm` in the demo directory (the demo bank is in memory, so that is the whole state) and is refused, before anything starts, for a directory outside the repository, the repository itself, `.data`, a link that leads to any of those, or a directory an application is running on.

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_DATA_DIR` | `.data-demo` | The demo app's data directory |
| `DEMO_APP_PORT` | 3610 | App port |
| `DEMO_BANK_PORT` | 4611 | Alt bank port |
| `ALT_BANK_SEED_FILE` | unset | Read by the alt bank itself: path to a seed JSON. `npm run demo` sets `tests/alt-bank/demo-seed.json` |

To start the seeded bank alone (for tests):

```sh
BANK_PORT=4611 ALT_BANK_SEED_FILE=tests/alt-bank/demo-seed.json ALT_BANK_MOVEMENTS_LIMIT=100 node --import tsx tests/alt-bank/server.ts
```

Seed file (`tests/alt-bank/demo-seed.json`):

```json
{
  "openingAt": "2026-07-01T06:00:00.000Z",
  "openings": { "acc-lucia": 249182 },
  "movements": [
    { "id": "demo-lucia-001", "accountId": "acc-lucia", "amountCents": -95000,
      "description": "RECIBO ALQUILER INMOB. CASTELLANA 41 SL", "createdAt": "2026-08-04T06:00:00.000Z" }
  ],
  "transfers": [
    { "userId": "lucia", "reference": "demo-lucia-savings-08", "fromAccountId": "acc-lucia",
      "toAccountId": "acc-lucia-savings", "amountCents": 20000, "concept": "ahorro mensual",
      "createdAt": "2026-08-29T07:00:00.000Z" }
  ],
  "descriptions": { "demo-lucia-savings-08": "ahorro mensual", "ref-historic-lucia": "Transfer · Team dinner" }
}
```

- An account with rows in `movements` gets them instead of the card payments; each amount is added to its balance. `openings` sets an account's initial deposit and `openingAt` (DS2) the date of every initial deposit (2026-08-01 without it). `transfers` are committed like real transfers (two movements, one operation). Accounts not in the file, and a bank started without the variable, keep the default seed. `POST /_control/reset` loads the file again.
- `descriptions` (DS1) maps a seeded transfer's reference to the text of its two movements, in place of this bank's `To acc-x: concept` / `From acc-x: concept`: the app prints the bank's text as the title of a transfer it did not send itself, and the demo's first screens showed raw account ids. The file sets it for every seeded transfer and for the two `ref-historic-*` ones (DS2: a transfer between the customer's own accounts reads as its concept, any other as `Transfer · <concept>`). A transfer made while the bank runs, and every transfer of a bank started without the file, keeps the bank's own wording. The texts were chosen so that no category changes: the savings pair is still recognised by its operation, and `Transfer · …` is a transfer wording the rules already know (`npm run offers:table` and `npm run observations:table` print the same before and after).
- **The dataset (DS2, 2026-10-06; DS3, 2026-10-07).** The file holds 591 movements and 14 transfers for all eight customers, three full months and the first days of October (2026-07-01 … 2026-10-06; Madrid local times stored as UTC), 66 to 86 movements each (initial deposits included; under the page of 100 that `npm run demo` asks for), with spending in at least six categories in October and five in September for every customer, and since DS3 groceries in four to eight trips a month as the block after housing: salary, pension, weekly pay or invoices, rent or mortgage, direct debits, card purchases with merchant and city, subscriptions, Bizum, cash, monthly transfers to the customer's own savings (Lucía, Carla, Elena, Inés), Hugo's rent to Omar, and texts no rule knows, which go to review. The table of every row, with what the rules decide, is [`demo-bank-dataset.md`](plan/23-spend-insights/inputs/demo-bank-dataset.md); the rows are written in `gen-demo-seed.mjs` beside it, which writes the file. Lucía's 29 and Bruno's 28 rows of SI9 ([the plan's tables](plan/23-spend-insights/inputs/demo-bank-dataset-proposal.md)) are in it unchanged, with the same id, date, amount and text (DS3 added rows to their August and September, so those months' totals changed). No customer of the demo bank keeps the default `Card payment` rows; the two `ref-historic-*` transfers stay in the default seed and are not in the file.
- Balances kept from before DS2 (the openings changed instead): `acc-lucia` 2,937.61, `acc-lucia-savings` 1,300.00, `acc-bruno` 4,592.52, `acc-diego` 75.00. The others are new: Carla 2,089.01 and 1,650.00, Elena 2,863.96 and 1,800.00, Hugo 3,472.12, Inés 4,832.85 and 1,200.00, Omar 6,160.22.
- Ids are `demo-<customer>-NNN` (Lucía's and Bruno's SI9 rows keep their numbers and their new rows continue from 33 and 30; the other six were numbered by date in DS2; the rows of DS3 continue after each customer's last id) and dates are fixed, so they are the same on every start. Movements of transfers get random ids, as always in this bank.
- A new movement during the demo, for example another payment at a merchant the customer has already categorised:

```sh
curl -X POST http://127.0.0.1:4611/_control/movement -H 'x-alt-control: alt-control' \
  -d '{"accountId":"acc-bruno","amountCents":-1500,"description":"SUMUP *ESPAI NOU"}'
```

## What differs from the simulator (all within the contract)

- In-memory state; own balances, IBANs, movement texts, 30 card payments per customer; same account ids and the two `ref-historic-*` operations the app seed refers to.
- Error bodies `{error, code, retryable}` with different wording and codes.
- New operation answers `201`, replay `200`; operations carry an extra `currency` field and `alt-` ids.
- Unknown source or destination account → `404` (simulator: `403` / `400`); same account → `400`.
- `/v1/accounts` sorted with the savings account first.
- `/v1/contacts` refused (`403`) for operators; the simulator lists every account.
- `/health` returns `{status:'up'}`.
- Faults are a queue that also hits replays (the simulator never faults a known reference), so both dispatch attempts can fail; atomicity is kept (no respond-then-commit).
- Eventual consistency on reads (`readLagMs`), smaller pages, optional oldest-first movements.
- No `/admin/*` API: e2e scripts that call `/admin/scenario` get a 404 and run on the default (normal) behaviour.

## Coupled tests

With `BANK_IMPL=alt`, some of the existing tests fail because they read or write the simulator's SQLite (`bankDb`, `seedBank`, `setScenario`), expect the simulator's seed ids (`op-historic-lucia`), account order, or operator contacts. In round 3 they were 14, each triaged as a test-tooling coupling, not an app defect; the list and outputs are in `.scratch/audit-03/alt-bank/`.

On 2026-10-05 at `dev` @ `cf3e7b6` the same run (`DECIDER=none BANK_IMPL=alt npm test`, after `npm run build`) gives 1045 tests, 1016 pass, **27 fail**, 2 skipped ([02-npm-test-bank-impl-alt.txt](../.scratch/after/docs-fx5-alt-bank-triage/02-npm-test-bank-impl-alt.txt)). The 27 are the same tests as on 2026-10-04 at `792d891`. Each one was triaged (FX5) by reading the test and its failure; the line of every assertion and of every cause is in the change note `2026-10-05-docs-fx5-alt-bank-triage.md` (`.artifacts/`).

After FX6-a (ALT-3b, below) the same run on the FX6 branch, merged with `dev` @ `b8ca20a`, gives 1072 tests, 1046 pass, **24 fail**, 2 skipped ([final-npm-test-bank-impl-alt.txt](../.scratch/after/fix-fx6-operator-and-error-wording/final-npm-test-bank-impl-alt.txt)): the 27 without O1, S3 and S5. The two tables below are that run.

| Class | Meaning | Failures |
|---|---|---:|
| a | The test expects the simulator's own seed: an operation id, the order of the accounts, the texts of the movements | 4 |
| b | The test needs a simulator failure profile, set with `setScenario` in the simulator's SQLite | 6 |
| c | The test reads or writes the simulator's SQLite directly (`bankDb`): it counts operations there, or sets a balance there | 13 |
| d | The app behaves differently against this bank | 1 (O3, what ALT-3b leaves by design: nothing was recorded, so the id stays; was 4) |
| e | The alt bank deviates from the contract | 0 |

| Test file | Failures | Class | Reason |
|---|---:|---|---|
| `answers` | 1 | a | Expects the model instructions to say `customer holds: Aurora account`; this bank lists Carla's savings account first (`Personal savings, Aurora account`). The contract fixes no order |
| `ar1-stale-proposal` | 1 | c | Its last assertion counts the operations in the simulator's SQLite; every assertion on the app passed before it |
| `operator-view` | 2 | a ×1, d ×1 | F5b expects the id `op-historic-lucia`, this bank's ids are `alt-…` (the verified status `completed` passed). O3 expects `accountNames['acc-bruno']` for the seeded intent of `case-lucia`: that conversation has no recorded step, this bank gives an operator no contacts, so no name exists to show and the id stays (ALT-3b, the part that is not a defect) |
| `pt1-f1-failed-after-dispatch` | 4 | c ×3, b ×1 | Counts the operations in the simulator's SQLite; one case also needs `lost-response` |
| `pt1-prepared` | 4 | c ×4 | Three count the operations in the simulator's SQLite; one sets Diego's balance there, so this bank still refuses the amount |
| `si6a-attachment` | 1 | a | Expects no buttons on the answer. The movement the test attaches is, in this bank's seed, one no rule classifies (`Card payment <d>`), so the answer carries the category buttons, as specified (`src/agent/quick-replies.ts:47-56`); the simulator's is classified |
| `transfer-idempotency` | 5 | b ×3, c ×2 | `lost-response`, `slow-response`, `read-unavailable`; the other two count the operations in the simulator's SQLite |
| `transfers-errors` | 2 | c ×1, a ×1 | One sets Diego's balance in the simulator's SQLite; one expects the two accounts in the simulator's order (the app keeps the bank's order and never chooses by it: `src/banking/recipients.ts:7-11`) |
| `transfers-review` | 1 | c | Counts the operations in the simulator's SQLite |
| `transfers-routes` | 3 | c ×1, b ×2 | The same count; `lost-response`, `slow-response` |

**Classes b and c, checked and not only read.** The 11 files were run again, unedited, against this bank, with the three simulator modules the tests import (`simulator/db`, `simulator/bank`, `simulator/seed`) redirected to this bank's control API: the operations counted at the bank, the balance set at the bank, and each profile as this bank's fault (`gateway-504`, `respondDelayMs: 2600`, `readFaults: 1`). The 19 tests of classes b and c pass; the 8 of classes a and d failed as before (that run is of `cf3e7b6`, before FX6-a) ([03-failing-files-with-shim.txt](../.scratch/after/docs-fx5-alt-bank-triage/03-failing-files-with-shim.txt): 80 tests, 72 pass, 8 fail; the redirect is `shim-register.mjs` and `sim-shim.mjs` in that folder, used for this evidence only).

**Money paths by hand.** [04-hand-run-money-paths.txt](../.scratch/after/docs-fx5-alt-bank-triage/04-hand-run-money-paths.txt) (`hand-run.ts` in that folder, alt bank on 4840, operations and balances read from the bank): a prepared transfer sent four times, three of them in parallel, is one proposal and no operation; its confirmation is one operation; a second confirmation returns the same operation; two concurrent confirmations are one operation (one answers `completed`, the other `processing`, as on the simulator); a confirmation whose response is lost (dropped connection, `504`, `504` then a `503` lookup) or refused before any effect (`503`) ends `completed` with one operation, and the source balance falls by the amount once. 45 checks, all OK.

**What this shows and does not show.** No failure of the 27 (now 24) is a transfer that is sent twice, lost or reported wrongly on this bank. It does not show that the app is right against any bank: this bank is one reading of the contract, written by the same author; `slow-response` here delays the retry as well, which the simulator does not; the hand run is one run, not a measurement. The checks that are meant to pass on this bank are `npm run test:alt-bank` (22 of 22) and the demo-bank browser suites; `BANK_IMPL=alt npm test` is not expected to be green while 23 of those tests depend on the simulator's internals or seed and one (O3) expects a name that only an operator's contacts read can give.

## Findings (app)

| Id | Severity | Where | Behaviour against the alt bank | Test |
|---|---|---|---|---|
| ALT-1 | P2 | `app/page.tsx:665` | "Recent activity" shows the first 7 movements in bank order; the contract does not fix the order, so an oldest-first page shows old movements. **Fixed by R4**: the dashboard sorts the movements newest first | `tests/alt-bank.test.ts`, "dashboard shows the newest movements first whatever order the bank uses" |
| ALT-2 | P1 | `scripts/dev.ts:20-23, 44-45` | `npm run dev` always spawns the simulator on `BANK_PORT`; if the external bank already listens there, the simulator exits with `EADDRINUSE` and the app stops. **Fixed by DV1**: `BANK_EXTERNAL=1`, or a `BANK_URL` that is not the local `BANK_PORT`, skips the simulator | evidence `dev-same-port.txt`; after: `.scratch/after/chore-delivery/dv1-*.txt`, `tests/bank-mode.test.ts` |
| ALT-3 | P2 | `src/operator/view.ts:53-62` | Account names come only from `/v1/contacts` as an operator (not in the contract); when refused, case detail and summary show ids, although `/v1/operator/customer` returned the customer's labelled accounts. **Fixed by OP1**: the labelled accounts of `/v1/operator/customer` are the fallback | `tests/alt-bank.test.ts`, "OP1: operator case detail names the customer's own accounts without operator contacts" |
| ALT-3b | P3 | `src/operator/view.ts` (`requestedDestination`, the names read from the case's steps), `src/banking/actions.ts` (`proposeTransfer`) | What was left of ALT-3. When the bank refuses `/v1/contacts` to an operator, an attempt the app refused before proposing it read `to acc-bruno` or `to "Lucía" (as the customer named them)`. **Fixed by FX6-a**: the insufficient-funds refusal carries the destination resolved in the customer's own session, as every proposal result does, and the case detail reads the destinations its own steps recorded before the bank's names (`accountNames` holds both, FX6-e). Nothing is invented: an attempt refused before any bank read (an invalid amount) records no name and reads `to account acc-elena` unless another step of the same case named that account; the seeded intent of `case-lucia` has no recorded step and keeps the id (O3 still fails on this bank); a name another customer's session recorded is not used | `tests/alt-bank.test.ts`, "FX6-a: a refused attempt names the other party from the recorded step, never from a guess"; `BANK_IMPL=alt`: `tests/operator-view.test.ts` O1, `tests/polish-semantics.test.ts` S3 and S5 pass |
