# 08 — SI8 Evaluation: harness, held-out bars, report

Branch `feat/si8-eval`. Size **M**. Priority **must** for the harness, the rules-only run and the bars; **should** for the live decider runs (they need keys and cost a little). Depends on SI4.

## Goal

Measure the classifier instead of trusting it, on rows its rule authors never saw, and take the option order and the thresholds from the numbers.

## Data (already in the repository; do not re-specify)

| Set | File | Rows | Who may read it |
|---|---|---|---|
| dev | [`inputs/eval-set-dev.jsonl`](inputs/eval-set-dev.jsonl) | 144 (136 until IG1 added `ev-137` to `ev-144`) | everyone; rules are tuned on it |
| held-out | [`inputs/heldout/eval-set-heldout.jsonl`](inputs/heldout/eval-set-heldout.jsonl) | 100 | SI8 builder, reviewer, orchestrator. **Never a rule author** ([heldout/README.md](inputs/heldout/README.md)) |

The harness reads both shapes as they are ([inputs/README.md](inputs/README.md), point 6):

- dev: `{id, description, amountCents, createdAt, expected, difficulty, notes, concept?, counterpartyIsOwnAccount?, acceptable?}`; adversarial = `notes` starts with `ADVERSARIAL`;
- held-out: `{id, description, amountCents, createdAt, counterparty: null | 'person' | 'own', expected, acceptable, difficulty, adversarial, note}`.

Mapping to `MovementInput`: own → `fromAccountId` and `toAccountId` both in the fake customer's own set; person → a non-own `toAccountId` (debit) or `fromAccountId` (credit); `concept` when given.

The files stay where they are; the harness takes `--set=dev|heldout|<path>`.

## Files (owner: this item only)

| File | Change |
|---|---|
| `scripts/eval-insights.ts` (new) | harness |
| `package.json` | `"eval:insights": "node --import tsx scripts/eval-insights.ts"` |
| `tests/si8-eval.test.ts` (new) | offline checks of the harness and the dev set |
| `docs/insights-eval.md` (new) | the report |
| `src/insights/taxonomy.ts` (`DECIDER_OPTIONS` order, criteria wording), `src/config.ts` / `.env.example` (threshold defaults) | only if the measurements say so; each change with its number |

