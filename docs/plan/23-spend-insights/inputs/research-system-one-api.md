# System One API (Jev, TypeSafe AI) — integration note

Researched 2026-10-03. Read-only: public docs, npm registry and SDK source only. No sign-up, no credentials, no inference call.
"Official" = typesafe.ai, docs.typesafe.ai, the `@typesafe-ai/sdk` package and its GitHub source. Everything else is third party.

## Summary

1. One endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, JSON body `{ model, state, questions }`. Model listing: `GET /v1/models`.
2. Three question types: `noul` (yes/no probability), `choice` (max 255 options), `score` (2 to 10 ordered levels). Each has `type`, `instructions` and `criteria`.
3. There is NO `options` field. Choice options are the keys of the `criteria` map; the values are the option descriptions (or `null`).
4. Choice answer: `choice`, `probabilities` (sum to 1), `confidence` (0..1, derived from `probabilities`). Noul has no `confidence`. Top level: `model` (resolved pinned id), `answers`, `usage.input_tokens/output_tokens`.
5. Current model `jev-1.13.0`; aliases `jev-latest` and `jev-preview` both point to it. Pin the versioned id once thresholds are tuned.
6. Price: $0.042 per million input tokens ($42 per billion); output tokens are free. Limits are in tokens (64k per request, 32k for state plus longest question) and 80 requests/s, 100K tokens/s.
7. Documented errors: 401, 422, 429, 529. Guidance: exponential backoff on 429/529. Idempotency keys and billing on retry are NOT documented anywhere official.
8. Spanish is not named. English is the primary language; "other languages ... are handled but not equally well; test on your own content".
9. Documented weaknesses: literal reading, numbers, dates, adversarial content in `state`, choice option order bias, large irrelevant state.
10. The same wire format is served by OpenRouter (`/api/v1/systemone`) and Vercel AI Gateway (`/typesafe/v1/systemone`), so one adapter with configurable base URL, key and model id covers all three. Use plain `fetch`.

## Verified facts

