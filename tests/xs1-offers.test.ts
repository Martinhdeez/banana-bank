// XS1: the offer catalogue and the pure selection (plan 24 §2, §3; REQ-XS-1…5). The table test
// reads the seeded customers of the simulator and of the demo bank through the app's own bank
// view (rules only, DECIDER=none: no model).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
import { OFFER_IDS, auroraWaiver, offers, productFees } from '../src/offers/catalogue';
import type { OfferId } from '../src/offers/catalogue';
import { THRESHOLDS, explainOffers, selectOffer } from '../src/offers/select';
import type { OfferInput } from '../src/offers/select';
import { merchantKey } from '../src/insights/normalize';
import type { CategoryId, RowCategory } from '../src/insights/taxonomy';
import { people } from '../src/people';

// ---- REQ-XS-1, REQ-XS-2: the catalogue ----

const FORBIDDEN =
  /referral|mortgage|travel insurance|foreign|currency|\bloans?\b|credit card|invest|\bfunds?\b|bonus/i;
const notSection = (text: string) => text.slice(text.indexOf('## What it is not'));

test('XS1 catalogue: eight offers, sheets within 900 characters, no excluded topic', () => {
  const all = offers();
  assert.deepEqual(
    all.map((o) => o.id),
    [...OFFER_IDS],
  );
  for (const o of all) {
    assert.ok(o.text.length <= 900, `${o.id}: ${o.text.length} characters`);
    assert.ok(
      o.text.endsWith(
        `Version ${o.version}. Valid from ${o.validFrom}. Demonstration content written by the project team.`,
      ),
      o.id,
    );
    for (const heading of ['## What it is\n', '## Terms\n', '## What it is not\n'])
      assert.ok(o.text.includes(heading), `${o.id}: ${heading}`);
    const outside = [
      o.name,
      o.pitch,
      o.reason,
      o.text.slice(0, o.text.indexOf('## What it is not')),
    ];
    for (const part of outside) assert.doesNotMatch(part, FORBIDDEN, o.id);
    assert.doesNotMatch(o.reason, /\d/, `${o.id}: the reason for the model has no figure`);
  }
  const sheet = (id: OfferId) => all.find((o) => o.id === id)!.text;
  assert.match(notSection(sheet('offer-home-insurance')), /not travel insurance/);
  assert.match(notSection(sheet('offer-salary-plan')), /not a referral reward/);
});

test('XS1 catalogue: every documented number is the one its fee document states', () => {
  const doc = (id: string) => fs.readFileSync(`fixtures/documents/${id}.md`, 'utf8');
  // The documents write `EUR 6`; the sheets write `€6`.
  for (const fee of productFees()) {
    const stated = /monthly fee[^.]*? is EUR (\d+)\./.exec(doc(fee.doc));
    assert.equal(Number(stated?.[1]), fee.euros, fee.doc);
    assert.match(doc(fee.doc), new RegExp(`^# ${fee.product} `), fee.doc);
  }
  const waiver = auroraWaiver();
  const text = doc(waiver.doc);
  assert.ok(text.includes(`at least EUR ${waiver.salaryEuros.toLocaleString('en-US')} and`));
  assert.ok(text.includes(`fully waived (EUR ${waiver.waivedEuros})`));
  assert.ok(text.includes(`${waiver.cardPurchases} settled card purchases`));
  assert.ok(text.includes('A transfer from your own account does not count as a salary payment'));

  const [first, last] = [offers()[0], offers()[7]];
  assert.deepEqual(first.cites, [waiver.doc]);
  for (const figure of ['€6', '€0', '€1,200', `${waiver.cardPurchases} settled card purchases`])
    assert.ok(first.text.includes(figure), figure);
  // Offer 8 lists Cloud and every product whose fee makes the rule hold, and cites their documents.
  const listed = productFees().filter(
    (f) => f.product === 'Cloud' || f.euros >= THRESHOLDS.cloudFeeEuros,
  );
  assert.deepEqual([...last.cites].sort(), listed.map((f) => f.doc).sort());
  for (const f of listed) assert.match(last.text, new RegExp(`- ${f.product} €${f.euros}\\b`));
});

// ---- REQ-XS-3: the seeded customers of both banks ----

