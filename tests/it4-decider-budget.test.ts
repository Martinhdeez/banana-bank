// IT4 (audit A1): the per-customer daily budget of decider items, inside the pipeline. Fake
// deciders and an injected clock: no bank, no network, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupEnv } from './helpers/bank';
import type { MovementInput } from '../src/insights/taxonomy';
import type { Decider, DecisionItem } from '../src/insights/decider';
for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-it4-budget-');
process.env.DECIDER_DAILY_ITEMS = '3';
const { appDb, closeAppDb } = await import('../src/db');
const { seedApp } = await import('../src/seed');
const { DeciderError } = await import('../src/insights/decider');
const { classifyMovements } = await import('../src/insights/classify');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const OWN = new Set(['acc-a']);
const movement = (id: string, description: string): MovementInput => ({
  id,
  accountId: 'acc-a',
  amountCents: -1250,
  description,
  createdAt: '2026-09-16T10:00:00.000Z',
});
function fake(fails = false) {
  const calls: DecisionItem[] = [];
  const decider: Decider = {
    id: 'systemone',
    threshold: 0.8,
    classify: async (item) => {
      calls.push(item);
      if (fails) throw new DeciderError(true, 529);
      return { candidates: [{ category: 'health', p: 0.9 }], confidence: 0.9, model: 'fake-1' };
    },
  };
  return { decider, calls };
}
const classify = (userId: string, movements: MovementInput[], decider: Decider, now: () => Date) =>
  classifyMovements(
    { userId, movements, ownAccountIds: OWN, deciders: [decider], wait: true },
    now,
  );
const asks = (userId: string) =>
  (appDb().prepare('SELECT COUNT(*) n FROM decider_asks WHERE user_id=?').get(userId) as any).n;
const five = (prefix: string) =>
  ['ALFA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'].map((name, i) =>
    movement(`${prefix}-${i}`, `ZZQXV ${name}`),
  );

test('IT4 budget: at most DECIDER_DAILY_ITEMS items per customer per rolling day; the rest is decider_budget', async () => {
  let clock = Date.parse('2026-10-01T08:00:00.000Z');
  const now = () => new Date(clock);
  const { decider, calls } = fake();
  const rows = five('a');
  const first = await classify('budget-a', rows, decider, now);
  assert.equal(calls.length, 3);
  const over = rows.filter((m) => first.get(m.id)!.reason === 'decider_budget');
  assert.equal(over.length, 2);
  assert.deepEqual(first.get(over[0].id), {
    id: 'other',
    state: 'needs_review',
    source: 'none',
    reason: 'decider_budget',
    confidence: null,
    threshold: null,
    candidates: [],
    merchantKey: over[0].description,
    model: null,
  });
  assert.equal(rows.filter((m) => first.get(m.id)!.source === 'model').length, 3);
  // The same day: nothing more is asked, whoever reads and however often.
  clock += 23 * 3600_000;
  for (let i = 0; i < 3; i++) await classify('budget-a', rows, decider, now);
  assert.equal(calls.length, 3);
  assert.equal(asks('budget-a'), 3, 'the count is in the database, not in the process');
  // Another customer has its own budget.
  await classify('budget-b', five('b'), decider, now);
  assert.equal(calls.length, 6);
  // A day after the first asks the budget is free again: what was left is asked, nothing twice.
  clock += 2 * 3600_000;
  const later = await classify('budget-a', rows, decider, now);
  assert.equal(calls.length, 8);
  assert.ok(rows.every((m) => later.get(m.id)!.source === 'model'));
  assert.equal(asks('budget-a'), 5);
});

test('IT4 budget: a failed item counts, so a failing decider cannot be asked without limit either', async () => {
  let clock = Date.parse('2026-10-01T08:00:00.000Z');
  const now = () => new Date(clock);
  const { decider, calls } = fake(true);
  const [m] = five('c');
  for (let i = 0; i < 6; i++) {
    await classify('budget-c', [m], decider, now);
    clock += 60_000;
    // What the reclassify route does: the failed row is removed and the pipeline runs again.
    appDb().prepare("DELETE FROM movement_categories WHERE user_id='budget-c'").run();
  }
  assert.equal(calls.length, 3);
  const last = await classify('budget-c', [m], decider, now);
  assert.equal(last.get(m.id)!.reason, 'decider_budget');
});

test('IT4 budget: an answer already paid for is not a new item (rule deleted, row lost)', async () => {
  const now = () => new Date('2026-10-02T08:00:00.000Z');
  const { decider, calls } = fake();
  const rows = five('d').slice(0, 3);
  const first = await classify('budget-d', rows, decider, now);
  for (let i = 0; i < 5; i++) {
    appDb().prepare("DELETE FROM movement_categories WHERE user_id='budget-d'").run();
    assert.deepEqual(await classify('budget-d', rows, decider, now), first);
  }
  assert.equal(calls.length, 3);
  assert.equal(asks('budget-d'), 3);
  // Another chain (the model or the provider changed) does not reuse it.
  appDb().prepare("DELETE FROM movement_categories WHERE user_id='budget-d'").run();
  const openai = { ...fake().decider, id: 'openai' as const };
  const other = await classify('budget-d', rows, openai, now);
  assert.ok(rows.every((m) => other.get(m.id)!.reason === 'decider_budget'));
});

test('IT4 budget: npm run reset (the seed) wipes the asks', () => {
  assert.ok(asks('budget-a') > 0);
  seedApp();
  assert.equal(asks('budget-a'), 0);
});

test('IT4 budget: DECIDER_DAILY_ITEMS is validated at startup; the default covers a full bank window twice', () => {
  const load = (value?: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const { config } = await import(${JSON.stringify(path.resolve('src/config.ts'))}); console.log(config.deciderDailyItems);`,
      ],
      {
        cwd: temp,
        env: { ...process.env, DECIDER_DAILY_ITEMS: value ?? '' },
        encoding: 'utf8',
      },
    );
  assert.equal(load().stdout.trim(), '200');
  assert.equal(load('60').stdout.trim(), '60');
  for (const bad of ['0', 'abc', '-5', '1.5']) {
    const r = load(bad);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /DECIDER_DAILY_ITEMS must be a positive whole number/);
  }
  assert.match(fs.readFileSync('.env.example', 'utf8'), /^# DECIDER_DAILY_ITEMS=200$/m);
});
