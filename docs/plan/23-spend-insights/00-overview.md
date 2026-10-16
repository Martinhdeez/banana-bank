# 23 — Spend insights (SI1–SI11): overview

Round 7, Part 2 of the challenge. Plan version 2, 2026-10-03, on `dev` @ `04682d9` (written on `cf3903f`, reviewed against `04682d9`); deadline 2026-10-12. It replaces version 1 after two independent critiques (technical and product) and the System One research. Tracker and execution plan: [`docs/advance/fix-checklist-07.md`](../../advance/fix-checklist-07.md).

Files that apply to every item:

- [contracts.md](contracts.md) — the **frozen public contracts**: taxonomy and labelling rules, the one pipeline entry point, the `Decider` interface, tables, HTTP routes, agent tools, env variables, the System One wire format, the alt-bank test server, DOM hooks.
- [requirements.md](requirements.md) — the **verification model (V-cycle)** and the acceptance requirements.
- [inputs/](inputs/README.md) — research and data: System One API note, rules dictionary, dev set, demo dataset, generator script, and the held-out set (**not for rule authors**).

| # | Item (one PR each) | Branch | Size | Priority | Depends on |
|---|---|---|---|---|---|
| [01](01-si1-taxonomy-normalize.md) | **SI1** taxonomy, sign rule, description cleaning, merchant key | `feat/si1-taxonomy` | S | must | — |
| [02](02-si2-rules-store.md) | **SI2a** regex dictionary (data) and rule tiers | `feat/si2a-rules` | M | must | SI1 |
| [02](02-si2-rules-store.md) | **SI2b** store, migrations 7–8, reset wipe | `feat/si2b-store` | S | must | SI1 |
| [03](03-si3-decider.md) | **SI3** `Decider` interface, System One adapter, OpenAI decider, env | `feat/si3-decider` | M | must | SI1 |
| [04](04-si4-pipeline.md) | **SI4** pipeline entry point, background run, `bankView` moved to its final home | `feat/si4-pipeline` | M | must | SI2a, SI2b, SI3 |
| [05](05-si5-api.md) | **SI5** API: categories on rows, summary in the dashboard, set category, rules, reclassify, audit | `feat/si5-insights-api` | M | must | SI4 |
| [06](06-si6-agent.md) | **SI6a** `message_extras` (migration 9), movement attachment, extras on GET | `feat/si6a-attachment` | S | must | SI2b (migration order) |
| [06](06-si6-agent.md) | **SI6b** agent tools, digest, quick replies with target, cited movements | `feat/si6b-agent-tools` | L | must | SI5, SI6a (the AR1 fix it waited for is on `dev`, #83) |
| [07](07-si7-ui.md) | **SI7-slots** five optional props (designer) | `feat/si7-slots` | S | must | — |
| [07](07-si7-ui.md) | **SI7a** Overview: card, chips, "why", Other group, select, similar offer, notice with undo, rules list | `feat/si7a-overview-ui` | M | must | SI5, SI7-slots |
| [07](07-si7-ui.md) | **SI7b** chat: "Ask the assistant", attachment, quick replies, cited movements | `feat/si7b-chat-ui` | M | must | SI7a, SI6a; SI6b for the live flow |
| [08](08-si8-eval.md) | **SI8** harness, held-out bars, report, option order, thresholds | `feat/si8-eval` | M | must (rules-only and bars); live deciders: should | SI4 |
| [09](09-si9-demo-bank.md) | **SI9** demo seed for Lucía and Bruno, inject route, `npm run demo` | `feat/si9-demo-bank` | S | must | — |
| [10](10-si10-handoff.md) | **SI10a** `submission/README.md` rounds 1–6 (closes HD1) | `docs/si10a-submission-rounds` | S | must | — |
| [10](10-si10-handoff.md) | **SI10b** Part 2 docs, integration surface, video outline | `docs/si10b-part2-handoff` | M | must | all merged |
| [11](11-si11-filter-csv.md) | **SI11** category filter and CSV columns | `feat/si11-filter-csv` | S | could, **last** | SI5, SI7a |

15 builder PRs (16 with SI11) and 5 acceptance-test PRs.

## Goal

The assistant answers "where did my money go?" from the customer's own bank movements, and shows its evidence. Each movement is classified into a fixed list of ten categories. A category the app is not sure about is never shown as fact: it goes to **Other** with state `needs_review`. The customer settles it with the assistant, in their own words or with one click, and the answer can become a rule for that customer. Every decision can explain itself ("why this category?"), and every rule can be undone.

The classifier is a small pipeline: facts and deterministic rules first, then a provider-agnostic **decision model** (System One API: a state and a typed question, answered with probabilities and a confidence), then OpenAI structured output as a fallback, then nothing. The app works with any of the three.

### Why it fits the grading

`docs/challenge.md`: Part 2 (40%) is judged on "creativity, usefulness and how well the feature works with the agent", and "must be part of the agent or its workflow".

- **It works with the agent.** The chat does what a dropdown cannot: it understands "fue ropa" or "Espai Nou es el rocódromo", explains why a movement got its category from the stored reason and probabilities, cites the movements behind a spending answer, offers to review what is unclassified, compares two months, and forgets a rule on request. Every chip has "Ask the assistant".
- **Useful.** The bank contract has no categories. A customer sees `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` and a number; after this round they see where the money went.
- **Creative, and honest.** It shows uncertainty instead of guessing (contract: "Customer-facing status should match verified facts"), learns per customer from one answer, and its classifier is replaceable and measured on a set its rule authors never saw.
- **Traceable** (contract: "make its evidence traceable"): cited movements under answers, a stored reason per decision, an audit event for every category or rule change.
- **Method (20%).** Blind held-out set with recorded bars, independent acceptance tests per public surface, reliability table per decider.

### The first two minutes on the default bank

An evaluator runs `npm run dev` with the simulator and an OpenAI key. The simulator has five clean descriptions per customer, and rules decide all of them, so no model is called. The feature must still be visible there:

- every movement has a chip, and every chip has **"Ask the assistant"**, which attaches the movement and asks why it has that category;
- a transfer made from the app (every evaluator makes one for Part 1) is `transfer_person` with the purpose words of its concept as **candidates**, so the assistant asks "what was it for?" — the one naturally ambiguous movement the default bank has;
- the README's Part 2 section starts with **`npm run demo`**, which needs only the OpenAI key (or none) and shows a realistic statement.

## User stories

1. As a customer, I see my spending by category on Overview, with how much is estimated and how much I confirmed, and which movements the bank returned.
2. As a customer, I see a chip on each movement, I can tell an estimate from a confirmed category without relying on colour, and I can see why it was chosen.
3. As a customer, I see the movements the app could not classify under "Other — to review", grouped by merchant.
4. As a customer, I ask the assistant about any movement from its chip.
5. As a customer, I tell the assistant what a movement was in my own words, or click one of the suggested categories.
6. As a customer, after one correction I am asked once whether to apply it to the other N movements of that merchant and to future ones.
7. As a customer, I can see the rules the app learned and remove one, from the page or by telling the assistant.
8. As a customer who does not want to chat, I change a category from a dropdown on the row.
9. As a customer, I ask "how much did I spend on groceries in September, and compared with August?" and the answer shows the movements it rests on, says which part is estimated, and offers to review what is unclassified.
10. As an evaluator with only an OpenAI key (or none), everything above works except the System One path.

## Decision pipeline

```text
GET /api/dashboard ──► bankView(): /v1/accounts, /v1/movements, /v1/contacts   (one bank read)
        │                    + withCounterparties (operations the app sent)
        │
        ├─► SYNC, in the request (pure + one DB transaction)
        │     for each movement with no valid stored row:
        │       clean description ─► merchant key
        │       tiers, first hit wins:
        │         1 own account (app record, own pair in this answer, own id in text)   savings_internal
        │         2 transfer to a person: debit → transfer_person (+ candidates from
        │           the concept); its credit side → income
        │         3 opening rows                                                       other
        │         4 the customer's rule for the merchant key                           confirmed
        │         5 credits: merchant refund → purchase category; tax refund → other;
        │           otherwise income (estimate)
        │         6 debits: regex dictionary, overrides first; exactly one category
        │       hit ─► stored (source rule / user_rule, with its reason)
        │       no hit, empty merchant key ─► other · needs_review · no_merchant
        │       no hit ─► answered as { other, pending }
        │     dashboard.insights (the summary) is computed from the same rows
        │
        └─► ASYNC, never awaited by the response (one run per customer at a time)
              one item per distinct merchant key + sign: cleaned description + direction
              + merchant profile as labels (typical_time, typical_day, typical_amount,
                occurrences), computed over that merchant's movements in this bank answer
                    ▼
              decider chain (env DECIDER), one movement per request:
                System One  (≤ 8 in flight, ≤ 3 attempts per item)
                    │ failed ─► next decider for that item
                    ▼
                OpenAI structured output  (≤ 4 in flight, no long retries)
                    │ failed ─► other · needs_review · decider_unavailable
                    │            (retried only on "Try again" or after 24 h: no billing loop)
                    ▼
              no decider ─► other · needs_review · no_decider
                    ▼
              threshold of that decider (System One: confidence, default 0.80;
                                         OpenAI: self-reported, default 0.85):
                confidence ≥ threshold and top ≠ other ─► category · estimated · model
                otherwise ─► other · needs_review · below_threshold, candidates kept
                    ▼
              stored ─► the page re-reads every 3 s while anything is pending

Customer correction (row select, Other group, or the agent's set_movement_category):
  one movement         ─► confirmed · user                       + audit event
  "apply to similar"   ─► rule (merchant key → category) + the similar movements of the
                          current bank answer ─► confirmed · user_rule; future ones hit tier 4
  remove a rule        ─► its user_rule movements are classified again
A model or a rule never overwrites a confirmed row. The sign rule is checked on every write.
```

## Data model

Next free migration versions in `src/db.ts` are **7, 8 and 9**. The version is the list position, so merge order is version order: SI2b (7, 8) before SI6a (9). Never edit an applied migration.

```ts
// SI2b — version 7
{
  name: 'si2-movement-categories',
  up: (db) =>
    db.exec(`
      CREATE TABLE movement_categories(
        user_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','transfer_person','savings_internal','income','other')),
        state TEXT NOT NULL CHECK(state IN ('estimated','confirmed','needs_review')),
        source TEXT NOT NULL CHECK(source IN ('user','user_rule','rule','model','none')),
        reason TEXT NOT NULL,
        confidence REAL,
        threshold REAL,
        candidates TEXT NOT NULL,
        model TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, movement_id)
      ) WITHOUT ROWID;
      CREATE INDEX movement_categories_merchant ON movement_categories(user_id, merchant_key);
    `),
},
// SI2b — version 8
{
  name: 'si2-category-rules',
  up: (db) =>
    db.exec(
      "CREATE TABLE category_rules(user_id TEXT NOT NULL,merchant_key TEXT NOT NULL CHECK(merchant_key<>''),category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','transfer_person','savings_internal','income','other')),created_at TEXT NOT NULL,PRIMARY KEY(user_id,merchant_key)) WITHOUT ROWID",
    ),
},
// SI6a — version 9
{
  name: 'si6-message-extras',
  up: (db) =>
    db.exec(
      'CREATE TABLE message_extras(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,data TEXT NOT NULL)',
    ),
},
```

