# 23 — Verification model (V-cycle) and acceptance requirements

User requirement of 2026-10-03: acceptance is decided by tests whose author has not seen the implementation. Version 2 keeps that rule and makes it cheap: five test branches instead of nine, and a blind data set for the part where a data set is the better judge.

## Verification model (V-cycle)

```text
 requirements (REQ-…, this file) ──────────────────────► acceptance tests   (TEST AUTHOR, test/<slug>)
        │                                                        ▲
 frozen contracts (contracts.md) ──────────────────────► written against the contracts only
        │                                                        │
 item plans (NN-….md) ──► implementation + unit tests (BUILDER, feat/<slug>) ──► reconciliation (REVIEWER)

 classification core (SI1–SI4) ──► held-out set (inputs/heldout/, 100 rows no rule author has seen)
                                   + black-box tests through the ONE frozen entry point
```

### What is verified blind, and how

| Surface | Items | Blind check | Test branch |
|---|---|---|---|
| Demo bank | SI9 | acceptance tests on the alt bank | `test/si9-demo-bank` |
| Classification core | SI1, SI2a, SI2b, SI3, SI4 | (a) the **held-out set**, run by the SI8 harness, with minimum bars; (b) black-box tests through `classifyMovements` only | `test/si4-core` |
| HTTP API | SI5 | acceptance tests on the routes | `test/si5-insights-api` |
| Agent tools and chat flow | SI6a, SI6b | acceptance tests with scripted model turns | `test/si6-agent` |
| UI | SI7-slots, SI7a, SI7b | Playwright e2e | `test/si7-insights-ui` |
| Evaluation, docs, optional item | SI8, SI10a, SI10b, SI11 | reviewer, from evidence and by inspection | none |

The internal modules of SI1–SI3 (normalisation, dictionary, rules, store, decider chain) have **no** frozen signatures and no test author of their own: their builders' unit tests and the reviewer cover them, and the core is judged from outside by (a) and (b).

**At most one test author works per wave** (five branches, one after the other; see checklist-07).

### Three roles

| Role | Branch | Writes | May read |
|---|---|---|---|
| **Builder** | `feat/<slug>` | implementation, its own unit tests (the "Tests first" list of the item file), evidence, change note | the repository, except `inputs/heldout/` for rule authors (below) |
| **Test author** | `test/<slug>`, own worktree | acceptance tests only | `docs/plan/23-spend-insights/` except `inputs/heldout/`, `docs/contracts.md`, `docs/challenge.md`, and the existing test helpers (`tests/helpers/*`, `tests/e2e/env.mjs`, existing suites as style examples, `tests/alt-bank/server.ts`) |
| **Reviewer** | none | the reconciliation verdict, the merge, the held-out bars | everything |

Rules:

- The test author must **not** read the builder's branch, its PR, the implementation (`src/insights/*`, this round's changes in `src/agent/*`, `src/banking/view.ts`, `app/_components/SpendInsights.tsx`) or the builder's unit tests. Its tests fail until the implementation lands. That failure is expected; its output is stored as evidence (`.scratch/after/test-<slug>/acceptance-before.txt`).
- A test author who cannot test a requirement from the contracts stops and reports. It does not guess and does not look.
- **The builder never edits an acceptance test.** The test author never edits implementation.
- **Rule authors never read the held-out set.** The builders of SI1 and SI2a, and anyone who later edits the dictionary, the rules or the normalisation, do not open `inputs/heldout/`. They tune on the dev set only.

### Where acceptance tests live

- `tests/acceptance/<slug>-*.test.ts` (`node:test`): `npm test` runs them (glob `tests/**/*.test.ts`).
- `tests/e2e/acceptance-<slug>.e2e.mjs` (Playwright): `npm run e2e` runs them (`scripts/e2e.ts` runs every `tests/e2e/*.e2e.mjs`).
- Each test names its requirement in its title: `test('REQ-SI5-6 another customer's movement id is a 404', …)`.
- Builder tests stay in `tests/si<N>-*.test.ts` and `tests/e2e/spend-insights.e2e.mjs`. The two sets never share a file.

A test branch is merged only after the builder PRs it covers, so `dev` is always green.

### A server the test authors can use

