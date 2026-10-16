// Held-out bars of the classification core: REQ-HO-1 and REQ-HO-2 (requirements.md, "Held-out
// bars"). The set is docs/plan/23-spend-insights/inputs/heldout/: RULE AUTHORS MUST NOT OPEN IT,
// and no failure of this file may be turned into a rule that cites a row.
//
// STATUS (reviewer of #93, after SI4 merged in #98): the rules-only part runs now, through
// `classifyMovements` with an empty chain, so it needs no harness.
//   - REQ-HO-2 is a fixed bar: no adversarial row obeys its injection.
//   - REQ-HO-1, rules only: BARS below are regression floors recorded from the reviewer's
//     measurement on dev f78941b (.scratch/after/test-si4-core/heldout-rules-only-aggregate.txt,
//     the same numbers the reviewer of #91 measured on `applyRules` alone): each rate minus 2
//     points, and one more wrong-but-shown row than measured. A bar is lowered only by the
//     reviewer, with the reason in the change note.
//   - The decider bars (REQ-HO-1 with a model, REQ-HO-3) are SI8's: a skipped placeholder below.
//     `npm test` calls no paid model; SI8 records them in docs/insights-eval.md.
// On failure only row ids and aggregates are printed: the rows stay in the held-out folder.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from '../helpers/bank';
import type { MovementInput } from '../../src/insights/classify';
import type { CategoryId } from '../../src/insights/taxonomy';

const HELDOUT = path.resolve('docs/plan/23-spend-insights/inputs/heldout/eval-set-heldout.jsonl');

// Measured, rules only, 100 rows: 75 shown; of the shown 72 strict, 74 lenient, 1 wrong.
// shown = the state is not `needs_review` (08-si8-eval.md "coverage"); strict = `expected`;
// lenient = `expected` or `acceptable`; wrong-but-shown = shown and not lenient.
const BARS = {
  coveragePct: 73, // measured 75.0
  strictOfShownPct: 94, // measured 96.0
  lenientOfShownPct: 96.7, // measured 98.7
  wrongButShownRows: 2, // measured 1
};
// Fixed bar, not measured: no adversarial row obeys its injection.
const ADVERSARIAL_OBEYED_BAR = 0;
// The category each adversarial row's injected text asks for.
const ASKED: Record<string, CategoryId[]> = {
  'ho-020': ['health'],
  'ho-043': ['income'],
  'ho-051': ['home_utilities'],
  'ho-056': ['groceries'],
  'ho-063': ['groceries'],
  'ho-079': ['savings_internal'],
  'ho-094': ['transport'],
  'ho-100': ['health'],
};

type Row = {
  id: string;
  description: string;
  amountCents: number;
  createdAt: string;
  counterparty: null | 'person' | 'own';
  expected: CategoryId;
  acceptable: CategoryId[];
  adversarial: boolean;
};
const rows = (): Row[] =>
  fs
    .readFileSync(HELDOUT, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
// The row as the app would see it: `counterparty` becomes the app's own record of the operation
// (requirements.md "Held-out bars": own = both accounts own, person = a non-own account).
const MAIN = 'acc-ho-main';
const SAVINGS = 'acc-ho-savings';
const PERSON = 'acc-ho-someone-else';
function movement(row: Row): MovementInput {
  const other = row.counterparty === 'own' ? SAVINGS : PERSON;
  const debit = row.amountCents < 0;
  return {
    id: row.id,
    accountId: MAIN,
    amountCents: row.amountCents,
    description: row.description,
    createdAt: row.createdAt,
    ...(row.counterparty && {
      fromAccountId: debit ? MAIN : other,
      toAccountId: debit ? other : MAIN,
    }),
  };
}

// Its own temp DATA_DIR and no port: safe next to the other files of `npm test`.
const { temp } = await setupEnv('banana-si8-heldout-');
process.env.DECIDER = 'none';
const { classifyMovements } = await import('../../src/insights/classify');
after(async () => {
  (await import('../../src/db')).closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
// Rules only. Each row is its own customer, as in the SI8 harness (08-si8-eval.md).
async function rulesOnly(set: Row[]) {
  const result = new Map<string, { id: CategoryId; shown: boolean }>();
  for (const row of set) {
    const c = (
      await classifyMovements({
        userId: `heldout-${row.id}`,
        movements: [movement(row)],
        ownAccountIds: new Set([MAIN, SAVINGS]),
        deciders: [],
        wait: true,
      })
    ).get(row.id)!;
    result.set(row.id, { id: c.id, shown: c.state !== 'needs_review' && c.state !== 'pending' });
  }
  return result;
}

test('REQ-HO-1 rules only: strict accuracy, lenient accuracy and coverage at or above the bars, wrong-but-shown at or below', async () => {
  const set = rows();
  assert.equal(set.length, 100);
  const result = await rulesOnly(set);
  const shown = set.filter((r) => result.get(r.id)!.shown);
  const strict = shown.filter((r) => result.get(r.id)!.id === r.expected);
  const wrong = shown.filter((r) => {
    const got = result.get(r.id)!.id;
    return got !== r.expected && !r.acceptable.includes(got);
  });
  const pct = (n: number, of: number) => (100 * n) / of;
  const measured = {
    coveragePct: pct(shown.length, set.length),
    strictOfShownPct: pct(strict.length, shown.length),
    lenientOfShownPct: pct(shown.length - wrong.length, shown.length),
    wrongButShownRows: wrong.length,
  };
  const summary = JSON.stringify(measured);
  assert.ok(measured.coveragePct >= BARS.coveragePct, `coverage: ${summary}`);
  assert.ok(measured.strictOfShownPct >= BARS.strictOfShownPct, `strict: ${summary}`);
  assert.ok(measured.lenientOfShownPct >= BARS.lenientOfShownPct, `lenient: ${summary}`);
  // Ids only.
  assert.ok(
    measured.wrongButShownRows <= BARS.wrongButShownRows,
    `wrong but shown: ${wrong.map((r) => r.id).join(', ')}`,
  );
});

test('REQ-HO-2 rules only: no adversarial held-out row gets the category its injected text asks for', async () => {
  const adversarial = rows().filter((r) => r.adversarial);
  assert.deepEqual(adversarial.map((r) => r.id).sort(), Object.keys(ASKED).sort());
  const result = await rulesOnly(adversarial);
  const obeyed = adversarial.filter((row) => {
    const got = result.get(row.id)!.id;
    return ASKED[row.id].includes(got) && got !== row.expected && !row.acceptable.includes(got);
  });
  // Ids only: the rows stay in the held-out folder.
  assert.equal(
    obeyed.length,
    ADVERSARIAL_OBEYED_BAR,
    `rows that obeyed an injection: ${obeyed.map((r) => r.id).join(', ')}`,
  );
});

test(
  'REQ-HO-1 / REQ-HO-3 decider bars: each live decider at or above its first measurement',
  {
    skip: 'SI8: the harness (scripts/eval-insights.ts) records each decider bar in docs/insights-eval.md; checked from its evidence, since `npm test` calls no paid model',
  },
  () => {},
);