const { temp } = await setupEnv('banana-xs1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json', // what `npm run demo` serves
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { bankView } = await import('../src/banking/view');
after(() => {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

// [accounts only, with movements]; null = no offer.
type Expected = Record<string, [OfferId | null, OfferId | null]>;
const SIMULATOR: Expected = {
  lucia: [null, 'offer-aurora-fee-waiver'],
  bruno: ['offer-savings-pot', 'offer-savings-pot'],
  carla: [null, 'offer-aurora-fee-waiver'],
  diego: [null, null],
  elena: [null, 'offer-aurora-fee-waiver'],
  hugo: ['offer-savings-pot', 'offer-savings-pot'],
  ines: [null, 'offer-aurora-fee-waiver'],
  omar: ['offer-savings-pot', 'offer-savings-pot'],
};
const DEMO: Expected = {
  lucia: [null, 'offer-aurora-fee-waiver'],
  bruno: ['offer-savings-pot', 'offer-cashback-card'],
  carla: [null, 'offer-aurora-fee-waiver'],
  diego: [null, null],
  elena: [null, 'offer-aurora-fee-waiver'],
  hugo: ['offer-savings-pot', 'offer-savings-pot'],
  ines: [null, 'offer-aurora-fee-waiver'],
  omar: ['offer-savings-pot', 'offer-cashback-card'],
};

for (const [impl, expected] of [
  ['simulator', SIMULATOR],
  ['alt', DEMO],
] as const)
  test(`XS1 selection: seeded customers of the ${impl === 'alt' ? 'demo bank' : impl}`, async () => {
    if (impl === 'simulator') seedBank();
    seedApp();
    const bank = await startSimulator(impl);
    try {
      if (impl === 'simulator') setScenario('normal');
      const measured: Expected = {};
      for (const { id } of people.filter((p) => p.role === 'customer')) {
        const view = await bankView(id);
        const accounts = view.accounts as OfferInput['accounts'];
        const inputs: OfferInput[] = [
          { accounts, view: null, exclude: [] },
          { accounts, view, exclude: [] },
        ];
        const [bare, read] = inputs.map(selectOffer);
        assert.deepEqual(inputs.map(selectOffer), [bare, read], 'same input, same output');
        measured[id] = [bare?.id ?? null, read?.id ?? null];
        // XS1_TABLE=1 prints the measured table (the change note holds a copy).
        if (process.env.XS1_TABLE)
          console.log(
            `${impl === 'alt' ? 'demo' : 'simulator'} | ${id} | ${accounts.map((a) => `${a.label} €${a.balanceCents / 100}`).join(', ')}` +
              `\n  accounts only: ${bare?.id ?? '-'}${bare ? ` | ${bare.basis}` : ''}` +
              `\n  with movements (${view.movements.length}): ${read?.id ?? '-'}${read ? ` | ${read.basis}` : ''}\n` +
              explainOffers(inputs[1])
                .map((o) => `    ${o.eligible ? 'yes' : 'no '} ${o.id}: ${o.why}`)
                .join('\n'),
          );
        // An Aurora holder with a salary gets offer 1 and is never eligible for the salary plan.
        if (accounts.some((a) => /aurora/i.test(a.label)))
          assert.equal(eligible(inputs[1], 'offer-salary-plan'), false);
      }
      assert.deepEqual(measured, expected);
    } finally {
      bank.kill();
    }
  });

// ---- REQ-XS-4, REQ-XS-5: boundaries, on made-up data ----

type Row = {
  day: string; // 2026-09-05
  euros: number; // negative: a debit
  text: string;
  cat: CategoryId;
  over?: Partial<RowCategory>;
  operationId?: string;
};
const account = (label: string, euros: number) => ({
  id: `acc-${label}`,
  label,
  balanceCents: Math.round(euros * 100),
});
const HORIZON = [account('Horizon account', 1000)];
const AURORA = [account('Aurora account', 1000)];
const WITH_SAVINGS = [account('Horizon account', 1000), account('Personal savings', 10)];
function input(accounts: OfferInput['accounts'], rows: Row[] | null, exclude: OfferId[] = []) {
  const movements = (rows ?? []).map((r, n) => ({
    id: `m${n}`,
    accountId: accounts[0].id,
    amountCents: Math.round(r.euros * 100),
    description: r.text,
    createdAt: `${r.day}T10:00:00.000Z`,
    operationId: r.operationId ?? null,
  }));
  const categories = new Map<string, RowCategory>(
    (rows ?? []).map((r, n) => [
      `m${n}`,
      {
        id: r.cat,
        state: 'estimated',
        source: 'rule',
        reason: 'test',
        confidence: null,
        threshold: null,
        candidates: [],
        merchantKey: merchantKey(r.text),
        model: null,
        ...r.over,
      },
    ]),
  );
  return { accounts, view: rows && { movements, categories }, exclude } satisfies OfferInput;
}
const eligible = (i: OfferInput, id: OfferId) =>
  explainOffers(i).find((o) => o.id === id)!.eligible;
const row = (day: string, euros: number, text: string, cat: CategoryId, rest = {}): Row => ({
  day,
  euros,
  text,
  cat,
  ...rest,
});
// A payment on 1 Sep and again `days` later.
const twice = (text: string, euros: number, cat: CategoryId, days = 25, second = euros) => [
  row('2026-09-01', euros, text, cat),
  row(`2026-09-${String(1 + days).padStart(2, '0')}`, second, text, cat),
];
const many = (n: number, euros: number, text: string, cat: CategoryId) =>
  Array.from({ length: n }, (_, k) =>
    row(`2026-09-${String(k + 1).padStart(2, '0')}`, euros, text, cat),
  );
const salary = (day: string, euros: number, rest = {}) =>
  row(day, euros, 'NOMINA ACME', 'income', rest);
const MODEL = { over: { source: 'model' } } as const;
const REVIEW = { over: { state: 'needs_review' } } as const;

// One line per threshold: the input that holds and its neighbour one step below.
const BOUNDARIES: [name: string, id: OfferId, holds: OfferInput, fails: OfferInput][] = [
  [
    'salary of €1,200 in an Aurora account',
    'offer-aurora-fee-waiver',
    input(AURORA, [salary('2026-09-28', 1200)]),
    input(AURORA, [salary('2026-09-28', 1199.99)]),
  ],
  [
    'salary of €600 in each month',
    'offer-salary-plan',
    input(HORIZON, [salary('2026-08-28', 600), salary('2026-09-28', 600)]),
    input(HORIZON, [salary('2026-08-28', 599.99), salary('2026-09-28', 600)]),
  ],
  [
    'salary in two calendar months',
    'offer-salary-plan',
    input(HORIZON, [salary('2026-08-28', 900), salary('2026-09-02', 900)]),
    input(HORIZON, [salary('2026-09-02', 900), salary('2026-09-28', 900)]),
  ],
  [
    '€3,000 in the main accounts',
    'offer-savings-pot',
    input([account('Horizon account', 3000)], null),
    input([account('Horizon account', 2999.99)], null),
  ],
  [
    '€300 of Home & utilities',
    'offer-home-insurance',
    input(HORIZON, twice('RECIBO ALQUILER', -150, 'home_utilities')),
    input(HORIZON, twice('RECIBO ALQUILER', -150, 'home_utilities', 25, -149.99)),
  ],
  [
    'a housing payment that repeats 25 days apart',
    'offer-home-insurance',
    input(HORIZON, twice('RECIBO ALQUILER', -200, 'home_utilities', 25)),
    input(HORIZON, twice('RECIBO ALQUILER', -200, 'home_utilities', 24)),
  ],
  [
    'three merchants that repeat',
    'offer-bills-watch',
    input(
      HORIZON,
      ['SPOTIFY', 'NETFLIX', 'DIGI'].flatMap((m) => twice(m, -10, 'other')),
    ),
    input(
      HORIZON,
      ['SPOTIFY', 'NETFLIX'].flatMap((m) => twice(m, -10, 'other')),
    ),
  ],
  [
    'a repeat within 5% of the amount',
    'offer-bills-watch',
    input(HORIZON, [
      ...['SPOTIFY', 'NETFLIX'].flatMap((m) => twice(m, -10, 'other')),
      ...twice('DIGI', -100, 'other', 25, -95),
    ]),
    input(HORIZON, [
      ...['SPOTIFY', 'NETFLIX'].flatMap((m) => twice(m, -10, 'other')),
      ...twice('DIGI', -100, 'other', 25, -94.99),
    ]),
  ],
  [
    '€75 of Eating out & leisure',
    'offer-cashback-card',
    input(HORIZON, [
      ...many(4, -15, 'BAR', 'eating_out_leisure'),
      row('2026-09-09', -15, 'BAR', 'eating_out_leisure'),
    ]),
    input(HORIZON, [
      ...many(4, -15, 'BAR', 'eating_out_leisure'),
      row('2026-09-09', -14.99, 'BAR', 'eating_out_leisure'),
    ]),
  ],
  [
    'five Eating out & leisure payments',
    'offer-cashback-card',
    input(HORIZON, many(5, -30, 'BAR', 'eating_out_leisure')),
    input(HORIZON, many(4, -30, 'BAR', 'eating_out_leisure')),
  ],
  [
    'twelve payments under €50',
    'offer-round-ups',
    input(WITH_SAVINGS, many(12, -49.99, 'SHOP', 'other')),
    input(WITH_SAVINGS, [
      ...many(11, -49.99, 'SHOP', 'other'),
      row('2026-09-20', -50, 'SHOP', 'other'),
    ]),
  ],
  [
    'a documented fee of €3',
    'offer-cloud-account',
    input(HORIZON, null),
    input([account('Community account', 1000)], null),
  ],
  [
    'Aurora without a salary of €1,200',
    'offer-cloud-account',
    input(AURORA, [salary('2026-09-28', 1199.99)]),
    input(AURORA, [salary('2026-09-28', 1200)]),
  ],
  // Review of #114: a large credit nobody decided may be the salary, so "your fee is €6" is not said.
  [
    'Aurora whose large credit is decided as not income',
    'offer-cloud-account',
    input(AURORA, [row('2026-08-01', 3000, 'Initial deposit', 'other')]),
    input(AURORA, [salary('2026-09-28', 2000, MODEL)]),
  ],
  // D5: a row a model estimated, or one in review, never counts.
  [
    'income decided by a rule, not a model',
    'offer-aurora-fee-waiver',
    input(AURORA, [salary('2026-09-28', 2000, { over: { source: 'user', state: 'confirmed' } })]),
    input(AURORA, [salary('2026-09-28', 2000, MODEL)]),
  ],
  [
    'housing decided by a rule, not in review',
    'offer-home-insurance',
    input(HORIZON, twice('RECIBO ALQUILER', -500, 'home_utilities')),
    input(
      HORIZON,
      twice('RECIBO ALQUILER', -500, 'home_utilities').map((r) => ({ ...r, ...REVIEW })),
    ),
  ],
  [
    'leisure decided by a rule, not a model',
    'offer-cashback-card',
    input(HORIZON, many(6, -30, 'BAR', 'eating_out_leisure')),
    input(
      HORIZON,
      many(6, -30, 'BAR', 'eating_out_leisure').map((r) => ({ ...r, ...MODEL })),
    ),
  ],
  // A debit sent through the app, or to a person, is not a payment.
  [
    'payments that are not transfers',
    'offer-round-ups',
    input(WITH_SAVINGS, many(12, -5, 'SHOP', 'other')),
    input(WITH_SAVINGS, many(12, -5, 'SHOP', 'transfer_person')),
  ],
];
for (const [name, id, holds, fails] of BOUNDARIES)
  test(`XS1 boundary: ${id} needs ${name}`, () => {
    assert.equal(eligible(holds, id), true, 'at the threshold');
    assert.equal(eligible(fails, id), false, 'one step below');
  });

test('XS1 selection: under €500 in the main accounts, or no account, nobody is offered anything', () => {
  const savings = account('Personal savings', 9000);
  assert.equal(
    selectOffer(input([account('Horizon account', 500), savings], null))?.id,
    'offer-cloud-account',
  );
  assert.equal(selectOffer(input([account('Horizon account', 499.99), savings], null)), null);
  assert.equal(selectOffer({ accounts: [], view: null, exclude: [] }), null);
});

test('XS1 selection: without movements only the two account offers; excluded and held never', () => {
  const portfolios = [
    [account('Horizon account', 5000)],
    [account('Aurora account', 5000)],
    [account('Aurora account', 5000), account('Personal savings', 100)],
    [account('Travel account', 5000), account('Family account', 10)],
    [account('Horizon account', 5000), account('Cloud account', 10)],
  ];
  for (const accounts of portfolios) {
    // Offer after offer, each one excluded once shown, until nothing is left.
    const exclude: OfferId[] = [];
    for (
      let o = selectOffer(input(accounts, null));
      o;
      o = selectOffer(input(accounts, null, exclude))
    ) {
      assert.ok(!exclude.includes(o.id), 'an excluded offer came back');
      exclude.push(o.id);
    }
    const aurora = accounts[0].label.startsWith('Aurora');
    const savings = accounts.some((a) => /saving/i.test(a.label));
    const cloud = accounts.some((a) => a.label.startsWith('Cloud'));
    assert.deepEqual(exclude, [
      ...(savings ? [] : ['offer-savings-pot']),
      ...(aurora || cloud ? [] : ['offer-cloud-account']),
    ]);
  }
  // With everything a customer could want and every offer but one excluded, that one is chosen.
  const rich = input(WITH_SAVINGS, [
    salary('2026-08-28', 900),
    salary('2026-09-28', 900),
    ...['SPOTIFY', 'NETFLIX', 'DIGI'].flatMap((m) => twice(m, -10, 'other')),
    ...many(12, -5, 'SHOP', 'other'),
  ]);
  assert.equal(selectOffer(rich)?.id, 'offer-salary-plan');
  assert.equal(
    selectOffer({ ...rich, exclude: ['offer-salary-plan', 'offer-bills-watch'] })?.id,
    'offer-round-ups',
  );
  assert.equal(selectOffer({ ...rich, exclude: [...OFFER_IDS] }), null);
});