The `CHECK` lists are literals, not built from `CATEGORY_IDS`: an applied migration does not follow later edits of the taxonomy (a new category id needs a new migration; `tests/si2b-store.test.ts` fails first). A write outside them (a `pending` row, an unknown category) is refused by the database and rolls back its whole `saveCategories` batch.

| Column | Meaning |
|---|---|
| `movement_id` | the bank's movement `id`. |
| `fingerprint` | `sha256(accountId \n amountCents \n createdAt \n description)`, hex. A stored row whose fingerprint differs from the bank's movement is ignored and replaced (a reset bank reuses ids such as `movement-lucia-1`). |
| `merchant_key` | the key of rules and of "apply to similar". |
| `state` | `estimated`, `confirmed`, `needs_review`. `pending` exists only in responses. |
| `source` | `user`, `user_rule`, `rule`, `model`, `none`. |
| `reason` | why: `keyword:MERCADONA`, `own_account`, `below_threshold`, `decider_unavailable`, … (contracts.md §1). It is what the chip's "why" and the assistant show. |
| `confidence`, `threshold` | what the model reported and the bar in force; `NULL` otherwise. |
| `candidates` | JSON `[{category, p}]`, at most 3; `p` is `null` for candidates a rule suggested. |
| `model` | `systemone:<id the provider returned>`, `openai:<model>`; `NULL` otherwise. |

