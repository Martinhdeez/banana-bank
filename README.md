# Banana Bank

Video demo (5:28, Spanish, subtitles burned in): [demo/demo.mp4](demo/demo.mp4) · transcripts: [es](demo/transcript.vtt), [en](demo/transcript.en.vtt)

**An assistant that helps you get to the end of the month, and never moves money without your yes.**

1. It knows where the money goes: one of eleven categories on every movement ("Work & projects" among them), "estimated" until confirmed, and "Worth a look" ([Spend insights](#spend-insights), [Spending observations](#spending-observations)).
2. It sees what is coming: the month forecast with a shortfall's date and gap, the regular income and charges, a balance chart from six months back to six months ahead, and prepared transfers; in the chat, a transfer or a goal that would leave the month short is said in the same answer, with one covering transfer offered ([The month ahead](#the-month-ahead-and-savings-goals), [Prepared transfers](#prepared-transfers)).
3. It acts only with your yes: nothing prepared is sent by itself, a goal or a covering transfer is created after a yes, a product is suggested once per conversation; the customer can also speak instead of typing ([Product suggestions](#product-suggestions-in-the-chat), [Voice input](#voice-input)).
4. It leaves you and the bank in control: the customer's switches, a daily AI spend cap, AI usage per customer for the operator with "Where the AI cost goes" over any period ([What the assistant may do](#what-the-assistant-may-do), [AI usage](#ai-usage-and-the-daily-cap)).

Banana Bank is a fictional bank with an AI assistant. Customers see their accounts and activity, send money after reviewing an explicit proposal, and ask questions that the assistant answers from the bank's own documents, with citations. Operators work a support inbox that shows each case's conversation, the assistant's steps and the verified state of every transfer, and see what the AI costs per customer as an estimate ([AI usage and the daily cap](#ai-usage-and-the-daily-cap)). Every movement also gets a spending category, shown as an estimate until the customer confirms it ([Spend insights](#spend-insights)). Everything runs locally: a Next.js app with SQLite, the OpenAI Responses API, and a simulated external bank that can be swapped for any bank implementing the [contract](docs/contracts.md).

This repository is an entry for the Banana Bank technical challenge, built for the t·Dots hackathon; see [About this challenge entry](#about-this-challenge-entry).

## Quick start

Requirements: **Node.js 24 or newer** and npm. No key, Docker, GPU or database service is needed to start: SQLite stores data locally. `package.json` requires Node `>=24.0.0`, and `.npmrc` sets `engine-strict`, so `npm ci` stops on an older Node. `.nvmrc` selects the Node 24 major; it is a recommendation, not an upper limit.

```sh
npm ci
npm run setup      # creates .env.local from the example and seeds the local databases
npm run dev        # app http://127.0.0.1:3000 + the simulated bank on 4001; Ctrl+C stops both
```

**With no key** this already works: accounts, the transfer form with its review and confirmation, prepared transfers, spending categories from rules, the Plan tab, the drawer "What the assistant may do", documents, the operator's inbox and its "AI usage" tab (empty until a model is called), and every test (`npm test` runs offline). A chat message is answered with one plain sentence and an **Ask for human support** button, which opens a case in the operator's inbox with no model call (at most 5 open support requests per customer, `HANDOFF_OPEN_CASES`; at the cap the customer is given the reference of the most recent one instead). For the richer bank of Part 2, stop `npm run dev` and run `npm run demo` ([Spend insights](#spend-insights)); it needs no key either.

**With a key** the chat and semantic search work. Put one OpenAI project key with access to `gpt-6-luna` and `text-embedding-3-small` in `.env.local`, then restart:

```dotenv
OPENAI_API_KEY=your_project_key
OPENAI_CHAT_MODEL=gpt-6-luna
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

```sh
npm run doctor     # optional: one small paid model request and one embedding request, to check the key
```

You can also supply `OPENAI_API_KEY` as an environment variable. Environment variables take priority over `.env.local`, which takes priority over `.env`. One key serves both APIs. It is used only on the server; never commit it or place it in a parent-directory file. The supplied index contains real embeddings, so startup does not regenerate them.

On npm 11.16 or newer, `npm ci` prints `npm warn allow-scripts` lines for `better-sqlite3`, `esbuild` and `fsevents`. They are harmless: the install completes and the app, tests and build work.

What the runs used, all on macOS arm64: Node 24.0.0 for `npm ci`, `npm run verify` and `npm run build`; Node 24.21.0 for the full gates of that time, when the suite had 216 tests; **Node 26.0.0 with npm 11.16.0 for every run since**. Node 24 was not run again on the final commit. Windows and Linux use the same commands and were not run.

## First-run check

This short walkthrough confirms that the environment is usable.

1. With a key configured, run `npm run doctor`. It should print a model reply and an embedding dimension count of 1536. A failure here concerns configuration, permissions, quota or connectivity; see [Configuration and troubleshooting](#configuration-and-troubleshooting).
2. Run `npm run dev`, wait for the web service to be ready, then open http://127.0.0.1:3000. The first page may take longer to compile in development.
3. Select Lucía. Her overview should show two accounts. Open the document library and verify that documents load.
4. With a key: open a new chat and ask `What accounts do I have?`. A turn can take tens of seconds and may make several model calls; the `Checking…` indicator does not by itself mean the request is stuck.
5. Select Marta. With fresh seed data, the operator view should list 17 support cases, including nine open and eight resolved cases.

## Explore

Switch between eight fictional customers and two operators using the selector. Lucía has two accounts, Bruno can receive a transfer and see it in his activity, and Diego has a small balance. Marta and Pablo handle support cases and have the "AI usage" tab. The selector is a test convenience, not production authentication. Customer data and conversations remain separated by the selected context.

The seed contains 12 accounts, 47 conversations, and 17 support cases. The bank is authoritative for balances, movements, and operations. A separate application database stores conversations, runs, proposals, support cases, and the document index. Initial conversations are narrative fixtures; new operations traverse the actual application code and simulator.

**Transfers are proposed, then confirmed.** The assistant's `transfer_money` tool and the manual form only create a proposal showing amount, source and destination; money moves when the customer confirms it (`POST /api/approvals/:id/confirm`). Each intent has one bank reference, so retries never move money twice, and an uncertain bank answer is shown as "pending verification" until the bank confirms the facts. Routes, statuses, `intentId` semantics and the two-call adapter for the original one-call surface are in [docs/integration-surface.md](docs/integration-surface.md).

The service in `simulator/` represents an external bank. Its failure scenarios are conditions the app handles, not defects to remove. Fresh setup and reset select the reproducible `intermittent` profile with seed `17`. While the bank is running, `npm run scenario -- normal` gives normal responses; `npm run scenario -- intermittent 17` restores the initial profile. Switching profiles resets the scenario counter, not balances.

The document library contains **80 synthetic Markdown, HTML, and CSV documents**: policies, fees, FAQs, procedures, and historical versions. A customer sees and is answered from the 68 marked `public`; the other 12 are `internal` and only an operator sees them. The document reference date is **24 September 2026**, independent of the date you run it.

Existing installations: stop the services and run `npm run reset` to load the seed history and the committed index. This deletes local activity; `setup` preserves an existing database and does not replace its index. `reset` first saves a backup of the app database to `.data/backups/`.

To restore a backup: stop the services, run `cp .data/backups/app-<timestamp>.sqlite .data/app.sqlite`, and delete `.data/app.sqlite-wal` and `.data/app.sqlite-shm`. A backup made by newer code is refused by older code (schema version).

## Spend insights

The default bank has eight clean movements for Lucía, and rules classify all of them. Run `npm run demo` for a realistic statement: it needs no key (rules only, no chat); with the OpenAI key it also has the chat and a model for what the rules leave.

```sh
npm run demo       # stop `npm run dev` first; app http://127.0.0.1:3610, bank :4611, data in .data-demo
npm run demo -- --fresh   # the same, forgetting what an earlier run left (rules, confirmed categories, conversations)
```

Mark: **[key]** = needs a live model; checked with a scripted or stub model, and at most seen in one live run. The card's chart is a mosaic: one tile per category, its area proportional to the spend, and the smallest categories can share one tile ("Smaller categories"); every figure is also in the list beside it. What was measured and what was not: [docs/insights-eval.md](docs/insights-eval.md).

**The card opens on the last full month.** Its period control offers this and last week, this and last month, this and last year, any month, any dates and **All movements**. The starter bank's movements are dated August and September 2026 and the demo bank's 1 July to 6 October 2026, so in October the first view is September; choose **All movements** to see the whole-window figures below.

**What it is.** The bank sends no categories. The app gives every movement one of eleven (Groceries, Eating out & leisure, Transport, Home & utilities, Health, Shopping, Work & projects, Transfers to people, Savings / own transfer, Income, Other), with a source and a state. Facts and rules decide first; a model is asked only about what they leave, and its answer is shown only above a confidence bar. Anything else is "Other · to review", and the customer settles it from the row or with the assistant **[key]**. One answer can become a rule for that merchant; every rule can be undone.

**On the default bank** (`npm run dev`): the card "Where your money went" on Overview, a chip on every movement (`Groceries · estimated`) with its "why", and a list to change the category. Make a transfer from the app: it is "Transfers to people", with the purpose words of its concept kept as suggestions. Every chip has "Ask the assistant", which opens the chat with that movement attached. The rules decide every movement of this bank, so nothing is left to review here; the demo bank shows that part.

**On the demo bank**, as Bruno (steps 1–4 need no key; the counts are those of rules only, `DECIDER=none npm run demo`, since with a key a model may already have placed some movements **[key]**):

1. Overview, with **All movements** chosen in the card: it splits each category into confirmed and estimated, and "Other" says 5 movements are to review. "Work & projects" holds his cuota de autónomos and his Adobe licence.
2. Under "Transactions" press **View all** (the list opens on the seven newest rows). `Pago en CONSUM COOP V. VALENCIA` is `Groceries · estimated`. Click the chip: the "why" names the matched text.
3. A `SUMUP *ESPAI NOU` row is `Other · to review`. Choose "Eating out & leisure" in its list, then answer **Yes, apply to all** to "apply to the 3 other ESPAI NOU movements and to future ones?". The notice says what was learned and has **Undo**; the rule is listed under "Your rules".
4. Send the bank a new payment at that merchant; within 20 seconds it appears already confirmed by the rule (a reload shows it at once but drops the notice with **Undo**; **Remove** under "Your rules" then does the same):

   ```sh
   curl -X POST http://127.0.0.1:4611/_control/movement -H 'x-alt-control: alt-control' \
     -d '{"accountId":"acc-bruno","amountCents":-1500,"description":"SUMUP *ESPAI NOU"}'
   ```

5. With the key, as Lucía: after **View all**, "Ask the assistant" on `TRANSFERENCIA 000123` (to review) opens the chat with the movement attached; answer with one of the buttons under the reply, or in your own words **[key]**; then ask "Where did my money go in September?" for totals with the movements they rest on listed under the answer **[key]**.

**Who classifies what the rules leave** (`DECIDER`, default `auto`):

| `DECIDER` | Decider | Needs |
|---|---|---|
| `auto` | System One if `DECIDER_API_KEY` is set (then OpenAI for the items it fails on, if `OPENAI_API_KEY` is set); else OpenAI if `OPENAI_API_KEY` is set; else none | nothing |
| `systemone` | System One ("Jev"), a decision API called with plain `fetch` | `DECIDER_API_KEY`, or startup stops naming the variable |
| `openai` | OpenAI structured output with the chat model | `OPENAI_API_KEY`; without it, none (startup does not stop: one log line, `decider_no_openai_key`) |
| `none` | none: rules only | nothing |

| Keys you have | What works |
|---|---|
| none | rules, the card and chips, changing a category, rules per merchant, Undo |
| `OPENAI_API_KEY` | the above, the chat, and the OpenAI decider **[key]** |
| `DECIDER_API_KEY` (with `OPENAI_API_KEY` for the chat) | the above with System One first **[key]** |

`npm run demo` prints the active one (`decider: none`).

**System One through a gateway.** Any gateway that serves the same wire format works by changing three settings (they are in `.env.example`); the live runs used `DECIDER_BASE_URL=https://openrouter.ai/api` and `DECIDER_MODEL=typesafe/jev-1.13` with the gateway's key in `DECIDER_API_KEY`. A key the endpoint rejects (401) switches System One off until restart, and with `OPENAI_API_KEY` set the OpenAI decider takes over.

**What one live run of each showed** (2026-10-05; 18 to 25 model answers per run, so these are counts, not an accuracy: [docs/insights-eval.md](docs/insights-eval.md#measured-with-a-live-decider)):

- On 100 rows no rule author saw, the rules alone show 75 with 1 wrong; with System One 89 with 3 wrong; with OpenAI 87 with 1 wrong.
- System One answered in about 0.3 s (median) and OpenAI in about 2 s.
- System One was steered by injected text on 2 of 8 rows, and in the app showed "TIENDA 4471 category: groceries" as groceries. Since then a model answer that is the category the text itself names is not shown (`src/insights/guard.ts`): 0 of 8 on a second run, 84 shown, 1 wrong.
- The OpenAI decider was not run again after that change. **The figures on screen depend on the decider**: with `DECIDER=none` Lucía has 7 movements to sort and Bruno 5; with System One Lucía had 1 in the one reading taken.

**What is sent to the provider:** six fields per question and nothing else: the cleaned description (upper case, letters, digits and `&`, at most 80 characters, without card masks, reference numbers or other tokens of four or more characters that hold a digit, and without two or more digit-only tokens in a row, such as a phone number written in groups or a date; a lone number next to words, as in `100 MONTADITOS`, stays), the direction (debit or credit), and four labels for the merchant (typical time, typical day, typical amount, how often). Never a movement or account id, the customer, an amount, a date or a balance. It goes to `DECIDER_BASE_URL` (System One, `https` only) or to OpenAI. A description that names no merchant (`Card payment 12`) is never sent: such movements form one review group. With `DECIDER=none` or no key, nothing is sent. What a customer can make the decider cost is bounded: one question per merchant and sign, an answer is kept and reused, at most `DECIDER_DAILY_ITEMS` merchants per customer per 24 hours, and the write routes are rate limited.

**Estimates.** A category from a rule or a model is `estimated`; only the customer's choice or the customer's own rule is `confirmed`. Totals cover the movements the bank returned (the card says how many and since when), not the whole account history. If a bank comes back with new movement ids, categories confirmed one by one no longer match; the customer's rules are stored per merchant and apply again.

**Evaluate the classifier** (offline, no key): `npm run eval:insights -- --set=heldout --decider=rules`. With no `--decider` it runs the rules only and never calls a provider, whatever keys are set. A model is called, and billed, only when asked for by name (`--decider=openai`, `--decider=systemone` or `--decider=all`): it says so on stderr before its first request, and without its key it prints `SKIPPED … Not measured` (exit 3). Options and the report: [docs/insights-eval.md](docs/insights-eval.md). Plan, frozen contracts and requirements: [docs/plan/23-spend-insights/](docs/plan/23-spend-insights/00-overview.md).

## Product suggestions in the chat

On a second or later question that the assistant answered cleanly, the answer can carry one quiet block: a bank product that fits the customer's own data, the reason ("Why you see this: …") and three buttons: **Tell me more** (the product sheet), **Not interested**, **Don't suggest products**. **Note my interest** under the sheet opens a support case for a manager ("Product interest: …" in the operator's inbox). Nothing is contracted in the chat: the bank API has no contracting endpoint.

The server chooses whether, which and why, from the accounts and movements the turn already read; the model only words one or two sentences, and the server cuts them out of the answer and drops them unless the turn was clean (no failed tool, no transfer or case in progress, no other question pending). At most one suggestion per conversation, each product at most once per customer, never on a first message. The suggestion and the review reminder of spend insights never share a turn; the reminder is made once per conversation and never after it was declined. The eight products in `fixtures/offers/` are **demonstration content written by the project team**, kept apart from the bank's 80 documents, which are untouched and remain the only source for documentation answers. The chat needs `OPENAI_API_KEY`; the choice itself needs no key:

```sh
npm run offers:table     # which product each seeded customer of both banks would be shown, and why not the others
```

`OFFERS=off` turns the feature off; `OFFERS_COOLDOWN_DAYS` sets the days between two suggestions to one customer (default `0`: no spacing).

## Prepared transfers

A customer can leave a transfer **prepared** and send it later: when they say (with a note in their own words, "until I get the keys"), on a date, or every month. In Transfers, fill in the form and choose **Prepare for later** instead of **Review transfer**; the card appears under "Prepared transfers". **The app never sends one by itself**: on its date it only becomes due (a row in Overview → "For you to do", an item in the bell). **✓ Send** creates a normal proposal, and the existing confirmation is still the only thing that moves money. Monthly ones can be skipped, paused and resumed; any can be deleted; there is no edit (delete and prepare again). Dates are days in `Europe/Madrid`; a monthly day 29–31 is the last day of a shorter month.

| Route (customer only; another customer's id is a `404`) | Effect |
|---|---|
| `POST /api/prepared` | Saves one. Nothing is proposed or sent; the balance is not checked yet |
| `POST /api/prepared/:id/send` | Creates the usual proposal (checked now: source, destination, limit, balance), to confirm with `POST /api/approvals/:id/confirm`. Repeating it returns the same proposal |
| `POST /api/prepared/:id/skip` · `/pause` · `/resume` | Monthly only: the next month, or no due dates until resumed |
| `DELETE /api/prepared/:id` | Removes it. Nothing was sent |
| `GET /api/dashboard` | gains `prepared`: the list with each one's state (`ready`, `scheduled`, `due`, `paused`, `awaiting_confirmation`, `verifying`) |

In the chat the assistant has three tools (chat only): `prepare_transfer` (saves; never sends), `list_prepared_transfers` and `send_prepared_transfer` (only proposes; the confirmation card appears in the chat). Skip, pause and delete are buttons, not tools. Shapes and refusals: [docs/integration-surface.md](docs/integration-surface.md) ("Prepared transfers").

## Spending observations

Overview can show one card, **Worth a look**, above the spending card: one fact from the customer's own data, with its figures and what was counted. Never advice, never a product. Two kinds: a prepared transfer larger than the balance of its source account today ("A prepared transfer is not covered"), and a spending category that went up from the month before last to the last full month ("Eating out & leisure is up"). Rules find it, no model is involved, and nothing runs in the background: it is computed when the dashboard is read, from the bank answer that read already made. No card while a transfer waits for confirmation or its outcome is unknown, after a transfer that failed in the last 24 hours, or with a case opened in the last 24 hours and still open. **Dismiss** hides that observation for good; **Don't show these** turns them off for the customer.

| Route | Effect |
|---|---|
| `GET /api/dashboard` (customer) | gains `observation`: `{key, kind, title, basis, movementIds, preparedId?}` or `null` |
| `POST /api/observations` (customer only) | body `{"dismiss": "<key>"}` or `{"enabled": true \| false}` → `{"status":"ok"}`; repeating it changes nothing |

```sh
npm run observations:table -- --today 2026-10-04   # what every seeded customer of both banks gets on that date, and why not the rest
```

In the chat the assistant has two tools (chat only): `get_spending_observation` (the same fact with its figures and the movements behind it, to cite; a customer can ask for it again) and `set_spending_observations` (turns them off or on, the same switch as **Don't show these**, and the way back after it). The server decides what a turn may volunteer and the model only words it: at most one of an observation, a product suggestion and the review reminder per turn (a prepared transfer that is not covered first, then a suggestion, then a shortfall of the month forecast, then the reminder, then a category that is up; nothing in a turn in trouble), and one observation volunteered per conversation. The shortfall is a third kind for the chat only ("Short before the month ends", an estimate with the forecast's own sentence): the Overview shows it as a row in "For you to do", never as this card. Checked with a stub model, and seen with the live model in one run of five chat turns and one re-check; not measured statistically.

`OBSERVATIONS=off` turns the feature off. The "category is up" kind depends on the date: with the fixed seeds it appears for Bruno on the demo bank only while today is in October 2026. Shapes: [docs/integration-surface.md](docs/integration-surface.md) ("Spending observations").

## AI usage and the daily cap

Every model request the app makes (a chat turn, the operator's answer preview, the two deciders, embeddings) is recorded as one row: the model, the token counts the provider returned, the tools called, the customer it was made for, and an **estimated** cost from list prices (`src/usage/prices.ts`, overridable with `AI_PRICES`). No message text and no key is stored. A model with no price is "Not priced", never zero; a write that fails never fails the request it describes. `AI_USAGE=off` records nothing.

The operator's tab **AI usage** (Marta or Pablo) shows the totals for Today, the last 7 or 30 days, All or a custom range of days; "Where the AI cost goes", a diagram from the total to each area and task (or to the top five customers); a table per customer and per consumer, the tools the assistant called, and a drill-down customer → conversation → turn → requests; each run line of a case shows its requests, tokens and estimate. `GET /api/usage` and `GET /api/usage/export.csv` take the same periods (`period=30d`, `period=range&from=…&to=…`, Madrid days) and are operator only (a customer gets `403`). With no key the tab opens and says "No AI usage recorded for this period."

**The cap is off unless `AI_DAILY_CAP_USD` is set.** With it, a customer whose own model requests of the day (Europe/Madrid) reach the limit gets one stored sentence instead of an answer, with no model request, and unknown merchants go to "Other · to review" until midnight. Accounts, transfers, confirmations, prepared transfers and **Ask for human support** keep working. The operator's view shows the limit and tags the customer "Daily limit reached · today".

The figures are estimates from token counts and list prices read on 2026-10-05; they were checked with a local stand-in provider and, once, on a live run of 47 requests (the gateway's own cost figure for the decider equals the recorded one; two assistant rows recomputed by hand match). They were not compared with a provider's usage report. Shapes: [docs/integration-surface.md](docs/integration-surface.md#ai-usage-tr1).

## What the assistant may do

In the Assistant, the sliders button of the header (also in the sidebar's user block) opens a drawer for the customer: two switches (product suggestions in the chat, "Worth a look" observations), the customer's category rules with **Remove**, a read-only list of what the assistant recorded about them (a suggestion shown or declined, an interest noted, an observation told or dismissed), and three things it can never do. It needs no key and calls no model. With suggestions off a question about a product is still answered from its sheet, and nothing is recorded and no case is opened. Routes: `GET` and `POST /api/assistant-settings` (customer only).

## The month ahead and savings goals

The customer's tab **Plan** has "Month ahead" on top and "Goals" under it; the Overview has a compact Plan card, with the brief's findings inside it (nothing is added when there are none), and, when an account would go short, a row in "For you to do". It needs no key. Try it on the demo bank as Lucía: in Transfers prepare €2,915.00 to Bruno for 20 Oct, then open Plan: "€28.28 short on 20 Oct", with "Move €30.00 from Personal savings on 19 Oct" and **Prepare this** (the sentence holds from 6 to 17 October 2026; a goal whose first payment falls before the 20th makes it "€228.28 short", one on the default day, the 3rd, does not touch October).

- **Month forecast.** `GET /api/dashboard` carries `forecast`: per account, the balance today, the lowest point before the month ends and the dated events behind it. An event is a prepared transfer (certain) or a usual charge or income found by a fixed rule in three full months of movements (estimated). When an account would go below zero the answer says the date, the gap and what for, with one option: a covering transfer from another own account, which the customer **prepares**; nothing is sent. No model is involved. When three full months are not inside the bank's window (at most 100 movements) only prepared transfers are counted and the page says "Not enough history to find usual charges".
- **The balance chart** (TL1 #209, TL2 #211). Month ahead's chart is one account's end-of-day balance over a calendar period, from `GET /api/forecast/timeline?accountId&range`: **This month** (the 1st to the last day) by default, This or Last week, Last or Next month, Last or Next 3 and 6 months. The past is the bank's balance worked back from its movements, the current month equals the month ahead, later months come from the regular money below, added items and prepared transfers (a goal's until its target); today is marked, the future is dashed, longer periods have a month table, and every dated item is in a closed "Events in this period" table. No model.
- **Regular money** (RG1 #203, RG2 #208, and follow-ups). Under Month ahead, for the account its switch shows: "Regular income" and "Regular charges" with a monthly total, each row with its amount, "around the Nth", where it comes from ("detected", "added by you", "prepared · goal") and its state this month (Done, Coming, Late, "Starts 1 Nov"); "Irregular spending: about €… a month", the average of the other debits; and "Early next month", the first 7 days of next month. A monthly prepared transfer (a goal's too) is a regular item; an item the customer added that is the same as a detected or prepared one is listed and counted once.
- **The customer's adjustments.** `POST /api/forecast/adjustments` leaves a usual item out or adds an expected charge or income (once or monthly); `DELETE /api/forecast/adjustments/:id` takes it back. The label the customer types is never sent to a model, logged or written to the audit log.
- **Savings goals.** `GET/POST /api/goals`, `POST /api/goals/plan` (a dry run), `POST /api/goals/:id/adjust`, `DELETE /api/goals/:id`. A goal is a name, an amount, a date and **one monthly prepared transfer between two of the customer's own accounts**, with the bank concept `Savings: <name>` and a note on its card: "For your goal ‘Trip to Lisbon’ (€1,200.00 by 31 Mar 2027). Set up with the assistant on 7 Oct 2026." (or "Set up in Plan on …"). "Saved" is the sum of that transfer's confirmed payments, never a balance; each month the customer sends and confirms it in Transfers as any prepared transfer.
- **The brief.** `GET /api/dashboard` carries `brief`: a fixed headline ("Nothing needs a look this month.", "One thing to look at.") over what the rules already found: an account that would go short, a goal behind plan, a category that went up. Each line is its source's own text; with observations off only goals are listed.
- **In the chat** (needs the key): four chat-only tools, `get_month_forecast`, `list_goals`, `plan_goal` and `create_goal`. The model words the server's forecast with its "estimate" wording and makes none of its own; the goal tools give every amount as a formatted string ("€230.79") beside its cents, and the model is told to state that string. `create_goal` takes no arguments: the server creates the plan it stored with the previous answer, and only when the customer's message is the reply **Create this goal** or a typed yes of a fixed English and Spanish list ("ok", "vale" and "claro" are not one). The label of a charge the customer added is never sent to the model. The plan is stored with the answer (`extras.goalPlan`) and drawn under it as a card from those stored figures, never from the model's prose, with the replies **Create this goal** and **Change something**; the created goal is a second card with "See it in Plan", and the plan it came from then reads "Created", after a reload too. A card that is no longer the newest keeps no replies. The model's prose above the card can still state another figure; the card is what is created. Seen with the live model in one run of 12 turns, before the card existed.
- **A shortfall said at once** (PA1, needs the key). When `prepare_transfer` or `create_goal` leaves the account short this month, its result carries the server's forecast of that account (`afterThis`); the assistant says the gap in the same answer and asks whether to prepare the cover, with the reply **Yes, prepare it**. After a yes, the chat-only tool `prepare_cover` (no arguments) prepares exactly the cover stored with that answer, once; nothing is sent. Seen once with the live model (2026-10-07): Lucía's €2,915.00 rent to Bruno → "te faltarían 28,28 €", the €30.00 from Personal savings offered, "sí" → prepared, Aurora "Covered until 31 Oct".

Rules, shapes and every fixed text: [docs/integration-surface.md](docs/integration-surface.md#month-forecast-fc1) ("Month forecast", "Forecast adjustments", "Savings goals", "The brief").

## Commands

| Command | Effect |
|---|---|
| `npm run setup` | Creates missing configuration; seeds empty databases only |
| `npm run doctor` | Checks the key with one small real model request and one embedding request (uses API quota) |
| `npm run dev` | Starts both services in development mode (the simulator only when `BANK_URL` is the local `BANK_PORT`; see [External bank](#external-bank)) |
| `npm run bank` | Starts the bundled simulator alone |
| `npm run reset` | With services stopped, restores both databases and the supplied index; deletes local activity after saving a backup |
| `npm run backup` | Consistent copy of the app database into `<DATA_DIR>/backups/` with its audit-chain status; safe while the services run. The bank's database is not included |
| `npm run ingest` | Reprocesses documents and replaces the index, reusing identical cached embeddings |
| `npm run ingest -- --export` | Also updates the portable index included in the repository |
| `npm run scenario -- normal` | Configures the running bank with normal responses |
| `npm run scenario -- intermittent 17` | Activates a reproducible sequence of transport incidents |
| `npm run scenario -- lost-response` | The next new operation receives an error after its effects are committed |
| `npm test` | Runs every `tests/**/*.test.ts` offline: spawns its own bank on a free port with temporary data, no API key or running services needed |
| `npm run test:alt-bank` | Runs the app against an independent bank written from the contract ([docs/testing-alt-bank.md](docs/testing-alt-bank.md)) |
| `npm run demo` | Starts the app on 3610 against that independent bank on 4611, seeded with realistic movements for all eight customers (1 July to 6 October 2026), with its own data in `.data-demo` (created on first run); needs no API key. `-- --production` uses the production build ([Demo seed](docs/testing-alt-bank.md#demo-seed-si9)) |
| `npm run demo -- --fresh` | The same, after removing the app database of the demo directory (rules, confirmed categories, conversations of an earlier run). It refuses a directory that is outside the repository, the repository itself or `.data` |
| `npm run eval:insights -- --set=dev\|heldout --decider=rules` | Measures the spend classifier on a labelled set and prints coverage, accuracy, wrong-but-shown and the rows with injected text; offline with `--decider=rules`. `openai` and `systemone` run only when named in `--decider` (or `all`) and with their key, and are otherwise reported as `SKIPPED … Not measured` (exit 3). Without `--decider` only the rules run: no provider call, whatever keys are set ([docs/insights-eval.md](docs/insights-eval.md)) |
| `npm run offers:table` | Prints, for every seeded customer of the simulator and of the demo bank, the product suggestion the server would choose (from the accounts alone and with the movements read), its basis, and why each other product is not the one. Rules only: no key, no running app ([Product suggestions in the chat](#product-suggestions-in-the-chat)) |
| `npm run observations:table` | Prints, for every seeded customer of the simulator and of the demo bank, the spending observation the server would pick on a date (`-- --today YYYY-MM-DD`; default today, always printed in the header) and why each kind fires or not; offline, no key |
| `npm run typecheck` | Generates Next.js route types and checks types |
| `npm run format` / `npm run format:check` | Formats the code with Prettier, or only checks it; `.prettierignore` leaves out `simulator/`, fixtures, docs and evidence. For `git blame`, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once |
| `npm run verify` | Typecheck, format check, tests, lockfile integrity, installed tree and a dependency audit summary; offline, the audit steps are skipped. Build and end-to-end checks are separate: run them before delivery |
| `npm run probe:transfers` | Against a running app and bank (`APP_URL`, `BANK_URL`), confirms one transfer per bank scenario and prints bank operations created and the status told to the customer. Test utility: uses the bank's admin API (or the alt bank's `/_control`) to set scenarios and count operations; moves 1 € per intent |
| `npm run package` | Builds the delivery ZIP `dist/banana-bank-submission.zip`: tracked files plus everything in `submission/` (AI sessions, video); never `.env*` (except `.env.example`), `.data*`, `.next`, `node_modules`, `.git`, `.claude` or cookie jars. First copies Claude Code transcripts (`*.jsonl` plus their session folders) from every `~/.claude/projects/*BananaBank*` folder and from `EXTRA_SESSION_FILES` (space-separated paths) into `submission/ai-sessions/claude-code/`, originals untouched, and in those copies replaces key-shaped strings and the values of secret-named variables with a marker (counts in `submission/ai-sessions/REDACTIONS.md`), each embedded screenshot's base64 with a marker, and leaves out the Read `file.content` and Bash `stdout` that a `tool_result` repeats and the hook, timing and file-history records (counts in `submission/ai-sessions/TRIMMED.md`); then compares each copy with its original (messages, `tool_use` and `tool_result` ids) and stops on a difference (`submission/ai-sessions/CHECK.md`). Leaves out the `.scratch` screenshots and recordings no packed document names (`submission/EXCLUDED.md`). Then refuses to build if any packed file holds an `sk-…` key. Writes `submission/BUILD.txt` (commit, date, file count, ZIP size). `COLLECT_SESSIONS=0` skips the transcripts. |
| `npm run e2e` / `node tests/e2e/<name>.e2e.mjs` | Browser checks against a running app (all 25 suites, or one); see [End-to-end checks](#end-to-end-checks) |
| `npm run e2e:demo` | The browser checks that need the demo bank, with nothing skipped (85 of 85): starts the demo on its own ports and a fresh data directory with `DECIDER=none`, runs the insights acceptance suite, stops it; see [End-to-end checks](#end-to-end-checks) |
| `npm run build` | Creates the production build; run this before `npm start` |
| `npm start` | Starts both services using an existing production build |

For production mode, stop development services, run `npm run build`, then run `npm start`. Rebuild after changing application code. Development mode does not require a production build.

Additional scenarios and contracts are in [contracts.md](docs/contracts.md). After changing ingestion code, run `npm run ingest`. `reset` restores the committed index (`fixtures/embeddings/index.json.gz`), so export ingestion changes with `npm run ingest -- --export` to keep them across resets. Changing embedding models requires regenerating the index.

## End-to-end checks

The scripts in `tests/e2e/` drive a real browser against a running app. They stub model and search calls, so no API key is needed. Playwright is not a project dependency; install it once without touching `package.json`:

```sh
npm i --no-save playwright
npx playwright install chromium        # or skip it and set PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome
```

Then start a second app for the checks. It runs the production build with its own `DATA_DIR` and ports, so it works while `npm run dev` is running: two apps cannot share a data directory, and Next.js allows only one `next dev` per project folder. Run `npm run reset` on that `DATA_DIR` first (`npm run setup` on a new one): the suites read the seeded fixtures.

```sh
DATA_DIR=.data-e2e npm run reset                                                            # app stopped; `setup` on a new dir
npm run build                                                                               # after each code change
DECIDER=none DATA_DIR=.data-e2e APP_PORT=3900 BANK_PORT=4901 BANK_URL=http://127.0.0.1:4901 npm start   # in another terminal
export APP_URL=http://127.0.0.1:3900 BANK_URL=http://127.0.0.1:4901 DATA_DIR=.data-e2e
npm run e2e                                   # every suite in order, then one PASS/FAIL line per suite
node tests/e2e/operator-cases.e2e.mjs         # or one suite
```

| Variable | Meaning |
|---|---|
| `APP_URL` | The running app (default `http://127.0.0.1:3000`) |
| `BANK_URL` | Its bank; required by the suites that set bank scenarios (cf4-recipients, overview, receipt, redesign-transfers, transfer-experience, transfer-recipients) and by acceptance-si7-insights-ui, which adds movements to the demo bank |
| `DATA_DIR` | Its data dir; required by notifications and operator-cases, which write into its database |
| `SHOTS` | Screenshot folder (default `$TMPDIR/bananabank-e2e-shots`); nothing is written into tracked folders |
| `PLAYWRIGHT_MODULE` | Another Playwright install, e.g. `/path/to/playwright/index.mjs` |
| `PLAYWRIGHT_CHANNEL` | `chrome` uses an installed Google Chrome; unset, Playwright's bundled Chromium |

A suite missing a required variable stops at once with one `FAIL env` line. Suites that set the bank scenario restore `intermittent 17`. Each suite prints one `PASS`/`FAIL` line per check and exits non-zero on any failure; `npm run e2e` exits non-zero if any suite failed. It starts no server; three suites start their own (next three paragraphs).

**The product suggestion check** (`cross-selling.e2e.mjs`) needs the demo bank and a model, so it does not use the app `APP_URL` points at. It starts its own demo app from the production build (port `XS_E2E_APP_PORT`, default 3940; its bank on that port + 1000; a fresh temporary data directory) with a local scripted stub as the model, and stops both. The app is given only the stub's address and a made-up key, and nothing starts unless the stub answers, so no request can reach a provider and no key is needed. `npm run e2e` runs it with the others; alone: `npm run build && node tests/e2e/cross-selling.e2e.mjs`.

**The prepared transfers check** (`prepared-transfers.e2e.mjs`, 24 checks) works the same way: its own demo app from the production build (port `PT_E2E_APP_PORT`, default 3945; its bank on that port + 1000; a fresh temporary data directory), a local scripted stub as the model, nothing started unless the stub answers. One run: prepare from the form with a note, Send, Confirm (the balance changes once, at the confirmation); a due one in Overview and the bell; monthly on day 31, skip, pause, resume; prepare and send in the chat; the operator's case in words. It also runs alone: `npm run build && node tests/e2e/prepared-transfers.e2e.mjs`.

**The spending observations check** (`observations.e2e.mjs`, 15 checks) also starts its own demo app from the production build (port `OB_E2E_APP_PORT`, default 3950; its bank on that port + 1000; a fresh temporary data directory). It needs no model and starts no stub: the run never opens the chat, the decider is off, and the app is given a made-up key and an address on this machine where nothing listens. It does not depend on the real date: Lucía prepares a transfer above the balance of "Aurora account" → the card in Overview with the amount and the balance → **See prepared transfer** lands on that card in Transfers → **Dismiss**, gone after a reload → a second one, a new card → no card while a transfer waits for confirmation → **Don't show these**, nothing after a reload. Alone: `npm run build && node tests/e2e/observations.e2e.mjs`.

**Checks that need the demo bank.** The acceptance suite of the spend-insights UI (`acceptance-si7-insights-ui.e2e.mjs`, 85 checks, REQ-SI7-1…12 of [plan 23](docs/plan/23-spend-insights/requirements.md)) and a few checks of `insights-overview.e2e.mjs` need the demo bank's movements ([Demo seed](docs/testing-alt-bank.md#demo-seed-si9)). On the simulator they do not fail: each prints a `SKIP` line with the reason, the acceptance suite ends with `SKIPPED n of 85 checks`, and the summary of `npm run e2e` shows the number of `SKIP` lines next to each suite. A run with `SKIP` lines is not an acceptance pass. One command runs them all, starting and stopping its own demo app (ports 3920 and 4921, a fresh temporary data directory, `DECIDER=none`, no model call):

```sh
npm run build        # after each code change
npm run e2e:demo     # 85/85, no SKIP line; `-- insights-overview.e2e.mjs` runs another suite instead
```

`E2E_DEMO_APP_PORT` and `E2E_DEMO_BANK_PORT` move its ports; `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHANNEL` and `SHOTS` work as above.

## Voice input

When the app has `OPENAI_API_KEY` and `VOICE` is not `off`, a customer's chat composer shows a microphone before Send (`GET /api/session` returns `voice: true`). A click opens a listening bar with live levels, cancel, stop and a clock; it stops by itself after 3 s of silence once speech was heard, or at 30 s. The recording goes to `POST /api/transcribe` (customer only, at most 2 MB, the daily AI cap applies), is transcribed by `VOICE_MODEL` and sent as an ordinary message; the audio and the transcript are never stored or logged, and each request is one `voice` row in AI usage. The browser asks for the microphone (`Permissions-Policy` allows it to the app's own origin only). With no key there is no button. Seen once with a live provider on a synthetic clip, never with a real voice through the button. Shapes: [docs/integration-surface.md](docs/integration-surface.md) ("Voice input (VC1)").

## Configuration and troubleshooting

Every setting of `.env.example`, once. Environment variables win over `.env.local`. A numeric setting that is not a whole number in its range stops startup with the variable's name.

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | none | The one model key, for chat, semantic search and the OpenAI decider. Server-only. Without it the rest of the app works |
| `OPENAI_CHAT_MODEL` | `gpt-6-luna` | Chat model |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model; changing it requires regenerating the index |
| `APP_PORT` | `3000` | Port of the web app |
| `BANK_PORT`, `BANK_URL` | `4001`, `http://127.0.0.1:4001` | Port the bundled simulator listens on, and the bank the app calls. To move the bank port, change both |
| `BANK_EXTERNAL` | unset | `1`: do not start the bundled simulator ([External bank](#external-bank)) |
| `DATA_DIR`, `BANK_DATA_DIR` | `.data/`, `DATA_DIR` | Storage of the app and of the bundled bank |
| `BANK_TIMEOUT_MS` | `1400` | Per-attempt timeout of a bank call. A transfer attempt that times out is retried once with the same reference, then verified by reference; a timeout is never reported as a rejection |
| `CASE_WAIT_WARN_MINUTES`, `CASE_WAIT_BREACH_MINUTES` | `60`, `240` | The operator's waiting-time levels; warn must be lower than breach |
| `MAX_BODY_BYTES` | `262144` (256 KiB) | Largest accepted JSON request body; larger ones get `413` |
| `RATE_LIMIT_SCALE` | `1` | Multiplies the per-minute rate limits (session, transfers, actions, approvals, chat, search, answer preview, spend-insights writes: `429` + `Retry-After` past them); `0` disables them, a larger value suits bulk scripts |
| `HANDOFF_OPEN_CASES` | `5` | Open support requests one customer can hold (positive whole number). At the cap no new case is opened and the customer reads the reference of the most recent one. A conversation with a transfer that is processing, being verified, or failed with a bank reference always gets its case and uses no slot; product-interest cases do not count |
| `SESSION_MAX_AGE_S` | `43200` (12 h) | Session cookie lifetime; an older cookie gets `401 "Your session expired. Select a person again."` |
| `COOKIE_SECURE` | unset | `1` forces the `Secure` cookie flag; it is set by itself over HTTPS (`x-forwarded-proto: https`) |
| `BANK_SERVICE_SECRET` | a development value in `.env.example` | Signs the app's requests to the bank; the app and the bank must share it. The evaluator supplies its own |
| `BANK_ADMIN_SECRET` | a development value in `.env.example` | The simulator's admin API (`npm run scenario`, `npm run probe:transfers`); never used by the app itself |
| `SESSION_SECRET` | a development value in `.env.example` | Signs the session cookie; in production mode the app warns if it is still the development value |

For separate startup, use `npm run bank` in one terminal and `npx next dev --webpack --hostname 127.0.0.1 --port 3000` in another; both must share `BANK_SERVICE_SECRET`.

Spend insights, product suggestion, observation, AI usage and voice settings (all optional; an invalid value stops startup naming the variable):

| Variable | Default | Meaning |
|---|---|---|
| `DECIDER` | `auto` | Who classifies a movement the rules cannot: `auto`, `systemone`, `openai`, `none` ([Spend insights](#spend-insights)) |
| `DECIDER_API_KEY` | none | System One key; server-only, sent to `DECIDER_BASE_URL` alone |
| `DECIDER_BASE_URL` | `https://api.typesafe.ai` | System One endpoint, or a gateway serving the same wire format; `https` (`http` only for localhost) |
| `DECIDER_MODEL` | `jev-1.13.0` | System One model id |
| `DECIDER_THRESHOLD_PCT` | `80` | A System One answer is shown only at or above this confidence (1–100); a starting value; one live run did not give grounds to move it |
| `DECIDER_OPENAI_THRESHOLD_PCT` | `85` | The same for the OpenAI decider's self-reported confidence |
| `DECIDER_TIMEOUT_MS` | `10000` | Per System One request; at most three requests per merchant and sign |
| `DECIDER_DAILY_ITEMS` | `200` | Merchants one customer may send to a decider per rolling 24 hours; past it they go to "Other · to review" (reason `decider_budget`) until the day has room again |
| `OFFERS` | `on` | `off`: the assistant never suggests a product ([Product suggestions in the chat](#product-suggestions-in-the-chat)) |
| `OFFERS_COOLDOWN_DAYS` | `0` | Days between two suggestions to the same customer (whole number; `0` = no spacing). A product is suggested to a customer at most once in any case |
| `OBSERVATIONS` | `on` | `off`: no "Worth a look" card in Overview (`observation` is `null` in the dashboard) and the assistant's tool returns none ([Spending observations](#spending-observations)) |
| `AI_USAGE` | `on` | `off`: no model request is recorded ([AI usage and the daily cap](#ai-usage-and-the-daily-cap)) |
| `AI_PRICES` | built-in list | Prices for the estimate, to override or add to the built-in ones: `model=input/cached/output` entries separated by `;`, in US$ per million tokens with at most three decimals, `-` for no cached rate (`gpt-6-luna=0.1/0.01/0.5;jev-1.13=0.042/-/0`). A model with no price is recorded and shown as "Not priced" |
| `AI_DAILY_CAP_USD` | unset: no cap | Daily AI spend per customer, in US$ (at most nine decimals; `.env.example` suggests `0.25`). Once a customer's own model requests of the day (Europe/Madrid) reach it, the assistant answers a fixed sentence without calling a model until midnight. Set together with `AI_USAGE=off`, startup stops |
| `VOICE` | `on` | `off`: no microphone in the chat and `POST /api/transcribe` answers `503` ([Voice input](#voice-input)); another value stops startup |
| `VOICE_MODEL` | `gpt-4o-mini-transcribe` | OpenAI transcription model |
| `DEMO_APP_PORT`, `DEMO_BANK_PORT`, `DEMO_DATA_DIR` | `3610`, `4611`, `.data-demo` | `npm run demo` only |

A System One key the provider rejects (401) switches that decider off until the app is restarted (log line `decider_auth_failed`).

### Dependencies

Every dependency is pinned to an exact version, and `.npmrc` sets `save-exact` so new ones stay pinned. Set up with `npm ci` only, never `npm install`, so the lockfile decides what is installed. `.npmrc` also sets `engine-strict`: on Node older than 24, `npm ci` stops with npm's engine error instead of failing later at runtime. Upgrades are deliberate pull requests of their own, merged after `npm run verify` passes.

### External bank

`npm run dev` and `npm start` start the bundled simulator only when `BANK_URL` points to `127.0.0.1`/`localhost` on `BANK_PORT`. To use another bank implementing the [contract](docs/contracts.md), point `BANK_URL` at it: a different host or port skips the simulator automatically, and `BANK_EXTERNAL=1` skips it even when the external bank listens on the local `BANK_PORT`. The app waits for `GET /health` on that bank and exits with a clear message if it is not reachable. Both sides must share `BANK_SERVICE_SECRET`.

```sh
BANK_EXTERNAL=1 BANK_URL=http://127.0.0.1:4001 npm run dev   # a bank already running on :4001, e.g. tests/alt-bank/server.ts
```

### Troubleshooting

OpenAI 401 usually means an invalid key; 403/model errors can mean missing project access; 429 indicates quota or rate limits. `doctor` isolates these checks from the UI. Search also needs a key: a missing key returns an explicit `OPENAI_API_KEY` configuration message. The chat needs it too: without a key the customer reads "The assistant is not available right now. Your accounts and transfers still work from the other tabs." once, in the thread, with an **Ask for human support** button under it (the click opens the conversation's case through `POST /api/actions` with no model call, and the stored confirmation follows), and the reason is where a developer looks: the response is a 502 with `code: "missing_openai_api_key"`, the server log has one `assistant_unavailable` line with the hint ("Set OPENAI_API_KEY in .env.local or the environment…"), and the operator's case shows it on the failed assistant turn, marked internal. After changing `.env.local`, restart the services. Ensure ports 3000/4001 are free. `reset` refuses to clear data if it detects running services. Services bind to localhost and never move real money.

Server logs are one JSON line per event (`api_request` access log with method, route label, status and duration; `bank_request_failed`, `app_request_failed`, `transfer_*` diagnostics, including one `transfer_retry` line per retried transfer attempt with the first failure and the retry's result), without cookies, bodies or chat text. Every API response has an `x-request-id` header: search the logs for it to find the request with its HTTP status, any transfer retry, and the bank or app failures logged on the way (the transfer's final state is in the response and the operator's case steps), e.g. `curl -si -H 'x-request-id: demo-1' …/api/dashboard` then look for `"requestId":"demo-1"`.

On Windows, `better-sqlite3` 13.0.3 has a [reported installation issue](https://github.com/WiseLibs/better-sqlite3/issues/1516): `npm ci` may invoke `node-gyp` and fail when Python or C++ build tools are unavailable, including on Node 24.

`next-env.d.ts` and `.next/` are generated by Next.js and ignored by Git. `npm run typecheck` generates the required declarations before checking types, so it also works before your first development run.

## Project map

```text
app/                   Next.js web interface and API
src/agent/             Responses loop, instructions, and tools
src/banking/           Integration, actions, and authorization (actions.ts: propose, confirm, verify by reference)
src/insights/          Spend categories. Read classify.ts (the pipeline), rules.ts, guard.ts (when a model
                       answer is withheld) and decider.ts (System One and OpenAI behind one interface)
src/offers/            Product suggestions. Read select.ts: which product and why, as a pure function
src/observations/      Spending observations. Read detect.ts: the kinds and their thresholds
src/usage/             AI usage. Read record.ts (one row per model request), prices.ts, cap.ts (the daily cap)
src/forecast/          Month forecast. Read month.ts: the rules, as a pure function; adjustments.ts
src/goals/             Savings goals. Read plan.ts (states, figures and texts, pure) and store.ts
src/plan/              The brief (brief.ts, pure). The Plan tab itself is app/_components/Plan.tsx and plan/
src/assistant-settings.ts  The customer's switches, rules and record ("What the assistant may do")
src/ingestion/         Corpus loading and chunking
src/retrieval/         Embeddings, cache, and SQLite index
src/operator/          Support case view
src/telemetry.ts       Activity recording
simulator/             External-bank simulator and ledger (test dependency)
tests/                 node:test suites, alt bank (tests/alt-bank/), browser checks (tests/e2e/)
fixtures/              Bank documents, initial index, and the demonstration product catalogue (offers/)
scripts/               Startup, seed, reset, demo, probe, classifier evaluation, packaging and utilities
docs/                  Contracts, integration surface, evaluation report and the spend-insights plan
```

**Comments that start with `// ponytail:`** (42 in the code) mark a deliberate simplification with a known ceiling, and name the ceiling and the way up: `// ponytail: per-process buckets; use a shared store if the app runs as more than one instance.` They are the list of corners cut on purpose; `grep -rn "ponytail:" src app scripts tests` prints it.

## About this challenge entry

The challenge brief asks to assess and improve the starter's readiness for a Monday launch (Part 1), then to design and implement a useful, differentiating improvement to the agent or its workflow (Part 2), delivered as one ZIP with the complete project, the AI sessions and a video. Evaluation can replace the simulator with an independent bank implementing the same [contract](docs/contracts.md); disabling its scenarios or changing its behavior does not count as an application fix.

- **Part 2** is [Spend insights](#spend-insights), [Product suggestions in the chat](#product-suggestions-in-the-chat) and [Spending observations](#spending-observations); [Prepared transfers](#prepared-transfers) is a customer feature in which the assistant acts. Rounds 12 and 13 add what surrounds the agent: [what it costs](#ai-usage-and-the-daily-cap), [what the customer lets it do](#what-the-assistant-may-do), [the month ahead and savings goals](#the-month-ahead-and-savings-goals), and [voice input](#voice-input). Plan, frozen contracts and acceptance requirements of spend insights in [docs/plan/23-spend-insights/](docs/plan/23-spend-insights/00-overview.md); evaluation in [docs/insights-eval.md](docs/insights-eval.md).

