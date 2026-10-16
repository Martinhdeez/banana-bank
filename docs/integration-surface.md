# Application integration surface (as implemented)

[`contracts.md`](contracts.md) ("Application integration surface") asks: "If you reorganize this surface, document and provide an equivalent adapter for the same observable behavior." This page is that document. It describes what the routes in `app/api/[...path]/route.ts` return **today**, from the code in `src/banking/actions.ts`, `src/banking/dispatch.ts`, `src/agent/tools.ts` and `src/operator/view.ts`.

**The one reorganisation:** `transfer_money` no longer moves money. It returns a proposal; money moves only when that proposal is confirmed with `POST /api/approvals/:id/confirm` (contract: "A sensitive operation must present its amount, source, and destination for explicit review before execution"). Every other route keeps the contract's shape.

> Keep this page in sync with the code. Whenever a result `status`, an error code or a route changes, update the state machine and the examples below in the same PR.

Example JSON below comes from a running app with no API key (`.scratch/after/fix-docs-delivery/d1-probe.sh` → `d1-probe.txt`) or, for chat-only and timing-dependent results, from the code; ids and long messages are shortened.

## Session and errors

- `POST /api/session {userId}` → `200 {person}` and an `HttpOnly` `banana_actor` cookie. `GET /api/session` → `200 {person, voice}` (VC1: `voice` is `true` only for a customer while `OPENAI_API_KEY` is set and `VOICE` is not `off`; the UI offers the microphone only then), or `401 {"error":"Select a person to continue."}` without a valid cookie. The web UI remembers the last selected person in `localStorage` and posts it on load, so it never makes the unauthenticated `GET`.
- Session lifetime (SEC3): the cookie is `banana_actor=<userId>.<issuedAt>.<hmac>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<SESSION_MAX_AGE_S>`, plus `Secure` when the request came over HTTPS (`x-forwarded-proto: https`) or `COOKIE_SECURE=1`. Every `POST /api/session` issues a fresh token. The server refuses a token older than `SESSION_MAX_AGE_S` (default 43200, 12 h), issued more than 60 s in the future, or in the pre-SEC3 two-part format with `401 {"error":"Your session expired. Select a person again."}`; a bad signature or unknown person is `401 {"error":"Invalid session."}`. Stateless: an older token stays valid until it expires. The web UI answers any `401` by returning to person selection (Retry or the person picker posts the session again).
- `GET /api/people`, `GET /api/health`: no session needed. `GET /api/health` returns only `200 {"ok":true}` (PL1: it no longer lists the model names or whether a key is set; `npm run doctor` reports those locally). Readiness checks do not depend on its body: `npm run dev`/`start` wait on the bank's `GET /health`.
- Every other route needs the cookie. Identity always comes from it, never from a body or tool argument.
- Every request that is not a `GET` (`POST`, `DELETE`) with an `Origin` header from another host is refused: `403 {"error":"Origin not allowed."}` (SI5: it was every `POST`). A request with no `Origin` header is accepted: [the decision is below](#requests-without-an-origin-header).
- Methods (IT2): a route answers only the methods the Routes table below gives it, plus `HEAD` where it has a `GET` (the same answer without a body) and `OPTIONS` (`204` with an `Allow` header, no session needed). Any other method, `PUT` and `PATCH` included, is `405 {"error":"Method not allowed."}` with `Allow: <the route's methods>, OPTIONS` (e.g. `Allow: GET, POST, HEAD, OPTIONS` for `DELETE /api/session`; with `"status":"failed"` on `/api/actions`, `/api/approvals/…` and `/api/prepared…`), with or without a session; the origin check above comes first. A path that is not in the table is `404 {"error":"Route not found."}` for every method once the session is valid (`401` without one), including a longer path under a real one (`/api/conversations/:id/anything`), which used to answer as its parent (a `POST` to `/api/approvals/:id/confirm/x` confirmed the proposal), and `OPTIONS` on such a path (it was Next's `204`; the app sends no CORS headers, so no cross-origin preflight ever succeeded, and its own pages only call their own origin). Unchanged: every route and method of the table, for every role and origin; trailing slashes still redirect (`308`). The table lives in `apiRoutes` (`src/http.ts`) and `tests/it2-method-hygiene.test.ts` walks it.
- Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` denying camera, geolocation, payment and USB and allowing the microphone to our own origin only (`microphone=(self)`, VC0), `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and `Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Pages replace that CSP with a per-request nonce policy (`script-src 'self' 'nonce-…' 'strict-dynamic'`, same-origin everything else) (SEC2).
- Route-level errors are `{error}` with the HTTP status: `400 {"error":"Invalid request data."}` (body fails validation), `401`, `403` (wrong role/owner), `404`, `405` (a method the route does not define, IT2), `409` (a chat turn already running in that conversation, and the conflicts each route names below), `410` (expired proposal), `413` (body too large), `429` (rate limit), `503 {error, code:"missing_openai_api_key"}` (chat/search without a key), `500` (generic).
- On `/api/actions`, `/api/approvals/…` and `/api/prepared…` every HTTP error body also carries `"status":"failed"`, e.g. `404 {"status":"failed","error":"Proposal not found."}`.
- Request bodies are JSON of at most `MAX_BODY_BYTES` bytes (default 262144, 256 KiB; SEC4). A larger body, announced by `Content-Length` or streamed without it, is refused before parsing: `413 {"error":"The request is too large."}` (on `/api/actions`, `/api/approvals/…` and `/api/prepared…` with `"status":"failed"`). No `Content-Type` check: `curl -d` bodies work. Query strings are ignored on every route except eight: on `GET /api/usage`, `GET /api/usage/export.csv`, `GET /api/documents`, `GET /api/movements`, `GET /api/movements/export.csv`, `GET /api/incidents`, `GET /api/incidents/:id/export` and `GET /api/insights/spending` an unknown key, a repeated key or a bad value is `400 {"error":"Invalid request data."}`; `GET /api/dashboard` reads only `period` (a bad or repeated value is the same `400`, any other key is ignored).
- Rate limits (SEC1), per minute, token bucket refilled continuously: `POST /api/session` 120 per client IP (first `x-forwarded-for` entry); per session actor: `POST /api/actions` with `transfer_money` 20, other `/api/actions` 120, `POST /api/approvals/:id/confirm` and `/cancel` 30 together, `POST /api/conversations/:id/messages` 20, `POST /api/search` 60, `POST /api/preview-answer` 30, every non-`GET` `/api/insights/*` request (`POST …/categories`, `DELETE …/rules/:merchantKey`, `POST …/reclassify`) 30 together (IT4: the last two can send merchants to the paid decider; a person changes a few categories a minute; the whole e2e run sends one such request to the app and the acceptance suites run with `RATE_LIMIT_SCALE=0`). Over the limit: `429 {"error":"Too many requests. Wait a moment and try again."}` with a `Retry-After` header in whole seconds (with `"status":"failed"` on actions, approvals and prepared); a throttled request runs nothing and writes nothing. Prepared transfers and observations share two of these buckets: `POST /api/prepared/:id/send` counts in the `transfer_money` 20, and every other `/api/prepared…` request (the `DELETE` too) and `POST /api/observations` count in the other-actions 120. `GET`s and other `POST`s (`/api/conversations`, `/api/incidents/:id/resolve`, `/api/ingestion`, `/api/recipients/favourites`, `/api/notifications/read`: no money, no model call, bounded writes) are not limited. `RATE_LIMIT_SCALE` multiplies every limit (e.g. `100` for bulk evaluation scripts); `0` disables them. Buckets are per app process.
- Every `/api/*` response (success or error) carries an `x-request-id` header (SEC5). A client may send its own `x-request-id` matching `^[A-Za-z0-9._:-]{1,64}$`; it is echoed back, otherwise the app generates a UUID. The same id is sent to the bank as an extra `x-request-id` header (outside the signed string; `x-bank-*` headers unchanged) and appears as `requestId` on every server log line for that request. A path that does not percent-decode (`/api/x/%zz`) is a `400 {"error":"Invalid request path."}` with the same headers; a page path is a plain `400` page (SC1).
- **Tool errors are not HTTP errors.** `POST /api/actions` returns `200 {"status":"failed","error":"…"}` when a tool throws (source account not yours, intent conflict, bank unavailable). Arguments that fail validation give `200 {"status":"failed","code":"invalid_request","error":"…"}` in plain words, e.g. `"Enter an amount in euros between €0.01 and €100,000.00, with at most two decimals (for example 12.50). No money moved."`, `"Add a short description of what the transfer is for. No money moved."` (S1) or `"Some details are missing or invalid: destination account."` (FX2-c: the field in words; the argument names are beside it in `"fields":["toAccountId"]`, which the assistant's model reads too). Check `status`, not only the HTTP code.

### Requests without an Origin header

What `sameOrigin` in `src/auth.ts` enforces, on every request whose method is not `GET` (`app/api/[...path]/route.ts`):

| The request's `Origin` header | Result |
|---|---|
| present, `http:` or `https:`, and its host (with port) equals the `Host` header | accepted |
| present and anything else: another host or port, another scheme, or a value that does not parse as a URL, such as the `null` a sandboxed or `file:` page sends | `403 {"error":"Origin not allowed."}` |
| **absent** | **accepted** |

The absent case is a decision, not an oversight. Current browsers send `Origin` on every cross-origin `POST` and `DELETE`, so a page on another site cannot leave it out; the clients that do send none are `curl`, scripts and server-side callers, which is how the probes, the evaluation scripts and an integrator's adapter call this API, and refusing them would break the surface this document describes. Such a caller still needs the session cookie, and the cookie is `SameSite=Strict` (`sessionCookie` in `src/auth.ts`), so a browser does not attach it to a request started by another site in the first place. The check on `Origin` is the second line, not the only one.

What this leaves open: a client that is not a browser and already holds a customer's cookie can call every route as that customer, with or without the header. That is what holding the cookie means; the person selector is a test convenience, not authentication. A deployment behind a proxy that rewrites `Host` would need the check to compare against the public host instead. Probed for the direct support request (HS1/HS2): a foreign and a `null` `Origin` both answer `403` and store nothing ([fix-checklist-11.md](advance/fix-checklist-11.md)).

## Routes

**Index.** Every route the app answers, from `apiRoutes` in `src/http.ts` (49 paths, 53 with their methods, with TL1's `forecast/timeline`, VC1's `transcribe`, TR1's two `usage` routes, AC1's `assistant-settings`, GL1's four `goals` paths and FC2's two `forecast/adjustments` routes) and the handlers in `app/api/[...path]/route.ts`, checked against the code at `792d891`. "Bucket" is the rate-limit bucket of "Session and errors" above, per session actor unless said; "—" is no limit. Every route also answers `HEAD` where it has a `GET`, and `OPTIONS`. Details are in the table after this one.

| Route | Who | Bucket | Main errors |
|---|---|---|---|
| `GET /api/health` | anyone, no session | — | — |
| `GET /api/people` | anyone, no session | — | — |
| `POST /api/session` | anyone, no session | `session` (120, per client IP) | `400` unknown person |
| `GET /api/session` | any session | — | `401` |
| `GET /api/dashboard` | customer or operator (different bodies) | — | `400` bad period; bank `503`/`504` |
| `GET /api/movements` | customer | — | `400` bad filter; `403` operator; bank `503`/`504` |
| `GET /api/movements/export.csv` | customer | — | as `GET /api/movements` |
| `GET /api/conversations` | customer | — | `403` operator |
| `POST /api/conversations` | customer | — | `403` operator |
| `GET /api/conversations/:id` | its owner | — | `404` |
| `POST /api/conversations/:id/messages` | its owner | `chat` (20) | `400`, `404`, `409` a turn is running, `502` the turn failed: `error` is one of three plain sentences and `code` says why (`missing_openai_api_key`, `provider_refused`, `provider_busy`, `turn_failed`; FX4-a, FX6-b), or, only when `AI_DAILY_CAP_USD` is set, the daily-limit sentence with `code: "ai_daily_limit"` (SC1, see "AI usage") |
| `POST /api/actions` | customer | `transfer` (20) for `transfer_money`, else `actions` (120) | `400` unknown tool name or body; `403` operator; tool refusals are `200` with `status:"failed"` |
| `POST /api/approvals/:id/confirm` | the proposal's owner | `approvals` (30) | `403`, `404`, `409` cancelled, `410` expired |
| `POST /api/approvals/:id/cancel` | the proposal's owner | `approvals` (30) | `403`, `404`, `409` already confirmed, `410` expired |
| `GET /api/transfers/:intentId/receipt` | the intent's owner | — | `403`, `404`, `409` nothing sent |
| `POST /api/prepared` | customer | `actions` (120) | `400`, `403`, `409 too_many`; refusals `200` with `status:"failed"` |
| `POST /api/prepared/:id/send` | its owner | `transfer` (20) | `403`, `404`, `409 not_active` / `paused`; refusals `200` with `status:"failed"` |
| `POST /api/prepared/:id/skip` | its owner | `actions` (120) | `403`, `404`, `409` |
| `POST /api/prepared/:id/pause` | its owner | `actions` (120) | `403`, `404`, `409` |
| `POST /api/prepared/:id/resume` | its owner | `actions` (120) | `403`, `404`, `409` |
| `DELETE /api/prepared/:id` | its owner | `actions` (120) | `403`, `404`, `409` |
| `GET /api/goals` | customer | — | `403`; bank `503`/`504` |
| `POST /api/goals/plan` | customer | `actions` (120) | `400`, `403`; bank `503`/`504` |
| `POST /api/goals` | customer | `actions` (120) | `400`, `403`, `409` one account, 20 goals, or the prepared transfer refused |
| `POST /api/goals/:id/adjust` | its owner | `actions` (120) | `400`, `403`, `404`, `409 prepared_in_progress` / `reached` |
| `DELETE /api/goals/:id` | its owner | `actions` (120) | `403`, `404`, `409 prepared_in_progress` |
| `POST /api/observations` | customer | `actions` (120) | `400`, `403` |
| `POST /api/forecast/adjustments` | customer | `actions` (120) | `400`, `403`, `404` not the customer's account, `409 too_many` |
| `DELETE /api/forecast/adjustments/:id` | customer | `actions` (120) | `403`; an unknown or another customer's id is `200 {"removed":false}` |
| `GET /api/forecast/timeline` | customer | — | `400` missing `accountId`, unknown key or `range`, a key twice; `403`; `404` not the customer's account |
| `GET /api/assistant-settings` | customer | — | `403` |
| `POST /api/assistant-settings` | customer | `actions` (120) | `400`, `403` |
| `POST /api/recipients/favourites` | customer | — | `400`, `403`, `409` 20 favourites; bank `503`/`504` on pin |
| `GET /api/notifications` | customer | — | `403` |
| `POST /api/notifications/read` | customer | — | `400`, `403` |
| `GET /api/insights/spending` | customer | — | `400`, `403`; bank `503`/`504` |
| `POST /api/insights/categories` | customer | `insights` (30) | `400` body or sign rule, `403`, `404` movement; bank `503`/`504` |
| `GET /api/insights/rules` | customer | — | `403` |
| `DELETE /api/insights/rules/:merchantKey` | customer | `insights` (30) | `403`; bank `503`/`504` |
| `POST /api/insights/reclassify` | customer | `insights` (30) | `400`, `403`; bank `503`/`504` |
| `GET /api/incidents` | operator | — | `400` bad filter, `403` customer |
| `GET /api/incidents/:id` | operator | — | `403`, `404` |
| `POST /api/incidents/:id/resolve` | operator | — | `400` no confirmation, `403`, `404` |
| `GET /api/incidents/:id/export` | operator | — | `400` bad format, `403`, `404` |
| `GET /api/documents` | any session (customers: public documents) | — | `400` bad filter |
| `GET /api/documents/:id` | any session | — | `404` |
| `GET /api/documents/:id/chunks` | any session | — | `404` |
| `POST /api/search` | any session | `search` (60) | `400`, `503` no model key |
| `POST /api/preview-answer` | operator | `preview` (30) | `400`, `403`, `503` no model key |
| `POST /api/ingestion` | operator | — | `403` |
| `GET /api/usage` | operator | — | `400` bad query, `403` customer |
| `GET /api/usage/export.csv` | operator | — | `400` bad query, `403` customer |
| `POST /api/transcribe` | customer | `actions` (120) | `400` not audio or empty, `403` operator, `413` over 2 MB, `502` `transcription_failed`, `503` `voice_unavailable` or `ai_daily_limit` |

Every route but the first three needs the session cookie (`401` without it); every non-`GET` request is refused with `403` from another origin and with `413` over the body limit; a throttled request is `429`.

| Route | Who | Returns |
|---|---|---|
| `GET /api/dashboard` | customer | `{accounts, movements, contacts, approvals, prepared, transfers, recipients, insights, observation, forecast, brief}` (FC1: `forecast`, see "Month forecast"; PL1: `brief`, see "The brief"); `movements` newest first whatever the bank order (R4), each with `fromAccountId`, `toAccountId` and `concept` added when its `operationId` is an operation the app sent (from the stored intent; other movements are the bank's rows as is); `approvals` = unconsumed, unexpired proposals `{id, user_id, intent_id, payload:{fromAccountId,toAccountId,amountCents,concept}, expires_at, consumed_at:null}`; `transfers` = the latest 8 intents with their timeline (R8, below); CF4: `recipients` (see "Favourite and recent recipients" below). Re-checks unknown outcomes first (R7). IT8 / IT8b: the period of `insights` is the `period` query parameter or the request header `x-insights-period` (`all`, `current`, `YYYY-MM`, and since IT8c `YYYY` or `YYYY-MM-DD..YYYY-MM-DD`; absent = `all`; bad, or both = `400`), see "Spend insights". OB1: `observation` (one spending observation or `null`), see "Spending observations" |
| `GET /api/dashboard` | operator | `{incidents}`: all cases in inbox order (OP2), each with `priority` (`money` \| `open` \| `closed`) and `priorityReason` (S4: never a time; an open case says "Waiting for support"), OPX2: `waiting` (see below), computed from recorded intents, rejected attempts, status and age (no bank call). Money at stake first, then open cases, both oldest first; closed cases last, newest first |
| `GET /api/movements?q&from&to&min&max&direction&account` | customer | **new (CF3).** `{rows, total, window}`: search and filters over the bank's movement window, see "Movement search" below; operators `403` |
| `GET /api/movements/export.csv?q&from&to&min&max&direction&account` | customer | **new (CF2).** The same rows as a CSV download, see "Movements CSV export" below; operators `403` |
| `GET /api/conversations` / `POST` | customer | list / `201 {id}`; operators get `403` |
| `GET /api/conversations/:id` | owner | `{conversation, messages}`; each message has `sources` (the documents its answer cited, stored at answer time; `[]` otherwise). Each source carries `id`, the cited chunk (DL1; absent on messages stored before), used by the library to highlight the excerpt. Transfer outcome messages (R6) are `role:"assistant"` with `run_id:"outcome:<tone>:<intentId>"`, see "Outcome messages". SI6a/SI6b: each message has `extras: {movement?, quickReplies?, citedMovements?, turnFailed?, handoff?, goalPlan?, goalCreated?} \| null`, see "Chat-only tools" |
| `POST /api/conversations/:id/messages {content, movementId?}` | owner | `{runId, answer, sources}`; `409` while a previous turn in that conversation runs. SI6a: the body is strict (`content` 1–8000 after trimming, `movementId` a string of 1–120; any other key or a bad value → `400 "Invalid request data."`). `movementId` attaches one of the session customer's bank movements to the message: the server reads it from the bank (the client sends only the id); an id that is not in that customer's bank answer → `404 "Movement not found."`, a bank read failure → the bank error (`503`/`504`); in those cases nothing is stored and no model call is made. `GET /api/conversations/:id` then gives each message `extras: {movement?: {id, title, amountCents, createdAt}, …} \| null` |
| `POST /api/actions {name, arguments, intentId?, conversationId?}` | customer | tool result, see below; operators get `403 {"status":"failed","error":"A customer is required."}` |
| `POST /api/approvals/:id/confirm` | proposal owner | transfer outcome, see below |
| `POST /api/approvals/:id/cancel` | proposal owner | **new (R5).** Cancels a proposal still awaiting confirmation, see below |
| `POST /api/prepared {fromAccountId, toAccountId \| recipient, amount \| amountCents, concept, note?, when, date?, inDays?, day?, conversationId?}` | customer | **new (PT1).** Saves a prepared transfer; `{status:"prepared", prepared}`. No intent, no approval, no bank transfer. See "Prepared transfers" below; operators `403` |
| `POST /api/prepared/:id/send {conversationId?}` | owner | **new (PT1).** The proposal of `transfer_money` for that prepared transfer (`requires_confirmation` with `approval`, `intentId`), to confirm with `POST /api/approvals/:id/confirm`; never executes. See below |
| `POST /api/prepared/:id/skip`, `/pause`, `/resume` | owner | **new (PT1).** Monthly only; `{status:"ok", prepared}`. See below |
| `DELETE /api/prepared/:id` | owner | **new (PT1).** `{status:"deleted"}`, idempotent. See below |
| `GET /api/goals`, `POST /api/goals/plan`, `POST /api/goals`, `POST /api/goals/:id/adjust`, `DELETE /api/goals/:id` | customer, owner | **new (GL1).** Savings goals: a name, an amount and a date, fed by one monthly prepared transfer between two own accounts. No route sends money. See "Savings goals" below; operators `403` |
| `POST /api/observations {dismiss}` or `{enabled}` | customer | **new (OB1).** Dismisses one spending observation, or turns them off or on for the customer; `{status:"ok"}`, idempotent. See "Spending observations" below; operators `403` |
| `GET /api/assistant-settings`, `POST /api/assistant-settings {suggestions?, observations?}` | customer | **new (AC1).** The customer's two switches over the assistant, their category rules and what the bank recorded about suggestions and observations; the `POST` sets either switch and answers the same body. No bank read. See "What the assistant may do" below; operators `403` |
| `GET /api/transfers/:intentId/receipt` | intent owner | **new (CF1).** Receipt of a transfer sent to the bank, see "Receipt" below; `404 {"error":"Transfer not found."}` absent or another customer's; `409` nothing sent; operators `403` |
| `POST /api/recipients/favourites {accountId, favourite}` | customer | **new (CF4).** Pins (`true`) or unpins (`false`) a contact account; `200 {favourites}` (account ids, pin order). See below |
| `GET /api/notifications` | customer | **new (CF5).** `{unread, items}` derived from recorded facts, see "Notifications" below; operators `403` |
| `POST /api/notifications/read {ids} \| {all: true}` | customer | **new (CF5).** Stores read marks; `200 {unread}`; see below |
| `GET /api/insights/spending?from&to` or `?period` | customer | **new (SI5).** `SpendingSummary` of the bank's movement window, the same object as `dashboard.insights`; see "Spend insights" below; operators `403`. **IT8:** `period` = `all` (default), `current`, `last` (DS2: the last full month) or `YYYY-MM`, also accepted by the customer's `GET /api/dashboard?period=`; **IT8b:** on both routes the period may come in the request header `x-insights-period` instead of the query (never both); the answer gains `period`, `periods` and `unresolvedInPeriod`; **IT8c:** `period` may also be a year `YYYY` or a day range `YYYY-MM-DD..YYYY-MM-DD`, and the answer gains `today`, `windowDays.from` / `windowDays.to` and `partialReason` |
| `POST /api/insights/categories {movementIds, category, applyToSimilar?}` | customer | **new (SI5).** Sets the category of one movement or one row (both legs of a merged row); `200 {updated, similar, rules}`; `404 "Movement not found."`, `400 "This category does not fit this movement."`; see below |
| `GET /api/insights/rules` | customer | **new (SI5).** `{rules: {merchantKey, category, createdAt}[]}`, newest first; no bank read |
| `DELETE /api/insights/rules/:merchantKey` | customer | **new (SI5).** Removes the customer's rule for that merchant key (URL-encoded); `200 {removed, reclassified}`, `removed: false` when there was none |
| `POST /api/insights/reclassify {}` | customer | **new (SI5).** "Try again" for movements no model could answer; `200 {queued}` |
| `GET /api/incidents?q=&status=&money=&reason=` | operator | all cases, same order and fields as the operator dashboard (OP2); OPX2: every case also has `waiting` (see below); OPX3: optional filters, see [Inbox filters](#inbox-filters-opx3) |
| `GET /api/incidents/:id` | operator | case detail: `{incident, customer, lastMessage, history, events, runs, intents, rejectedAttempts, bank, accountNames, gaps, summary}` (FX2-d: `summary.handoffs` = every recorded handoff request of the case in order, `[{at, summary}]`, each also a line of `summary.text`; `summary.handoff` stays the latest); OPX2: `incident.waiting` (same object as on inbox rows); S5: `incident.statusLabel` (`Open` \| `Resolved`, also on every inbox case and in the first summary line), `lastMessage.text` (content without markdown), and every event (also inside `runs`) has `description`, one readable line such as "Transfer proposed: €15.00 to Carla Ríos · Aurora account, awaiting the customer's confirmation", next to its raw `data`; each intent carries its `approval` and a bank-`verified` status; `rejectedAttempts` = `transfer_money` calls the app refused (no intent, never sent to the bank; O1) as `{eventId, runId, at, arguments, code, error}`, each also carrying `amountCents` (null if invalid), `source` and `destination` in words (S3: the account name, else the recipient the customer named, never `null`); `accountNames` maps account ids to "holder · label" (OP1: the bank's names; FX6-e: and the destinations this case's own steps recorded, for a bank that gives an operator no contacts); summary amounts use the shared money format (`€500.00 to Lucía Martín · Horizon account`); INT1: `audit: {status: verified\|broken\|empty, checked, legacy: {through, count, at}\|null, brokenAt: {eventId, kind, at, reason: hash_mismatch\|unlinked_rows\|head_mismatch\|fork}\|null}` (see [Audit log](#audit-log-int1)), every event also carries `prev_hash` and `hash`, and `gaps` gains "Audit log: …" when the chain is broken and "Steps before <time> were recorded before the audit log existed: …" when the case has legacy events |
| `GET /api/incidents/:id/export?format=json\|html` | operator | **new** (OPX1). Evidence bundle download: `format` defaults to `json`; any other value, a repeated `format` or another query key → `400 "Invalid request data."`; customer 403, unknown case 404. `Content-Disposition: attachment; filename="case-{REF}-{YYYYMMDD}.{json\|html}"` (REF = the six-character case reference), `Cache-Control: no-store`. JSON (`application/json`): `{format:"banana-case-bundle", version:1, exportedAt, exportedBy:{id,name}, case, bankVerifiedAt, notRecorded, integrity:{sha256, chain:{status: verified\|broken\|empty, detail?}}}`; `case` = the case detail without `events` (they are inside `runs`) and without recording a view; `bankVerifiedAt` = `exportedAt` (the bank is read live), or `null` when that read failed (FX2-a; the HTML section is then titled "Bank (not read)" and holds the error); `notRecorded` = the detail's `gaps` plus missing handoff summary, intents without a bank reference, a closed case without a `case.resolved` time, views/exports before `activitySince`, and that the export itself is recorded after the file was built; `integrity.sha256` = SHA-256 hex of `JSON.stringify(case)`; `chain` = `verifyAuditChain()` (INT1) with the break (`reason at event id`) or the legacy note as `detail`. HTML (`text/html; charset=utf-8`): the same content as a self-contained printable report (inline CSS, no scripts, no external URLs, every value escaped, times in UTC), "Not recorded" first. Each export records `case.exported` `{incidentId, operatorId, format, sha256}` (OPX4 activity: "Exported as JSON by …"). No money action, no customer message |
| `POST /api/incidents/:id/resolve {confirm: true}` | operator | **new.** S6: the body must be `{"confirm": true}`; without it (empty body, `false`, any other value) `400 {"error":"Resolving a case needs explicit confirmation: …"}` and nothing changes. Closes the case (idempotent, audited as a `case.resolved` event) and returns the case detail. The first resolution also appends an assistant message to the customer's conversation, "A support agent marked your request as resolved.", with the event's `run_id` (OP3); S4: its time is the message's `created_at`, formatted by the UI in local time |
| `GET /api/documents` | any | `{documents, products, index:{chunks}}`; customers see `public` documents only. Each document has `product` (a product name found in its id, or `null`) and `validity` (`current` if it applies at the reference date, else `archived`). Optional filters `?product=<name>&validity=current\|archived` (DL1); SEC4: any other key, a repeated key or another `validity` is `400 {"error":"Invalid request data."}`; an unknown `product` is `200` with `documents: []` |
| `GET /api/documents/:id`, `/:id/chunks` | any | document with `text` / chunks without vectors; `404` for an internal document asked by a customer |
| `POST /api/search {query}` | any | `{sources}`, filtered by the caller's role |
| `POST /api/ingestion` | operator | `{documents, chunks, model, dimensions}` |
| `POST /api/preview-answer {question, sources}` | operator | `{answer, model, usage, sources}` (the cited subset) |
| `GET /api/usage?period=&customer=&run=` | operator | **new** (TR1). What the app spent on models: totals, per customer, per consumer, down to the single request; see [AI usage](#ai-usage-tr1) |
| `GET /api/usage/export.csv?period=` | operator | **new** (TR1). The per-customer table of a period as a CSV file; see [AI usage](#ai-usage-tr1) |

**Case `waiting` (OPX2).** Additive field on every inbox row and on the detail's `incident`, computed on the server from recorded timestamps only: `{asOf, openedAt, openMs, lastCustomerMessageAt, sinceCustomerMs, resolvedAt, level, thresholds:{warnMinutes, breachMinutes}}`. `asOf` is the server time of the read (one value for the whole inbox); `openedAt` = `incidents.created_at`; `openMs` = `asOf − openedAt` for an open case (clamped at 0), `null` when closed; `lastCustomerMessageAt` = the conversation's last `user` message (whatever its time), `sinceCustomerMs` its age, both `null` when none was recorded; `resolvedAt` = the `case.resolved` event time, `null` for an open case or one closed without that event (seeded closed cases). `level` is `ok` / `warn` / `breach` from `openMs` against `CASE_WAIT_WARN_MINUTES` (default 60) and `CASE_WAIT_BREACH_MINUTES` (default 240), a threshold reached counting as reached; `null` for closed cases. Startup stops if either setting is not a positive whole number or warn ≥ breach. Seeded open cases are days old, so they are `breach`. Inbox order is unchanged.

<a id="inbox-filters-opx3"></a>**Inbox filters (OPX3).** Every inbox row (dashboard and `/api/incidents`) has `reasons: string[]`, the stable codes behind `priority`: `pending_verification`, `sent_failed`, `rejected_attempt` (money at stake, one per fact in `priorityReason`), `waiting` (open, no money), `resolved` (closed). `GET /api/incidents` takes optional `q` (1–100 characters after trimming; only spaces = absent; case- and accent-insensitive substring of the customer name, else the user id, the summary, or the short reference with or without `#`), `status` (`open` \| `closed`), `money` (`true` \| `false`: `priority` is or is not `money`) and `reason` (one of the codes). All given filters apply together; the result keeps inbox order; no parameters = the whole inbox. Round-5 query rule: an unknown key, a repeated key or a bad value → `400 {"error":"Invalid request data."}`. Customer 403, no session 401. `GET /api/dashboard` is never filtered.

**Case `activity` (OPX4).** `GET /api/incidents/:id` records a `case.viewed` event (`{incidentId, operatorId}`, hash-chained like every event) unless the same operator viewed the same case in the last 10 minutes; a customer (403) or an unknown case (404) writes nothing. `POST /api/incidents/:id/resolve` records no view. The detail adds `activity: {id, kind: case.viewed|case.resolved|case.exported, at, operatorId, operatorName, description, format?}[]`, newest first, selected by `data.incidentId` (never by conversation); `description` reads "Viewed by Marta Sanz", "Marked resolved by Marta Sanz", "Exported as JSON by Marta Sanz"; `operatorName` falls back to the recorded id. `activitySince` (ISO time or `null`) = `meta` `case-activity-since`, set by migration 3 and by `npm run reset`: views and exports before it were never recorded. `events` and `runs` exclude `case.viewed` and `case.exported`; `case.resolved` stays in both as before. Migration 4 adds the `events_incident` index on `json_extract(data,'$.incidentId')`.

**Favourite and recent recipients (CF4).** `GET /api/dashboard` (customer) carries `recipients: {favourites: string[], recent: {accountId, lastAt, lastAmountCents}[]}`, computed from app records after the bank reads (no extra bank call). `favourites` = pinned account ids in pin order, keeping only ids among the current contacts (a pinned id that disappears, e.g. during a bank outage, is kept in storage but not shown). `recent` = up to 5 destinations of the customer's own **completed** intents, newest first, one per account, own accounts and ids no longer in the contacts excluded; `lastAt` is the intent's `created_at` (proposal time), `lastAmountCents` the amount of that newest transfer. Transfers made outside the app (bank movements carry no counterparty) and intents still `pending_verification`, cancelled or failed are never recent, so a fresh customer has none. `POST /api/recipients/favourites` (body `.strict()`: `accountId` 1–120 chars, `favourite` boolean; same-origin check): pinning reads `/v1/contacts` and `/v1/accounts` and is idempotent; unpinning reads nothing and is a no-op when not pinned. Errors: `400 "Invalid request data."`, `400 "This person is not in your contacts."` (not a contact, or an own account), `403` operator, `409 "You can pin up to 20 favourites."`, `503`/`504` when the bank read fails on pin (nothing stored). `npm run reset` clears favourites. Use `rankRecipients` (`src/banking/recipients.ts`) to order people: favourites, then recent, then bank order.

**Movement search (CF3).** `GET /api/movements` makes the dashboard's three bank reads (`/v1/accounts`, `/v1/movements`, `/v1/contacts`; no recheck of unknown outcomes) and returns the overview's own rows (`activityRows` in `src/ui-helpers.ts`: newest first, counterparties named from app records, a move between own accounts merged into one row), all of them, filtered. Each row is `{id, kind, title, detail, amountCents, account, accountId, createdAt, direction}`; `accountId` is the customer's account the row hit (a merged internal row: the destination); `direction` is `sent` (`amountCents < 0`), `received`, or `internal` (a merged pair, or a movement whose counterparty is an own account). The dashboard's pending proposals and "being verified" transfers are not bank movements and are never in the results. Query parameters, all optional (zod `.strict()`, `src/banking/movements.ts`):

| Param | Format | Rule |
|---|---|---|
| `q` | text ≤ 100 chars | case- and accent-insensitive substring of `title`, `detail` or `account` ("rios" finds "Carla Ríos") |
| `from`, `to` | ISO 8601 instant with offset, or `YYYY-MM-DD` | inclusive; a plain date is a **UTC** day (`from` 00:00:00.000Z, `to` 23:59:59.999Z). S4: the server stores ISO and the UI is local, so a client sends instants for local day bounds (`new Date(y, m, d).toISOString()` and the end of that day). `from` after `to` → `400 "The start date is after the end date."` |
| `min`, `max` | euros, transfer format (`12,50` / `12.50`, €0.01 upwards) | compared with the absolute amount; `min` above `max` → `400 "The minimum amount is above the maximum."` |
| `direction` | `sent` \| `received` \| `internal` | exact |
| `account` | one of the customer's own account ids | only that account's rows (an internal move from either side, signed for that account); any other id → `400 "Unknown account."` |

`total` = `rows.length` (no pagination). `window = {limit: 100, returned, oldestAt, mayBeTruncated}`: `returned` = the raw movements the bank returned, `oldestAt` = the oldest of their `createdAt` (`null` if none), `mayBeTruncated` = `returned ≥ 100` (the contract's "up to 100 recent movements"; older movements cannot be searched, and a bank with a smaller page is trusted as complete). Errors: the `400`s above; `401` without a session; bank errors as on the dashboard (`503`/`504`). No rate-limit bucket (a GET, three bank reads, bounded by the window, like the dashboard).

**Movements CSV export (CF2).** `GET /api/movements/export.csv` takes the same query parameters and errors as `GET /api/movements` (same parser, same three bank reads, same rows; an unknown or repeated key or a bad value is `400 "Invalid request data."`, another customer's `account` is `400 "Unknown account."`). Response `200`: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="banana-movements-<from|all>-<to|today>.csv"` (days `YYYY-MM-DD`; a local-day instant is named by its local day for offsets within ±12 h), `Cache-Control: no-store`, `X-Movements-Window: returned=<n>; limit=100; truncated=<true|false>; oldest=<ISO|none>` (the facts of `window`). Body: a UTF-8 BOM, then RFC 4180 lines ending in CRLF; the header row is `date,account,description,details,direction,amount,currency,reference`:

| Column | Value |
|---|---|
| `date` | `createdAt` (ISO 8601 UTC) |
| `account` | the customer's account label (`row.account`) |
| `description` | `row.title` ("Sent to Carla Ríos", "Between your accounts", or the bank description) |
| `details` | `row.detail` (concept, or the internal move's accounts) |
| `direction` | `sent` \| `received` \| `internal` |
| `amount` | signed, dot decimal, 2 places, no symbol or grouping (`-85.00`, `1750.00`), from integer cents; an internal move is unsigned unless `account` is set (as on screen) |
| `currency` | `EUR` |
| `reference` | the bank `operationId` when the movement has one, else the movement id |

A field is quoted when it contains `"`, `,`, CR or LF, with inner `"` doubled. Formula-injection guard: a text cell (`account`, `description`, `details`, `reference`) starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`; `amount` is never prefixed. No result is a header-only file, not an error. At most the bank's 100 most recent movements (the file has no comment lines; the header and the UI say so). Without a session the link returns the JSON `401` (`"Select a person to continue."`); SEC3: a session older than `SESSION_MAX_AGE_S` (12 h by default) gets `401 "Your session expired. Select a person again."`. No rate-limit bucket (a GET, like `/api/movements`). The web UI's "Download CSV" link (movement search toolbar) carries the applied filters and the Overview account.

**Spend insights (SI5).** Shapes are frozen in [`docs/plan/23-spend-insights/contracts.md` §3](plan/23-spend-insights/contracts.md#3-http). Every bank movement of the customer's `GET /api/dashboard` has `category: RowCategory & {movementIds}` and the response has `insights: SpendingSummary` from the same bank read (SI4); every row of `GET /api/movements` that is a bank movement has the same `category` (additive, `window` and the CSV are unchanged). `movementIds` is what to send to change that row: one id, or both legs (debit first) of a merged "Between your accounts" row, which takes the debit leg's category; one account's view of an internal move lists that leg only; proposal rows have no `category`. All `/api/insights/*` routes: customer session only (`403 "A customer is required."` for an operator; `401` without a session; a method a route does not define is `405` and an unknown sub-path `404` for both roles, as everywhere since IT2: until then an operator got `403` there too), the three write routes share the `insights` rate-limit bucket (30 per minute per customer, see "Rate limits" above; the `GET`s are not limited), strict bodies (`400 "Invalid request data."` for an unknown key or a bad value, `413` over the body limit).

- `GET /api/insights/spending`: optional `from` and `to` in the formats of `/api/movements` (a UTC day or an instant with its offset, both inclusive). An unknown or repeated key or a bad value → `400 "Invalid request data."`; `from` after `to` → `400 "The start date is after the end date."`. `partial` is true when `from` is earlier than the oldest movement the bank returned. Movements still being classified are counted in `pending` and are in no total.
- Periods (IT8, contracts.md §3 "Periods"): `GET /api/dashboard?period=` and `GET /api/insights/spending?period=` (IT8b: or the request header `x-insights-period` with the same values; the header together with the `period` query parameter, or with `from` / `to`, is the same `400`; the card sends the header so that its URL stays `/api/dashboard`, with `last` on its first read and that month's `YYYY-MM` afterwards; the card shows the period, the Transactions table always the whole window) take `all` (the whole window; also when the key is absent), `current` (the current calendar month in Europe/Madrid by the server clock), `last` (DS2, contracts.md 2.30: the calendar month before the current one in Europe/Madrid, answered as its `YYYY-MM`) or a month `YYYY-MM`. A bad or repeated value, or `period` together with `from` / `to`, → `400 "Invalid request data."` before any bank read; a month with no movements is a `200` with zero totals. For a month the totals and categories are those of the month's movements (by `createdAt` in Europe/Madrid); `window`, the review list `unresolved`, `pending` and `periods` always cover the whole window. `periods` lists the months with movements plus the current month, newest first, then `all`, each `{id, label, count, partial, partialReason?}` (`window`: a truncated window starts in that month; `in_progress`: the current month). **IT8c** (contracts.md 2.21): `period` also takes a year `YYYY` and a day range `YYYY-MM-DD..YYYY-MM-DD` (inclusive, Europe/Madrid days, real dates, from <= to; else the same `400`). The answer adds `today` (the server's Madrid day, for the client's presets) and `windowDays.from` / `windowDays.to` (the days of the oldest and newest movement); for every period other than `all`, `range` is its first and last day and `partial` / `partialReason` (`window`: the window is truncated and the period reaches its oldest day or before; `in_progress`: the period ends today or later) describe it. The bank returns at most its 100 most recent movements and the app reads no further, so every period is bounded by that window.
- `POST /api/insights/categories`: `movementIds` 1–100 strings of 1–120 characters (repeats count once), `category` one of the ten taxonomy ids, `applyToSimilar` optional boolean. The server reads the bank first and uses only its answer (ids, signs, descriptions); nothing else is taken from the client. Any id that is not in the session customer's current bank answer (another customer's, invented, or a movement the bank no longer returns) → `404`; a debit set to `income` or a credit set to `transfer_person` → `400`; in both cases nothing is written, even when other ids of the list were valid. Each movement becomes `confirmed` · source `user` · reason `user`. `similar` has one entry per non-empty merchant key among the movements sent: the other movements of the current bank answer with that key and sign that are not already that category and confirmed (`count` may be 0). With `applyToSimilar: true` a rule merchant key → category is created or replaced per key and those similar movements become `confirmed` · `user_rule` · reason `user_rule:<key>`, including one the customer had set by hand to another category; a later movement of that merchant is `confirmed` · `user_rule` on first read. A movement with an empty merchant key can be set but has no `similar` entry and never gets a rule. `updated` counts the movements actually changed, `rules` lists the merchant keys of this call that have a rule after it. The call is idempotent: a repeat changes nothing, answers `updated: 0` and records no event.
- `DELETE /api/insights/rules/:merchantKey`: the movements of the current bank answer whose source is `user_rule` for that key are classified again at once by the global rules (back to `other` · `needs_review` when no rule knows the merchant; a model, when configured, answers in the background); `reclassified` is their count. Movements set by hand (source `user`) stay. Another customer's rule and an unknown key answer `200 {removed: false, reclassified: 0}`. A key that is not valid percent-encoding (`%E0%A4%A`) never reaches the route: the proxy answers `400 "Invalid request path."` (SC1).
- `POST /api/insights/reclassify`: the body must be `{}`. Movements of the current bank answer with reason `decider_unavailable` are sent through the pipeline again; `queued` is the count of those sent (IT7: with a decider, a movement whose merchant the daily budget left out is stored `decider_budget` and is not counted). The first retry of a merchant is immediate; after it, a failure younger than one minute is skipped (IT4), so repeated posts cannot multiply the decider's attempt budget. It records no event (not a category change).
- Decider cost control (IT4, audit A1/A2), three layers. (1) The `insights` rate-limit bucket above. (2) A per-customer budget: at most `DECIDER_DAILY_ITEMS` (default `200`, a positive whole number checked at startup) merchants are sent to a decider per rolling 24 hours, counted in the app database (`decider_asks`, migration 10; survives a restart; wiped by `npm run reset`). 200 is two full bank windows (100 movements) of merchants no rule knows; the first load of a demo persona sends 3–4, and a new customer with 60 unknown merchants is classified in full. Past it a movement is `other` · `needs_review` · reason `decider_budget` and is sent by itself when the day has room. (3) No re-ask: a movement a decider already answered gets that answer back when its row is gone, so creating and deleting a rule sends nothing.
- Bank errors: every route above except `GET /api/insights/rules` reads the bank; when that fails the answer is the bank error as on the dashboard (`503`/`504`), nothing is stored and no event is recorded.
- Audit: each changed movement records one `category.set` event `{channel, movementId, from, to, source}` (`from`: the previous category id, or `null` if it had none yet; `source`: `user` or `user_rule`); a created or replaced rule one `rule.created` and a removed rule one `rule.removed`, both `{channel, merchantKey, category}`. `channel` is `ui` for these routes (`chat` for the agent tools), `conversation_id` is null for `ui`. The rows, the rule and their events are one transaction and the events are hash-chained like every other. Events hold movement ids and merchant keys; log lines never do: the access log labels the delete as `insights/rules/:key`.

**Prepared transfers (PT1).** Plan: [`docs/plan/25-prepared-transfers/00-plan.md`](plan/25-prepared-transfers/00-plan.md) §2–§4. A prepared transfer is a stored row (`prepared_transfers`, migration 11), never sent by the app: no timer, no background process. "Due" is computed at read time from its date and today's date in `Europe/Madrid`. The customer's `GET /api/dashboard` gains `prepared: PreparedView[]` (app database only; a completed send is closed on this read and recorded once as `prepared.sent`), in the order due (oldest first), awaiting confirmation, verifying, scheduled (by date), ready, paused.

`PreparedView`: `{id, fromAccountId, toAccountId, to, amountCents, concept, note, when: {kind:"manual"} | {kind:"on_date", date} | {kind:"monthly", day}, nextDue, state, approvalId, expiresAt, lastAttempt: "expired" | "cancelled" | "failed" | null, lastSentAt}`. `state`: `ready` (manual), `scheduled` (`nextDue` after today), `due`, `paused`, `awaiting_confirmation` (a live proposal; `approvalId`, `expiresAt`), `verifying` (the attempt's intent is `processing` or `pending_verification`, or a confirm is in flight).

- Customer session only (operator `403`); another customer's id is `404 "Prepared transfer not found."`; other methods `405`. The actor is the session: an unknown key in the body of `POST /api/prepared` (`userId`, `actor`, any other) is refused with `400 {"status":"failed","error":"Invalid request data."}` and nothing is written (probed in the review of #130), and the body of a send is read only for `conversationId`. `send` shares the `transfer` rate-limit bucket, the others `actions`.
- `POST /api/prepared`: source, destination, amount and concept are checked as for a proposal; the balance is **not** (it is checked at send). `when` is `manual`, `on_date` (`date` `YYYY-MM-DD` from today to 366 days ahead, or `inDays` 1–366, turned into the date by the server) or `monthly` (`day` 1–31; in a shorter month the last day, and the anchor day is kept). `note` at most 140 characters. Refusals answer `200` with `{status:"failed", code, error}` like `POST /api/actions` (`invalid_request`, `invalid_date`, `invalid_destination`, `ambiguous_recipient`, `same_account`) or `needs_source_account`; `409 too_many` at 20 active ones. Nothing is stored on a refusal.
- `POST …/send`: `proposeTransfer` under the intent id `prepared:<id>:<occurrence>:<attempt>` (`occurrence`: `once`, or the due date of a monthly one). Parallel and repeated sends return the same approval. The attempt number grows only after the previous proposal expired, was cancelled, or its intent was verified `failed`. Ownership, destination, limit and balance are checked now: `failed` with `insufficient_funds`, `invalid_destination`… writes no intent and leaves the row as it was. While the last attempt's outcome is unknown the answer is that outcome (`processing`, `pending_verification` or the verified `completed`), status `200`, and nothing is created. `409 not_active` (sent or deleted), `409 paused`. Before its date, send acts on the coming occurrence.
- `skip` (the month after `nextDue`, records `prepared.skipped`), `pause`, `resume` (the later of `nextDue` and the first occurrence on or after today): `409 not_monthly`, `not_active`, `paused` (skip only), `prepared_in_progress` (a proposal waits, or the outcome is unknown). `DELETE`: `409 prepared_in_progress`, `409 not_active` (already sent).
- A missed monthly occurrence stays due until sent or skipped; the next is the following month's, due at once if already past. Only one occurrence is open.
- Events (hash-chained, with `conversationId` when the request had one): `prepared.created {preparedId, input, to, when, note}`, `prepared.sent {preparedId, occurrence, intentId}`, `prepared.skipped {preparedId, occurrence}`, `prepared.paused`, `prepared.resumed`, `prepared.deleted`. A send attempt is the usual `transfer.proposed`. There is no `prepared.due` event: nothing happens at midnight.

**Spending observations (OB1, OB2).** Plan: [`docs/plan/26-spending-observations/00-plan.md`](plan/26-spending-observations/00-plan.md) §2–§4, §6. One fact from the customer's own data, found by rules (`src/observations/detect.ts`, a pure function with the date as an argument: no model, no bank request of its own) and computed on each dashboard read: no timer, no background process, no stored "pending" row. The customer's `GET /api/dashboard` gains `observation`:

`Observation | null`: `{key, kind: "prepared_uncovered" | "category_up", title, basis, movementIds, preparedId?}`. `title` and `basis` are plain text written by the server (English), to render as text. `movementIds`: the movements behind a `category_up`, newest first, at most 8; `[]` for `prepared_uncovered`, which carries `preparedId`. `key`: `prepared_uncovered:<prepared id>:<nextDue | once>` or `category_up:<category id>:<YYYY-MM>`.

- `prepared_uncovered`: a prepared transfer in state `due`, `ready`, or `scheduled` with `nextDue` within 7 days, whose amount is above the balance of its source account in the same read. Never `paused`, `awaiting_confirmation` or `verifying`. Each transfer is compared on its own.
- `category_up`: M = the last full calendar month (`Europe/Madrid`), P = the month before; both must be inside the bank's movement window (a full page must start before P). A spending category (never `other`, `transfer_person`, `savings_internal`) with counted spend in M of at least €50 in at least 3 movements, at least €20 in P, and M − P at least 25% of P and at least €15. Only movements decided by a rule or by the customer and not in review are counted; the basis says how many payments of the two months are not counted, whatever the reason (estimated by a model, still being classified, in review): "N movements of those months are not classified by a rule or by you and are not in these figures." The number does not depend on a decider's state, so the dashboard and the chat tool state the same one (OB4).
- One at most: `prepared_uncovered` first (by due date), then `category_up` (by the increase). `null` when there is none, when `OBSERVATIONS=off`, when the customer turned them off, when the customer has a case opened in the last 24 hours and still open, an intent `pending_verification` or `processing` or one `failed` in the last 24 hours, or a proposal waiting for confirmation; and never an observation the customer dismissed. A failure while computing it gives `null`, never a failed dashboard.
- `POST /api/observations`: customer session only (operator `403 "A customer is required."`); the body is exactly one of `{"dismiss": "<key>"}` (the key must match `^(prepared_uncovered|category_up|month_shortfall):[^\n]{1,160}$`) or `{"enabled": boolean}`; anything else `400 "Invalid request data."`; other methods `405`. Answer `200 {"status":"ok"}`. Idempotent: a repeated dismiss records one event. The key is not checked against the bank: a made-up key hides nothing. Shares the `actions` rate-limit bucket.
- Events: `observation.dismissed {key}`, `observations.disabled {}`, `observations.enabled {}` (and `observation.told`, written by the chat, OB3). No table, no migration; `seedApp` clears them with the other events.
- In the page (OB2, `app/_components/Observation.tsx`): the card "Worth a look" in Overview above the spending card, with **Dismiss** and **Don't show these**; for `prepared_uncovered`, **See prepared transfer** opens Transfers on that card.

<a id="month-forecast-fc1"></a>**Month forecast (FC1).** Plan: [`docs/plan/28-plan-area/00-plan.md`](plan/28-plan-area/00-plan.md) §4.4, §5.1, §6.1. The customer's `GET /api/dashboard` gains `forecast: MonthForecast | null`: per account, the balance today, what is still to come before the month ends and the lowest point. Computed on each read by `monthForecast` (`src/forecast/month.ts`: a pure function with the date as an argument) from the accounts, movements and prepared transfers that load already read: no bank request of its own, no model, no categories, no table, no migration. `null` only if computing it fails (never a failed dashboard); the operator's dashboard has no such field.

```ts
type MonthForecast = { today: string; until: string;                         // 'YYYY-MM-DD', Europe/Madrid; until = the month's last day
  history: { months: string[] } | { months: null; reason: 'window_short' | 'no_history' | 'movements_unread' };
  income: 'counted' | 'none_regular';
  notes: string[]; sourceLine: string;
  accounts: ForecastAccount[];                                               // an account that goes short first, then the ones with events
  notCounted: { label: string; reason: 'paused' | 'no_date' | 'irregular'; text: string }[] };
type ForecastAccount = { id: string; label: string; balanceCents: number; endCents: number;
  lowest: { date: string; balanceCents: number };
  shortfall: { date: string; shortCents: number; certainty: 'certain' | 'estimated'; forLabel: string; preparedId?: string } | null;
  headline: string; explanation: string;                                     // never print the headline without the explanation
  options: CoverOption[]; events: ForecastEvent[] };
type ForecastEvent = { date: string; label: string; amountCents: number; balanceAfterCents: number;
  source: 'prepared' | 'usual_charge' | 'usual_income'; certainty: 'certain' | 'estimated';
  merchantKey?: string;                                                      // usual items only: the key the rule grouped by
  seenOn?: string[]; usualDay?: number; late?: boolean; note?: string; preparedId?: string };
type CoverOption = { id: string; title: string; consequence: string;
  change: { kind: 'add'; date: string; amountCents: number; label: string };
  prepare: { fromAccountId: string; toAccountId: string; amountCents: number; concept: string; when: 'on_date'; date: string } };
```

Rules:

1. **Usual charge:** debits of one account with the same merchant key (`merchantKey`, month words removed) and no `operationId`; exactly one in each of the three full months before this one; days of the month within 5 of each other; amounts within 15% of their median. Expected on the median day at the **highest** amount seen.
2. **Usual income:** the same test on credits, at the **lowest** amount on the **latest** day. A payer seen two or more times in those months that fails the test is in `notCounted` as `irregular`; with no usual income `income` is `none_regular` and a note says so.
3. **This month:** an item already seen (same account, key and sign) is removed. A charge whose day has passed stays on today as `late` for 7 days, then is dropped; late income is not counted.
4. **Prepared transfers:** `scheduled` on `nextDue` (if within the month); `due`, `awaiting_confirmation` and `verifying` today; `ready` and `paused` in `notCounted`. One between own accounts debits one account and credits the other.
5. **No double counting:** a usual charge is dropped when a counted prepared transfer from the same account is within 15% and 5 days of it.
6. **Projection** per account to the month's last day, debits before credits within a day. Accounts are never netted.
7. **Shortfall:** the first day an account is below zero, at its lowest that day; `forLabel` is the item that took it there. `certain` when no estimated item is counted up to that point (the day's lowest, so a usual charge of the same day counts), else `estimated`: every figure of the sentence is then an event of the account, and an estimate is never worded as certain.
8. **Silence:** a full page of movements (100) that does not start before the third month back → `window_short`; a window that does not reach that month → `no_history`; both give no usual item, only prepared transfers.
9. **Cover option:** for a short account, each other own account that stays at or above zero after it gives one: the month's lowest point rounded up to the next €10, on the day before the shortfall (today if that is earlier). At most 2; none when the move would not cover it (a shortfall of today), or when the customer already has 20 prepared transfers (`POST /api/prepared` would answer `409 too_many`).
10. **"Prepare this"** posts `options[].prepare` unchanged to the existing `POST /api/prepared`: one prepared transfer and a `prepared.created` event; no intent, no approval, no bank write. The customer still sends and confirms it in the existing card.

Fixed texts, all written by the server (amounts as `€1,234.56`, days as `20 Oct`):

| Field | Case | Text |
|---|---|---|
| `headline` | short | `€{short} short on {date}` |
| `explanation` | short, estimated | `If {items} come as in {July–September}, on {date} you would be €{short} short for {forLabel}. An estimate.` (`comes` for one item). `{items}`: every estimated item counted up to that point, `Name (€39.90, around the 10th)`; a usual income reads `your income from Name (…)` |
| `explanation` | short, certain | `On {date} you are €{short} short for {forLabel}. Your prepared transfers alone take this account below zero.` |
| `forLabel` | | `your prepared transfer to {to}` or `{label}, a usual charge` |
| `headline` | covered | `Covered until {until}` |
| `explanation` | covered | `Lowest point €{lowest} on {date}.` plus, with any estimated item, ` An estimate: it counts {n} usual {payment\|payments}.` |
| `notes[]` | `no_history`, `window_short` | `Not enough history to find usual charges: only your prepared transfers are counted.` |
| `notes[]` | `movements_unread` | `Your movements could not be read just now: only your prepared transfers are counted.` |
| `notes[]` | `none_regular` (with history) | `No regular income found; none is counted.` |
| `events[].note` | `late` | `Usually around the {usualDay}, not seen yet this month. An estimate.` |
| `events[].label` | | the merchant key in title case (`Digi Spain Telecom`); `Prepared transfer to {to}`; `Prepared transfer from {account}` |
| `notCounted[].text` | | `{label}: paused, not counted.` / `{label}: no date set, not counted.` / `{label}: not regular, not counted.`; a prepared transfer's label is `Prepared transfer to {to} (€{amount})` |
| `sourceLine` | | `Worked out by fixed rules from your movements and your prepared transfers. No AI is involved in these figures.` |
| `options[].title` | | `Move €{amount} from {account} on {date}` |
| `options[].consequence` | | `Lowest point €{lowest} on {date}.` plus ` An estimate.` when any item of that account is estimated |
| `options[].prepare.concept` | | `Cover for {shortfall date}` |

Observation kind `month_shortfall` (key `month_shortfall:<accountId>:<YYYY-MM>`, title `Short before the month ends`, basis = the account's `explanation`, `preparedId` when a prepared transfer goes uncovered): found only when the caller passes the forecast to the detection, between `prepared_uncovered` and `category_up`; silent when `prepared_uncovered` names the same transfer; behind the same gate and switch. **Never returned in `dashboard.observation`** (plan 28 D12). The chat does not pass the forecast yet (that is GL3), so today no surface volunteers it.

Limits: it stops at the month's last day; usual items need three full months inside the bank's 100-movement window; a charge that moves across a month boundary (the 31st, then the 1st) is not found; transfers the app sent (an `operationId`) are never usual, so a monthly saving made by hand each month is not projected unless it is a prepared transfer; card spending that is not a fixed monthly charge is not estimated at all, so "covered" means covered for what is listed.

<a id="forecast-adjustments-fc2"></a>**Forecast adjustments (FC2).** Plan: [`docs/plan/28-plan-area/00-plan.md`](plan/28-plan-area/00-plan.md) §13 and §6.1. The customer changes what the forecast counts: leaves a usual item out ("this is not regular") or adds a charge the rule cannot see. Table `forecast_adjustments` (migration `fc2-forecast-adjustments`); a removed row keeps `removed_at`; `npm run reset` and a reseed clear it. Nothing here sends money, prepares a transfer, calls a model or writes an event. After either call the page reads `GET /api/dashboard` again: neither answer holds a forecast.

```ts
// POST /api/forecast/adjustments — customer only, same origin, strict body, one of:
{ kind: 'exclude'; accountId: string; merchantKey: string }                    // the `merchantKey` of a usual event, /^[A-Z0-9& ]{1,40}$/
{ kind: 'expect'; accountId: string; label: string; amountCents: number; repeats: 'monthly'; day: number }   // day 1–31; the 31st is the last day of a shorter month
{ kind: 'expect'; accountId: string; label: string; amountCents: number; repeats: 'once'; date: string }     // 'YYYY-MM-DD', from today to 366 days ahead
// → 201 { adjustment }; 200 { adjustment } with the existing one when that key is already left out on that account
// DELETE /api/forecast/adjustments/:id → 200 { removed: boolean }
type ForecastAdjustment = { id: string; kind: 'exclude' | 'expect'; accountId: string; merchantKey?: string;
  label: string; amountCents?: number; repeats?: 'monthly' | 'once'; day?: number; date?: string; createdAt: string };
```

```json
{"adjustment":{"id":"1f8ef704-ae7a-4102-94c2-e4b988a3b1ee","kind":"expect","accountId":"acc-lucia","label":"Car insurance","amountCents":290000,"repeats":"once","date":"2026-10-25","createdAt":"2026-10-07T08:17:52.768Z"}}
{"adjustment":{"id":"4bf7da29-e58b-4c0c-9c3c-472864bf4309","kind":"exclude","accountId":"acc-lucia","merchantKey":"SPOTIFY","label":"Spotify","createdAt":"2026-10-07T08:17:52.821Z"}}
{"removed":true}
{"error":"You already have 20 changes to your month ahead. Remove one before adding another.","code":"too_many"}
```

Limits and checks: `label` is trimmed, 1 to 40 characters, and a control character or a bidirectional control (U+202A–U+202E, U+2066–U+2069) is refused with `400` (a transfer concept has them removed; this one is refused); `amountCents` is a whole number from 1 to 10,000,000 (the transfer form's ceiling); at most 20 active adjustments per customer (`409`, `code: "too_many"`); an `accountId` that is not one of the customer's accounts at the bank is `404`; an operator is `403`. RG1: an `expect` body takes an optional `direction: 'charge' | 'income'` (absent is `charge`, exactly as before; see "Regular money" below). An exclusion's `label` is the usual item's name, made from its key.

What `forecast` gains on the dashboard:

```ts
type MonthForecast = { adjustable: true;                                       // this server takes adjustments
  adjustments: ForecastAdjustment[];                                           // every active one of these accounts, oldest first
  notCounted: { label: string; text: string; adjustmentId?: string;
    reason: 'paused' | 'no_date' | 'irregular' | 'excluded_by_you' | 'already_seen' | 'already_prepared'
      | 'usual_like_it' }[];                                                   // RG1f
  /* …as FC1 */ };
type ForecastEvent = { source: 'prepared' | 'usual_charge' | 'usual_income' | 'expected_by_you';
  adjustmentId?: string;                                                       // on an `expected_by_you` event
  /* …as FC1 */ };
```

```json
{"date":"2026-10-25","label":"Car insurance","amountCents":-290000,"source":"expected_by_you","certainty":"estimated","adjustmentId":"1f8ef704-ae7a-4102-94c2-e4b988a3b1ee","balanceAfterCents":-1328}
{"label":"Spotify","reason":"excluded_by_you","adjustmentId":"4bf7da29-e58b-4c0c-9c3c-472864bf4309","text":"Spotify: left out by you, not counted."}
```

Rules (the adjustments are an argument of `monthForecast`; the module still reads no database):

1. **Exclude:** the usual item with that key on that account, charge or income, leaves `events`. Every active exclusion is in `notCounted` as `excluded_by_you`, also in a month where the rule finds no such item, so it can always be counted again. `income` stays `counted` when the income left out is one the rule found.
2. **Expect:** an event `expected_by_you`, always `estimated`. Monthly: this month's occurrence, unless its day has passed. Once: on its date, when that is from today to the month's last day. One that is not in this month is only in `adjustments`.
3. **No double counting:** an expected charge is not counted when a debit of this month on that account, or a counted prepared transfer from it, is within 15% and 5 days of it. It is then in `notCounted` as `already_seen` or `already_prepared`. RG1f: nor is one that a usual charge counted this month on that account already is (FC1's twin rule, 15% and 5 days, between the expected charge's date and the usual charge's usual day this month, also when that charge is late and counted on today); it is then in `notCounted` as `usual_like_it`. An expected income is never dropped this way.
4. **Wording:** a shortfall that counts an expected charge up to its lowest point is `estimated`, never `certain`, and names the charge as the customer's own.
5. **The label stays with the customer:** it is in `forecast` of their own dashboard and nowhere else: no model request, no `ai_usage` row, no log line, no event, no operator view. The `month_shortfall` observation (its basis is told in the chat and recorded) is therefore worked out without the expected charges, with the exclusions kept (`src/observations/detect.ts`): a shortfall only an expected charge causes is not an observation, and one that exists without it is, in the sentence and with the figures of the forecast without it. Those figures can differ from the Plan page's, which counts the charge.

| Field | Case | Text |
|---|---|---|
| `explanation` | short, only the customer's items counted | `If {yours} comes, on {date} you would be €{short} short for {forLabel}. An estimate.` (`come` for several); `{yours}` is `Car insurance (€2,900.00, on the 25th, added by you)` |
| `explanation` | short, usual items and the customer's | `If {items} come as in {July–September} and {yours} comes, on {date} you would be €{short} short for {forLabel}. An estimate.` |
| `forLabel` | the item that crossed is the customer's | `{label}, added by you` |
| `explanation` | covered | `Lowest point €{lowest} on {date}.` plus ` An estimate: it counts {m} {payment\|payments} added by you.` or ` An estimate: it counts {n} usual {payment\|payments} and {m} added by you.` |
| `notCounted[].text` | `excluded_by_you` | `{label}: left out by you, not counted.` |
| `notCounted[].text` | `already_seen` | `{label} (€{amount}, added by you): a payment like it is already in your movements this month, not counted twice.` |
| `notCounted[].text` | `already_prepared` | `{label} (€{amount}, added by you): a prepared transfer like it is already counted, not counted twice.` |
| `notCounted[].text` | `usual_like_it` (RG1f) | `{label} (€{amount}, added by you): a usual charge like it is already counted, not counted twice.` |
| `sourceLine` | with an active adjustment | `Worked out by fixed rules from your movements, your prepared transfers and what you added or left out. No AI is involved in these figures.` |
| `409` `error` | at the cap | `You already have 20 changes to your month ahead. Remove one before adding another.` |

Limits: an adjustment cannot be edited (remove it and add it again); a usual charge is not dropped because the customer added one like it (the added one is, RG1f); the chat has no tool for adjustments.

<a id="regular-money-rg1"></a>**Regular money (RG1).** Each account of `forecast.accounts[]` gains `regular`: what comes every month, all of it (also what is already paid this month), apart from `events` (what is still to come). Same function, same reads, no model, no categories; one migration (`rg1-expect-direction`: a nullable `direction` column on `forecast_adjustments`). Every other field of the forecast is unchanged.

```ts
type ForecastAccount = { regular: RegularMoney; /* …as FC1 */ };
type RegularMoney = { income: RegularItem[]; charges: RegularItem[];           // each by usualDay, then label
  irregularSpend: { monthlyCents: number; months: string[] } | null };         // monthlyCents positive; months = history.months
type RegularItem = { id: string;                                               // detected: its merchantKey; added: the adjustment id
  label: string; amountCents: number;                                          // positive for income, negative for a charge
  usualDay: number; source: 'detected' | 'added_by_you'; seenOn?: string[];    // seenOn: detected only
  thisMonth: 'done' | 'to_come' | 'late'; excludable: boolean; adjustmentId?: string };
// POST /api/forecast/adjustments, an expect body: { …as FC2, direction?: 'charge' | 'income' }
type ForecastAdjustment = { direction?: 'income'; /* …as FC2; absent is a charge */ };
```

1. **Detected:** the usual items of the history's three full months (the FC1 rule), less those the customer excluded (`exclude` works for an income as for a charge). `excludable: true`; the `exclude` body takes `merchantKey: id`.
2. **Added:** the customer's monthly `expect` adjustments of that account, with `adjustmentId` (removed with `DELETE`), `excludable: false`. A one-off (`repeats: 'once'`) is not regular: it is only in `events` and `adjustments`.
3. **`thisMonth`:** `done` when a movement of this month already is it (detected: same key and sign; added: same sign within 15% and 5 days); else `late` when its day of this month has passed; else `to_come`.
4. **An expected income** (`direction: 'income'`) is an `expected_by_you` event with a positive amount, counted like a usual income: after the debits of its day. It is not counted when a credit of this month on that account is within 15% and 5 days of it (`already_seen`, text `… an income like it is already in your movements this month …`); a prepared transfer never stands in for it. In an explanation it reads `your income from {label} (€{amount}, on the {nth}, added by you)`. `income` and `notes` of the forecast still speak of the income the rule found.

<a id="prepared-regular-rg1b"></a>**Prepared transfers as regular money, and early next month (RG1b).** A monthly prepared transfer (a savings goal's included) whose first payment is next month was in no list: `events` stop at the month's end. Now:

```ts
type RegularItem = { /* …as RG1, and: */ source: 'detected' | 'added_by_you' | 'prepared';
  thisMonth: 'done' | 'to_come' | 'late' | 'next_month';
  nextDue?: string;                                                            // prepared: its next payment, YYYY-MM-DD
  goalId?: string };                                                           // prepared: the savings goal it feeds
type ForecastAccount = { nextMonth: NextMonthItem[]; /* …as RG1 */ };          // by date, debits first, then label
type NextMonthItem = { date: string; label: string; amountCents: number;      // signed as on the account
  preparedId?: string; goalId?: string; adjustmentId?: string };
```

5. **Prepared:** every active monthly prepared transfer (paused ones are left out), on each own account it touches: a charge (`-amount`) on the account it leaves, an income on the own account it reaches. `id` is the prepared transfer's id, `usualDay` its day, `excludable: false` (it is managed in Transfers or Goals). `label`: `Goal: {goal name}` for a goal's, else `To {recipient}` on the source and `From {source account label}` on the destination. `thisMonth`: `done` when it was sent this month (`lastSentAt` in this month, Madrid), else `to_come` when its next due date is in this month (or earlier: a due one), else `next_month`. It is still counted in `events` exactly as FC1 counts it (a due one on today); `irregularSpend` is unchanged.
6. **`nextMonth`:** what falls in the first 7 days of next month, listed only: each regular item's occurrence there (a prepared one's `nextDue` when that is already next month, else its day of next month; day 31 is the month's last day) and a one-off prepared transfer (`on_date`, not paused) dated there. RG1c: a detected charge that a prepared transfer of the same account already is (FC1's twin rule: within 15% and 5 days) is listed once, as the prepared item, in `regular.charges` and in `nextMonth` (a one-off's twin in `nextMonth` too); `irregularSpend` still treats it as a regular charge. The projection, `endCents`, `lowest`, the shortfall and `until` do not change: nothing of next month is counted. Example (Lucía, 7 Oct, a goal "Pagar a Carla" of €666.67 on the 1st): `[{date:'2026-11-01', label:'Alquiler Inmob Castellana', amountCents:-95000}, {date:'2026-11-01', label:'Goal: Pagar a Carla', amountCents:-66667, preparedId, goalId}, {date:'2026-11-05', label:'Iberdrola Clientes', amountCents:-7120}]`.
7. **`irregularSpend`:** over `history.months`, the account's debits that are not a detected regular charge of it, not the payment of an added monthly charge of it (RG1e: such a charge takes at most one debit of each calendar month, the closest in amount, then in days, within 15% and 5 days of its day of that month or of the month before or after, so a payment on the 30th is near the 1st), not a move between own accounts (the app's record names two own accounts, or the operation has two legs on own accounts in this read) and not an operation sent from a prepared transfer (an intent `prepared:…`), summed and divided by the number of months, rounded to the cent. `null` when `history.months` is `null`. An excluded usual charge counts as irregular.
8. **An added monthly charge that is another regular item (RG1d, RG1e).** Within FC1's twin rule (same account, 15%, 5 days), an added monthly charge that a monthly prepared transfer already is (RG1d), or that a detected charge already is (RG1e), is listed once, as that item, in `regular.charges` and `nextMonth`. RG1e follows the projection: the added one stays listed while the projection counts it as its own event this month. Since RG1f the projection does not count an added charge whose detected twin it counts (`usual_like_it` above), so the added twin is listed inside the detected item in every case where that item is counted, still to come or late; it stays listed on its own only when the projection still counts it: the detected one is not counted this month (its payment already seen) and no debit like the added one is seen within 15% and 5 days of its date (e.g. rent usually on the 3rd, paid on the 1st, added for the 8th). The timeline's later months are built from `regular`, so they count it once too. The hidden one stays in `adjustments`, with `countedWith`: the label of the item it is listed in, as the customer sees it (`To Inmob Castellana`, `Goal: Pagar a Carla`, `Alquiler Inmob Castellana`), and that item's `source`. Absent otherwise. It is not in the chat tools' results (`adjustments` is not).

```ts
type ForecastAdjustment = { countedWith?: { label: string; source: 'prepared' | 'detected' }; /* …as RG1 */ };
```

Lucía on the demo seed, on 7 October 2026 (`.scratch/after/feat-rg1-regular-money/lucia-regular.txt`): income `Nomina Acme Consulting` €2,150.00 on the 28th (to come); charges `Alquiler Inmob Castellana` €950.00 on the 1st (done), `Iberdrola Clientes` €71.20 on the 5th (done), `Digi Spain Telecom` €39.90 on the 10th, `Spotify` €10.99 on the 14th, `Recarga Abono Transporte Crtm` €32.70 on the 31st; `irregularSpend` €820.04 a month (July–September).

<a id="balance-timeline-tl1"></a>**Balance timeline (TL1).** `GET /api/forecast/timeline?accountId=<own account>&range=<range>`: one account's end-of-day balance over a calendar period, for the Plan chart. Customer only; the same reads as the dashboard's month ahead (bank accounts and movements, prepared transfers, adjustments, goals), computed on each request, so an added or removed item, a prepared transfer or a goal shows on the next read. No model, nothing recorded. `src/forecast/timeline.ts` (pure) over `monthForecast`.

```ts
type Range = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'next_month'
  | 'last_3_months' | 'next_3_months' | 'last_6_months' | 'next_6_months';    // absent = this_month
type Timeline = { accountId: string; range: Range; today: string; from: string; to: string;
  points: { date: string; balanceCents: number; lowCents?: number; actual: boolean }[]; // one per day, start..to
  events: { date: string; label: string; amountCents: number;                // signed
    source: 'movement' | 'usual_charge' | 'usual_income' | 'expected_by_you' | 'prepared' | 'goal' | 'everyday';
    certainty: 'actual' | 'certain' | 'estimated'; preparedId?: string; goalId?: string }[];
  months: { month: string; from: string; to: string; startBalanceCents: number; endBalanceCents: number;
    incomeCents: number; outCents: number; actual: 'full' | 'partial' | 'none' }[]; // one per calendar month of the line
  lowest: { date: string; balanceCents: number } | null;                     // projected part only; its day's point carries it
  shortfall: { date: string; shortCents: number } | null;
  basis: { regularIncomeMonthlyCents: number; regularChargesMonthlyCents: number;
    everydayMonthlyCents: number; months: string[] };
  notes: string[] };
```

1. **Periods** (Madrid days, `today()`): weeks run Monday to Sunday; `this_month` is the 1st to the last day; `last_3_months` / `last_6_months` start on the 1st two / five months back and end on the current month's last day; `next_3_months` / `next_6_months` start on the current month's 1st and end two / five months ahead.
2. **Actual days** (up to today, `actual: true`): the bank balance less the account's movements after that day. Today's point is the bank balance. When the movement page may be cut (`movementWindow().mayBeTruncated`) and its oldest day is after `from`, the points start on that day and a note says so.
3. **The current month after today** is the month ahead (`forecast.accounts[]` of the same account): the same events, and `lowest` / `shortfall` worked out as it does (debits before credits within a day). For `this_month` they are equal. An event dated today (a late usual charge, a due prepared transfer) is still to come (TL1b): today's point stays the bank balance (`actual: true`), the event shows from the next day's point, and every balance worked out from the projection counts it as today's: a `months[]` entry that ends today ends after it (so it can differ from today's point), the next entry starts there, and `lowest` / `shortfall` include it on today's date, as the month ahead does. Every `months[]` entry satisfies `startBalanceCents + incomeCents − outCents = endBalanceCents`, and each starts where the one before ended.
4. **Later months:** RG1's `regular` items on their usual day (`usual_income`, `usual_charge`; the customer's monthly ones `expected_by_you`; RG1b's `prepared` items are the prepared transfers below, not counted twice), the customer's one-off items on their date, prepared transfers on their dates (a monthly one every month), a goal's transfer (`source: 'goal'`, `certainty: 'certain'`) every month until what is left of the goal is paid (TL1b: only drawn payments count; a transfer overdue by more than a month is paid once this month, as the month ahead counts it, and then monthly from next month), and `irregularSpend` spread evenly over each day of the month (`everyday`, estimated). Paused and undated prepared transfers are not counted, as in the month ahead. FC1's twin rule holds in every month: a usual charge or an added charge within 15% and 5 days of a prepared transfer from the same account is counted once, as the transfer. `basis.regularChargesMonthlyCents` includes RG1b's monthly prepared transfers.
5. **Labels** are the month ahead's and the customer's own (bank descriptions, the label of an item they added; a goal's transfer is `Goal: {goal name}` with its `goalId`, on both accounts, as in RG1b's `regular`, TL1c): this route answers only the owner and goes to no model.
6. **The lowest point is on the chart** (TL1c). `balanceCents` is the end of the day, but `lowest` is worked out item by item, so it can fall inside a day (debits before credits: a goal's payment and a charge on the 28th before the payroll the same day). Each point from today on carries `lowCents`, the lowest balance within that day (from its opening balance, today's being the bank balance, through each of its items in that order), only when it differs from `balanceCents`. The point of `lowest.date` has `balanceCents` or `lowCents` equal to `lowest.balanceCents`, and no point from today on goes below it. Example (Lucía, demo bank, 7 Oct 2026, a goal "Lisboa" of €1,200 paid €200 on the 29th, `next_6_months`; `.scratch/after/fix-tl1c-timeline-lowest-label/probe-after.txt`): `lowest` is 28 Feb 2027 at €2,754.70; that point ends at €4,904.70 with `lowCents` 275470, while the lowest end of day is €2,886.72 on 14 Oct.

Limits: everyday spending is flat over the days (no weekday pattern); a shortfall that starts before `from` is reported on the first item inside the period.

<a id="the-brief-pl1"></a>**The brief (PL1).** Plan: [`docs/plan/28-plan-area/00-plan.md`](plan/28-plan-area/00-plan.md) §4.5, §6.1, D14, D15. The customer's `GET /api/dashboard` gains `brief: Brief | null`: what the rules already found, in one place, under a fixed headline. Computed on each read by `planBrief` (`src/plan/brief.ts`, a pure function) from the `forecast` of the same read, the customer's goals (`goalsOf` over the accounts that read already holds, and the app's own tables), what the observation rules found (`explainObservations`) and the customer's dismissed keys and switch (`observationHistory`). No bank request of its own, no model, no new rule, no table; reading it records nothing. `null` only if computing it fails (never a failed dashboard); the operator's dashboard has no such field.

```ts
type Brief = { headline: string;
  findings: { kind: 'forecast_shortfall' | 'goal_behind' | 'category_up'; text: string;
    accountId?: string;   // forecast_shortfall: the account of `forecast.accounts[]`
    goalId?: string }[] } // goal_behind: the goal of `GET /api/goals`
```

Lucía on the demo bank on 7 October 2026, after preparing €2,915.00 to Bruno for 20 October and lowering a goal to €150.00 a month (`.scratch/after/feat-pl1-plan-brief/briefs/lucia-shortfall-goal.json`):

```json
{
  "headline": "Two things to look at.",
  "findings": [
    { "kind": "forecast_shortfall", "text": "Aurora account: €28.28 short on 20 Oct. An estimate.", "accountId": "acc-lucia" },
    { "kind": "goal_behind", "text": "Trip to Lisbon: €300.00 behind plan.", "goalId": "fff884db-f1aa-4022-969d-6db616dda9f2" }
  ]
}
```

| Findings | `headline` |
| --- | --- |
| 0 | `Nothing needs a look this month.` |
| 1 | `One thing to look at.` |
| 2 | `Two things to look at.` |
| 3 or more | `{n} things to look at.` |

| Kind | `text` | From |
| --- | --- | --- |
| `forecast_shortfall` | `{account label}: {the account's forecast headline}.`, plus ` An estimate.` when `shortfall.certainty` is `estimated`. Model: `Aurora account: €28.28 short on 20 Oct. An estimate.`; certain: `Savings: €100.00 short on 25 Oct.` | each account of `forecast.accounts` with a `shortfall`, whatever the forecast counted to find it |
| `goal_behind` | `{goal name}: {the goal's headline}.`, that is `Trip to Lisbon: €300.00 behind plan.` | each goal with `behindCents` above 0. A goal that is `behind` for a waiting payment alone has `behindCents` 0 and is not a finding |
| `category_up` | the `basis` of the `category_up` observation, unchanged | the first `category_up` the rules found whose key the customer has not dismissed; none during trouble (below) |

No figure is formatted by the brief: each text is the sentence of the piece that computed it, so the brief and that piece cannot disagree. Order: shortfalls by date, goals by `behindCents` (largest first), then one `category_up`. At most 5 findings are listed; the headline counts all of them.

**Observations off (D15), enforced by the server.** When the customer turned observations off (`POST /api/assistant-settings {"observations": false}` or `POST /api/observations {"enabled": false}`), or the bank runs with `OBSERVATIONS=off`, the brief has no `forecast_shortfall` and no `category_up` finding. Goal findings stay: a goal is the customer's own plan. `forecast` itself is unchanged, so the Plan page still shows the month. **During trouble.** The `category_up` finding passes the gate of `dashboard.observation` (`observationGate`: a case opened in the last 24 hours and still open, a transfer being verified, in process or failed in the last 24 hours, a pending approval): it is absent whenever that gate hides the "Worth a look" card, because the bank does not point at a spending habit while the customer has a problem open. A `forecast_shortfall` and a `goal_behind` are about the customer's own money and plans: they stay listed during trouble.

**What the assistant may do (AC1).** One read and one write for the customer's control over the assistant. No table and no migration: both switches stay events (plan 24 D8, plan 26 D6), read from the app database only (no bank request, no model).

- `GET /api/assistant-settings` → `200 {suggestions: {enabled, changedAt, available}, observations: {enabled, changedAt, available}, rules: [{merchantKey, name, category, categoryLabel, createdAt}], recorded: [{at, kind, text, incidentId?}]}`. `enabled` is the customer's own switch (`true` until they turn it off); `available` is `false` when the deployment has the feature off (`OFFERS=off` / `OBSERVATIONS=off`): the customer's switch is kept and can still be set, but has no effect until the feature is back; `changedAt` is the instant of the last change, or `null` if the customer never changed it. `rules` is `GET /api/insights/rules` (newest first) with `name` (the merchant key, or "Payments with no merchant name" for a key that is only a payment channel) and `categoryLabel` (English). `recorded` is newest first, at most 50, with `kind` one of `suggestion_shown`, `suggestion_declined`, `interest_noted`, `observation_told`, `observation_dismissed` (the events `offer.shown`, `offer.declined`, `offer.interest`, `observation.told`, `observation.dismissed`); `text` is server text (plan 28 §6.1), to render as text: `Suggested: <product>`, `You declined: <product>`, `Interest noted: <product>. A support case was opened.`, `Told in the chat: <basis>` (the basis the server wrote when the chat told the observation) and `You dismissed: <title>` (the title rebuilt from the dismissed key: "A prepared transfer is not covered", "Short before the month ends", "<Category> is up"; nothing of a made-up key is repeated); never text the customer typed. `incidentId` is present on `interest_noted` only: the support case that was opened.
- `POST /api/assistant-settings` with `{"suggestions"?: boolean, "observations"?: boolean}`: at least one of the two, no other field, else `400 "Invalid request data."`. It records `offers.enabled` / `offers.disabled` and `observations.enabled` / `observations.disabled` only on a change (idempotent) and answers the same body as the `GET`. Shares the `actions` rate-limit bucket.
- Both: customer session only (operator `403 "A customer is required."`, no session `401`); other methods `405`.
- `POST /api/observations {enabled}` stays and is the same observations switch (the Overview card uses it). A rule is deleted with the existing `DELETE /api/insights/rules/:merchantKey`. `recorded` is read-only: those events are the hash-chained audit log, so there is no route that deletes them.
- With product suggestions off (the customer's switch), the chat still answers a question about a product from its sheet (plan 24 D7), but: a turn with `get_offer_details` attaches no `Note my interest` / `Not interested` replies; `offer_response` with `interested` answers `{status:"refused", reason:"suggestions_off"}`, records nothing and opens no case (`declined` is still recorded); and a click on a `Note my interest` reply left by an older answer records nothing.

**Notifications (CF5).** Computed at read time from records that already exist; nothing in the transfer or case paths writes a notification, and no bank or model call is made (the list works while the bank is down). Window: the last 30 days, at most 50 items, newest first. Each item is `{id, kind, at, read, status?, amountCents?, to?, expiresAt?, link}`; the client builds the text (money and time formatting are local).

| `kind` | Source | `id` | `at` | Fields, `link` |
|---|---|---|---|---|
| `transfer_verified` | `transfer.verified` event of the customer (a later check changed an unknown outcome, R7) | `ev:<event id>` | event time | `status` (`completed` \| `failed`), `amountCents`, `to`; `{tab:"transfers"}` |
| `proposal_expiring` | unconsumed approval with `now < expires_at ≤ now + 3 min` | `expiring:<approval id>` | `expires_at − 3 min` | `amountCents`, `to`, `expiresAt`; `{tab:"transfers"}` |
| `proposal_expired` | unconsumed approval with `expires_at ≤ now`, intent still `awaiting_confirmation` | `expired:<approval id>` | `expires_at` | same as above |
| `case_resolved` | `case.resolved` event of a case owned by the customer | `ev:<event id>` | event time | `{tab:"assistant", conversationId}` |
| `prepared_due` | **PT1.** a prepared transfer in state `due` (never `ready`, `scheduled`, `paused` or one with a proposal waiting) | `prepared-due:<id>:<nextDue>` | the due date | `amountCents`, `to`; `{tab:"transfers"}` |

`to` is the name recorded with the proposal (DV7-B), else the destination account id. A transfer completed during the confirm itself (`transfer.completed`) is not notified: the customer saw that result on screen. A cancelled or confirmed proposal is consumed, so it gives neither proposal kind. `POST /api/notifications/read` takes `{ids: string[]}` (1–50 ids, each 1–120 chars) or `{all: true}` (zod `.strict()`; same-origin check); it stores a mark only for ids in the customer's current derived list (others are ignored) and is idempotent. Errors: `400 "Invalid request data."`, `403` operator. `npm run reset` clears read marks.

**Voice input (VC1).** `POST /api/transcribe`: the body is the raw recording from the browser's `MediaRecorder`, at most 2 MB (2,097,152 bytes), with `Content-Type` one of `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/wav` (parameters such as `;codecs=opus` allowed). Answer `200 {"text": "<transcript>"}`, trimmed; a recording with no speech is `200 {"text": ""}`. The checks, in order, all before the body is read or a model is called: operator `403 "A customer is required."`; the `actions` bucket (`429`); no `OPENAI_API_KEY` or `VOICE=off` → `503 {"error":"Voice input is not available.","code":"voice_unavailable"}`; a customer at `AI_DAILY_CAP_USD` → `503` with the chat's daily-limit sentence and `code: "ai_daily_limit"`; another `Content-Type` → `400 "Invalid request data."`. Then over 2 MB (by `Content-Length`, or by counting a stream without it) → `413 {"error":"Recording too long."}`, an empty body → `400 "Invalid request data."`. The provider is OpenAI's transcription endpoint through the assistant's client (`OPENAI_API_KEY`, `OPENAI_BASE_URL`), model `VOICE_MODEL` (default `gpt-4o-mini-transcribe`), language detected by the model; any provider error or timeout → `502 {"error":"Could not transcribe the recording.","code":"transcription_failed"}`. The audio and the transcript are neither logged nor stored: the log lines `voice_ok` and `voice_failed` carry the status and the milliseconds; the `ai_usage` row (consumer `voice`) carries the tokens the provider reported.

## Actions

| `name` | `arguments` | Result |
|---|---|---|
| `list_accounts` | `{}` | `{status:"ok", accounts, contacts}` |
| `search_documents` | `{query, validAt?}` (`YYYY-MM-DD`) | `{status:"ok", sources}` |
| `cancel_transfer` | `{approvalId}` | **new (R5).** Same result as `POST /api/approvals/:id/cancel`; errors as `{status:"failed", error}` |
| `transfer_money` | `{fromAccountId \| null, recipient? \| null, toAccountId? \| null, amountCents, concept}`; `recipient` or `toAccountId` required. S1: instead of `amountCents` (integer cents, 1..10,000,000) a client may send `amount`, the decimal euros text the customer typed (`"12.50"` or `"12,50"`; no sign, exponent, hex, `Infinity`/`NaN`, at most 2 decimals). `concept` is trimmed and must not be empty. Invalid values give `{status:"failed", code:"invalid_request"}` and create nothing | a **proposal**, see below |
| `operation_status` | `{reference \| null}` | one verified transfer (same shapes as a repeated confirm, below), or `{status:"ok", transfers:[…]}` (latest 5, each verified) for `null`. A reference the app did not create but the bank knows returns the bank operation as is. An unknown reference is `not_found`, never a failed transfer: `{"status":"not_found","reference":"nope","message":"No transfer with this reference was found for this customer."}` |
| `request_human` | `{summary}` | `{status:"open", incidentId}`; needs `conversationId`; reuses the conversation's open case. HS2: called through `POST /api/actions` (the customer's "Ask for human support" on a failed turn, no model) it also stores one assistant message in that conversation, "A support request is open for this conversation (reference #XXXXXX). A person from the bank will review it.", with `extras.handoff`; the result is unchanged. A repeat while that message is still the conversation's newest stores nothing (10 parallel calls: one case, one message); after later messages a new call returns the same case and stores the confirmation again. Called by the model inside a turn it stores no message: the model's answer is the confirmation. FX7: a customer holds at most `HANDOFF_OPEN_CASES` (default `5`, a positive whole number checked at startup) open cases opened this way, on both paths, counted and inserted in one transaction. At the limit no case is opened and the result is `{status:"open", incidentId, limitReached:true, message}`, `incidentId` being the customer's most recent open case and `message` telling the model that no case was opened for this conversation; through `POST /api/actions` the stored message is then "You already have open support requests (most recent reference #XXXXXX). A person from the bank will review them. No new request was opened for this conversation." Not counted and never refused: a case the app opened for a product interest, and a conversation with a transfer that is `processing`, `pending_verification`, or `failed` with a bank reference (money may have moved, unverified). A resolved case frees a slot. The operator reads a refused request on the case it named: `GET /api/incidents/:id` → `summary.cappedRequests` (`[{at, conversationId, summary}]`, the newest 10; `summary.cappedRequestsTotal` counts all) and one line each in `summary.text` |

**Chat-only tool (new, G4).** The chat agent also has `list_movements` (`{}` → `{status:"ok", movements}`: the session customer's latest 20 movements from `GET /v1/movements`, newest first, read-only). `POST /api/actions` does not accept it: `400` (its `name` enum is the contract's five actions plus `cancel_transfer`); API clients read the same movements from `GET /api/dashboard`.

**Chat-only tools (new, SI6b).** Shapes are frozen in [`docs/plan/23-spend-insights/contracts.md` §4](plan/23-spend-insights/contracts.md#4-agent-tools-chat-only). The chat agent has five spend-insights tools; `POST /api/actions` does not accept them (`400`). They run the same functions as the `/api/insights/*` routes (ownership, sign rule, one transaction, audit events with `channel: "chat"` and the conversation id), on one bank read per chat turn. Merchant text in their results and in the prompt digest is the merchant key, never a raw bank description. IT7: a result row whose `merchant` (or group whose `merchantKey`) is a generic key (only channel words, such as `CARD PAYMENT` or the direct debit `RECIBO`) also has `genericKey: true`, and the model is told to describe it as payments with no merchant name; other rows do not have the field. Arguments are strict (an extra or missing field → `{status:"failed", code:"invalid_request", error}`).

| `name` | `arguments` | Result |
|---|---|---|
| `get_spending_summary` | `{from: "YYYY-MM-DD" \| null, to: "YYYY-MM-DD" \| null}` (UTC days, inclusive) | `{status:"ok", …SpendingSummary}` with the totals of `GET /api/insights/spending` for that range; each category also has `labelEs` and `movements: {ref, id, merchant, amountCents, createdAt, state}[]` (its 5 largest); a group's `title` is its merchant key. `from` after `to` → `failed`, `"The start date is after the end date."` |
| `list_unresolved_movements` | `{}` | `{status:"ok", count, totalCents, groups: {merchant, count, totalCents, movementIds, candidates, reason, direction?}[]}` (`direction`: `debit` or `credit`, the sign of the group): the movements in `needs_review` by merchant, largest first, at most 10 groups |
| `suggest_category_choices` | `{movementId}` | `{status:"ok", movementId, merchant, amountCents, createdAt, category, state, reason, confidence, threshold, candidates}` for any movement of the customer ("why this category?" and "which one is it?"). `candidates` are the stored ones the sign allows; when there are none, the three categories the customer uses most (then taxonomy order), `p: null`, never `other` |
| `set_movement_category` | `{movementId, category, applyToSimilar: boolean \| null}` (`category`: an enum of the eleven ids; `work` since #193) | `{status:"ok", category, updated, similar: {merchant, count} \| null, ruleCreated}`. `similar`: the other movements of that merchant and sign in the bank answer (null when none). With `applyToSimilar: true` the rule is created and they are changed, but only when the conversation's newest assistant message stored an offer for that merchant key and category; otherwise `failed`, `"Ask the customer first."`, nothing written |
| `remove_category_rule` | `{merchantKey}` | `{status:"ok", removed, reclassified}`, as `DELETE /api/insights/rules/:merchantKey` |
| `list_movements` (G4) | `{}` | as before; each movement gains `category: {id, state, reason}` and `ref` |

Failures are `{status:"failed", error}`: `"Movement not found."` (an id that is not in the session customer's current bank answer: another customer's or unknown, the same answer), `"This category does not fit this movement."` (sign rule), the bank's error text when the bank read fails (nothing written), and `"This answer is about another movement."` from `set_movement_category` when the customer's message is a quick-reply click (exactly a `value` of the newest assistant message's `quickReplies`) and the movement is not the stored target of that message (nothing written; typed words may name any movement of the customer).

**Message extras (SI6a, SI6b).** Stored by the server with a message, from bank and app records only (never from model text), and sent on `GET /api/conversations/:id` as `extras` (`null` when a message has none):

- `movement: {id, title, amountCents, createdAt}` on a user message: the attached movement (SI6a).
- `quickReplies: {label, value}[]` on an assistant message; a click sends `value` as an ordinary message. First match: (1) a category was set and other movements share the merchant, no rule yet → `Yes, apply to the other N` / `No, only this one`; (2) the run's last `suggest_category_choices` (unless the run then set that movement) → one per candidate (English category label; `other` is left to the next button), then `Other` (value `Another category`), then `Skip`; (3) the message's attached movement is in `needs_review` and nothing was set → as (2) for it; (4) the run's last `get_spending_summary` has unresolved movements → `Review them` / `Not now`, at most once per conversation (so never again after a `Not now`) and not on a turn for which the server chose a product suggestion, which does not use the nudge up (XS6, plan 24 §4).
- `citedMovements: {id, title, amountCents, createdAt, category}[]` (at most 8, in order of first mention) on an assistant message: tools hand out refs (`m1`, `m2`, … unique within a turn); a marker `[m3]` (or `[m1, m2]`) in the answer is removed from the stored text and its movement stored here; an unknown ref stays in the text. Document citations work as before.
- `turnFailed: string` on an assistant message (HS2): the message is the stored answer of a turn the assistant could not run or finish. The value is the `code` of that turn's `502` (`missing_openai_api_key`, `provider_refused`, `provider_busy`, `turn_failed`, and `ai_daily_limit` with a daily cap set, SC1), or `no_answer` for a turn that completed (`200`) with no text and stored "I could not finish this request. Try again or ask for human support." Never the internal reason. The page offers "Ask for human support" while such a message is the conversation's last; messages stored before HS2 have no marker and no button.
- `handoff: {incidentId, reference}` on an assistant message (HS2): the confirmation of a support case the customer opened directly (`request_human` through `POST /api/actions`). `reference` is the case's short reference as the operator sees it (`#` and six characters), the same one in the message text.
- `awaiting: {movementIds, merchantKey, offer?: {category}}` is stored with rows (1)–(3) and is **never sent**: it is what the customer's next answer is about. The next model request names those ids and that merchant key (and the open offer) in its "SPENDING STATE" digest, so a click or a free-text answer lands on the right movement without relying on the model's memory, and `set_movement_category` checks the offer there. An answer that used no tool and asked nothing keeps the target (not the offer); any other answer without one closes it.

The digest is rebuilt every turn (today's date in `Europe/Madrid`, the awaited target, the conversation's attached movement with its merchant key, category, state and reason, the five largest unresolved groups); if the bank read fails it says so and the answer continues.

**Product suggestions in the chat (new, XS3).** Plan: [`docs/plan/24-cross-selling/00-plan.md`](plan/24-cross-selling/00-plan.md) §4, §6. No new route: everything goes through `POST /api/conversations/:id/messages`, whose response shape is unchanged (`{runId, answer, sources}`).

- **Who decides.** Before each model request of a turn, until an offer is chosen, the server asks `offerGate` and then `selectOffer` over the accounts the turn already read (and the movements only if the run's bank view is already there). No bank request and no model request is added. The chosen offer adds a `PRODUCT SUGGESTION` block to the instructions with the catalogue's name, pitch, reason (no figures) and sheet: never the basis, a balance, an amount, a movement description or a merchant key.
- **The cut.** The model writes the suggestion as a last paragraph that starts with the marker `[offer-<id>]`. That line and everything after it is removed from the stored message and from `answer`, whether or not the suggestion is shown. A line that starts with any other `[offer-…]` marker (an offer the server did not choose, an invented id) is cut the same way and shows nothing; the exception is an offer whose sheet `get_offer_details` returned in this turn, where the marker is a citation. An answer that was only a suggestion becomes the fixed "I could not finish this request…" text.
- **Clean-turn rule.** The suggestion is attached only when the model wrote the chosen offer's paragraph, every tool of the turn was one of `list_accounts`, `list_movements`, `search_documents`, `get_spending_summary`, `list_unresolved_movements` and returned `status: "ok"`, the turn has a tool run or a cited document, and round 7 produced no quick replies. Otherwise the text is dropped and nothing is recorded. If the model's sentences are over 400 characters or hold a figure that is not in the sheet, the catalogue pitch is shown instead.
- **Extras** on the assistant message (`GET /api/conversations/:id`), in addition to the ones above:
  - `offer: {id, name, text, basis}`: the suggestion block. `text` is the model's sentences (or the pitch); `basis` is server text (figures rounded to €10, account label).
  - `offerSources: {id, title, version, validFrom, text}[]`: product sheets, shown inside the block. With `offer` it is that offer's sheet; without `offer` it is the sheets the answer rests on (`get_offer_details` of this turn, or a cited `[offer-<id>]`). Product sheets are never in `sources` / `message_sources`: the library stays the starter documents.
  - `quickReplies`: stage offered → `Tell me more` (value `Tell me more about this suggestion`), `Not interested`, `Don't suggest products` (value `Don't suggest products to me`); stage details (a turn whose `get_offer_details` returned ok and recorded no answer) → `Note my interest`, `Not interested`.
  - `awaitingOffer: {offerId, stage: "offered" | "details"}` is stored with those replies and **never sent**, like `awaiting`.
- **Clicks.** When the customer's message is exactly a reply `value` of the newest assistant message and that message has `awaitingOffer`, the server applies it before the model runs: `Not interested` → `offer.declined`; `Don't suggest products to me` → `offer.declined` and `offers.disabled`; `Note my interest` → `offer.interest` and a support case (`Product interest: <name>. …`, reusing the conversation's open case); `Tell me more…` → nothing. The model is told the result in an `OFFER STATE` line (offer id and name, the case id) and only words the reply.
- **Events** (XS2): one `offer.shown {offerId, name, basis}` per attached suggestion; `offer.declined {offerId, name}`, `offer.interest {offerId, name, incidentId}`, `offers.disabled {}`, `offers.enabled {}`. An offer that was shown, declined or answered with interest is never suggested to that customer again. A conversation gets at most one suggestion, and none once the customer answered about a product there (a click, `offer_response`) or asked about one (`get_offer_details`).

Chat-only tools (`POST /api/actions` does not accept them: `400`); arguments are strict and take no free text; `offerId` is an enum of the eight catalogue ids, anything else is `{status:"failed", code:"invalid_request", error}`:

| `name` | `arguments` | Result |
|---|---|---|
| `get_offer_details` | `{offerId}` | `{status:"ok", offer: {id, name, text, version, validFrom}, notice: "Nothing is contracted here. I can note your interest so a manager contacts you.", sources}`. `sources`: the sheet as a citable source (`documentId` = the offer id) and, for the two documented offers, the first chunk of the fee documents it restates (Cloud's and those of the customer's own products only) |
| `offer_response` | `{offerId, response: "interested" \| "declined"}` | `{status:"ok", incidentId?, response, notice: "Nothing is contracted in this chat."}`; idempotent per customer and offer. `interested` opens (or reuses) the support case; with the customer's suggestions switch off it answers `{status:"refused", reason:"suggestions_off"}` and records nothing (AC1) |
| `set_product_suggestions` | `{enabled: boolean}` | `{status:"ok", enabled}`; records `offers.disabled` / `offers.enabled` only on a change |

`OFFERS=off` refuses every suggestion (the tools stay, so a customer can still ask about a product); `OFFERS_COOLDOWN_DAYS` (default 0) spaces suggestions between conversations.

**Chat-only tools (new, PT3): prepared transfers.** Plan: [`docs/plan/25-prepared-transfers/00-plan.md` §5](plan/25-prepared-transfers/00-plan.md). The chat agent has three tools over `src/banking/prepared.ts`; `POST /api/actions` does not accept them (`400`). None of them executes a transfer: a prepared transfer is never sent by the app, not on its date either; sending one creates the usual proposal and `POST /api/approvals/:id/confirm` stays the only path that moves money.

| `name` | `arguments` | Result |
|---|---|---|
| `prepare_transfer` | `{fromAccountId \| null, recipient \| null, toAccountId \| null, amountCents, concept, note \| null, when: "manual" \| "on_date" \| "monthly", date: "YYYY-MM-DD" \| null, inDays \| null, day \| null}`; source and recipient as in `transfer_money`; `inDays` (1–366) is turned into the date by the server | `{status:"prepared", prepared: PreparedView, notice: "Prepared, not sent. Nothing leaves the account until the customer sends it and confirms."}`; no intent, no approval. Otherwise the refusal of preparing: `needs_source_account`, or `failed` with `invalid_request`, `invalid_date`, `ambiguous_recipient`, `invalid_destination`, `same_account`, `too_many`; nothing is stored |
| `list_prepared_transfers` | `{}` | `{status:"ok", today: "YYYY-MM-DD", prepared: PreparedView[]}` (due first); app database only, no bank request |
| `send_prepared_transfer` | `{preparedId}` | the `transfer_money` proposal (`requires_confirmation` with `approval`, `destination`, `intentId`), shown in the same confirmation card; a repeated call returns the same proposal. An id that is not the session customer's: `{status:"failed", error:"Prepared transfer not found."}`. Also `failed` with `not_active`, `paused`, `insufficient_funds`, `invalid_destination`, or the verified outcome while the last send is being verified |

The `note` and `concept` of a prepared transfer are the customer's text: they travel only as data fields of these results and are never added to the model instructions (the fixed block `preparedInstructions` in `src/agent/prepared.ts`). A turn that used any of the three tools carries no product suggestion (they are not in the clean-turn list above). Bank reads: `prepare_transfer` and `send_prepared_transfer` each read `GET /v1/accounts` and `GET /v1/contacts` once (the checks of a proposal); `list_prepared_transfers` reads nothing; a turn that calls none of them makes the same bank requests as before. Skip, pause and delete have no tool: they are the buttons in Transfers → Prepared.

**The month after a prepare (PA1, #198).** A successful `prepare_transfer` or `create_goal` result can carry `afterThis`: the forecast `get_month_forecast` gives, cut to the account the money leaves, with the new transfer counted (`afterThis` in `src/agent/forecast.ts`). Either `{covered: true, headline}` or `{shortfall: {date, shortCents, shortEuros, forLabel, explanation}, cover: {title, consequence, prepareWith} | null}`, where `prepareWith` is the cover option's own `prepare_transfer` arguments. It is absent when a bank read fails or the history window is short; a failed forecast never fails the save. The instructions tell the model to state a shortfall in the same answer, with the server's figures, and to offer the cover as a question, never preparing it in that answer. An answer whose last `prepare_transfer`, `prepare_cover` or `create_goal` carries a non-null `cover` is stored with `extras.coverOffer = {title, prepare}` and one quick reply, **Yes, prepare it** (value `Yes, prepare the transfer that covers it`).

| `name` | `arguments` | Result |
|---|---|---|
| `prepare_cover` | `{}` (anything the model passes is ignored) | the `prepare_transfer` result for exactly `extras.coverOffer.prepare` of the conversation's newest assistant message (so with its own `afterThis`). Otherwise `{status:"refused", reason, message}` and nothing is stored: `no_cover_offered` (that answer offered no cover), `not_confirmed` (the customer's message of this turn is not the reply's value or a typed yes of the goal list: `saidYes` of `goals.ts`), `already_prepared` (a second call in one turn). Each refusal message starts "Nothing was prepared: …" except `already_prepared`. It never sends money |

Known limits (#198's review): nothing on the server stops the model from calling `prepare_transfer` for the cover in the same answer (the instructions forbid it; a prepared transfer moves no money and can be deleted); the operator timeline names the tool `prepare_cover`; `afterThis` reports the account's first shortfall of the month, which an earlier transfer may cause; "create it" also counts as a yes to the cover; `coverOffer` is sent to the browser with the conversation (only the customer's own account ids, the amount and the date of an offer already shown in words).

**Chat-only tools (new, OB3): spending observations.** Plan: [`docs/plan/26-spending-observations/00-plan.md` §5](plan/26-spending-observations/00-plan.md). The chat agent has two tools over `src/observations/`; `POST /api/actions` does not accept them (`400`). Arguments are strict.

| `name` | `arguments` | Result |
|---|---|---|
| `get_spending_observation` | `{}` | `{status:"ok", observation: {kind, title, basis, movements: {ref, date, amountCents, description}[]} \| null, notice: "A fact from the customer's own movements, not advice. State it with its figures and period; recommend nothing and mention no product."}`. `observation` is the one the server picked (`prepared_uncovered` before `category_up`): one the chat has not told yet first, else one already told (the customer asked again), never a dismissed one; `null` when nothing is found or the gate refuses (`OBSERVATIONS=off`, turned off by the customer, a case opened in the last 24 hours, a transfer in trouble, a proposal awaiting confirmation). `basis` is server text with exact figures; `movements` are the movements behind a `category_up` figure, newest first, at most 8 (`[]` for `prepared_uncovered`), with refs to cite like the other spending tools. Bank reads: the run's bank view, so `GET /v1/movements` once if the turn has not read it yet (accounts and contacts are the turn's own reads); the prepared transfers come from the app database |
| `set_spending_observations` | `{enabled: boolean}` | `{status:"ok", enabled}`; records `observations.disabled` / `observations.enabled` only on a change. The same switch as `POST /api/observations {enabled}`: it also hides or shows the Overview card |

- **Who decides.** Before each model request of a turn (every one: the block of an earlier request is not kept), the server looks for an observation in what the turn already read (accounts; movements only if the run's bank view is there; prepared transfers from the app database): no bank request, no model request, so a plain turn still makes two bank requests. It adds a `SPENDING OBSERVATION` block that names **the kind only** and asks the model to call `get_spending_observation` after a full answer about the customer's money. No figure, balance, amount, name, note or movement text is ever in the instructions: the figures reach the model as the tool result.
- **At most one volunteered thing per turn**, decided by the server: a turn in trouble or with an awaited answer (`turnTrouble`: the rules `open_case` … `problem` of the suggestion gate) volunteers nothing, and so does a turn from the moment one of its tools failed or was a transfer tool (`transfer_money`, `cancel_transfer`, `operation_status`, `send_prepared_transfer`) or `request_human`: the next model request has no block > `prepared_uncovered` (no product is chosen on that turn) > a chosen product suggestion > the review nudge, while it was not made in the conversation and there are movements to review > `category_up`. The review replies (`Review them` / `Not now`) are not attached on a turn that was given the block or in which `get_spending_observation` ran, and that tool is not in the clean-turn list, so such a turn carries no suggestion either. A conversation in which an observation was told gets no second block; the customer can still ask.
- **Told once.** `observation.told {key, kind, basis}` is recorded after the answer is stored, for an observation the tool returned in that turn; once per customer and key. A turn that fails records nothing. An error anywhere in this path loses the observation, never the answer.

**Chat-only tools (new, GL3): savings goals and the month forecast.** Plan: [`docs/plan/28-plan-area/00-plan.md` §4.5](plan/28-plan-area/00-plan.md) (REQ-PL-25, REQ-PL-26). Four tools over the functions the routes run (`goalsOf`, `planGoal`, `createGoal` of `src/goals/store.ts`; `monthForecast` of `src/forecast/month.ts`), on the turn's one bank read; `POST /api/actions` does not accept them (`400`). No tool adjusts or deletes a goal, sends money or changes a prepared transfer.

| `name` | `arguments` | Result |
|---|---|---|
| `list_goals` | `{}` | `{status:"ok", ...}` with the body of `GET /api/goals`, unchanged |
| `plan_goal` | `{name: string \| null, targetCents, targetDate, day: 1–31 \| null, fromAccountId: string \| null, toAccountId: string \| null}` | `{status:"ok", plan: GoalPlan, notice}`: the dry run of `POST /api/goals/plan` with what the page's form asks beside it. Defaults the server applies: `name` "Savings goal", `day` 3 (GL6), saved in the one account whose label says savings, from the one other account. `{status:"needs_accounts", accounts, message}` when the two accounts cannot be told (never guessed); `{status:"refused", reason:"single_account", message}` with the `canSaveReason` of `GET /api/goals` for a customer with one account; a date that is not after today is `{status:"failed", error}`. Writes nothing |
| `create_goal` | `{}` (anything the model passes is ignored) | `{status:"created", goal: GoalView, notice}`: the result of `POST /api/goals` for the plan stored with the conversation's newest answer. Otherwise `{status:"refused", reason, message}` and nothing is written: `no_plan_shown` (the newest answer of **this** conversation shows no plan), `not_confirmed` (the customer's message of this turn is not a yes), `plan_expired` (the same request gives other figures today), `already_created` (a second call in one turn) |
| `get_month_forecast` | `{}` | `{status:"ok", today, until, accounts: {id, label, balanceCents, endCents, lowest, headline, explanation, shortfall: {date, shortCents, certainty, forLabel} \| null, events: {date, label, amountCents, balanceAfterCents, source, certainty, note?}[], coverOptions: {title, consequence}[], regular: {income, charges: {label, amount, usualDay, source, thisMonth, nextDue?}[], irregularSpendPerMonth: string \| null}, nextMonth: {date, label, amount}[]}[], notCounted: string[], notes, sourceLine, addedByCustomer?, notice}`: the `forecast` of `GET /api/dashboard`, field by field (RG1: `regular` compact, euro strings; an item the customer added is named `a payment you added` or `an income you added`; RG1b: prepared items keep their label, `nextMonth` lines carry a signed euro string) |

- **The plan card.** The answer of a turn in which `plan_goal` returned `ok` is stored with `extras.goalPlan` and two quick replies, `Create this goal` (value the same) and `Change something` (value `Change something about this plan`). `GoalPlan = {name, targetCents, targetDate, day, from: {id, label}, to: {id, label}, monthlyCents, payments, firstDue, lastDue, fits: boolean \| null, room: {monthlyCents, months} \| null, today}`; every figure is the server's and the page draws the card from it, never from the model's text. Unlike `awaiting` it is sent to the browser. A turn that ended without an answer ("I could not finish this request…") stores no plan and no replies. Since UI4 (#190) the chat draws it as a card under the answer, from these stored figures.
- **The yes.** `create_goal` reads the plan from the newest assistant message of the conversation, so a plan shown in another conversation, to another customer, or before a later answer does not count; the customer's message of the turn must be exactly the `Create this goal` reply or a short typed yes (the whole message, lower-cased and without `.,!¡`, is one of: yes, yep, yeah, sure, go ahead, do it, confirm, create it, create this goal, create the goal, sí, si, adelante, hazlo, créalo, crea el objetivo, crea este objetivo; optionally followed by one of please, por favor, go ahead, do it, create it, create this/the goal, adelante, créalo). "ok", "okay", "vale" and "claro" are not a yes: after a plan they also mean "understood". Anything else is `not_confirmed`, whatever the model decides. The created goal is the stored plan: name, amount, date, day and the two accounts.
- **After creating.** The answer is stored with `extras.goalCreated = {id, name, monthlyCents, firstDue, targetCents, targetDate, today}` (types `GoalPlan` and `GoalCreated`, exported by `src/agent/extras.ts`) and no plan, so the same reply sent again creates nothing. The goal's transfer is prepared and never sent by the app: each payment is sent and confirmed by the customer in Transfers.
- **The customer's own text.** A goal's name reaches the model only as a data field of these results, never in the instructions. The label of a charge the customer added to the forecast (FC2, `source: "expected_by_you"`) **never reaches the model**: such an event keeps its amount and date and is named `a payment you added`; an account whose shortfall counts one gets `"<headline>, counting a payment you added. An estimate."` as `explanation` and `a payment you added` as `forLabel`; a `notCounted` line about one is a fixed sentence, and so is the line of a usual item the customer left out (`A usual payment you left out: not counted.`: its name comes from a key the client sent). `adjustments`, `merchantKey`, `preparedId` and `adjustmentId` are not in the result. When the customer has added a charge the result carries `addedByCustomer`, a fixed sentence: these figures count the customer's added payments, an observation told earlier does not, so the two can differ and the model states each as it is. No chat tool adds, removes or changes an adjustment.
- **`month_shortfall` in the chat.** Both callers of the observation detection in `src/agent/observations.ts` now pass the same forecast, only when the turn has read the movements. In the order above it comes after `prepared_uncovered` and a chosen product suggestion (a turn that chose a suggestion volunteers no shortfall) and before the review nudge and `category_up`. It is told once per customer and month (`observation.told`, key `month_shortfall:<accountId>:<YYYY-MM>`), with the forecast's own `explanation` as `basis`, and follows the customer's switch, `OBSERVATIONS=off`, a dismissal and FC2's rule (with a charge the customer added, the observation is worked out without it, so its figure can differ from the Plan page's and from `get_month_forecast`). The instructions say "no forecast of your own: the only forecast you may state is the one the server gives you, with its "estimate" wording".

## Assistant tools (index)

The 25 tools the chat model is given (`toolDefinitions` in `src/agent/tools.ts`, with `insights.ts`, `offers.ts`, `prepared.ts`, `observations.ts`, `goals.ts` and `forecast.ts`), checked against the code at `792d891`, for the four goal and forecast tools on GL3's branch and for `prepare_cover` at `3f15da8b` (DOC6). `POST /api/actions` accepts the six of its `name` enum; the other 19 are **chat-only** and a call to them through `/api/actions` is `400`. The chat model's `transfer_money` has two more arguments than the route documents, `secondTransfer` and `replacesApprovalId` (see "Proposal results"). No tool moves money: the only execution path is `POST /api/approvals/:id/confirm`. Every call records its step events (`tool.started`, then `tool.completed` or `tool.failed`); the last column says what else a call can write.

| Tool | Source | Through `POST /api/actions` | Writes |
|---|---|---|---|
| `list_accounts` | `tools.ts` | yes | nothing |
| `search_documents` | `tools.ts` | yes | nothing |
| `transfer_money` | `tools.ts` | yes | a proposal (intent and approval) |
| `cancel_transfer` | `tools.ts` | yes | cancels a pending proposal |
| `operation_status` | `tools.ts` | yes | a verified status, when it changed |
| `request_human` | `tools.ts` | yes | a support case |
| `list_movements` | `tools.ts` (G4; its body is in `insights.ts`, SI6b) | **chat-only** | nothing |
| `get_spending_summary` | `insights.ts` | **chat-only** | nothing |
| `list_unresolved_movements` | `insights.ts` | **chat-only** | nothing |
| `suggest_category_choices` | `insights.ts` | **chat-only** | nothing |
| `set_movement_category` | `insights.ts` | **chat-only** | a category; a rule only after a stored offer |
| `remove_category_rule` | `insights.ts` | **chat-only** | removes a rule |
| `get_offer_details` | `offers.ts` | **chat-only** | nothing |
| `offer_response` | `offers.ts` | **chat-only** | `offer.interest` and a support case, or `offer.declined` |
| `set_product_suggestions` | `offers.ts` | **chat-only** | `offers.disabled` / `offers.enabled` |
| `prepare_transfer` | `prepared.ts` | **chat-only** | a prepared transfer; no intent, no approval |
| `list_prepared_transfers` | `prepared.ts` | **chat-only** | nothing |
| `send_prepared_transfer` | `prepared.ts` | **chat-only** | a proposal, as `transfer_money` |
| `prepare_cover` | `prepared.ts` (PA1) | **chat-only** | the prepared transfer offered in the previous answer (`extras.coverOffer`), after a yes, once; no intent, no approval |
| `get_spending_observation` | `observations.ts` | **chat-only** | `observation.told`, after the answer is stored |
| `set_spending_observations` | `observations.ts` | **chat-only** | `observations.disabled` / `observations.enabled` |
| `list_goals` | `goals.ts` | **chat-only** | nothing |
| `plan_goal` | `goals.ts` | **chat-only** | nothing (the plan is stored with the answer, as `extras.goalPlan`) |
| `create_goal` | `goals.ts` | **chat-only** | a goal and one monthly prepared transfer; no intent, no approval |
| `get_month_forecast` | `forecast.ts` | **chat-only** | nothing |

## Transfers: propose, then confirm

```text
POST /api/actions transfer_money ──► requires_confirmation (approval.id, expiresAt: +10 min)
                                 ├─► needs_source_account (several accounts, fromAccountId null)
                                 ├─► possible_duplicate   (chat agent only: identical transfer pending or being verified)
                                 └─► failed               (same_account, invalid_destination, insufficient_funds,
                                                           invalid_request, source not yours, intent conflict)

POST /api/approvals/:id/confirm  ──► completed            (bank operation returned)
                                 ├─► pending_verification (5xx/timeout after the retry, or any error after an
                                 │                         uncertain attempt: outcome unknown)
                                 ├─► failed               (bank rejected it: 400/403/404/409/422, or nothing was sent)
                                 └─► processing           (another confirm of the same proposal is still in flight)

pending_verification ── lookup by reference ──► completed (found)          (operation_status, a repeated confirm,
                                                                           or automatically on GET /api/dashboard, R7)
                                              ├─ failed   (bank 404, once the absence window has closed)
                                              └─ stays pending (lookup failed, or 404 inside the window)
```

Intent states stored in the `intents` table: `awaiting_confirmation` (proposal) → (confirm) `processing` → `completed` | `failed` | `pending_verification`; `awaiting_confirmation` → (cancel, R5) `cancelled`. Through the HTTP surface an intent never passes through `created`: `transferMoney` (`src/banking/actions.ts`) inserts a `created` row only when it runs for an intent that has no proposal, which happens only when tests call it directly.

- **Dispatch.** Each confirm sends at most two `POST /v1/transfers` with the intent's one reference; the second only after a 5xx/timeout, and it is recorded as a `transfer.retry` event (`{status:"retrying", attempt:2, reason, intentId}`) shown in the operator's case steps. Once the retried attempt answers, the server logs one `transfer_retry` line (`{requestId, intentId, attempt:2, reason, outcome}`, `outcome` = `completed`, `bank <status>` or `error <name>`; no amount, accounts or reference) (SC2).
- **Absence window.** Every bank request is signed with a 60-second clock window, so a 404 on lookup proves "no money moved" only when no attempt was uncertain, or when the last dispatch attempt (the confirm, or the latest `transfer.retry`) is older than **120 s + `BANK_TIMEOUT_MS`**. Before that, a 404 keeps `pending_verification` with the message "The bank has not registered this transfer yet, but it may still be processing it. …".
- **Completed stays completed.** Once the bank returned the operation, later results are `completed` with `verified:true`; a failed re-lookup never downgrades it.
- **Automatic re-check (R7).** Each customer `GET /api/dashboard` first re-checks up to 3 of that customer's `pending_verification` (or `processing`) intents with a bank reference, each at most once every 30 s per app process, with one lookup each. A status change is recorded as a `transfer.verified` event (`{status, from, intentId}`) and noted in the conversation (R6). **FX1:** the same re-check covers a `failed` intent with a bank reference that has neither a `transfer.failed` event (the bank's own rejection) nor a `transfer.verified` one, such as the seeded `intent-historic-lucia`, recorded `failed` on a lost response: found at the bank it becomes `completed`; a 404 keeps it `failed` and records `transfer.verified` (`from: failed`, no note), so it is looked up once; a failed lookup changes nothing and is tried again on a later load. The web page re-reads the dashboard every 20 s while it is visible and when Overview or Transfers is opened.
- **Stuck `processing`.** A dispatch older than 10 × `BANK_TIMEOUT_MS` (the process died mid-transfer) is verified through its saved reference like an uncertain outcome.

### `intentId`

- Optional on `POST /api/actions` (max 150 chars); a random UUID is generated when absent. It identifies one customer intention.
- A client `intentId` is scoped to the session user: it is stored and returned as `<userId>:<intentId>` (`"doc-28873"` sent by Lucía comes back as `"lucia:doc-28873"`), so two customers can use the same id and a conflict never reveals another customer's intent.
- Same `intentId` + same arguments, before confirming → the **same** proposal (same `approval.id`), never a second one.
- Same `intentId` + same arguments, after confirming → the outcome of that intent (verified with the bank). It never sends again.
- Same `intentId` + same arguments, after the proposal expired unconfirmed → `expired` (below).
- Same `intentId` + different arguments → `{"status":"failed","error":"This intent belongs to a different payload."}`.
- Each intent gets one bank reference, reused by every retry, so the bank's actor + reference idempotency makes retries safe. Two different `intentId`s with identical arguments are two separate transfers: `POST /api/actions` never runs the chat's duplicate check below.

### Recipients (R2)

A destination is a **person** (`recipient`) or an exact account (`toAccountId`). `toAccountId` wins when both are given (the customer asked for that account).

- A person is the `/v1/contacts` rows sharing `userId` (or `name` when a bank omits `userId`). `recipient` matches the person id or full name, case and accents ignored (`"carla"`, `"Carla Ríos"`, `"carla rios"`), else a unique first name.
- **Main account rule**: the first of the person's accounts, in bank order, whose label does not contain "savings" (case-insensitive); if all are savings accounts, the first one. `src/banking/recipients.ts` holds the rule; the transfer form uses the same code.
- The intent and approval payload always store the exact `toAccountId`. Proposal results add `destination`: `{"accountId":"acc-carla","name":"Carla Ríos","label":"Aurora account","main":true}` (`main:false` when another account of the person was asked for; `{accountId,name:null,label,own:true}` for the customer's own account).
- Unknown person → `failed` `invalid_destination` with `recipients` (the names to choose from). Several people match → `failed` `ambiguous_recipient` with the matching names in `recipients`. Neither field given → `invalid_request`.

### Proposal results (`POST /api/actions`, `transfer_money`)

`requires_confirmation`:
```json
{"status":"requires_confirmation","approval":{"id":"959f…","expiresAt":"2026-09-29T17:34:11.534Z","fromAccountId":"acc-lucia","toAccountId":"acc-bruno","amountCents":1500,"concept":"Dinner"},"intentId":"lucia:doc-28873","destination":{"accountId":"acc-bruno","name":"Bruno Vidal","label":"Horizon account","main":true}}
```
`expired`: the same shape, returned when the intent's proposal expired unconfirmed; ask again with a new `intentId`.

`needs_source_account` (the customer holds several accounts and `fromAccountId` is `null`):
```json
{"status":"needs_source_account","message":"Ask the customer which account to send from. Do not choose one for them.","accounts":[{"id":"acc-lucia","label":"Aurora account","balanceCents":400750},{"id":"acc-lucia-savings","label":"Personal savings","balanceCents":100000}]}
```

`replacesApprovalId` (AR1, optional, `string | null`; the chat agent must always send it): the approval id of a proposal still awaiting confirmation that this call corrects. Only a string or `null` is accepted; `""` (or blank) means `null`; any other type gives `failed` `invalid_request`. The caller must own it (else `failed`, nothing proposed). Only a proposal that is still pending can be replaced: one already cancelled, replaced by an earlier correction or confirmed gives `{"status":"failed","code":"proposal_not_pending","error":"…","pending":[{"approvalId":"…","fromAccountId":"…","toAccountId":"…","amountCents":4000,"concept":"…"}],"intentId":"…"}` and nothing new stays proposed; `pending` lists the caller's proposals awaiting confirmation now, so the correction can name the live one. The new proposal is created first; only when it is `requires_confirmation` is the old one checked and cancelled in one transaction, and the result gains `replaced`: the `cancelled` result of `POST /api/approvals/:id/cancel`. If another correction or a confirm closed the old one in between, this call's own new proposal is withdrawn (cancelled, with its closing line) and the answer is `proposal_not_pending`: two corrections of one proposal leave exactly one pending. An expired old proposal is not live: the new one is kept with `replaced: {status:"not_cancelled", approvalId, error}`. Retrying the same correction (same `intentId`) returns the same proposal and `replaced`. A refused correction leaves the earlier proposal unchanged. Absent or `null`: nothing else is touched.

`possible_duplicate` (chat agent only, `transfer_money` with `secondTransfer` not `true`): an identical transfer (same source, destination and amount) is already awaiting confirmation, or was sent and is still `processing`/`pending_verification`. The agent must ask whether this is a second, separate transfer and call again with `secondTransfer: true` only on a yes. The web UI uses the same rule (K4, `transferKey` in `src/ui-helpers.ts`; the concept is ignored) to flag pending proposals as possible duplicates; the flag is only a warning, every proposal stays confirmable. Two shapes:
```json
{"status":"possible_duplicate","approval":{"id":"959f…","expiresAt":"…","fromAccountId":"acc-lucia","toAccountId":"acc-bruno","amountCents":1500,"concept":"Dinner"},"intentId":"b1c2…","message":"An identical transfer proposal is already awaiting confirmation. …"}
{"status":"possible_duplicate","transfer":{"fromAccountId":"acc-lucia","toAccountId":"acc-bruno","amountCents":1500,"concept":"Dinner"},"reference":"aaec…","intentId":"b1c2…","message":"An identical transfer was already sent and its outcome is still being verified, so it may have gone through. …"}
```

`failed` before any proposal. Checked in this order: source not yours (`"error":"This source account does not belong to you, …"`), then:
```json
{"status":"failed","code":"same_account","error":"The destination must be a different account from the source. No money moved.","intentId":"lucia:x1"}
{"status":"failed","code":"invalid_destination","error":"That destination account does not exist or is not among your recipients. No money moved. Choose one of your contacts or your own accounts.","intentId":"lucia:x2"}
{"status":"failed","code":"insufficient_funds","error":"Insufficient funds: this transfer needs €9,000.00 but Horizon account has €75.00 available, so the app did not send it. No money moved and no debt was created. You can …","availableCents":7500,"sources":[{"id":"faq-insufficient-funds","documentId":"faq-insufficient-funds","title":"…","text":"…","score":1,…}],"intentId":"dbd1…"}
```
`sources` holds the `faq-insufficient-funds` document the message rests on (empty if that document is missing); S2: the id is not printed in `error`, and amounts use the shared money format (`€9,000.00`). A 422 at execution gives the same result with "so the bank refused it".

### Confirm results (`POST /api/approvals/:id/confirm`)

`completed` (first confirm; `operation` is the bank response, `replay:true` when a retry was answered from the bank's idempotency record):
```json
{"status":"completed","operation":{"id":"0773…","userId":"lucia","reference":"aaec…","fromAccountId":"acc-lucia","toAccountId":"acc-bruno","amountCents":1500,"concept":"Dinner","createdAt":"2026-09-29T17:24:11.618Z","status":"completed","replay":false},"intentId":"lucia:doc-28873","approvalId":"959f…"}
```

Repeated confirm of a consumed proposal: the verified outcome of the same intent, no new dispatch:
```json
{"status":"completed","verified":true,"operation":{…},"reference":"aaec…","transfer":{"fromAccountId":"acc-lucia","toAccountId":"acc-bruno","amountCents":1500,"concept":"Dinner"},"intentId":"lucia:doc-28873","approvalId":"959f…"}
```
A completion stored with its bank operation id is returned like this (`verified:true`) without asking the bank again. A `failed` intent re-checked by `operation_status` whose lookup errors is kept and marked `verified:false`: `{"status":"failed","verified":false,"error":"…","reference":"e4b1…",…}`.

`pending_verification` (both attempts ended in 5xx/timeout, or an attempt after an uncertain one was rejected, and up to three lookups could not settle it; `message` is the "not registered yet" text when the lookup answered 404 inside the absence window):
```json
{"status":"pending_verification","message":"The bank did not confirm the result in time, so the transfer may already have gone through. Do not repeat it: we are verifying it with the bank. Ask about its status in a moment.","reference":"…","transfer":{…},"intentId":"…","approvalId":"…"}
```
Resolve it with `operation_status` (`{reference}` or `null`) or another confirm of the same proposal; never with a new proposal.

`failed` (bank rejection with no earlier uncertain attempt, or nothing was sent): `{"status":"failed","code":"invalid_request|forbidden|not_found|conflict|insufficient_funds|rejected","error":"… No money moved.","intentId":"…","approvalId":"…"}`; `insufficient_funds` also carries `availableCents` and `sources`. After a lookup that proves no such operation (see absence window): `{"status":"failed","verified":true,"error":"The bank has no record of this transfer, so no money moved.",…}`.

`processing`: `{"status":"processing","intentId":"…","approvalId":"…"}` — a concurrent confirm; ask again later.

Confirm errors are HTTP errors with `{status:"failed", error}`: `404 {"status":"failed","error":"Proposal not found."}` (unknown or another customer's), `410 {"status":"failed","error":"This proposal has expired. Ask for a new one to review."}`, `403` for operators.

### Timeline (`dashboard.transfers`, R8)

`{intentId, approvalId, status, transfer, reference, date, steps:[{kind, label, at}]}`, newest first. `date` (FX1) is the transfer's own date: the bank's execution time once a `transfer.completed` or `transfer.verified` event recorded it, else the intent's creation time; never the time of a later check. The list "Your transfers" shows it. `status` is the intent status, or `expired` for a proposal that expired unconfirmed. Steps come only from stored facts, oldest first:

| `kind` | Source |
|---|---|
| `proposed` | the intent row (`created_at`) |
| `confirmed` | the approval's `consumed_at` (not for a cancelled proposal) |
| `expired` | the approval's `expires_at`, when it passed unconfirmed |
| `cancelled`, `started`, `retry`, `completed`, `pending_verification`, `failed` | the `transfer.*` event of that name |
| `verified` | the `transfer.verified` event (R7): a lookup changed the status |

```json
{"intentId":"bruno:r-12","approvalId":"4c1e…","status":"completed","transfer":{…},"reference":"9a0b…","steps":[{"kind":"proposed","label":"Proposed for your review","at":"…"},{"kind":"confirmed","label":"Confirmed by you","at":"…"},{"kind":"started","label":"Sent to the bank","at":"…"},{"kind":"completed","label":"Completed by the bank","at":"…"}]}
```

### Outcome messages (R6)

When a proposal's intent belongs to a conversation (`conversationId` on `POST /api/actions`, or any chat proposal), the server stores its outcome in that conversation: after the first confirm answers, after a cancel, and when a later verification changes the intent's status (lookup found or proved absent). Nothing is written for a repeated confirm that changes nothing or for a confirm that fails with an HTTP error.

- `role:"assistant"`, `run_id:"outcome:<tone>:<intentId>"` (`tone`: `notice` completed, `warning` pending/cancelled, `error` failed), `content` e.g. `"€3.21 to Carla Ríos · Aurora account (Books): Transfer completed. You can see it under “Your transfers”, on the Transfers page."` (same wording as the proposals panel).
- Every browser, the operator case history and the agent's next turn read it with the rest of the conversation. It replaces the per-browser `localStorage` line of X2.

### Cancel (`POST /api/approvals/:id/cancel`, R5)

Only the proposal's owner, only while it is unconsumed and unexpired. The approval is consumed atomically (a concurrent confirm and cancel cannot both win), the intent becomes `cancelled` and a `transfer.cancelled` event is recorded. Cancelling again returns the same result. The event carries `reason` when the customer did not cancel it (AR1-a): `"replaced"` (closed by a correction, `replacesApprovalId`) or `"withdrawn"` (a correction the app withdrew because the proposal it corrected was closed first); the customer timeline and the operator steps say so instead of "cancelled by you / by the customer". Events without `reason` are customer cancels.
```json
{"status":"cancelled","message":"This proposal was cancelled. No money moved.","transfer":{…},"intentId":"…","approvalId":"…"}
```
Errors: `404` unknown or another customer's proposal, `409 {"status":"failed","error":"This proposal was already confirmed, so it can no longer be cancelled."}`, `410` expired. A confirm after a cancel is `409 {"status":"failed","error":"This proposal was cancelled. No money moved."}` and never reaches the bank. Reusing the cancelled `intentId` on `POST /api/actions` returns `{status:"cancelled", error, intentId}`.

### Receipt (`GET /api/transfers/:intentId/receipt`, CF1)

Only for an intent sent to the bank (it has a `reference`). A non-final intent is first re-checked with one bank lookup (as `operation_status` does); if that errors, the stored status stands. So is a `failed` intent nothing vouches for (FX1, see "Automatic re-check"). Nothing is cached.

| Intent status | Answer |
|---|---|
| `completed` | `200`, `final: true`, `verifiedAt` set |
| `pending_verification`, `processing` | `200`, `final: false` (the UI says "Being verified with the bank. This is not proof of payment.") |
| `failed` | `409 {"error":"No money moved, so there is no receipt."}` |
| `failed`, sent, not yet verified and the bank lookup failed (FX1) | `503 {"error":"The bank could not confirm this transfer right now. Try again in a moment."}` |
| `awaiting_confirmation`, `created`, `cancelled`, expired | `409 {"error":"This transfer was never sent, so there is no receipt."}` |

```json
{"intentId":"…","reference":"800d…","operationId":"9549…","status":"completed","final":true,"amountCents":110,"concept":"Rent","from":{"accountId":"acc-lucia","label":"Aurora account","iban":"ES91 2100 0418 450000000001"},"to":{"accountId":"acc-carla","name":"Carla Ríos · Aurora account","label":"Aurora account"},"proposedAt":"…","confirmedAt":"…","sentAt":"…","executedAt":"…","verifiedAt":"…","issuedAt":"…"}
```

- `operationId` is `null` until verified. `confirmedAt` is `null` without an approval (direct execution). `sentAt` is the first `transfer.started` event.
- `to.name` is the name recorded with the proposal, else a live `/v1/contacts` name, else the account id. `from.label`/`from.iban` come from `/v1/accounts`; if that read fails they are the account id and `null` (PL1: nothing stored holds the source label: the intent payload and the `transfer.proposed` event keep only `fromAccountId`, so no label is invented).
- `executedAt` is the bank operation's `createdAt` (recorded, or one `GET /v1/operations/:reference`), else `null`. `verifiedAt` is when the app learned "completed" (`transfer.completed` or `transfer.verified` event), `null` while not final.
- Bank errors only degrade fields; they never fail the receipt.
- Web page (CF1-ui): `/receipt/<encoded intentId>` renders this resource outside the app shell, printable. "Your transfers" links to it (new tab) for rows with a `reference` and status `completed`, `pending_verification` or `processing` (`hasReceipt` in `src/ui-helpers.ts`); any `401`/`404`/`409` text is shown as is.

## Savings goals (GL1)

A goal is a name, an amount and a date, fed by **one monthly prepared transfer between two of the customer's own accounts** (plan 28 §4.3, §5.2, §6.1; migration 13: the `goals` table and `prepared_transfers.goal_id`). The five routes are customer only (`403` for an operator, `401` signed out); another customer's goal id is the same `404 {"error":"Goal not found."}` as an unknown one. **No goal route sends money, creates an intent or an approval, or writes to the bank.** Create and adjust prepare the goal's transfer; the customer sends and confirms each month with `POST /api/prepared/:id/send` and `POST /api/approvals/:id/confirm`, as for any prepared transfer. Bodies are strict: an unknown field, a wrong type, or a date that is not a real day after today (at most 30 years ahead) is `400`. All of it works with no model key; no model is involved in any figure or text.

### The rules, in ten lines

1. **Saved** is the sum of the **completed** intents of the goal's own prepared transfers, the deleted ones included. It is never read from a balance.
2. **Payments left** are the monthly occurrences from the next due to the target date. **Required monthly** is `ceil(remaining / payments left)`, with at least one payment: a new plan whose first occurrence falls after the date is one payment after it (`lastDue` says when). For the state, a goal with no occurrence left on or before its date has 0 payments left: it is `behind` by all that remains, never `on_track`.
3. **State, first match:** `reached` (saved ≥ target), `date_passed` (the target date is before today), `no_plan` (no monthly transfer, or a paused one), `behind`, `on_track`.
4. **`behind`** is either a gap (`behindCents` = remaining − monthly × payments left, above 0) or a payment whose day has passed and is not sent (`behindCents: 0`, headline "A payment is waiting"). A payment due today is `on_track`.
5. `targetCents − behindCents` = `savedCents` + `monthlyCents` × payments left: the amount the `behind` sentence says the customer reaches.
6. **Adjustments:** `behind` with a gap offers `suggestion` (`raise`) and `alternative` (`extend`), each only when it would change something and can be applied: either can be `null` (no `raise` when a replacement at the same amount already reaches the target or no occurrence is left before the date; no `extend` when the later date would be more than 30 years away); `no_plan` offers `prepare_again`; `date_passed` offers `extend` (under the same 30-year limit). Each is applied by posting its `monthlyCents` or `targetDate` to the adjust route, and its `text` says what that post does.
7. **A new date keeps the monthly amount** when that amount still reaches the target by then; otherwise the amount becomes the required one.
8. **A replacement starts at the next occurrence the customer has not paid:** a month already confirmed is not asked for a second time.
9. **`room`** is the mean of income − spending over up to three full months that are whole inside the bank's movement window (`null` with none). `fits: false` warns; nothing is blocked by it.
10. **One account:** `canSave: false`, `canSaveReason` says why, and `POST /api/goals` answers `409`.

### Shapes

```ts
// GET /api/goals
{ today: string;                         // 'YYYY-MM-DD', Europe/Madrid
  canSave: boolean; canSaveReason: string | null;
  accounts: { id: string; label: string }[];
  room: { monthlyCents: number; months: number } | null;
  goals: GoalView[] }                    // oldest first; deleted goals are not listed

// POST /api/goals/plan {targetCents, targetDate, day, goalId?}   dry run: reads the bank once, writes nothing
{ monthlyCents: number; payments: number; firstDue: string; lastDue: string; fits: true | false | null }

// POST /api/goals {name, targetCents, targetDate, fromAccountId, toAccountId, day} → {status:'created', goal: GoalView}
// POST /api/goals/:id/adjust {monthlyCents} | {targetDate}                       → {status:'adjusted', goal: GoalView}
// DELETE /api/goals/:id                                                          → {status:'deleted'}

type Suggestion = ({ kind: 'raise'; monthlyCents: number } | { kind: 'extend'; targetDate: string }
                 | { kind: 'prepare_again'; monthlyCents: number }) & { text: string };
type GoalView = {
  id: string; name: string; targetCents: number; targetDate: string;
  savedCents: number; remainingCents: number; behindCents: number;
  state: 'on_track' | 'behind' | 'no_plan' | 'date_passed' | 'reached';
  monthlyCents: number | null;           // the active transfer's amount; null with none or a paused one
  requiredMonthlyCents: number | null;   // null when reached or the date has passed
  prepared: PreparedView | null;         // the goal's transfer as `dashboard.prepared` lists it (same `id`)
  from: { id: string; label: string }; to: { id: string; label: string }; // of the newest transfer, deleted or not
  headline: string; basis: string;       // fixed server text, printed verbatim
  suggestion: Suggestion | null; alternative: Suggestion | null;
  reachedAt?: string;                    // the day of the confirmation that reached the target
  history: { month: string; plannedCents: number; savedCents: number }[] }
```

Limits: `name` 1–60 characters after trimming; `targetCents` and `monthlyCents` whole cents from 1 to 1,000,000,000 (a monthly amount above the transfer limit of €100,000.00 is refused when it is prepared); `day` 1–31 (the 31st falls on the last day of a shorter month); at most 20 goals. Both accounts must be the customer's own and differ. `PreparedView` has no goal field: a prepared transfer belongs to the goal whose `prepared.id` is its `id`. `history` runs from the goal's first month to the current one: `savedCents` is what was confirmed in that month, `plannedCents` the amount of the goal's occurrences of that month (those that fell due while their transfer existed, and those the customer paid; a skipped one is not planned).

| Route | Errors beyond `400`, `401`, `403`, `404` |
|---|---|
| `GET /api/goals`, `POST /api/goals/plan` | the bank's `503`/`504` (both read accounts and movements) |
| `POST /api/goals` | `409 single_account` (the sentence of `canSaveReason`), `409 too_many`; `409` with the prepared transfer's own refusal and `code` (`invalid_request`, `too_many`). The same account twice is a `400` |
| `POST /api/goals/:id/adjust` | `409 prepared_in_progress` while a proposal of the goal waits or the bank has not confirmed a send; `409 reached`. The new transfer is prepared before the old one is deleted, so a bank error leaves the plan as it was |
| `DELETE /api/goals/:id` | `409 prepared_in_progress` as above. The goal's transfer is deleted with it; nothing sent is undone. No bank read |

**The dry run.** Without `goalId` it plans a new goal: the first payment is the next occurrence of `day` from today (today included). With `goalId` (the what-if of an existing goal; another customer's is `404`) it plans what an adjust of that goal would make: pass the goal's `remainingCents` as `targetCents`; the goal's own day and its next unpaid occurrence are used and `day` is ignored. `monthlyCents` is always the required amount for that date (`ceil(targetCents / payments)`), which can be below the amount a slider started from. `fits` is `false` only when a room exists and the monthly amount is above it; `null` means no room could be worked out. The route makes no app write and its arithmetic is constant-time; its cost is the one bank read (5 ms on the local demo bank).

**Choices the customer may make.** `POST /api/goals/:id/adjust {monthlyCents}` accepts an amount below the required one: the goal is then `behind` with its gap. A goal whose date has passed keeps its monthly transfer if it still exists: `prepared` is that transfer (not `null`) and `monthlyCents` its amount; both are `null` only when the transfer was deleted. The same holds for a `reached` goal, whose `basis` then says the transfer is still there: nothing deletes it for the customer. There is no total across goals.

Deleting the goal's transfer in Transfers (`DELETE /api/prepared/:id`) leaves the goal as `no_plan` with what it saved.

### Real answers

From `.scratch/after/feat-gl1-goals/demo-run.txt`: the demo bank on a production build, Lucía, 7 October 2026, `DECIDER=none`. Ids are shortened here.

`GET /api/goals` before any goal, and for Bruno (one account):

```json
{ "today": "2026-10-07", "canSave": true, "canSaveReason": null,
  "accounts": [{ "id": "acc-lucia-savings", "label": "Personal savings" }, { "id": "acc-lucia", "label": "Aurora account" }],
  "room": { "monthlyCents": 71448, "months": 3 }, "goals": [] }
```

```json
{ "today": "2026-10-07", "canSave": false,
  "canSaveReason": "A savings goal moves money between two accounts of yours. You have one account, so a goal cannot be set up yet.",
  "accounts": [{ "id": "acc-bruno", "label": "Horizon account" }],
  "room": { "monthlyCents": 91068, "months": 3 }, "goals": [] }
```

`POST /api/goals/plan {"targetCents":120000,"targetDate":"2027-03-31","day":7}`:

```json
{ "monthlyCents": 20000, "payments": 6, "firstDue": "2026-10-07", "lastDue": "2027-03-07", "fits": true }
```

`POST /api/goals {"name":"Trip to Lisbon","targetCents":120000,"targetDate":"2027-03-31","fromAccountId":"acc-lucia","toAccountId":"acc-lucia-savings","day":7}`:

```json
{ "status": "created",
  "goal": { "id": "…", "name": "Trip to Lisbon", "targetCents": 120000, "targetDate": "2027-03-31",
    "savedCents": 0, "remainingCents": 120000, "behindCents": 0, "monthlyCents": 20000, "requiredMonthlyCents": 20000,
    "suggestion": null, "alternative": null, "state": "on_track", "headline": "On plan",
    "basis": "€0.00 of €1,200.00 saved. €200.00 a month, 6 payments left, the last on 7 Mar 2027.",
    "prepared": { "id": "…", "fromAccountId": "acc-lucia", "toAccountId": "acc-lucia-savings", "to": "Personal savings",
      "amountCents": 20000, "concept": "Trip to Lisbon", "note": null, "when": { "kind": "monthly", "day": 7 },
      "nextDue": "2026-10-07", "state": "due", "approvalId": null, "expiresAt": null, "lastAttempt": null, "lastSentAt": null },
    "from": { "id": "acc-lucia", "label": "Aurora account" }, "to": { "id": "acc-lucia-savings", "label": "Personal savings" },
    "history": [{ "month": "2026-10", "plannedCents": 20000, "savedCents": 0 }] } }
```

The same goal in `GET /api/goals` after the customer sent and confirmed the first payment (excerpt):

```json
{ "savedCents": 20000, "remainingCents": 100000, "state": "on_track", "headline": "On plan",
  "basis": "€200.00 of €1,200.00 saved. €200.00 a month, 5 payments left, the last on 7 Mar 2027.",
  "prepared": { "nextDue": "2026-11-07", "state": "scheduled" },
  "history": [{ "month": "2026-10", "plannedCents": 20000, "savedCents": 20000 }] }
```

`POST /api/goals/:id/adjust {"monthlyCents":15000}` (excerpt), and the same route while a proposal of the goal waits:

```json
{ "status": "adjusted",
  "goal": { "savedCents": 20000, "remainingCents": 100000, "behindCents": 25000, "monthlyCents": 15000, "requiredMonthlyCents": 20000,
    "state": "behind", "headline": "€250.00 behind plan",
    "basis": "€200.00 of €1,200.00 saved. At €150.00 a month you reach €950.00 by 31 Mar 2027, €250.00 short.",
    "suggestion": { "kind": "raise", "monthlyCents": 20000, "text": "€200.00 a month reaches €1,200.00 by 31 Mar 2027." },
    "alternative": { "kind": "extend", "targetDate": "2027-05-07", "text": "€150.00 a month reaches €1,200.00 by 7 May 2027." } } }
```

```json
{ "error": "A payment of this goal is being sent. Confirm or cancel it first, then adjust. Nothing changed.", "code": "prepared_in_progress" }
```

After the alternative was applied and the transfer then deleted in Transfers (excerpt), and `DELETE /api/goals/:id`:

```json
{ "targetDate": "2027-05-07", "savedCents": 20000, "monthlyCents": null, "requiredMonthlyCents": 14286,
  "state": "no_plan", "headline": "No monthly transfer",
  "basis": "€200.00 of €1,200.00 saved. No monthly transfer is set up for this goal, so nothing more is added.",
  "suggestion": { "kind": "prepare_again", "monthlyCents": 14286, "text": "A monthly transfer of €142.86 reaches €1,200.00 by 7 May 2027." },
  "alternative": null, "prepared": null }
```

```json
{ "status": "deleted" }
```

### Fixed texts

Written by the server (`src/goals/plan.ts`) and printed verbatim. Amounts are exact (`€1,234.56`); a day is `7 Mar`, with its year when that is not the current year (`7 Mar 2027`). None says "automatic" or "scheduled".

| State | `headline` | `basis` |
|---|---|---|
| `on_track` | `On plan` | `€{saved} of €{target} saved. €{monthly} a month, {n} {payment\|payments} left, the last on {lastDue}.` |
| `behind`, a gap | `€{behind} behind plan` | `€{saved} of €{target} saved. At €{monthly} a month you reach €{projected} by {targetDate}, €{behind} short.` |
| `behind`, a payment not sent | `A payment is waiting` | `€{saved} of €{target} saved. The payment of {due} is waiting for your confirmation.` |
| `no_plan` | `No monthly transfer` | `€{saved} of €{target} saved. No monthly transfer is set up for this goal, so nothing more is added.` |
| `date_passed` | `The date has passed` | `€{saved} of €{target} saved by {targetDate}. €{remaining} remains.` |
| `reached` | `Reached on {reachedAt}` | `€{saved} saved, with the transfers you confirmed.` While the goal's monthly transfer still exists, followed by ` Its monthly transfer of €{monthly} is still in Transfers and stays there until you delete it.` |

| Suggestion | `text` |
|---|---|
| `raise` | `€{monthly} a month reaches €{target} by {targetDate}.` |
| `extend` | `€{monthly} a month reaches €{target} by {newDate}.` |
| `prepare_again` | `A monthly transfer of €{monthly} reaches €{target} by {targetDate}.` |

`canSaveReason`: `A savings goal moves money between two accounts of yours. You have one account, so a goal cannot be set up yet.`

## AI usage (TR1)

Every request the app makes to a model provider leaves one row in the `ai_usage` table (migration 12), written as the request returns: who it was for, which consumer made it, the tokens the provider reported, the price used and the cost. Plan: [`plan/27-ai-usage-trace/00-plan.md`](plan/27-ai-usage-trace/00-plan.md).

**What is stored, and what is not.** Counts, ids, times, the model id, the provider's hostname and the NAMES of the app's own tools the model called. No prompt, message, answer, tool argument, movement description, merchant key or conversation title is stored, and the API returns none at any level: a request lists its model, consumer, tokens, cost, cost basis, outcome, attempt, tool names, time and the ids needed to open the case (`runId`, `conversationId`, `caseId`). No key, no `Authorization` header, no URL: `host` is a hostname only. A tool name the app does not define is stored as `unknown_tool` (a name is model output).

**Consumers** (`consumer`): `assistant` (a model request of a chat turn; `seq` is its number in the turn, 1 to 7), `operator_preview` (`POST /api/preview-answer`), `decider:systemone` (Jev, one row per attempt, `attempt` 1 to 3), `decider:openai` (`attempt` 1 or 2), `embeddings` (one row per embeddings request; a text already embedded makes no request and has no row), `voice` (VC1: one row per `POST /api/transcribe` that reached the provider, for the customer, with no conversation).

**Who it is recorded for** (`actor`, `user_id`). The customer whose request made the call: a chat turn's model, embedding and decider requests carry the customer, the conversation and the run; a decider request started by the Overview or the spending card carries the customer and no conversation (always the customer being classified, whoever's request is open around it); `POST /api/search` is the signed-in person's. `operator`: the operator's own preview, search and `POST /api/ingestion`. `system`: work with no person, such as `npm run ingest` and `npm run setup`. A decider answer kept for a customer and an embedding already cached cost later readers nothing and have no row.

**Outcome.** `ok` or `failed`. A failed request is a row too: with the tokens when the provider reported them (a System One or OpenAI decider answer that came back 200 and could not be used was billed), with `NULL` tokens when it did not (a 429, a 5xx, a timeout). Nothing is guessed. Rows are written per request, so a turn that fails in its third request keeps the first two.

**Money.** `cost_nano_usd` is a whole number of nano-dollars (1e-9 US$; 1 US$ = 1,000,000,000). A price is whole nano-dollars per token, the same number as US$ per billion tokens (US$ per million × 1000). Cost = `(input − cached) × price_input + cached × price_cached + output × price_output`; reasoning tokens are part of the output and are not added again. `cost_basis`: `estimated` (tokens × the price copied into the row: `price_input`, `price_cached`, `price_output`, `price_source`), `provider` (the provider returned its own charge, `usage.cost` in US$, as OpenRouter does on System One answers: it is stored instead, and the price columns are still filled for comparison), `unpriced` (no cost, `NULL`, never zero: the model has no listed price, the provider reported no input tokens, or no output tokens for a model whose output is not free, cached tokens exceed the input, or cached tokens came with a price that has no cached rate). Every cost but a `provider` one is an estimate at public list prices, not an invoice.

**Prices** (`src/usage/prices.ts`; matched by exact model id, else the longest listed prefix):

| Model | Input | Cached input | Output | Source |
|---|---|---|---|---|
| `gpt-6-luna` | US$ 0.10 / M | US$ 0.01 / M | US$ 0.50 / M | OpenAI pricing page (`developers.openai.com/api/docs/pricing`), Standard tier, read 2026-10-05 |
| `text-embedding-3-small` | US$ 0.02 / M | none | 0 | the same page, read 2026-10-05 |
| `jev-1.13`, `typesafe/jev-1.13` | US$ 0.042 / M | none | 0 (free) | Typesafe models page (`docs.typesafe.ai/models`), read 2026-10-05 |

Both pages were read through a page fetch (a tool returning the page's text), not in a browser. The chat model's long-context rate is not applied.

**Settings.** `AI_USAGE=on|off` (default `on`; `off` records nothing and the route answers `enabled: false` with whatever rows exist; another value stops startup). `AI_PRICES` overrides or adds prices: `model=input/cached/output` entries separated by `;`, in US$ per million tokens with at most three decimals, `-` for no cached rate (for example `gpt-6-luna=0.1/0.01/0.5;my-model=0.042/-/0`); a malformed value stops startup naming the setting; an overridden model's `price_source` is `AI_PRICES setting`. The price is copied into each row, so a later change does not rewrite what was recorded.

**Daily cap per customer (SC1).** `AI_DAILY_CAP_USD` is an amount in US$ with at most nine decimals (`0.25`), kept as whole nano-dollars. **Unset (the default, and the delivery's setting): no cap, and nothing changes.** An invalid value (not a number, `0`, negative, more than nine decimals) stops startup naming the setting; so does a value together with `AI_USAGE=off` (the cap is read from the recorded rows). The cap is one figure for every customer.

- **What counts** (`capState`, `src/usage/cap.ts`): the customer's own rows (`actor = 'customer'`) since today's midnight in Europe/Madrid, whichever consumer made them (chat turn, embeddings, decider). A customer is at the cap when the sum of `cost_nano_usd` reaches the limit, or, as a second fixed measure for requests that have no cost, when the unpriced rows' `input_tokens + output_tokens` reach 1,000,000. `operator` and `system` rows never count, nor do yesterday's. Nothing is stored: the cap lifts at Madrid midnight; `npm run reset` clears the rows, a reseed does not.
- **Chat turn**: one check, at the start of the turn, after the customer's message is stored and before any bank read, embedding or model request. At the cap no provider is called; the turn stores `The assistant is not available for the rest of today. Your accounts, transfers and confirmations still work from the other tabs, and you can ask for human support here.` and ends like any failed turn: `502 {error: <that sentence>, code: "ai_daily_limit"}`, the message marked `extras.turnFailed = "ai_daily_limit"` (the page offers "Ask for human support"), the run `failed` with an internal reason for the operator. Its log line (`assistant_turn_failed`, `code: "ai_daily_limit"`) is at `info` level, not `error`: the cap at work is not an outage. The sentence holds no figure. A quick reply is an ordinary message and gets the same answer. The check is never repeated inside a turn: a turn that has started, a transfer tool included, completes.
- **Decider**: a customer at the cap gets no decider request; the movements no rule knows go to "to sort" with the existing reason `decider_budget`, and are asked for again once the customer is under the cap (the next day).
- **Not behind the cap** (none calls the chat model): confirming or cancelling a proposal, `POST /api/actions` (the transfer form, `request_human` from the button), prepared transfers, the dashboard and every other read (a read that classifies movements simply asks no decider, as above). `POST /api/search` (one embedding) and the operator's routes are not capped. A message sent with an attached movement still has that movement read from the bank by the route before the turn starts.
- **A cap read never fails a request**: an error reading the table (missing, locked) is logged as `usage_cap_read_failed` and counts as not capped.
- **Overshoot, accepted**: there is no lock and the check is per turn, so the day can end above the limit by the cost of one turn (up to 7 model requests) for each conversation of the customer with a turn starting at that moment, plus the turn that crossed it.

**A write never fails a request.** The insert is synchronous, makes no network call and is wrapped: a failure logs one `usage_write_failed` line per kind of error and the customer's request goes on unchanged. No customer-facing route carries usage or cost. Rows survive a reseed (`seedApp()`); only `npm run reset` clears them, after its backup (`scripts/reset.ts`), as does deleting the data directory.

### `GET /api/usage`

Operator only: customer `403 {"error":"Operator role required."}`, no session `401`. Query: `period` = `today` | `7d` | `30d` | `all` | `range` (default `7d`; UP1: `range` requires `from=YYYY-MM-DD&to=YYYY-MM-DD`, real dates, `from` ≤ `to` ≤ today in Madrid, `to` inclusive; `from`/`to` with any other period is a 400; the same on `/api/usage/export.csv`, whose file name then carries `<from>_<to>`), and at most one of `customer=<user id>`, `run=<run id>` (1 to 80 characters of letters, digits, `_ : . -`). An unknown key, a repeated key, a bad value or both ids together: `400 {"error":"Invalid request data."}`. **Period boundaries are calendar days of Europe/Madrid, the day the app's spending periods use, never UTC days**: `today` starts at that day's midnight in Madrid (22:00 or 23:00 UTC of the day before), `7d` is today and the six days before it, `all` has no bound. `since` in the answer is that start as a UTC instant, `null` for `all`. UP1: `30d` is today and the 29 days before it; the answer also has `until`, the exclusive end as a UTC instant (the next Madrid midnight after `to`, so a 23- or 25-hour day counts whole), `null` for every other period, and for `range` echoes `from` and `to`.

`Totals`, used at every level: `{requests, failed, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, costNanoUsd, providerNanoUsd, unpricedRequests, unreportedRequests}`. Token sums count unreported tokens as 0 and say how many requests reported none (`unreportedRequests`: `input_tokens` is `NULL`). `costNanoUsd` is the sum of the priced requests, or `null` when the group has requests and none is priced ("Not priced", never `$0`); a group with no request at all has `requests: 0` and `costNanoUsd: 0` (an empty period, `outsideChat` of a customer who only chatted, an id nobody has): show the empty state by `requests`, not by the cost; with `unpricedRequests` > 0 it is partial. `providerNanoUsd` is the part of it the provider reported.

- No id: `{enabled, period, since, firstRecordAt, totals, byCustomer, staffAndSystem, byConsumer, byTool, prices, cap}`. SC1: `cap` is `{dailyNanoUsd, unpricedTokens, dayStart} | null`: `null` when `AI_DAILY_CAP_USD` is unset; `dailyNanoUsd` the limit in whole nano-dollars, `unpricedTokens` the fixed limit of unpriced tokens a day (1,000,000), `dayStart` the UTC instant of today's midnight in Europe/Madrid, from which both are counted. Each `byCustomer` row also has `capped: boolean`: the customer is at the cap **now, today, whichever `period` was asked** (always `false` with no cap). A customer at the cap has rows today, so is listed in every period. The CSV export has neither field. Excerpt of `GET /api/usage?period=today` with `AI_DAILY_CAP_USD=0.0000005` (`.scratch/after/feat-sc1-ai-daily-cap/evidence-api-usage.json.txt`; the other fields of the answer and of each row are left out):

  ```json
  {
    "period": "today",
    "cap": { "dailyNanoUsd": 500, "unpricedTokens": 1000000, "dayStart": "2026-10-05T22:00:00.000Z" },
    "byCustomer": [
      { "userId": "lucia", "name": "Lucía Martín", "requests": 3, "costNanoUsd": 526560, "capped": true }
    ]
  }
  ```

  The other fields: `firstRecordAt`: the time of the oldest row of the table (not of the period), `null` when empty. `byCustomer`: `Totals & {userId, name, sharePct}`, rows of actor `customer` only, by cost, at most 200; `name` is the person's name, else the id; `sharePct` is the customer's part of the customers' priced cost, one decimal, `null` when the customer has no priced request. `staffAndSystem`: the `operator` and `system` rows, outside the shares; `totals` = `byCustomer` + `staffAndSystem` = the sum of `byConsumer` (`Totals & {consumer}`). `byTool`: `{tool, calls, runs}`, counts only: a tool's result is part of the next request's input, so tokens and cost are not split per tool. `prices`: `{model, input, cached, output, source}`, nano-dollars per token, the defaults and the setting's entries.
- `?customer=<id>`: `{period, since, customer: {userId, name}, totals, byConsumer, outsideChat, conversations}`, the customer's own rows (actor `customer`). `outsideChat`: the requests with no conversation (Overview, spending card, search). `conversations`: `Totals & {conversationId, startedAt, removed, turns, caseId, runs}`, the 50 with the newest requests; `removed` is true when the conversation no longer exists (a reseed), `startedAt` is then its first row's time; `caseId` is the newest support case of the conversation or `null`; `runs`: `Totals & {runId, startedAt, status}`, at most 100 per conversation, newest first, `status` the run's (`completed`, `failed`, `running`) or `removed`. An id nobody has answers with empty totals, named by the id.
- `?run=<id>`: `{runId, actor, userId, conversationId, caseId, totals, requests}`; `period` is not applied (a turn is one moment). `requests`, in the order they were made, at most 50 (`totals` covers all of them): `{id, createdAt, consumer, seq, attempt, outcome, model, host, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, tools, costNanoUsd, costBasis, priceInput, priceCached, priceOutput, priceSource}`. `null` where the provider reported nothing: on a failed request with no usage the four token fields and `costNanoUsd` are `null` and `costBasis` is `unpriced`; `cachedInputTokens` and `reasoningTokens` are also `null` on any request whose provider does not report them (embeddings, System One); the three price fields and `priceSource` are `null` when the model has no listed price.

`GET /api/usage/export.csv?period=` (same access and period; any other key `400`): `byCustomer` then one `staff_and_system` line, columns `customer_id,name,requests,failed,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_nano_usd,provider_nano_usd,unpriced_requests,unreported_requests,share_pct`; an empty cost cell means not priced. Same CSV rules as the movements export (UTF-8 BOM, CRLF, formula-safe text cells), `Content-Disposition: attachment; filename="banana-ai-usage-{period}.csv"`.

**Case view.** Each recorded run of `GET /api/incidents/:id` (and of its export bundle) gains `usage`: the run's `Totals`, or `null` when none of its requests was recorded (a run from before this feature, or `AI_USAGE=off`).

**Limits, stated.** (1) Tokens are not attributed per tool. (2) The chat and embeddings client retries twice inside the OpenAI SDK (`maxRetries: 2`); those attempts are invisible to the app, so such a request is one row, and when it ends in an error whether any attempt was billed is unknown (`NULL` tokens). The OpenAI decider's client has `maxRetries: 0` and System One is a plain `fetch`: every decider attempt has its own row. (3) The wording of a product suggestion, an observation and the review nudge is part of the chat turn's own request and cannot be separated. (4) Nothing exists from before the feature: `firstRecordAt` says when recording started. (5) The embedding cache is shared: the first person to ask for a text pays for it. (6) Not measured with a live provider: the token fields were checked against stand-ins only.

## Audit log (INT1)

Every `events` row is hash-chained on insert (`hash = sha256(prev_hash + "\n" + [id, run_id, user_id, conversation_id, kind, data, created_at])`, genesis `prev_hash = ""`, tip in `meta` `audit-head`). `GET /api/incidents/:id` runs `verifyAuditChain()` and reports the first problem: an edited row (`hash_mismatch`), a row added or left unreachable (`unlinked_rows`), two rows on one link (`fork`), or missing newest rows (`head_mismatch`). It never repairs. Rows that existed before migration 2 are `legacy`: known unchanged only since then. The chain detects changes made without recomputing every later hash and the head; someone with write access who rewrites all of them is not detected (upgrade: an HMAC key kept outside the database). Schema changes are versioned migrations recorded in `schema_migrations` (INT2); a database newer than the code is refused with a message pointing to `npm run reset`.

## Adapter for one-call execution

A client written against the original surface (one `POST /api/actions transfer_money` that executes) gets the same observable effect with two calls:

1. `POST /api/actions {name:"transfer_money", arguments, intentId}` → take `approval.id` from the `requires_confirmation` result (or handle `needs_source_account` / `failed`; `possible_duplicate` never appears here).
2. `POST /api/approvals/{approval.id}/confirm` → `completed` / `pending_verification` / `failed` as above.

Retrying either step with the same `intentId` / `approval.id` never creates a second bank operation. No server-side shortcut exists on purpose: skipping the review step would break the contract rule for sensitive operations.
