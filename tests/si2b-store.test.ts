// SI2b: migrations 7–8 and the store of movement categories and per-customer category rules.
// No bank is needed: the store only talks to app.sqlite.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setupEnv } from './helpers/bank';
import { CATEGORY_IDS, type MovementInput } from '../src/insights/taxonomy';
const { temp } = await setupEnv('banana-si2b-');
const db = await import('../src/db');
const { appDb, closeAppDb } = db;
const store = await import('../src/insights/store');
const { seedApp } = await import('../src/seed');
type StoredCategory = import('../src/insights/store').StoredCategory;
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const movement = (id: string, over: Partial<MovementInput> = {}): MovementInput => ({
  id,
  accountId: 'acc-lucia',
  amountCents: -1250,
  description: 'MERCADONA 0412 VALENCIA',
  createdAt: '2026-09-20T10:00:00.000Z',
  ...over,
});
const row = (m: MovementInput, over: Partial<StoredCategory> = {}): StoredCategory => ({
  movementId: m.id,
  fingerprint: store.fingerprint(m),
  id: 'groceries',
  state: 'estimated',
  source: 'rule',
  reason: 'keyword:MERCADONA',
  confidence: null,
  threshold: null,
  candidates: [],
  merchantKey: 'MERCADONA',
  model: null,
  updatedAt: '2026-09-20T10:00:01.000Z',
  ...over,
});
const count = (table: string) =>
  appDb().prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
const applied = () =>
  (
    appDb().prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() as {
      version: number;
      name: string;
    }[]
  ).map((r) => `${r.version} ${r.name}`);
function wipeFiles() {
  closeAppDb();
  for (const f of fs.readdirSync(temp))
    if (f.startsWith('app.sqlite')) fs.rmSync(path.join(temp, f));
}

test('SI2b a fresh database has both tables and the index, as versions 7 and 8', () => {
  assert.deepEqual(applied().slice(6, 8), ['7 si2-movement-categories', '8 si2-category-rules']);
  const names = appDb()
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%categor%' ORDER BY name")
    .pluck()
    .all();
  assert.deepEqual(names, [
    'category_rules',
    'movement_categories',
    'movement_categories_merchant',
  ]);
  const columns = (table: string) =>
    (appDb().pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).join(',');
  assert.equal(
    columns('movement_categories'),
    'user_id,movement_id,fingerprint,merchant_key,category,state,source,reason,confidence,threshold,candidates,model,updated_at',
  );
  assert.equal(columns('category_rules'), 'user_id,merchant_key,category,created_at');
});

test('SI2b a database at version 6 migrates in place and keeps its data', () => {
  wipeFiles();
  // What the code before SI2b leaves on disk: migrations 1–6 applied and recorded.
  const old = new Database(path.join(temp, 'app.sqlite'));
  old.exec(
    'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
  );
  db.migrations.slice(0, 6).forEach((m, i) => {
    m.up(old);
    old.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(i + 1, m.name, 'then');
  });
  old.exec(`
    INSERT INTO conversations VALUES('c1','lucia','T','2026-09-01T00:00:00.000Z');
    INSERT INTO messages VALUES('m1','c1','user','hi','2026-09-01T00:00:01.000Z',NULL);
    INSERT INTO favourite_recipients VALUES('lucia','acc-bruno','2026-09-01T00:00:02.000Z');
    INSERT INTO notification_reads VALUES('lucia','n1','2026-09-01T00:00:03.000Z');`);
  const before = old
    .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  old.close();
  assert.equal(applied().length, db.SCHEMA_VERSION);
  assert.deepEqual(applied().slice(6, 8), ['7 si2-movement-categories', '8 si2-category-rules']);
  assert.equal(
    appDb().prepare('SELECT applied_at FROM schema_migrations WHERE version=6').pluck().get(),
    'then',
    'applied migrations are not run again',
  );
  for (const t of ['conversations', 'messages', 'favourite_recipients', 'notification_reads'])
    assert.equal(count(t), 1, t);
  // No existing table or index changed: only the three new objects were added (and SI6a's table,
  // and IT4's table and index).
  const added = [
    'category_rules',
    'movement_categories',
    'movement_categories_merchant',
    'message_extras',
    'decider_asks',
    'decider_asks_user',
    'prepared_transfers', // PT1: migration 11
    'prepared_transfers_user',
    'ai_usage', // TR1: migration 12
    'ai_usage_user',
    'ai_usage_run',
    'goals', // GL1: migration 13
    'forecast_adjustments', // FC2
    'forecast_adjustments_user',
  ];
  const now = appDb()
    .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(
    now.filter((o) => !added.includes(o.name)),
    before,
  );
  assert.equal(store.saveCategories('lucia', [row(movement('mv-up'))]), 1);
});

