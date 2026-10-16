# Environment contracts

## Business behavior

- Only an account holder may initiate a transfer from that account. Operators inspect support cases and cannot transfer customer money.
- Amounts are positive integer euro cents, without overdrafts. Maximum per operation: 10,000,000 cents. Source and destination must exist and differ.
- A sensitive operation must present its amount, source, and destination for explicit review before execution. An informational conversation alone does not authorize payment.
- An operation intent represents a customer intention. Retrying that intent must not multiply its effects. Two distinct legitimate intentions may have identical amounts and destinations.
- A transport error or timeout does not prove that the bank rejected the operation. Customer-facing status should match verified facts.
- Assistant information should rely on applicable documentation and make its evidence traceable. Missing evidence should be acknowledged with a useful next step. Documents can contain historical versions and third-party content.
- Operators need to understand the conversation, relevant steps, and effects. Historical evidence that was never recorded must not be invented.

These describe the intended experience; they do not guarantee that the starter complies or prescribe an implementation.

## External bank boundary

The service in `simulator/` is a simulated external dependency. The candidate's work concerns the web application, agent and bank integration. Supported bank failures are conditions to handle, not defects to remove from the simulator. Evaluation may use an independent implementation of this contract; changing the supplied bank or disabling its scenarios does not establish an application improvement.

## Bank HTTP API

Default base: `http://127.0.0.1:4001`. JSON. The browser calls the application; the application server calls the bank. The web application must not access the bank's SQLite directly.

Every `/v1/*` request includes `x-bank-actor`, `x-bank-time` (Unix milliseconds), and `x-bank-signature`. The signature is the hexadecimal HMAC SHA-256 of `[method, pathWithQuery, actor, timestamp, exactJsonBody].join('\n')`, using `BANK_SERVICE_SECRET`. Clock window: 60 seconds. See `src/banking/client.ts`. The actor comes from the selected server session, never from model-generated arguments.

| Method and path | Result |
|---|---|
| `GET /health` | Availability; no credentials |
| `GET /v1/accounts` | Actor's accounts and `balanceCents` |
| `GET /v1/contacts` | Destination accounts and fictional names |
| `GET /v1/movements` | Up to 100 recent movements belonging to the actor |
| `POST /v1/transfers` | Completed operation or error |
| `GET /v1/operations/:reference` | Actor's operation by reference; 404 if absent |
| `GET /v1/operator/customer?id=lucia` | Customer accounts and operations; operators only |

Transfer body: `{fromAccountId,toAccountId,amountCents,concept,reference}`. A reference contains 1–120 characters. The idempotency key is **actor + reference**. Reusing a key with the same payload returns the original operation with `replay:true`; a different payload returns 409. The bank provides this guarantee. The application decides which requests represent the same intent.

The ledger entry and both balance changes commit atomically. The response contains `id,userId,reference,fromAccountId,toAccountId,amountCents,concept,createdAt,status:'completed'` and `replay`. Status codes: 400 invalid input, 401 invalid context, 403 ownership/role, 404 absent, 409 conflict, 422 insufficient funds, 503 unavailable, 504 upstream timeout.

## Reproducible scenarios

`npm run scenario -- <profile> [seed]` configures the running bank without restoring balances. Fresh setup and reset select `intermittent` with seed `17`. Changing profile resets its counter. `reset` restores everything with services stopped.

| Profile | Behavior |
|---|---|
| `normal` | Normal responses |
| `intermittent` | `(counter + seed) % 4 === 0` loses the response after commit; seed 17 triggers the third new operation |
| `reject-before` | First new operation returns 503 before any effects |
| `lost-response` | First new operation commits and returns 504 |
| `slow-response` | First new operation commits; response takes 2.6 seconds |
| `read-unavailable` | First new operation commits and returns 504; first status lookup returns 503 |

Known references return as replays without retriggering the profile. The counter counts valid new operations, not queries. Reproduction does not depend on chance or exact model wording.

The administrative API (`POST /admin/scenario`, `POST /admin/reset`, `GET /admin/snapshot`) requires Bearer `BANK_ADMIN_SECRET`. It is a local testing utility. The customer application must not use it to complete operations or inspect their effects. Evaluation controls an independent bank instance and its failures.

## Application integration surface

Select a user with `POST /api/session {userId}` and use the returned session cookie. Tool arguments cannot select identity. This is a local simulator session, not authentication between people sharing a machine.

- `GET /api/dashboard`: accounts, movements, contacts, and approvals; or support cases for an operator.
- `GET/POST /api/conversations`; `GET /api/conversations/:id`; `POST /api/conversations/:id/messages {content}`.
- `POST /api/actions {name,arguments,intentId?,conversationId?}`: agent tools. Reusing `intentId` represents the same intent.
- `POST /api/approvals/:id/confirm`: confirmation entry point for proposals. `dashboard.approvals` supports their display in the UI.
- `GET /api/incidents/:id`: operator case detail.
- `GET /api/documents`, `/api/documents/:id`, and `/api/documents/:id/chunks`: sources and chunks without vectors.
- `POST /api/search {query}`; `POST /api/ingestion` for operators only.
- `POST /api/preview-answer {question,sources}` for operators only: uses the same document-answer construction with supplied sources, separating retrieval from generation. Sources contain `id,documentId,text,title,version,validFrom,validTo,audience,score`; see `SearchResult` in `src/types.ts`.

Actions support `transfer_money`, `list_accounts`, `operation_status`, `search_documents`, and `request_human`. Results contain `status` and applicable operation, approval, or error fields. Do not replace real effects with constant responses to satisfy checks. If you reorganize this surface, document and provide an equivalent adapter for the same observable behavior.