| Fact | Value | Source | Official? |
|---|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | https://docs.typesafe.ai/api | Yes |
| Auth | `Authorization: Bearer <API_KEY>`, `Content-Type: application/json` | https://docs.typesafe.ai/api | Yes |
| Key source | `https://console.typesafe.ai/keys` (page returned 403 to an anonymous fetch; not inspected) | https://docs.typesafe.ai/introduction/quickstart | Yes |
| List models | `GET /v1/models` returns `models[]` with `name`, `description`, `release_date`; lists aliases only | https://docs.typesafe.ai/models | Yes |
| `model` | string, required. "Use `"jev-latest"`" | https://docs.typesafe.ai/api | Yes |
| `state` | `string \| object \| array`, required. Text only, no images/audio | https://docs.typesafe.ai/api, /concepts/state | Yes |
| `questions` | `map<string, Question>`, required. "The key is not sent to the underlying model and is not used in inference." | https://docs.typesafe.ai/api | Yes |
| `instructions` | `string \| object \| array`, required on all three types | https://docs.typesafe.ai/api | Yes |
| `noul` `criteria` | optional object with `true` and `false` descriptions | https://docs.typesafe.ai/api | Yes |
| `choice` `criteria` | required `map<string, string \| object \| array \| null>`. "use null when an option needs no extra detail. You can have a maximum of 255 options per Choice." | https://docs.typesafe.ai/api | Yes |
| `score` `criteria` | required ordered array. "A Score should have at least two levels; the API accepts up to 10." | https://docs.typesafe.ai/api | Yes |
| `options` field | Does not exist. Options are the `criteria` keys | https://docs.typesafe.ai/api | Yes |
| Noul answer | `{ type: "noul", noul: number }` "from 0 (no) to 1 (yes)". No `confidence` | https://docs.typesafe.ai/api, /confidence | Yes |
| Choice answer | `{ type, choice, probabilities, confidence }`. `choice` = "The highest-probability option."; `probabilities` = "Every option mapped to its probability (floats that sum to 1)." | https://docs.typesafe.ai/api | Yes |
| Score answer | `{ type, score, legend, probabilities, confidence }`. `score` is probability-weighted and "can land between levels"; keys of `legend`/`probabilities` are level indexes as strings | https://docs.typesafe.ai/api | Yes |
| `usage` | `{ input_tokens, output_tokens }` | https://docs.typesafe.ai/api | Yes |
| Choice confidence formula | `(p_max - 1/n) / (1 - 1/n)`; only the top probability counts | https://docs.typesafe.ai/confidence | Yes |
| Noul confidence (do it yourself) | `\|2p - 1\|` | https://docs.typesafe.ai/confidence | Yes |
| Models | `jev-1.13.0`; aliases `jev-latest` -> `jev-1.13.0`, `jev-preview` -> `jev-1.13.0` ("no preview build available right now") | https://docs.typesafe.ai/models | Yes |
| Pinning | "If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias". Response `model` reports the versioned id | https://docs.typesafe.ai/models | Yes |
| Price | "$42 / $0.042" per Btok / Mtok. "Charged per input token. Output tokens are free." | https://docs.typesafe.ai/models, https://typesafe.ai | Yes |
| Rate limits | "100K tokens per second / 80 requests per second"; "can change without notice" | https://docs.typesafe.ai/models | Yes |
| Context length | "64k tokens per request; 32k tokens for `state` plus the longest question" | https://docs.typesafe.ai/models | Yes |
| Body size limit (bytes) | Not documented | — | UNVERIFIED |
| Questions per request | Not documented officially (only the token budget) | — | UNVERIFIED |
| Errors | 401, 422, 429, 529 (table below) | https://docs.typesafe.ai/api | Yes |
| Retry guidance | Exponential backoff on 429 and 529; SDKs honor `retry-after` | https://docs.typesafe.ai/api, /models | Yes |
| Idempotency key, billing on retry | Not documented | — | UNVERIFIED |
| Language | "English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev for a non-English workload". Spanish not named | https://docs.typesafe.ai/models | Yes |
| Training on customer data | "Jev is not trained on customer requests or responses."; privacy policy: "We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input." | https://docs.typesafe.ai/models, https://typesafe.ai/legal/privacy-policy | Yes |
| Retention | No fixed period. DPA: "retained for as long as necessary taking into account the purpose of the Processing". MCA lets TypeSafe keep derived "Telemetry" (logs, hashes, statistics) in perpetuity. ZDR only "for enterprise customers" | https://typesafe.ai/legal/data-processing, https://typesafe.ai/legal/mca, https://docs.typesafe.ai/legal | Yes |
| Hosting | "The Services are hosted in the United States." | https://typesafe.ai/legal/privacy-policy | Yes |
| Subprocessors | Listed at https://trust.typesafe.ai/subprocessors (not fetched) | https://typesafe.ai/legal/data-processing | Yes |
| SDK | `@typesafe-ai/sdk` 0.6.0, published 2026-09-15, MIT, Node >= 20, ESM + CJS + types, unpacked 209,203 bytes, 9 files, no runtime dependencies, npm provenance attestation | https://registry.npmjs.org/@typesafe-ai/sdk | Yes |
| SDK previous version | 0.5.7 (first public release). 0.6.0 breaking change: `Score.criteria` is an ordered array | https://docs.typesafe.ai/sdk/javascript/changelog | Yes |
| SDK defaults | timeout 10,000 ms per attempt; 2 retries; backoff 500 ms doubling to 5,000 ms, jitter 0.25; retries 408, 429, all 5xx, connection errors and timeouts; honors `retry-after-ms` / `Retry-After` up to 60 s | https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts | Yes |
| SDK errors | `APIError` (`status`, `body`, `headers`, `requestId` from `x-typesafe-request-id`) with subclasses for 400/401/403/404/422/429/5xx; `APIConnectionError`, `APITimeoutError`, `APIUserAbortError` | https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts | Yes |
| SDK extras | Env vars `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`; sends `X-TypeSafe-Retry-Count` on retries; refuses to run in a browser; no idempotency key | https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts | Yes |
| OpenRouter model id | `typesafe/jev-1.13`, alias `~typesafe/jev-latest`; $0.000000042 per input token, output 0; context 32,000 | https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints, https://openrouter.ai/docs/guides/community/jev | No |
| Vercel model id | `typesafe-ai/jev` | https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe | No |
| Cloudflare model id | `typesafe/jev`, $0.042 per 1M input, 32,000 tokens, "Zero data retention: Yes" | https://developers.cloudflare.com/ai/models/typesafe/jev/ | No |
| jev-ai.pro limits | body 256,000 bytes, 64 questions, question id max 64 chars, 1,000 requests/minute | https://jev-ai.pro/docs | No |