**What happens when ids change.** The key is `(user_id, movement_id)`. Both banks give a transfer's movements a new random id after a restart. A category confirmed for a vanished id stays in the table but is neither counted nor shown; nothing deletes it. The customer's rules are keyed by merchant key, so they apply again to the new ids: **rules are the durable memory, single confirmations are not**. The demo seed uses fixed ids and dates so that confirmed demo rows survive a bank restart. "Apply to similar" counts and changes only movements of the current bank answer.

`message_extras.data`: [contracts.md §2](contracts.md#2-tables). It follows `message_sources`: extra data for a message without a new column on `messages`.

Rules from the code:

- **Positional-insert rule** (`src/db.ts`): no new columns on `runs`, `messages`, `incidents`, `conversations`, `chunks`, `embedding_cache`, `meta`. This plan adds none. SI6a keeps the user message's id in a variable (it is created inline in `sendMessage` today); it does not change the positional insert.
- The store uses its own prepared statements with named columns and `ON CONFLICT`; the two tables are **not** added to `Rows` (`insert()` cannot upsert).
- **Reset wipe** (`src/seed.ts`): add `DELETE FROM movement_categories; DELETE FROM category_rules;`. `message_extras` cascades from `messages`.

## Config and env vars

[contracts.md §5](contracts.md#5-env-variables). Read in `src/config.ts` (SI3); a bad value makes the import throw with the variable's name. Tests and e2e runs use `DECIDER=none` unless they test a decider: `setupEnv` gets `process.env.DECIDER ??= 'none'` (SI4), or every existing test that reads the dashboard with the fake OpenAI server would send unexpected model requests.

## Security notes

What actually protects the customer, in order:

1. **A closed list.** A decider can only pick one of eight options; the answer is validated against the taxonomy.
2. **Facts before models.** `savings_internal` and `income` never come from a model. The sign rule holds on every write: no debit becomes `income`, whatever the text says.
3. **The threshold.** A weak answer goes to Other.
4. **Only the customer confirms.** A model answer is `estimated` until the customer says so. A rule is created only after an offer the server stored and the customer accepted; the agent cannot create one from an instruction hidden in a description.

Then:

- **Descriptions and concepts are untrusted data.** The decider gets the cleaned description (upper case, `[A-Z0-9& ]`, 80 characters) as a field of `state`, never inside the instructions or the option descriptions. Cleaning does not remove an instruction written in plain words; points 1–4 are what make it harmless. In the agent prompt, the insights digest and the insights tools carry merchant keys only, quoted and marked as data. (The existing `list_movements` tool already returns raw descriptions; that is unchanged.)
- **Ownership of movement ids.** An id from the browser or from model arguments is accepted only if it is in the session actor's own bank answer for this request: `404` on routes, `{status:'failed'}` in tools.
- **The quick-reply target is server-side.** Which movement a customer's answer refers to is stored with the assistant message, not remembered by the model.
- **No PII in logs.** `log()` lines carry counts, decider id, status and duration. Never descriptions, merchant keys, amounts or movement ids. The access-log label for `DELETE /api/insights/rules/:merchantKey` is `insights/rules/:key`.
- **Key server-side only.** `DECIDER_API_KEY` is read in `src/config.ts`, used only by the System One adapter, and never appears in a response, an event or a log line.
- **Data sent to the provider:** the cleaned description, the direction and four profile labels (for example `late_night`, `weekend`, `medium`, `few`). No account ids, names, raw amounts, balances, times or dates. The README says where it goes (TypeSafe, hosted in the United States, per the research note).
- **Cost bound.** One decider call per merchant key and sign, at most three attempts, no retry loop on failure, at most 100 movements per customer.
- **Audit.** Every category or rule change, from the UI and from the chat, is an event in the hash-chained log. Operators see the assistant's tool steps in a case timeline as they do for every tool; there is no operator view of categories.
- **Money.** Nothing here moves money or touches the transfer path.

## Out of scope

- **Recurring charges and subscriptions** ("what subscriptions do I pay?"): the best next iteration, listed as pending in the handoff.
- An operator quality view of customer categories.
- Unusual-spend alerts, budgets, forecasts, merchant logos.
- A movement archive beyond what the bank returns.
- Editing the taxonomy; splitting one movement across categories.
- A Spanish UI. Labels and quick replies are English; the assistant answers in the customer's language.
- The parked assistant fixes (cancelled intent described as sent; an amount correction leaving the old proposal pending): fixed outside round 7 and already on `dev` (#83, `.artifacts/tested/2026-10-03-fix-assistant-stale-proposal.md`): `transfer_money` has a required `replacesApprovalId`, and `conversationState` words every intent status. SI6a and SI6b build on that code and keep it.
- The rest of AR1–AR3. SI10b records it as pending.
- `simulator/`: never modified.

## Risks

| Risk | Mitigation |
|---|---|
| No System One key in time | The adapter is built from the official wire format and unit-tested with an in-test `fetch` stub. The demo runs on rules + OpenAI. The report says "not measured" and the READMEs claim no calibration. A gateway key (same format, other base URL) is the fallback. |
| The OpenAI decider is slow or the key is wrong on the evaluator's machine | One movement per call, 15 s timeout, no long retries; failure stores `decider_unavailable` at once, so nothing stays "Classifying…". |
| First-option bias of the model | `other` is never first; SI8 measures the order-permutation flip rate and fixes the order. |
| A wrong category shown as fact | Threshold per decider; `estimated` in words on every chip; "why" on every chip; wrong-but-shown rate measured on the held-out set. |
| Rules tuned on their own test data | The held-out set, which no rule author reads; bars recorded from the first measurement. |
| Designer slots late | Five optional props, sent on 3 Oct, no dependency. If a slot is missing when SI7a starts, the builder stops and reports. |
| Conflicts in `route.ts`, `run.ts`, `page.tsx` | One owner per file and wave; `bankView` moves once (SI4). See checklist-07. |
| 20 PRs in 8 days | Six parallel builder streams, small items, one test author at a time, SI10a early, SI11 last and optional. Drop order in checklist-07. |
| Prompt growth | The digest is bounded (5 groups, fixed fields). |

### Minimal slice

- **No key at all:** SI1–SI5, SI7a and SI9 with `DECIDER=none`: rules classify, the rest lands in Other, the customer resolves by hand, rules are learned and undone. The chat needs an OpenAI key, as today.
- **OpenAI key only (the evaluators' setup):** all of the above plus the OpenAI decider and every agent flow. This is the demo path if no decision-model key arrives.
- **Decision-model key:** the same with System One first in the chain; only SI8's live measurement needs it.

## Deviations from the draft

1. **A third table, `message_extras` (migration 9):** `messages` cannot gain a column.
2. **Extra columns on `movement_categories`:** `fingerprint`, `merchant_key`, `reason`, `threshold`.
3. **`auto` is a chain when both keys are set:** a System One failure sends that item to OpenAI. A low-confidence answer does not fall through (D2).
4. **No 64-question batching.** The draft's "up to 64 `choice` questions per request" came from an unofficial source; the official API is one state per request. One movement per request, bounded concurrency.
5. **Five sources** (`user`, `user_rule`, `rule`, `model`, `none`) and an API-only `pending` state.
6. **Two thresholds,** one per decider (`DECIDER_THRESHOLD_PCT` 80 on System One's `confidence`, `DECIDER_OPENAI_THRESHOLD_PCT` 85), instead of one at 0.70. Both are starting values that SI8 replaces. Also `DECIDER_TIMEOUT_MS`; `DECIDER_BASE_URL` and `DECIDER_MODEL` have defaults.
7. **The decider sees the cleaned description as well as pre-digested labels.** Time and amount stay decision inputs, as the draft required, but as a **merchant profile** (typical time, typical day, typical amount, occurrences) computed over the merchant's movements, so one merchant still gets one decision. SI8 reports accuracy with and without it.
8. **Rule tiers:** own account and person transfer are facts and run before the customer's rules and the dictionary; a person transfer is never classified by its concept (the draft's "transfers to own accounts = savings/internal; positive amounts = income" is kept and made precise).
9. **More agent tools than the draft's three:** `suggest_category_choices`, `remove_category_rule`, and `category` on `list_movements`.
10. **More routes:** rules list and delete, reclassify; the summary also travels inside the dashboard response.
11. **Labels are English** ("Other", "Ask the assistant"); D8 says "labels in the UI language" and the UI is English.
12. **D10's two parked fixes are not in this round's PRs;** they shipped separately in #83 (`fix/assistant-stale-proposal`).
13. **Bulk "Resolve all" button is replaced** by the assistant's offer after a spending answer and by `list_unresolved_movements` (D4 is met in chat and by the grouped Other list).
14. **Category filter and CSV column are the last, optional item** (SI11).

No draft decision turned out to be impossible in the code.
