// SI2b: stored movement categories and per-customer category rules (migrations 7–8 in src/db.ts).
// Server only. Own prepared statements with named columns: insert() of src/db.ts cannot upsert.
import { createHash } from 'node:crypto';
import { appDb } from '../db';
import type { CategoryId, MovementInput, RowCategory } from './taxonomy';

export type StoredCategory = RowCategory & {
  movementId: string;
  fingerprint: string;
  updatedAt: string;
};
type CategoryRow = {
  movement_id: string;
  fingerprint: string;
  merchant_key: string;
  category: CategoryId;
  state: RowCategory['state'];
  source: RowCategory['source'];
  reason: string;
  confidence: number | null;
  threshold: number | null;
  candidates: string;
  model: string | null;
  updated_at: string;
};

// What makes a stored row belong to a movement: a reset bank reuses ids for other movements.
export function fingerprint(m: MovementInput): string {
  return createHash('sha256')
    .update([m.accountId, m.amountCents, m.createdAt, m.description].join('\n'))
    .digest('hex');
}

function fromRow(r: CategoryRow): StoredCategory {
  return {
    movementId: r.movement_id,
    fingerprint: r.fingerprint,
    id: r.category,
    state: r.state,
    source: r.source,
    reason: r.reason,
    confidence: r.confidence,
    threshold: r.threshold,
    candidates: JSON.parse(r.candidates),
    merchantKey: r.merchant_key,
    model: r.model,
    updatedAt: r.updated_at,
  };
}

// Rows whose fingerprint matches the given movement; mismatches are left out.
export function storedCategories(
  userId: string,
  movements: MovementInput[],
): Map<string, StoredCategory> {
  const prints = new Map(movements.map((m) => [m.id, fingerprint(m)]));
  const rows = appDb()
    .prepare(
      'SELECT movement_id,fingerprint,merchant_key,category,state,source,reason,confidence,threshold,candidates,model,updated_at FROM movement_categories WHERE user_id=? AND movement_id IN (SELECT value FROM json_each(?))',
    )
    .all(userId, JSON.stringify([...prints.keys()])) as CategoryRow[];
  return new Map(
    rows
      .filter((r) => prints.get(r.movement_id) === r.fingerprint)
      .map((r) => [r.movement_id, fromRow(r)]),
  );
}

// Upsert in one transaction; returns how many rows were written. A confirmed row with the same
// fingerprint is kept unless the new row comes from the customer (source user or user_rule).
export function saveCategories(userId: string, rows: StoredCategory[]): number {
  const db = appDb();
  const upsert = db.prepare(
    `INSERT INTO movement_categories(user_id,movement_id,fingerprint,merchant_key,category,state,source,reason,confidence,threshold,candidates,model,updated_at)
     VALUES(@user_id,@movement_id,@fingerprint,@merchant_key,@category,@state,@source,@reason,@confidence,@threshold,@candidates,@model,@updated_at)
     ON CONFLICT(user_id,movement_id) DO UPDATE SET
       fingerprint=excluded.fingerprint,merchant_key=excluded.merchant_key,category=excluded.category,
       state=excluded.state,source=excluded.source,reason=excluded.reason,confidence=excluded.confidence,
       threshold=excluded.threshold,candidates=excluded.candidates,model=excluded.model,updated_at=excluded.updated_at
     WHERE movement_categories.state<>'confirmed'
        OR movement_categories.fingerprint<>excluded.fingerprint
        OR excluded.source IN ('user','user_rule')`,
  );
  return db.transaction(() =>
    rows.reduce(
      (written, r) =>
        written +
        upsert.run({
          user_id: userId,
          movement_id: r.movementId,
          fingerprint: r.fingerprint,
          merchant_key: r.merchantKey,
          category: r.id,
          state: r.state,
          source: r.source,
          reason: r.reason,
          confidence: r.confidence,
          threshold: r.threshold,
          candidates: JSON.stringify(r.candidates),
          model: r.model,
          updated_at: r.updatedAt,
        }).changes,
      0,
    ),
  )();
}

export function deleteCategories(userId: string, movementIds: string[]): number {
  return appDb()
    .prepare(
      'DELETE FROM movement_categories WHERE user_id=? AND movement_id IN (SELECT value FROM json_each(?))',
    )
    .run(userId, JSON.stringify(movementIds)).changes;
}