`tests/acceptance/si8-heldout.test.ts` is written by the **reviewer**, not by this builder ([requirements.md](requirements.md#held-out-bars)).

## Harness

`npm run eval:insights -- --set=dev|heldout --decider=rules|openai|systemone [--out=<dir>] [--reverse-options] [--no-profile]`

It calls `classifyMovements` with `wait: true`, a temporary `DATA_DIR` and one synthetic customer per row (so nothing is shared between rows), then scores. No HTTP.

Per run it prints and writes:

- **strict accuracy** (`expected` only) and **lenient accuracy** (`expected` or `acceptable`);
- **coverage** (share shown with a category, i.e. not `needs_review`), **precision when shown**, **wrong-but-shown rate** (lenient) — the number behind "never a guess shown as fact";
- the split by `difficulty`; the **adversarial rows on their own**, one line each: expected, got, obeyed-injection yes/no;
- share decided by rules, by the model, sent to review;
- a confusion table;
- for a decider: requests, latency p50/p95, input tokens, **cost per 1,000 movements**, and the **reliability table**: confidence bucket (0.5–0.6 … 0.9–1.0), rows, observed accuracy. It is the only artefact that shows whether confidence means anything: System One's buckets should track accuracy; OpenAI's self-reported value may not;
- a **threshold table** from the stored confidences (0.50 to 0.95 in steps of 0.05: coverage and wrong-but-shown per value). A ten-line loop over one run; no extra calls;
- with `--no-profile`: the same run with `classifyMovements({profile: false})`. The report puts both runs side by side as the **ablation column** (strict accuracy, coverage, wrong-but-shown, with and without the merchant profile). In the eval sets every row is its own customer, so the profile there is that row's own time, day and amount buckets with `occurrences: once`; the report says that the multi-movement part of the profile (typical values, `recurring_monthly`) is exercised by the demo data, not by these sets;
- with `--reverse-options`: the same run with the option order reversed, and the **flip rate** (share of model-decided rows whose top option changed).

The list of misses is written to `<out>/misses.txt`. For the held-out set, `<out>` is `.scratch/after/feat-si8-eval/heldout/` and that file is never given to a rule author.

Live runs cost money: one run per decider and set, plus one reversed run and one no-profile run on the dev set. System One at $0.042 per million input tokens is cents; OpenAI depends on the chat model.

## Decisions taken from the numbers

1. **Option order.** If the flip rate on the dev set is above 5%, try the order with the most confusable options last and keep the better one; `other` is never first. Record the final order in `docs/insights-eval.md` and ask the orchestrator for the contracts.md changelog line.
2. **Thresholds.** Per decider: the lowest threshold whose wrong-but-shown rate on the **dev** set is at most 5%; if none, the highest in the table, and say so. Set `DECIDER_THRESHOLD_PCT` / `DECIDER_OPENAI_THRESHOLD_PCT` defaults accordingly. The held-out set is then run once with those values; it is not used to choose them.
3. **Profile.** Keep the merchant profile unless the ablation shows it lowers accuracy or raises wrong-but-shown on the dev set; either way the report shows both columns. Dropping it is a contracts.md change (orchestrator).
4. **Bars.** The first rules-only held-out measurement goes to the reviewer, who writes the bars (requirements.md "Held-out bars"). Export the scoring function from the harness so `tests/acceptance/si8-heldout.test.ts` can import it; that file merges right after this PR.

## Report (`docs/insights-eval.md`)

Method; one table with a row per decider and set (strict, lenient, coverage, wrong-but-shown, cost per 1,000, p95); the adversarial table; the reliability table per decider; the flip rate and the chosen order; the thresholds and why; the bars. Limits, stated plainly: synthetic rows; about 100 per set; the dev set and the rules share authors, the held-out set does not; Spanish is not named by the provider; OpenAI confidence is self-reported; a decider that was not run is "not measured", with no claim about it.

## Tasks

1. As soon as SI4 is merged: harness with `--decider=rules`; run dev and held-out; hand the held-out numbers to the reviewer (first measurement).
2. `tests/si8-eval.test.ts`.
3. OpenAI runs (dev, dev reversed, held-out). System One runs when a key exists (direct, or a gateway with the same wire format); else "not measured".
4. Order and thresholds; report.
5. Gates.

## Tests first (`tests/si8-eval.test.ts`, offline)

- The dev set parses: unique ids, valid `expected`, valid `acceptable`.
- The harness with `--set=dev --decider=rules` exits 0 and writes its files; its numbers are reproducible (two runs equal).
- Scoring unit tests on a five-row fixture: strict vs lenient, coverage, wrong-but-shown, a reliability bucket, the flip rate.
- The mapping of both row shapes to `MovementInput`.

This file does **not** read the held-out set (the reviewer's acceptance test does).

**Must fail before:** no harness.

## Evidence

`.scratch/after/feat-si8-eval/`: `dev-rules.txt`, `dev-openai.txt`, `dev-openai-reversed.txt`, `dev-systemone.txt` (or `systemone-not-measured.txt`), `heldout/rules.txt`, `heldout/openai.txt`, `heldout/systemone.txt`, `heldout/misses.txt`, `verify.txt`.

## Acceptance

- Every number in the report is reproducible with one command and has its evidence file.
- No change to the dictionary, rules or normalisation in this PR. A dev-set miss that shows a real gap goes to a follow-up by the rules stream; a held-out miss never does (only its class, in words, through the reviewer).
- Gates green; change note; id `SI8`.

## Verification (V-cycle)

The held-out set **is** the blind check of the core: REQ-HO-1 … -3, with bars written by the reviewer. REQ-SI8-1 … -5 are checked by the reviewer from the evidence.
