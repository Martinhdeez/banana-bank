// IT5 (round 7; audit A3, A6, A15, A22): a description with no merchant left groups under its
// channel words and can take a customer rule, but is never sent to a decider; a transfer row is
// set alone and never makes a rule; review groups are per merchant key and sign; what a decider
// is sent keeps no card mask, reference or long digit run. No bank, no network, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';
import type { CategoryId, MovementInput } from '../src/insights/taxonomy';
import type { Decider, DecisionItem } from '../src/insights/decider';
const { temp } = await setupEnv('banana-it5-');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { userRules } = await import('../src/insights/store');
const { decisionState } = await import('../src/insights/decider');
const { classifyMovements } = await import('../src/insights/classify');
const { applyRules } = await import('../src/insights/rules');
const normalize = await import('../src/insights/normalize');
const { cleanDescription, merchantKey } = normalize;
const { setCategory, spendingSummary, uiAudit } = await import('../src/insights/summary');
seedApp();
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const OWN = new Set(['acc-a', 'acc-a-savings']);
const accounts = [...OWN].map((id) => ({ id }));
let seq = 0;
const mv = (description: string, over: Partial<MovementInput> = {}): MovementInput => ({
  id: `it5-${++seq}`,
  accountId: 'acc-a',
  amountCents: -1250,
  description,
  createdAt: '2026-09-16T10:00:00.000Z',
  ...over,
});
// A decider that is never sure: whatever reaches it goes to review, and is recorded.
function unsure() {
  const calls: DecisionItem[] = [];
  const decider: Decider = {
    id: 'systemone',
    threshold: 0.8,
    classify: async (item) => {
      calls.push(item);
      return { candidates: [{ category: 'shopping', p: 0.4 }], confidence: 0.4, model: 'fake-1' };
    },
  };
  return { decider, calls };
}
const view = async (userId: string, movements: MovementInput[], deciders: Decider[] = []) => ({
  accounts,
  movements,
  categories: await classifyMovements({
    userId,
    movements,
    ownAccountIds: OWN,
    deciders,
    wait: true,
  }),
});
const set = (
  userId: string,
  v: Awaited<ReturnType<typeof view>>,
  movementIds: string[],
  category: CategoryId,
) => setCategory(userId, v, { movementIds, category, applyToSimilar: true }, uiAudit(userId));

const GENERIC: [string, string][] = [
  ['Card payment 12', 'CARD PAYMENT'],
  ['CARD PAYMENT 7', 'CARD PAYMENT'],
  ['Purchase 1234', 'PURCHASE'],
  ['TPV 0041', 'TPV'],
  ['Recibo 2291', 'RECIBO'],
  ['Adeudo recibo 000123', 'ADEUDO RECIBO'],
  ['PAGO CON TARJETA XXXX XXXX XXXX 1234', 'PAGO CON TARJETA'],
  ['COMPRA TARJ. 4532XXXX 0098231 ES', 'COMPRA TARJ'],
];

test('IT5 A3: with no merchant left the key is the channel words, and says it is generic', () => {
  for (const [raw, key] of GENERIC) {
    assert.equal(merchantKey(raw), key, raw);
    assert.equal(normalize.genericKey(key), true, key);
    assert.match(key, /^[A-Z0-9& ]{1,40}$/);
  }
  // A channel in front of a real merchant is still stripped; a merchant is never generic.
  assert.equal(merchantKey('Card payment MERCADONA 0412'), 'MERCADONA');
  assert.equal(
    merchantKey('PAGO CON TARJETA XXXX XXXX XXXX 1234 BAR LA ESQUINA'),
    'BAR LA ESQUINA',
  );
  for (const key of ['MERCADONA', 'CARD PAYMENT SERVICES', 'RECIBOS', ''])
    assert.equal(normalize.genericKey(key), false, key);
  // No channel and no letter: still the empty key. A processor with an unreadable payee too: the
  // key `PAYPAL` would put every such payee under one rule.
  for (const raw of ['1234567', '27/09 03:41', '', 'PAYPAL *JGARCIA88', 'SUMUP *0041'])
    assert.equal(merchantKey(raw), '', raw);
});