test('SI2b fingerprint is sha256 of account, amount, date and description', () => {
  const m = movement('mv-1');
  assert.match(store.fingerprint(m), /^[0-9a-f]{64}$/);
  assert.equal(store.fingerprint(m), store.fingerprint({ ...m, id: 'other-id', concept: 'x' }));
  for (const change of [
    { accountId: 'acc-lucia-savings' },
    { amountCents: -1251 },
    { createdAt: '2026-09-20T10:00:00.001Z' },
    { description: 'MERCADONA 0412 VALENCIA ES' },
  ])
    assert.notEqual(store.fingerprint(m), store.fingerprint({ ...m, ...change }));
});

test('SI2b every field makes the round trip', () => {
  const rule = movement('mv-rt-rule');
  const model = movement('mv-rt-model', { description: 'ZZQXV ALPHA' });
  const rows = [
    row(rule, {
      id: 'transfer_person',
      reason: 'person_transfer',
      candidates: [{ category: 'eating_out_leisure', p: null }],
      merchantKey: '',
    }),
    row(model, {
      id: 'shopping',
      source: 'model',
      reason: 'model:late_night,weekend',
      confidence: 0.83,
      threshold: 0.7,
      candidates: [
        { category: 'shopping', p: 0.83 },
        { category: 'other', p: 0.1 },
        { category: 'health', p: 0.07 },
      ],
      merchantKey: 'ZZQXV ALPHA',
      model: 'systemone:jev-1.13.0',
    }),
  ];
  assert.equal(store.saveCategories('lucia', rows), 2);
  const got = store.storedCategories('lucia', [rule, model, movement('mv-rt-absent')]);
  assert.deepEqual([...got.keys()].sort(), ['mv-rt-model', 'mv-rt-rule']);
  assert.deepEqual(got.get('mv-rt-rule'), rows[0]);
  assert.deepEqual(got.get('mv-rt-model'), rows[1]);
  assert.equal(store.storedCategories('lucia', []).size, 0);
});

test('SI2b a confirmed row is kept against rule and model, and replaced by the customer', () => {
  const m = movement('mv-confirmed');
  const confirmed = row(m, { id: 'health', state: 'confirmed', source: 'user', reason: 'user' });
  store.saveCategories('lucia', [confirmed]);
  const read = () => store.storedCategories('lucia', [m]).get(m.id);
  assert.equal(store.saveCategories('lucia', [row(m)]), 0);
  assert.equal(store.saveCategories('lucia', [row(m, { source: 'model', reason: 'model' })]), 0);
  assert.deepEqual(read(), confirmed);
  const corrected = row(m, { id: 'shopping', state: 'confirmed', source: 'user', reason: 'user' });
  assert.equal(store.saveCategories('lucia', [corrected]), 1);
  assert.deepEqual(read(), corrected);
  const byRule = row(m, {
    id: 'transport',
    state: 'confirmed',
    source: 'user_rule',
    reason: 'user_rule:MERCADONA',
  });
  assert.equal(store.saveCategories('lucia', [byRule]), 1);
  assert.deepEqual(read(), byRule);
  // A row that is not confirmed is replaced by any source.
  const estimated = movement('mv-estimated');
  store.saveCategories('lucia', [row(estimated)]);
  assert.equal(store.saveCategories('lucia', [row(estimated, { id: 'other' })]), 1);
  assert.equal(store.storedCategories('lucia', [estimated]).get(estimated.id)?.id, 'other');
});

test('SI2b a changed fingerprint hides the old row; the next save replaces it', () => {
  const m = movement('movement-lucia-1');
  store.saveCategories('lucia', [
    row(m, { id: 'health', state: 'confirmed', source: 'user', reason: 'user' }),
  ]);
  // A reset bank reuses the id for another movement.
  const reused = { ...m, description: 'REPSOL A7 KM 312', amountCents: -4000 };
  assert.equal(store.storedCategories('lucia', [reused]).size, 0);
  const next = row(reused, { id: 'transport', reason: 'keyword:REPSOL', merchantKey: 'REPSOL' });
  assert.equal(store.saveCategories('lucia', [next]), 1, 'confirmed, but for other content');
  assert.deepEqual(store.storedCategories('lucia', [reused]).get(m.id), next);
  assert.equal(store.storedCategories('lucia', [m]).size, 0);
});

