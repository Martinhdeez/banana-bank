# Plan 23 — inputs

Research and data produced on 2026-10-03 for the plan. They are committed so builders do not depend on a temporary folder. **Where an input and the plan disagree, the plan wins** ([contracts.md](../contracts.md) first, then the item files).

| File | What it is | Used by |
|---|---|---|
| `research-system-one-api.md` | System One API (Jev, TypeSafe AI) from the official docs: wire format, errors, limits, price, best practice | SI3; `contracts.md` §6 is taken from it |
| `rules-dictionary-proposal.md` | 212 regex rules by category, priority overrides, normalisation steps, known ambiguous merchants | SI1 (normalisation), SI2a (dictionary) |
| `gen-spend-data.mjs` | the script that generated the dictionary, the dev set and the demo tables from one source, and checked that no rule contradicts a labelled row | SI1, SI2a: the arrays `PRIORITY`, `RULES`, `TRANSFER_PERSON`, `OPENING`, `INCOME` and the functions `light`, `merchantKey`, `ruleDecision` are the starting point |
| `eval-set-dev.jsonl` | 144 labelled rows (136 from the generator, 8 added by IG1 for injected text), the **dev set**. Rule authors may read it and tune on it | SI2a, SI8 |
| `demo-bank-dataset-proposal.md` | demo movements per persona and five demo scenarios, plus how to load them into the alt bank | SI9 (Lucía and Bruno only) |
| `heldout/` | 100 blind-labelled rows and their notes. **Rule authors must not read it** ([heldout/README.md](heldout/README.md)) | SI8, reviewer |

## Where the plan overrides these inputs

The inputs were written before the final labelling rules (contracts.md §1, "Labelling rules"). Differences:

1. **A person transfer stays `transfer_person` whatever its concept.** The generator classifies a transfer by its concept first (`ruleDecision`: keywords before the `TRANSFER_PERSON` fallback). In the plan, a transfer to a person is decided before any keyword. Dev rows `ev-027`, `ev-028`, `ev-054`, `ev-060` were relabelled to `transfer_person` in `eval-set-dev.jsonl`, with the old label in `acceptable`.
2. **A merchant refund takes the purchase category; a tax refund is `other`.** The generator makes every credit `income`. Dev rows `ev-108` (Zara refund → `shopping`), `ev-110` (tax refund → `other`) and `ev-114` (Amazon refund, merchant not ruled → `other`) were relabelled the same way.
3. Because of 1 and 2, **do not run `gen-spend-data.mjs` in place**: it rewrites its output files next to itself with the old labels. It is kept as the record of how the dictionary was validated and as the source of the regex arrays. SI2a ports the arrays and adapts the tier order; the SI8 harness replaces the generator's check.
4. **Demo dataset: Lucía and Bruno only** (SI9). Their tables are taken as they are, with these expected labels changed by rule 1: Lucía row 26 (`To acc-bruno: Team dinner`) and Bruno rows 1 and 13 (`TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER`) are `transfer_person`. Demo scenario 5 (Hugo, "a transfer classified by its concept") is dropped.
5. **Taxonomy ids** in the inputs are the final ones (`transfer_person`, `savings_internal`).
6. The dev set has `difficulty` and `notes` (adversarial rows: `notes` starts with `ADVERSARIAL`), optional `concept`, `counterpartyIsOwnAccount`, and `acceptable` on the seven relabelled rows. The held-out set has `counterparty`, `acceptable`, `adversarial`, `note`. The SI8 harness reads both shapes as they are.
7. The proposal's per-movement amount and time "features for the model" become a per-merchant **profile** of labels (contracts.md §1 "Merchant profile"), so that one merchant gets one decision.
