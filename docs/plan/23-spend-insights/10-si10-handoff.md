# 10 — SI10 Docs and handoff

| | SI10a | SI10b |
|---|---|---|
| Branch | `docs/si10a-submission-rounds` | `docs/si10b-part2-handoff` |
| Size | S | M |
| Priority | must | must |
| Depends on | nothing: **starts on 4 Oct** | every other item merged or explicitly dropped |
| Closes | HD1 of round 6 | — |

## Goal

A reviewer who opens the ZIP can run the feature, understand why it exists and see what was verified and what is pending (`docs/challenge.md`: "For Part 2, explain your idea, why it is useful and how to try it"; "State what is finished, what you verified and what remains pending").

## SI10a — `submission/README.md`, rounds 1–6

The file is still the round-3 draft. Nothing in round 7 is needed to fix that.

Files: `submission/README.md` only. (`submission/` is prettier-ignored and tracked except `ai-sessions/`; never hand-edit `submission/ai-sessions/`.)

- Header: ZIP command; the date and commit stay placeholders until packaging. Remove the "Draft" banner; mark Part 2 and the video as "in progress (round 7)".
- Setup and demo: the Part 1 path, kept and shortened.
- Part 1: findings and the before/after table (kept); the **Rounds** table completed for rounds 1–6 with checklist links, counts and PR ranges. Count the ticked boxes in each checklist; do not retype numbers from memory.
- Method: orchestrator / builder / reviewer, plans, change notes, evidence folders, gates.
- Evidence index: `.scratch/baseline/`, `.scratch/after/`, `.scratch/audit-02/` … `audit-06/`.
- Pending (Part 1): what of AR1–AR3 is still open after #83 (`fix/assistant-stale-proposal`, AR1-a and AR1-b; its change note lists three open items and a live correction probe that was not run).
- A marked placeholder section "Part 2 — spend insights" for SI10b.

Checks: every cited path exists (the check described in `.scratch/audit-06/handoff/05-evidence-paths.txt`); `npm run verify`.

Evidence: `.scratch/after/docs-si10a-submission-rounds/`: `paths.txt`, `counts.txt` (boxes per checklist), `verify.txt`.

## SI10b — Part 2 docs, integration surface, video outline

| File | Change |
|---|---|
| `README.md` | "Spend insights" section; Commands rows checked (`demo`, `eval:insights`); Optional settings (`DECIDER*`); Project map (`src/insights/`); "About this challenge entry" gains round 7 |
| `docs/integration-surface.md` | final pass against `route.ts`: the insights routes, `category` and `insights` on the dashboard, the chat-only tools, `movementId`, `extras`, the audit events |
| `submission/README.md` | the Part 2 section; round 7 row; finished / verified / pending |
| `docs/video-outline.md` (new) | the outline |
| `AGENTS.md` | Status: round 7 done (orchestrator-owned; note it in the PR) |

### README "Spend insights"

1. **First line:** "The default bank has four expenses per customer. Run `npm run demo` for a realistic statement; it needs only the OpenAI key (and works with none, with rules only)."
2. What the default bank still shows: a chip, its "why" and "Ask the assistant" on every movement; make a transfer and ask the assistant what it was for.
3. What it is, in four lines; the five steps of the demo path.
4. Deciders: the `DECIDER` table; what works with no key, with an OpenAI key, with a decision-model key; what is sent to the provider (the cleaned description, the direction and the four merchant-profile labels) and where it goes.
5. What is shown as estimate and why; the window note; what happens to a confirmed category when a bank restarts (rules persist).
6. Links: `docs/insights-eval.md`, this plan.

No calibration claim for a decider that was "not measured".

### `submission/README.md` Part 2

The idea; why it is useful; why it is part of the agent; how to try it (`npm run demo` first); the pipeline in six lines; the evaluation table and the held-out bars; security in four lines (closed list, facts before models, threshold, only the customer confirms); the verification model (blind held-out set, independent acceptance tests).

**Finished / verified / pending**, as three lists. Pending includes: recurring charges and subscriptions (the next iteration), the rest of AR1–AR3, SI11 if not built, a decider that was "not measured", the limits of the evaluation.

Included files with relative paths (`ai-sessions/`, the video, this README).

### Video outline (`docs/video-outline.md`)

5–10 minutes, both parts; Part 2 in about three. Demo bank, real decider, clean `DATA_DIR`.

| Time | Part | Shows |
|---|---|---|
| 0:00–0:30 | Intro | the brief in one sentence; how the work was organised |
| 0:30–3:30 | Part 1 | duplicate transfer before/after with `probe:transfers`; propose → confirm; a cited answer; the operator case; the independent bank |
| 3:30–3:55 | Part 2, Lucía, Overview | a raw line `COMPRA TARJ. … MERCADONA …`, its chip "Groceries · estimated", the card, "Other — to review". The bank sends no categories; estimates are labelled; unknowns are not guessed |
| 3:55–4:25 | Lucía, chat | "¿En qué gasté en septiembre?" → totals with cited movements, savings and cash named as not counted, the estimated share, "N movements unclassified" and the offer |
| 4:25–4:55 | Lucía, `EL CORTE INGLES` | "¿Por qué no lo clasificaste?" → the probabilities and the bar; "Fue ropa" → set; no rule offered for one movement |
| 4:55–5:30 | Bruno, `SUMUP *ESPAI NOU` ×4 | "Espai Nou es el rocódromo" → "apply to the 4 and to future ones?" → yes → the learning notice; a fifth movement injected arrives as "your rule" |
| 5:30–5:55 | Bruno | the instruction-in-description row sits in Other, untouched; "Olvida esa regla" → rule removed, rows back in review |
| 5:55–6:20 | Evaluation | `npm run eval:insights` output: accuracy on the held-out set, wrong-but-shown, cost, the reliability table |
| 6:20–6:40 | Default bank | `npm run dev` with only the OpenAI key: chips, "Ask the assistant", a transfer asked "what was it for?" |
| 6:40–7:10 | Close | what is verified, what is pending |

The pipeline diagram and the no-key mode are in the README, not in the video.

### Checks (SI10b)

- Path check over `submission/README.md`, `README.md`, `docs/`: 0 missing.
- `docs/integration-surface.md` lists every route in `route.ts`.
- `npm run package`; extract into a fresh folder; with **only `OPENAI_API_KEY` set**: `npm ci`, `npm run setup`, `npm run demo`, `npm test`.
- `npm run verify`.

Evidence: `.scratch/after/docs-si10b-part2-handoff/`: `paths.txt`, `routes-vs-docs.txt`, `package.txt`, `fresh-extract.txt`, `verify.txt`.

## Acceptance

- `submission/README.md` has no "draft", no "in progress" for a finished round, and "TBD" only for the video file until it exists.
- A reader can try Part 2 from the README alone, starting with `npm run demo`.
- Pending work is listed.
- HD1 ticked by the reviewer when SI10a merges.

## Verification (V-cycle)

Docs: no test branch. The reviewer checks REQ-SI10-1 … -5 by inspection and by the fresh-extract run.