test('SI2b rows are per customer', () => {
  const m = movement('mv-shared-id');
  store.saveCategories('lucia', [row(m)]);
  assert.equal(store.storedCategories('bruno', [m]).size, 0);
  store.saveCategories('bruno', [row(m, { id: 'other' })]);
  assert.equal(store.storedCategories('lucia', [m]).get(m.id)?.id, 'groceries');
  assert.equal(store.storedCategories('bruno', [m]).get(m.id)?.id, 'other');
  assert.equal(store.deleteCategories('bruno', [m.id, 'mv-none']), 1);
  assert.equal(store.storedCategories('lucia', [m]).size, 1);
  assert.equal(store.deleteCategories('bruno', [m.id]), 0);
});

test('SI2b one failing row rolls the whole batch back', () => {
  const ok = movement('mv-batch-ok');
  const bad = movement('mv-batch-bad');
  // `pending` exists only in responses; the table refuses it.
  assert.throws(() => store.saveCategories('lucia', [row(ok), row(bad, { state: 'pending' })]));
  assert.equal(store.storedCategories('lucia', [ok, bad]).size, 0);
});

test('SI2b the tables refuse values outside the contract and accept every category id', () => {
  const insertRow = appDb().prepare(
    "INSERT INTO movement_categories VALUES('zoe',?,'f','K',?,?,?,'r',NULL,NULL,'[]',NULL,'t')",
  );
  CATEGORY_IDS.forEach((id, i) => insertRow.run(`mv-check-${i}`, id, 'estimated', 'rule'));
  assert.throws(() => insertRow.run('mv-x', 'pets', 'estimated', 'rule'), /CHECK/);
  assert.throws(() => insertRow.run('mv-x', 'other', 'pending', 'rule'), /CHECK/);
  assert.throws(() => insertRow.run('mv-x', 'other', 'estimated', 'guess'), /CHECK/);
  const insertRule = appDb().prepare("INSERT INTO category_rules VALUES('zoe',?,?,'t')");
  CATEGORY_IDS.forEach((id, i) => insertRule.run(`KEY ${i}`, id));
  assert.throws(() => insertRule.run('KEY X', 'pets'), /CHECK/);
  assert.throws(() => insertRule.run('', 'other'), /CHECK/);
  assert.throws(() => insertRule.run('KEY 0', 'other'), /UNIQUE|PRIMARY/);
});

test('SI2b rules: set, replace, list newest first, remove, empty key throws', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  assert.equal(store.userRules('lucia').size, 0);
  store.setUserRule('lucia', 'MERCADONA', 'groceries');
  await tick();
  store.setUserRule('lucia', 'LA ESQUINA', 'eating_out_leisure');
  await tick();
  store.setUserRule('bruno', 'MERCADONA', 'shopping');
  assert.deepEqual(
    store.listRules('lucia').map((r) => `${r.merchantKey}=${r.category}`),
    ['LA ESQUINA=eating_out_leisure', 'MERCADONA=groceries'],
  );
  assert.match(store.listRules('lucia')[0].createdAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  await tick();
  store.setUserRule('lucia', 'MERCADONA', 'shopping');
  assert.deepEqual(
    store.listRules('lucia').map((r) => `${r.merchantKey}=${r.category}`),
    ['MERCADONA=shopping', 'LA ESQUINA=eating_out_leisure'],
  );
  assert.deepEqual(
    [...store.userRules('lucia')],
    [
      ['MERCADONA', 'shopping'],
      ['LA ESQUINA', 'eating_out_leisure'],
    ],
  );
  assert.equal(store.userRules('bruno').get('MERCADONA'), 'shopping');
  assert.throws(() => store.setUserRule('lucia', '', 'other'), /merchant key/);
  assert.equal(store.removeUserRule('lucia', 'UNKNOWN'), false);
  assert.equal(store.removeUserRule('lucia', 'MERCADONA'), true);
  assert.equal(store.removeUserRule('lucia', 'MERCADONA'), false);
  assert.deepEqual([...store.userRules('lucia').keys()], ['LA ESQUINA']);
  assert.equal(store.userRules('bruno').size, 1, "another customer's rule is not removed");
});

test('SI2b reset leaves both tables empty', () => {
  store.saveCategories('lucia', [row(movement('mv-reset'))]);
  store.setUserRule('lucia', 'MERCADONA', 'groceries');
  assert.ok(count('movement_categories') > 0 && count('category_rules') > 0);
  seedApp();
  assert.equal(count('movement_categories'), 0);
  assert.equal(count('category_rules'), 0);
});