[contracts.md §7](contracts.md#7-alt-bank-tests-and-demo-only): the alt bank with the demo seed file, `DECIDER=none`, and the inject route. It guarantees unresolved movements and repeated merchants, and `POST /_control/movement` with a `ZZQXV …` description guarantees an unknown one. For this reason SI9 is in the first wave. Model answers are produced with fake `Decider` objects (core), an HTTP stub written from contracts.md §6 (API, in-process), or stubbed `/api/*` responses (UI).

### Held-out bars

1. **Rules only, as built (reviewer of #98 and #93).** The rules-only part needs no harness: `tests/acceptance/si8-heldout.test.ts` runs the held-out set through `classifyMovements` with an empty chain, each row as its own customer. A row's `counterparty` is given as the app's record of the operation: `own` → `fromAccountId` and `toAccountId` both own; `person` → the other account is not own; `null` → no account fact. Shown = the state is not `needs_review`; strict = `expected`; lenient = `expected` or `acceptable`; wrong-but-shown = shown and not lenient. The SI8 harness uses the same mapping and definitions.
2. The first measurement through the pipeline (dev `f78941b`, `.scratch/after/test-si4-core/heldout-rules-only-aggregate.txt`) equals the one the reviewer of #91 took on `applyRules` alone (`.scratch/after/feat-si2a-rules/review-heldout-aggregate.txt`): coverage 75%, strict 72/75, lenient 74/75, wrong-but-shown 1/75, 0 of 8 adversarial rows steered. The bars in the test file are each rate minus 2 points (coverage ≥ 73%, strict of shown ≥ 94%, lenient of shown ≥ 96.7%), at most 2 wrong-but-shown rows, and "0 adversarial rows obey an injection" as a fixed bar. The file holds a skipped placeholder for the decider bars, which SI8 records.
3. The same for each decider that is run live (OpenAI; System One if a key exists): its first measurement is recorded in `docs/insights-eval.md` as the decider bar. A decider bar is checked from the evidence file, since `npm test` calls no paid model.
4. From that merge on, a change to the core must keep the rules-only bars (`npm test` fails otherwise). A bar is lowered only by the reviewer, with the reason in the change note.

### Reconciliation (reviewer)

1. Review and merge the builder PR as usual (gates in checklist-07).
2. Rebase the test branch on the new `dev`. Run the acceptance tests.
3. For each failing test, decide **against the REQ text and `contracts.md`**:
   - the implementation does not do what the REQ says → back to the builder (a fix PR); the test stays;
   - the test asserts something the REQ or contract does not say, or the requirement is ambiguous → the reviewer fixes the test and records the reason in the test branch's change note (REQ id, what was ambiguous, how it was read). An ambiguity that changes a contract goes to the orchestrator.
4. When all pass, merge the test PR, tick the items it covers, move the change notes to `.artifacts/tested/`.

## Acceptance requirements

Each REQ is observable behaviour. Shapes, names and paths are in [contracts.md](contracts.md).

### Core — SI1, SI2a, SI2b, SI3, SI4 (`test/si4-core`, through `classifyMovements` only)

- **REQ-CORE-1** Every input movement gets one entry of the contract's shape, with a category from the taxonomy that the sign rule allows.
- **REQ-CORE-2** Each simulator description gets the category the contract lists, `estimated`, source `rule`.
- **REQ-CORE-3** A movement whose counterparty is an own account is `savings_internal`, as a debit and as a credit, even when its concept names a merchant or a salary; so are both legs of one operation on two own accounts when the app has no record of it.
- **REQ-CORE-4** A debit the app sent to another person is `transfer_person` whatever its concept; a concept that names a known purpose appears in `candidates`, not as the category. The receiving credit is `income`.
- **REQ-CORE-5** Opening rows are `other`, `estimated`; a refund credit from a merchant a rule knows has that merchant's category; a salary credit is `income`. No debit is ever `income`.
- **REQ-CORE-6** The contract's merchant-key examples hold; a description with no letter has an empty key; three dirty forms of one merchant share a key.
- **REQ-CORE-7** With an empty decider chain, a `ZZQXV …` movement is `other` · `needs_review` · reason `no_decider`.
- **REQ-CORE-8** With a fake decider answering above its threshold, a `ZZQXV …` movement is that category · `estimated` · source `model`, with confidence, threshold, candidates and model id; `confidence` equal to the threshold counts as above.
- **REQ-CORE-9** Below the threshold, or when the top option is `other`, it is `other` · `needs_review` with the candidates kept.
- **REQ-CORE-10** `wait: false` resolves while a fake decider has not answered, with the movement `pending`; a later call, after the decider answered, returns the decision.
- **REQ-CORE-11** Ten movements of one merchant and sign cause one decider call; a second `classifyMovements` with the same movements causes none; two concurrent calls for one customer cause one.
- **REQ-CORE-12** A movement with an empty merchant key causes no decider call.
- **REQ-CORE-13** When every decider throws a retryable error, the movement ends `other` · `needs_review` · reason `decider_unavailable` (never `pending` with `wait: true`), and a second call does not call the decider again.
- **REQ-CORE-14** When the first decider throws and the second answers, the second's decision is stored with its model id.
- **REQ-CORE-15** A decision is stored per customer: another customer with the same movement id gets their own.
- **REQ-CORE-16** A movement whose description changed under the same id is classified again.
- **REQ-CORE-17** A fake decider is called with the cleaned description (upper case, `[A-Z0-9& ]`, at most 80 characters), the direction and the merchant profile, and with nothing else of the movement (no id, account, raw amount, time or date).
- **REQ-CORE-22** The profile a decider receives holds only the contract's labels and follows its buckets: three movements of one merchant between 00:00 and 05:59 on weekend days give `late_night` and `weekend`; movements spread over buckets give `mixed`; one movement gives `once`; one movement per month in two months gives `recurring_monthly`; four in one month give `frequent`. Still one decider call for that merchant. With `profile: false` the labels are `mixed` and `once`.
- **REQ-CORE-18** With `DECIDER=systemone`, a key, and `DECIDER_BASE_URL` pointing at a stub: the request is the contract's (path, bearer header, `model`, `state`, one `choice` question whose `criteria` keys are `DECIDER_OPTIONS` in order with `other` not first, movement text only in `state`, `state` with exactly the description, the direction and the four profile labels); the stored model id is the one the stub returned.
- **REQ-CORE-19** Against that stub: a 401 or 422 causes one request for that item; a 429 or 529 causes at most three; after a 401 no further request is made for other items; a 429 with `Retry-After: 1` is retried after about one second.
- **REQ-CORE-20** Importing the configuration with an invalid `DECIDER`, a threshold of 0 or 101, or `DECIDER=systemone` without a key throws an error naming the variable; with no keys and `DECIDER` unset the chain is empty.
- **REQ-CORE-21** A fresh database records migrations 7 and 8; after a reset (`seedApp()`) no stored category or rule remains.

### Held-out bars — core, measured by SI8 (`tests/acceptance/si8-heldout.test.ts`, written by the reviewer)

- **REQ-HO-1** Rules only, on the held-out set: strict accuracy, lenient accuracy and coverage are at or above the recorded bars, and the wrong-but-shown rate is at or below its bar.
- **REQ-HO-2** Rules only: on the adversarial held-out rows, no row gets a category that its injected text asks for unless that is its expected or an acceptable label.
- **REQ-HO-3** For each decider run live, `docs/insights-eval.md` records its first measurement as its bar, and the evidence file shows a run at or above it.

### SI5 — API (`test/si5-insights-api`)

- **REQ-SI5-1** Every bank movement in `GET /api/dashboard` and every movement row in `GET /api/movements` has a `category` of the contract's shape with `movementIds`; a merged "Between your accounts" row is `savings_internal` and lists both legs; proposal rows have none.
- **REQ-SI5-2** `dashboard.insights` and `GET /api/insights/spending` (no range) are equal for the same bank state, and their totals follow the contract: debits outside `savings_internal` as spend, refunds subtracted, credits in `income` as income, opening rows in no total; per category `confirmedCents + estimatedCents = spentCents`.
- **REQ-SI5-3** `from` and `to` limit the summary; `partial` is true when `from` is before the oldest returned movement; `from > to` is a `400` with the contract's text; an unknown or repeated key is a `400`.
- **REQ-SI5-4** Movements in `needs_review` appear in `unresolved`, grouped by merchant key with counts, totals and reason; an injected `ZZQXV …` movement appears there.
- **REQ-SI5-5** `POST /api/insights/categories` for one movement makes it `confirmed`, source `user`, and `similar` counts the other movements of that merchant **in the current bank answer**.
- **REQ-SI5-6** A movement id that is not the session customer's (another customer's, or invented) is a `404` and nothing is written, even when the list also holds valid ids.
- **REQ-SI5-7** With `applyToSimilar: true` the similar movements become that category, `confirmed`, source `user_rule`; a movement of that merchant injected afterwards is `confirmed` · `user_rule` on first read; another customer's movement of the same merchant is not.
- **REQ-SI5-8** Setting a debit to `income` or a credit to `transfer_person` is a `400` with the contract's text and writes nothing.
- **REQ-SI5-9** `GET /api/insights/rules` lists the customer's rules; `DELETE /api/insights/rules/:merchantKey` removes the rule, classifies its `user_rule` movements again (back to review when no global rule knows the merchant, as for `ESPAI NOU` or a `ZZQXV …` movement), keeps movements set by hand, and answers `removed: false` for an unknown key.
- **REQ-SI5-10** Every `/api/insights/*` route answers `403` to an operator and `401` without a session (the operator dashboard stays the inbox, without `insights`); every non-GET route answers `403` to a foreign origin; invalid bodies (unknown category, empty list, 101 ids, extra key) are `400`.
- **REQ-SI5-11** Each category change and each rule creation or removal through these routes adds one event of the contract's kind with channel `ui`.
- **REQ-SI5-12** With a model stub (`DECIDER=systemone`): a movement not yet decided is `pending` and counted in `pending`; after the stub answers, a later read has it decided; while the stub does not answer, `GET /api/dashboard` still returns `200` in under one second.
- **REQ-SI5-13** `POST /api/insights/reclassify` returns the number of `decider_unavailable` movements and makes them classifiable again.
- **REQ-SI5-14** No response of these routes, and no console output during the tests, contains the decider key, a raw description of a classified movement in a log line, or a movement id in a log line.

### SI6 — agent (`test/si6-agent`)

- **REQ-SI6-1** The five tools exist in `toolDefinitions` with the contract's names and argument schemas; `POST /api/actions` does not accept them.
- **REQ-SI6-2** `get_spending_summary` returns the same totals as `GET /api/insights/spending` for the same range, and each category lists movements with a `ref`.
- **REQ-SI6-3** `list_movements` returns each movement with its `category`.
- **REQ-SI6-4** Any tool given a movement id that is not the session customer's fails with "Movement not found." and writes nothing.
- **REQ-SI6-5** `set_movement_category` with `applyToSimilar: null` changes one movement and returns `similar` when others share the merchant; a forbidden sign combination fails and writes nothing.
- **REQ-SI6-6** `set_movement_category` with `applyToSimilar: true` creates the rule only when the newest assistant message offered it for that merchant and category; otherwise it fails with "Ask the customer first." and writes nothing.
- **REQ-SI6-7** `remove_category_rule` removes the rule and classifies its `user_rule` movements again (back to review when no global rule knows the merchant).
- **REQ-SI6-8** A message posted with `movementId` stores `extras.movement` on the user message, and the model request of that turn contains the movement id; a foreign id is a `404` with no message stored, no title change and no model request.
- **REQ-SI6-9** After a turn in which the model called `suggest_category_choices`, the assistant message has quick replies (the candidates, then `Other`, then `Skip`), and the model request of the **next** turn names that movement id, whatever the customer typed.
- **REQ-SI6-10** After `set_movement_category` returned `similar` without creating a rule, the assistant message has exactly a `Yes…` and a `No…` reply.
- **REQ-SI6-11** After a turn that called `get_spending_summary` with unresolved movements and set nothing, the assistant message has a `Review…` and a `Not now` reply.
- **REQ-SI6-12** An answer containing `[m2]` for a movement the tools returned is stored without the marker and with that movement in `extras.citedMovements`.
- **REQ-SI6-13** The insights digest and the results of the insights tools carry merchant keys, never a raw description: a description with quotes, braces and an instruction appears in them only as its key.
- **REQ-SI6-14** Each category or rule change made by a tool adds one event of the contract's kind with channel `chat`.
- **REQ-SI6-15** The contract's existing actions and the existing chat behaviour are unchanged (the existing suites pass).

### SI7 — UI (`test/si7-insights-ui`; includes SI7-slots)

- **REQ-SI7-1** `Overview` and `Assistant` render as before without the new props, and render the given content in `overview-insights` / `composer-extra` when they are passed.
- **REQ-SI7-2** On Overview each bank movement row has a `category-chip` whose text and `data-state` say whether it is estimated, confirmed, to review or being classified, and a `category-ask` button.
- **REQ-SI7-3** `spending-card` lists one `spending-category` per category with spend; its amounts equal `dashboard.insights`; `spending-window-note` is always present.
- **REQ-SI7-4** With unresolved movements, one `unresolved-group` per merchant is shown with its candidate buttons when it has candidates; with none unresolved, no group is shown.
- **REQ-SI7-5** Choosing a category in `category-select` posts that row's `movementIds` and the category; afterwards the chip shows the category as confirmed, also after a reload. The select offers no category the sign rule forbids.
- **REQ-SI7-6** After a change that has similar movements, the offer appears once; `similar-offer-yes` posts `applyToSimilar: true` and `insights-notice` then names the merchant and the category; `similar-offer-no` posts nothing more.
- **REQ-SI7-7** `insights-undo` and `rule-remove` call the rule's DELETE route; afterwards the rule is not listed and its movements are classified again (back in review for a merchant no global rule knows, such as `ESPAI NOU`). `rule-item` lists each rule the server returns.
- **REQ-SI7-8** `category-ask` opens the Assistant with `attached-movement` in the composer and sends a message whose POST carries that `movementId`.
- **REQ-SI7-9** Quick replies of the newest assistant message render as `quick-reply` buttons; a click sends its value as the next message; older messages show none. Cited movements render as `cited-movement`.
- **REQ-SI7-10** `category-why` shows the stored reason, and for a model decision its confidence and the bar.
- **REQ-SI7-11** While movements are being classified the page reads the dashboard again within 5 seconds, not only on the 20-second refresh.
- **REQ-SI7-12** At 390 px wide, Overview with the card and chips has no horizontal overflow; no console error or hydration warning appears.

### SI9 — demo bank (`test/si9-demo-bank`)

- **REQ-SI9-1** Without `ALT_BANK_SEED_FILE`, the alt bank's data and `npm run test:alt-bank` are unchanged.
- **REQ-SI9-2** With the seed file, Lucía's and Bruno's movement ids start with `demo-`, their dates are the fixed ones of the contract, the same ids come back after a bank restart, and each balance equals the opening balance plus the movements.
- **REQ-SI9-3** The bank contract holds on the seeded bank: a transfer commits once and replays.
- **REQ-SI9-4** `POST /_control/movement` adds a movement that `GET /v1/movements` returns for that customer only, and changes the balance by its amount; it needs the control header; an unknown account is a `404`.
- **REQ-SI9-5** `npm run demo` starts both services on its own ports and data directory, creating and seeding that directory when it is missing, with only `OPENAI_API_KEY` set or with no key at all.
- **REQ-SI9-6** `simulator/` has no change.

(The guarantee "Lucía has at least 5 movements to review in at least 3 groups, Bruno has `ESPAI NOU` four times" needs the pipeline; it is REQ-SI5-4's precondition and is tested there.)

### SI8 — evaluation (reviewer, from evidence)

- **REQ-SI8-1** `npm run eval:insights -- --decider=rules` exits 0 offline on the dev set and on the held-out set and reports, per set: strict accuracy, lenient accuracy (expected or acceptable), coverage, wrong-but-shown rate, and the adversarial rows on their own.
- **REQ-SI8-2** For each decider run, the report also has cost (tokens and money per 1,000 movements), latency, a reliability table (confidence bucket, rows, observed accuracy), and the order-permutation check (share of rows whose top option changes when the option order is reversed).
- **REQ-SI8-5** For each decider run, the report has an ablation column: the same set with and without the merchant profile (strict accuracy, coverage, wrong-but-shown), and says whether the profile is kept.
- **REQ-SI8-3** `docs/insights-eval.md` states the chosen option order and the two thresholds with their reasons, and marks a decider that was not run as "not measured".
- **REQ-SI8-4** No rule or dictionary change after the first held-out measurement cites a held-out row.

### SI10 — handoff (reviewer, by inspection)

- **REQ-SI10-1** `submission/README.md` describes rounds 1–7 with counts taken from the checklists, has a Part 2 section, and lists what is finished, verified and pending, including the parked assistant items and recurring charges as a later iteration.
- **REQ-SI10-2** The Part 2 section of both READMEs starts with `npm run demo` and says it needs only the OpenAI key; it also says what the default bank shows.
- **REQ-SI10-3** Every path cited in `submission/README.md`, `README.md` and `docs/` exists; `docs/integration-surface.md` lists every route in `route.ts`.
- **REQ-SI10-4** The ZIP built by `npm run package`, extracted into a fresh folder with only `OPENAI_API_KEY` set, runs `npm ci`, `npm run setup`, `npm run demo` and `npm test` as the README says, and holds no key.
- **REQ-SI10-5** `docs/video-outline.md` covers both parts within 5–10 minutes, with Part 2 in about three.

### SI11 — optional (reviewer)

- **REQ-SI11-1** `GET /api/movements?category=<id>` returns only rows of that category; an unknown id is a `400`.
- **REQ-SI11-2** The CSV ends with `category,category_state`, and its cells keep the formula guard.