## Request and response examples

All three blocks are copied from the official API reference and quickstart.

Request (three types in one call):

```json
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated the customer appears",
      "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
```

Response:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "confidence": 0.78,
      "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 }
    },
    "frustration": {
      "type": "score",
      "score": 1.0,
      "confidence": 1.0,
      "legend": { "0": "Calm, just stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" },
      "probabilities": { "0": 0.0, "1": 1.0, "2": 0.0 }
    },
    "is_urgent": { "type": "noul", "noul": 1.0 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

Noul with criteria:

```json
"is_urgent": {
  "type": "noul",
  "instructions": "Does this convey urgency?",
  "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
}
```

Structured option descriptions (official, `primitives/advanced`). The field names `what`, `not_for`, `examples` are free: "not part of the API, and none are reserved".

```json
"criteria": {
  "billing": {
    "what": "Charges, invoices, refunds, or subscriptions",
    "not_for": "Order tracking or account access",
    "examples": ["I was charged twice", "Where is my refund?"]
  }
}
```

Sketch for a bank movement (my own, not from the docs; untested):

```json
{
  "model": "jev-1.13.0",
  "state": { "description": "COMPRA TARJ. MERCADONA VALENCIA", "direction": "debit" },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which single spending category best describes the bank movement in `description`?",
      "criteria": {
        "groceries": "Supermarkets and food shops",
        "transport": "Fuel, public transport, taxis, parking",
        "other": "Fits none of the other categories"
      }
    }
  }
}
```

## Errors and retries

Official table (https://docs.typesafe.ai/api):

| Status | Official meaning | Adapter action |
|---|---|---|
| 401 | "Missing or invalid API key." | Fail, do not retry |
| 422 | "The request body failed validation ... The body details the offending field." | Fail, do not retry |
| 429 | "You have exceeded your rate limit. Back off and retry after a short delay." | Retry with backoff, honor `Retry-After` |
| 529 | "TypeSafe is temporarily overloaded. Retry after a short delay." | Retry with backoff |

Official guidance, quoted: "retry the request with exponential backoff instead of retrying immediately. Our client SDKs handle this automatically".

- The error body schema is not specified officially. The SDK's parser accepts `error` (string or `{message}`), `message`, or `detail` (string, `{message}`, or a FastAPI-style list of `{loc, msg}`). Vercel shows `{ "message": ..., "error_type": "invalid_request" }` and calls it "TypeSafe's shape" (third party).
- The official SDK retries the POST by default on 408, 429, any 5xx, connection errors and timeouts (2 retries). It sends no idempotency key.
- Idempotency and billing on retry: nothing in the official docs. The call is a stateless read with no side effects, so a replay is safe functionally. Whether a timed-out attempt is billed is UNVERIFIED. At $0.042 per million tokens a duplicate costs about $0.00003.
- Only jev-ai.pro (third party) tells users to disable retries ("Avoid replaying a request with an uncertain outcome"). That is about its own credit balance, not the official API.
- Gateways add codes: OpenRouter documents 400, 402, 403, 404, 413, 500, 502, 503, 524, 529; jev-ai.pro adds 402, 404, 409, 502, 503, 504.

## Access routes compared

| Route | Base URL and path | Auth | Model id | Same shape as TypeSafe? | Price | Key |
|---|---|---|---|---|---|---|
| TypeSafe direct (official) | `https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer` | `jev-latest`, `jev-1.13.0` | Reference | $0.042 / M input | console.typesafe.ai/keys. Marketing says "early access"; whether sign-up is gated is UNVERIFIED |
| OpenRouter, System One API | `https://openrouter.ai/api/v1/systemone` | Bearer, OpenRouter key | `jev-1.13`, `jev-latest`, or `typesafe/jev-1.13` | Yes. "implements TypeSafe's request and response shapes"; adds `id`, `provider`, `usage.cost`. Response `model` is `typesafe/jev-1.13-20260917`. `GET /api/v1/models` is NOT TypeSafe-shaped | $0.042 / M input | openrouter.ai/settings/keys. "no waitlist or separate TypeSafe account" |
| OpenRouter, Decisions API (alpha) | `https://openrouter.ai/api/alpha/decisions` | Bearer | `typesafe/jev-1.13`, `~typesafe/jev-latest` | Same `model`/`state`/`questions` and answers. Schema marks `confidence`, `probabilities` and `usage.cost` optional. Extra optional fields: `provider` (incl. `zdr`, `data_collection`), `session_id`, `user`, `trace` | Same | Same |
| Vercel AI Gateway, TypeSafe-compatible | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` (also `/typesafe/v1/models`) | Bearer, AI Gateway key or Vercel OIDC token | `typesafe-ai/jev` | Yes. "implements the TypeSafe request and response shapes"; adds `provider_metadata.gateway` | Docs example: 275 tokens cost "0.00001155", which equals $0.042 / M | Vercel dashboard, needs AI Gateway credits. BYOK supported |
| Vercel AI Gateway, native | `https://ai-gateway.vercel.sh/v1/evaluate`, or AI SDK 7 `experimental_evaluate` from `ai` | Same | `typesafe-ai/jev` | NO. Type is `boolean` (not `noul`) and returns `probability`; `usage` is `inputTokens`/`outputTokens`; documented examples show no `confidence` or `legend`. Accepts `providerOptions.gateway.zeroDataRetention` | Same | Same |
| Cloudflare | `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run`, or `env.AI.run('typesafe/jev', ...)` in a Worker | Bearer, Cloudflare API token | `typesafe/jev` | NO for the request: `{ "model": "typesafe/jev", "input": { state, questions } }`. Response example matches TypeSafe (`model: "jev-1.13.0"`, answers, usage) | $0.042 / M input | Cloudflare account. The page sits under Cloudflare "AI" model docs; I found no TypeSafe entry in the AI Gateway provider docs |
| jev-ai.pro (unofficial) | `https://jev-ai.pro/api/v1/systemone` (also `/api/alpha/decisions`) | Bearer, `JEV_AI_API_KEY` | `jev-latest`, `jev-preview`, `jev-1.13.0` | Yes, with differences below | Prepaid tokens and credits; no per-call USD price | Google sign-in on the site |

### jev-ai.pro in detail (third party, not official)

- Its docs say: "`@typesafe-ai/sdk` is the official JavaScript / TypeScript SDK published by TypeSafe. Jev AI independently provides a compatible hosted API endpoint; this SDK is not published by Jev AI." Its about page: "Jev AI is an independently operated platform for accessing Jev models".
- Operator: only the name "Jev AI" and a contact email. No legal entity, address or governing law on the terms, privacy or about pages.
- Terms: https://jev-ai.pro/terms. Privacy: https://jev-ai.pro/privacy. Also `/refund`, `/pricing`.
- Privacy policy states: "We store prompts, lyrics and other submitted text, generation settings, model choices ...", "Do not submit sensitive personal information in prompts", and "the text and questions you submit are processed by TypeSafe, which provides the Jev model, and by OpenRouter when a fallback provider is needed". The mention of lyrics and reference media suggests a policy reused from another product.
- Terms grant it "a limited license to process it solely to operate and improve the service".
- Differences from the official API: `model` optional (defaults to `jev-latest`); explicit limits (256,000-byte body, 1 to 64 questions, ids limited to letters, digits, dots, dashes, underscores, max 64 chars, 1,000 requests/minute); unknown fields rejected; extra errors 402/404/409/502/503/504 with body `{ "error": { "code", "message" } }`; billing headers `X-Jev-Run-Id`, `X-Jev-Billing`, `X-Jev-Paid-Input-Tokens-Used`, `X-Jev-Credits-Charged`, `X-Jev-Tokens-Remaining`; credit/token billing instead of USD; extra models (`laya-english`, `laya-multilingual`, `mercury-decide`), saved judges (`judgeId`), and `/api/v1/web-context`.

## Best practice for classification

Official unless marked.

- Put definitions in `criteria`, not in the instruction: "The option names and their descriptions are both sent to the model, so write descriptions that separate the options from each other."
- For confusable options use a structured description (`what`, `not_for`, `examples`) with "the same field names across options".
- "give the model the full list ... rather than a shortlist. Add an `other` or `none of the above` option when the list might not cover every input".
- Be literal: "state the exact condition in the `instructions`. Be specific. Put boundary cases in the criteria."
- Keep `instructions` and `criteria` consistent; contradictory pairs perform worse.
- Option order bias: "`jev-1.13` leans toward the option that comes first." "reorder the options to double check that the answer stays consistent."
- Keep `state` small: "Accuracy falls as the state grows with content unrelated to the decision." Send only the fields the question needs; "Use an object for most requests so each part of the state has a descriptive name".
- Numbers and dates stay in code: "Jev is not a calculator"; it "reads dates as text, not as ordered quantities". Pass a computed value or "a named bucket".
- Adversarial content: "Content written to adversarially steer the model ... can move the answer." A movement description is user-influenced text, so treat the answer as untrusted and gate it.
- One state per request, many questions: "Each request evaluates one state against one or more questions. All questions see the same state and are evaluated independently." "Ask every Choice question your code might need in a single request". The parallel-questions cookbook measured 12.2x cheaper and 10.0x faster with no change in answers.
- One item per request versus many items: the official docs define a request as one state. They do show a list in `state` with one question per element (`` Is `items[i]` ...? ``), so several movements per request is possible. For a single `choice` this saves little, because the category list is repeated in every question, and it enlarges `state`. OpenRouter's classification cookbook (third party) uses one item per request with 8 concurrent workers, about 610 input tokens and $0.0000256 per item.
- Thresholds: "A confidence threshold is not one number." "Start with conservative thresholds, test with your own data, and adjust as you observe results." "Test thresholds by plotting confidence against accuracy on your data." Official examples use a floor of 0.5 or 0.6 and 0.9 for high-stakes actions; these are illustrations, not recommended values.
- Alternatives to `confidence`, computable from `probabilities`: top probability and the top-to-second ratio.
- Calibration claim: the docs say RLCD "communicates uncertainty through calibrated probabilities". No calibration data for Spanish. The score levels are "weak in numerical calibration".
- Third party (OpenRouter cookbook, TweetTopic, 150 items): confidence >= 0.8 matched 114 of 122; 0.5 to 0.8 matched 9 of 18; below 0.5 matched 4 of 10. It suggests labelling 100 to 200 items by hand to pick the cut.

## Recommendations

**Plain `fetch`, not the SDK.**
- The whole API is one POST with a small JSON body; Node 24 has `fetch` and `AbortSignal.timeout`.
- The SDK is clean (zero dependencies, 209 kB, MIT), but it is v0.6.0, three weeks old, and already had a breaking change.
- What the SDK adds is about 30 lines: timeout, retry on 429/5xx with `Retry-After`, typed errors, request id. Type inference per question is not needed for one fixed `choice`.
- With `fetch`, the adapter owns the retry policy, which the app already needs for its own rules.

**Adapter shape.** Three env values: base URL, API key, model id. Official, OpenRouter `/api/v1/systemone` and Vercel `/typesafe/v1/systemone` then work unchanged. Read only `answers[id].choice`, `.probabilities`, `.confidence`, `model` and `usage`; ignore extra fields. Recompute confidence from `probabilities` if `confidence` is missing (optional on OpenRouter's Decisions schema). Validate that `choice` is one of the sent categories.

**Access route for a bank-data demo.**
1. TypeSafe direct if a key can be obtained: fewest parties see the data, with a no-training commitment and a DPA.
2. Otherwise OpenRouter `/api/v1/systemone`: identical shape, no waitlist, same price. Vercel's `/typesafe` route is equivalent if a Vercel team with credits already exists.
3. Do not use jev-ai.pro: no named legal entity, stores submitted text, forwards it to two other parties, and its own policy says not to submit sensitive data.
4. Avoid Vercel `/v1/evaluate` and Cloudflare `/ai/run` as the primary route: different request or answer shape.

**Behaviour.**
- One movement per request, one `choice` with all categories plus `other`, short descriptions in `criteria`.
- Send only the description (and a direction bucket if useful). No account numbers, names or balances.
- Pin `jev-1.13.0`. Store the returned `model` with each result.
- Start with a conservative confidence cut and fall back to `other`/uncategorised below it; tune on a small labelled Spanish sample.
- Timeout about 10 s; retry 429, 529 and 5xx up to 2 times with backoff and `Retry-After`; never retry 401/422. If the key is absent or the call fails, the feature degrades to uncategorised.

## Unverified and open points

- UNVERIFIED: whether a direct TypeSafe key is available without a waitlist. The console returned 403 to an anonymous fetch; marketing says "early access".
- UNVERIFIED: any byte limit on the body and any cap on questions per request on the official API. Only token limits are documented. The 256,000-byte and 64-question figures come from jev-ai.pro only.
- UNVERIFIED: idempotency support and whether failed, timed-out or retried requests are billed.
- UNVERIFIED: the exact official error body schema.
- UNVERIFIED: accuracy and calibration in Spanish. Not named in the docs; needs a local test.
- UNVERIFIED: retention period for API inputs on the standard (non-enterprise) plan. Only "as long as necessary" is stated. The subprocessor list was not fetched.
- UNVERIFIED: whether Cloudflare exposes Jev through AI Gateway proper. The model page documents Workers AI style `/ai/run` and lists zero data retention; the AI Gateway provider docs did not mention TypeSafe.
- UNVERIFIED: Vercel's listed price (taken from a docs example that equals $0.042 / M) and whether its native API returns `confidence`.
- Context length differs by source: official 64k per request / 32k state plus longest question; OpenRouter and Cloudflare say 32,000.
- OpenRouter's doc example shows `usage.cost: 0.00003` for 275 tokens, which does not match $0.042 / M; treat it as illustrative.
- The brief's `options` field and "billing on retry" guidance do not exist in the official docs.
- No endpoint was called, so every response shape here is as documented, not observed.

## Sources

Official:
- https://typesafe.ai
- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/advanced
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/model-jaggedness/jev-1.13
- https://docs.typesafe.ai/cookbooks/parallel_questions
- https://docs.typesafe.ai/legal
- https://typesafe.ai/legal/privacy-policy
- https://typesafe.ai/legal/data-processing
- https://typesafe.ai/legal/mca
- https://docs.typesafe.ai/sdk/javascript
- https://docs.typesafe.ai/sdk/javascript/changelog
- https://registry.npmjs.org/@typesafe-ai/sdk
- https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts
- https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts
- https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts

Third party:
- https://openrouter.ai/docs/guides/community/jev
- https://openrouter.ai/docs/guides/community/typesafe-sdk
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
- https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification
- https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints
- https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
- https://vercel.com/docs/ai-gateway/modalities/evaluation
- https://vercel.com/docs/ai-gateway/getting-started/evaluation
- https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
- https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev
- https://developers.cloudflare.com/ai/models/typesafe/jev/
- https://jev-ai.pro/docs
- https://jev-ai.pro/terms
- https://jev-ai.pro/privacy
- https://jev-ai.pro/about
- https://jev-ai.pro/pricing