test('IT5 A3: a generic key matches no global rule and is never sent to a decider', async () => {
  const empty = {
    ownAccountIds: OWN,
    ownPairOperationIds: new Set<string>(),
    userRules: new Map(),
  };
  for (const [raw] of GENERIC) assert.equal(applyRules(mv(raw), empty), null, raw);

  const { decider, calls } = unsure();
  const rows = [1, 2, 3, 4, 5].map((n) => mv(`Card payment ${n}`, { amountCents: -100 * n }));
  const v = await view('lucia', [...rows, mv('ZZQXV ALPHA')], [decider]);
  assert.deepEqual(
    calls.map((c) => c.description),
    ['ZZQXV ALPHA'],
    'only the real unknown merchant is sent',
  );
  for (const m of rows) {
    const c = v.categories.get(m.id)!;
    assert.deepEqual(
      [c.merchantKey, c.id, c.state, c.source, c.reason],
      ['CARD PAYMENT', 'other', 'needs_review', 'none', 'no_merchant'],
    );
  }
  // One review group for all of them, not one per movement.
  const groups = spendingSummary(v, {}, 'systemone').unresolved.groups;
  const group = groups.find((g) => g.merchantKey === 'CARD PAYMENT')!;
  assert.deepEqual([groups.length, group.count, group.totalCents], [2, 5, 1500]);
  assert.deepEqual([...group.movementIds].sort(), rows.map((m) => m.id).sort());
});

test('IT5 A3: the group is reviewed once and takes a customer rule', async () => {
  const rows = [1, 2, 3].map((n) => mv(`Card payment ${n}`));
  const v = await view('bruno', rows);
  const result = set('bruno', v, [rows[0].id], 'shopping');
  assert.equal(result.updated, 3);
  assert.deepEqual(result.rules, ['CARD PAYMENT']);
  assert.deepEqual(
    result.similar.map((s) => [s.merchantKey, s.count]),
    [['CARD PAYMENT', 2]],
  );
  const later = mv('Card payment 99');
  const c = (await view('bruno', [...rows, later])).categories.get(later.id)!;
  assert.deepEqual(
    [c.id, c.state, c.source, c.reason],
    ['shopping', 'confirmed', 'user_rule', 'user_rule:CARD PAYMENT'],
  );
});

test('IT5 A6: a transfer row is set alone — no similar entry, no rule', async () => {
  const user = 'carla';
  const toPerson = { fromAccountId: 'acc-a', toAccountId: 'acc-z', concept: 'alquiler piso' };
  const rows = [
    mv('Transfer · alquiler piso', toPerson), // the app's record of a transfer to a person
    mv('Transfer · alquiler piso', toPerson),
    mv('To acc-z: alquiler piso'), // the bank's transfer wording, no record
    mv('From acc-z: alquiler piso', { amountCents: 40000 }), // the sender's concept, a credit
    mv('BIZUM ENVIADO A MARIA LOPEZ'), // person wording
    mv('Opening balance', { amountCents: 100000 }),
  ];
  const v = await view(user, rows);
  for (const [m, category] of [
    [rows[0], 'home_utilities'],
    [rows[2], 'home_utilities'],
    [rows[3], 'other'],
    [rows[4], 'eating_out_leisure'],
    [rows[5], 'income'],
  ] as const) {
    const result = set(user, v, [m.id], category);
    assert.deepEqual(result, { updated: 1, similar: [], rules: [] }, m.description);
  }
  assert.equal(userRules(user).size, 0, 'no rule keyed by a concept');
  // The hand-set category holds for that movement; the next transfer with that concept is a
  // person transfer, as the contract says.
  const next = mv('Transfer · alquiler piso', toPerson);
  const again = (await view(user, [...rows, next])).categories;
  assert.deepEqual(
    [again.get(rows[0].id)!.id, again.get(rows[0].id)!.source],
    ['home_utilities', 'user'],
  );
  assert.deepEqual(
    [again.get(rows[1].id)!.id, again.get(next.id)!.id],
    ['transfer_person', 'transfer_person'],
  );
});

test('IT5 A6: a merchant’s rule does not sweep in a transfer whose concept names it', async () => {
  const user = 'diego';
  const rows = [
    mv('ZZQXV BETA'),
    mv('ZZQXV BETA'),
    mv('Transfer · ZZQXV BETA', { fromAccountId: 'acc-a', toAccountId: 'acc-z' }),
  ];
  const v = await view(user, rows);
  const result = set(user, v, [rows[0].id], 'groceries');
  assert.deepEqual(result.similar, [
    { merchantKey: 'ZZQXV BETA', count: 1, movementIds: [rows[1].id] },
  ]);
  assert.deepEqual([result.updated, result.rules], [2, ['ZZQXV BETA']]);
  const again = (await view(user, rows)).categories;
  assert.equal(again.get(rows[2].id)!.id, 'transfer_person');
  // Chosen together with a merchant row, the transfer is set by hand and adds nothing to the rule.
  const both = set(user, await view(user, rows), [rows[0].id, rows[2].id], 'shopping');
  assert.deepEqual(
    both.similar.map((s) => [s.merchantKey, s.count]),
    [['ZZQXV BETA', 1]],
  );
});

