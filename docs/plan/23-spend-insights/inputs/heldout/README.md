# Held-out evaluation set — do not read if you write rules

**Rule authors must not open this folder.** That means the builders of SI1 and SI2a, and anyone who edits `src/insights/dictionary.ts`, `src/insights/rules.ts` or `src/insights/normalize.ts`, now or later.

Why: the 100 rows in `eval-set-heldout.jsonl` were written blind (see the notes file for what its author read). They are the independent acceptance check of the classification core. A rule tuned on them measures nothing.

Who may read it:

- the SI8 builder, to run the harness on it. It reports aggregate numbers; the list of misses goes only to `.scratch/after/feat-si8-eval/heldout/` and is never passed to a rule author;
- the reviewer and the orchestrator.

Rules and dictionary entries change only because of the dev set (`../eval-set-dev.jsonl`) or a customer-visible defect, never because of a held-out miss. If a held-out miss shows a real defect, the reviewer describes the **class** of problem in words ("refunds from a merchant are labelled income"), not the row.

Row shape: `{id, description, amountCents, createdAt, counterparty: null | 'person' | 'own', expected, acceptable: CategoryId[], difficulty: 'clean' | 'dirty' | 'hard', adversarial: boolean, note}`.