// The customer's rules, newest first.
export function listRules(
  userId: string,
): { merchantKey: string; category: CategoryId; createdAt: string }[] {
  return appDb()
    .prepare(
      'SELECT merchant_key merchantKey,category,created_at createdAt FROM category_rules WHERE user_id=? ORDER BY created_at DESC,merchant_key',
    )
    .all(userId) as { merchantKey: string; category: CategoryId; createdAt: string }[];
}

export function userRules(userId: string): Map<string, CategoryId> {
  return new Map(listRules(userId).map((r) => [r.merchantKey, r.category]));
}

// Sets or replaces the rule of a merchant key; a replaced rule becomes the newest.
export function setUserRule(userId: string, merchantKey: string, category: CategoryId): void {
  if (!merchantKey) throw new Error('setUserRule: empty merchant key');
  appDb()
    .prepare(
      'INSERT INTO category_rules(user_id,merchant_key,category,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,merchant_key) DO UPDATE SET category=excluded.category,created_at=excluded.created_at',
    )
    .run(userId, merchantKey, category, new Date().toISOString());
}

export function removeUserRule(userId: string, merchantKey: string): boolean {
  return (
    appDb()
      .prepare('DELETE FROM category_rules WHERE user_id=? AND merchant_key=?')
      .run(userId, merchantKey).changes > 0
  );
}

// ---- IT4: what was sent to a decider (migration 10 in src/db.ts) ----

// Takes budget for the items of one run, in one IMMEDIATE transaction (two processes cannot both
// take the last unit): at most `max` asks per customer since `since`. Returns the ask id of each
// item that may be sent; the others are over the budget.
export function takeAsks(
  userId: string,
  itemKeys: string[],
  chain: string,
  at: string,
  since: string,
  max: number,
): Map<string, number> {
  const db = appDb();
  const add = db.prepare(
    'INSERT INTO decider_asks(user_id,item_key,chain,asked_at) VALUES(?,?,?,?)',
  );
  return db
    .transaction(() => {
      const left = max - askCount(userId, since);
      return new Map(
        itemKeys
          .slice(0, Math.max(0, left))
          .map((key) => [key, Number(add.run(userId, key, chain, at).lastInsertRowid)]),
      );
    })
    .immediate();
}

export function askCount(userId: string, since: string): number {
  return (
    appDb()
      .prepare('SELECT COUNT(*) n FROM decider_asks WHERE user_id=? AND asked_at>?')
      .get(userId, since) as { n: number }
  ).n;
}

// Asks per item since `since`: the "Try again" cool-down reads it (src/insights/summary.ts).
export function askCounts(userId: string, since: string): Map<string, number> {
  const rows = appDb()
    .prepare(
      'SELECT item_key,COUNT(*) n FROM decider_asks WHERE user_id=? AND asked_at>? GROUP BY item_key',
    )
    .all(userId, since) as { item_key: string; n: number }[];
  return new Map(rows.map((r) => [r.item_key, r.n]));
}

// The answer a decider gave for an ask, with the movements (fingerprints) it was stored for.
export function saveAnswer(askId: number, answer: unknown, fingerprints: string[]): void {
  appDb()
    .prepare('UPDATE decider_asks SET answer=? WHERE id=?')
    .run(JSON.stringify({ answer, fingerprints }), askId);
}

// Per movement fingerprint, the latest answer this customer already got from this chain, whatever
// its age: the decision of a movement whose row was replaced (a rule) or deleted since.
// ponytail: reads every answer of the customer (at most DECIDER_DAILY_ITEMS new rows a day); a
// table keyed by fingerprint, or pruning, if a customer's history grows large.
export function answers<T>(userId: string, chain: string): Map<string, T> {
  const rows = appDb()
    .prepare(
      'SELECT answer FROM decider_asks WHERE user_id=? AND chain=? AND answer IS NOT NULL ORDER BY id',
    )
    .pluck()
    .all(userId, chain) as string[];
  const found = new Map<string, T>();
  for (const row of rows) {
    const { answer, fingerprints } = JSON.parse(row) as { answer: T; fingerprints: string[] };
    for (const print of fingerprints) found.set(print, answer);
  }
  return found;
}