test('IT5 A15: a merchant with a debit and a credit in review is one group per sign', async () => {
  const { decider } = unsure();
  const rows = [
    mv('ZZQXV GAMMA', { amountCents: -500 }),
    mv('ZZQXV GAMMA', { amountCents: -700 }),
    mv('ZZQXV GAMMA', { amountCents: 300 }),
  ];
  const v = await view('elena', rows, [decider]);
  const groups = spendingSummary(v, {}, 'systemone').unresolved.groups;
  assert.deepEqual(
    groups.map((g) => [g.merchantKey, g.count, g.totalCents, g.movementIds.length]),
    [
      ['ZZQXV GAMMA', 2, 1200, 2],
      ['ZZQXV GAMMA', 1, 300, 1],
    ],
  );
  // Each group can be set whole: no category the sign rule refuses for part of it.
  assert.equal(set('elena', v, groups[0].movementIds, 'transfer_person').updated, 2);
});

const MASK = /X{4,}|\*|\b\d{4,}\b/; // a card mask, its last four digits, a run of 4+ digits
test('IT5 A22: the cleaned description keeps no card mask, reference or long digit run', () => {
  for (const [raw, clean] of [
    ['AMZN MKTP ES 7HH21MM04', 'AMZN MKTP ES'],
    ['TRANSFERENCIA 000123', 'TRANSFERENCIA'],
    ['FARMACIA LOPEZ ****1234', 'FARMACIA LOPEZ'],
    ['FARMACIA LOPEZ **** 0098', 'FARMACIA LOPEZ'],
    ['PAGO CON TARJETA XXXX XXXX XXXX 1234 BAR LA ESQUINA', 'PAGO CON TARJETA BAR LA ESQUINA'],
    ['PAGO CON TARJETA XXXX-XXXX-XXXX-1234 BAR LA ESQUINA', 'PAGO CON TARJETA BAR LA ESQUINA'],
    [
      'COMPRA TARJ. 4532XXXXXXXX0098 MERCADONA 0412 VALENCIA ES',
      'COMPRA TARJ MERCADONA VALENCIA ES',
    ],
    ['COMPRA EN DIA % S.A. 08-09 TARJ *7781', 'COMPRA EN DIA S A TARJ'], // IT7: nor the date
    ['PAYPAL *SPOTIFY 35314369001', 'PAYPAL SPOTIFY'],
    ['ADEUDO SEPA B12345678 REF 2026090001', 'ADEUDO SEPA REF'],
    ['100 MONTADITOS 0456 SEVILLA', '100 MONTADITOS SEVILLA'], // a short number is a name
    ['FARMACIA 24H GRAN VIA', 'FARMACIA 24H GRAN VIA'],
  ])
    assert.equal(cleanDescription(raw), clean, raw);
});

test('IT5 A22: no dev-set row would send a card mask or a run of 6+ digits', () => {
  const rows = fs
    .readFileSync('docs/plan/23-spend-insights/inputs/eval-set-dev.jsonl', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; description: string });
  assert.ok(rows.length > 100);
  for (const { id, description } of rows) {
    const clean = cleanDescription(description);
    assert.doesNotMatch(clean, MASK, `${id}: ${clean}`);
    assert.doesNotMatch(clean, /\d{6,}/, `${id}: ${clean}`);
    assert.match(clean, /^[A-Z0-9& ]{0,80}$/);
  }
});

test('IT5 A22: the decider input keeps its shape — four item fields, six state fields', async () => {
  const { decider, calls } = unsure();
  await view('lucia', [mv('ZZQXV DELTA 7HH21MM04 REF 000123 ****1234')], [decider]);
  const [item] = calls;
  assert.deepEqual(Object.keys(item).sort(), ['description', 'direction', 'key', 'profile']);
  assert.equal(item.description, 'ZZQXV DELTA REF');
  assert.deepEqual(Object.keys(decisionState(item)).sort(), [
    'description',
    'direction',
    'occurrences',
    'typical_amount',
    'typical_day',
    'typical_time',
  ]);
});
