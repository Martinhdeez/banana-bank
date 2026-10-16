import { randomUUID } from 'node:crypto';
import { bankDb } from './db';
import { HttpError } from '../src/auth';
import type { Account, Operation, TransferInput } from '../src/types';
import { person } from '../src/people';
export const profiles = [
  'normal',
  'intermittent',
  'reject-before',
  'lost-response',
  'slow-response',
  'read-unavailable',
] as const;
export type Profile = (typeof profiles)[number];
export function setScenario(profile: Profile, seed = 17) {
  if (!profiles.includes(profile)) throw new HttpError(400, 'Unknown scenario profile.');
  bankDb()
    .prepare('UPDATE scenario SET profile=?,seed=?,counter=0,read_failures=0 WHERE id=1')
    .run(profile, seed);
}
export function scenario() {
  return bankDb().prepare('SELECT * FROM scenario WHERE id=1').get() as {
    profile: Profile;
    seed: number;
    counter: number;
    read_failures: number;
  };
}
export function listAccounts(userId: string) {
  return bankDb()
    .prepare('SELECT * FROM accounts WHERE userId=? ORDER BY id')
    .all(userId) as Account[];
}
export function transfer(
  userId: string,
  reference: string,
  input: TransferInput,
): { operation: Operation; fault: string | null; replay: boolean } {
  if (person(userId)?.role !== 'customer')
    throw new HttpError(403, 'Only the account holder can transfer funds.');
  if (!reference || reference.length > 120)
    throw new HttpError(400, 'An operation reference is required.');
  const db = bankDb();
  return db.transaction(() => {
    const previous = db
      .prepare('SELECT * FROM operations WHERE userId=? AND reference=?')
      .get(userId, reference) as Operation | undefined;
    if (previous) {
      if (
        previous.fromAccountId !== input.fromAccountId ||
        previous.toAccountId !== input.toAccountId ||
        previous.amountCents !== input.amountCents ||
        previous.concept !== input.concept
      )
        throw new HttpError(409, 'The reference already belongs to a different operation.');
      return { operation: previous, fault: null, replay: true };
    }
    const from = db
      .prepare('SELECT * FROM accounts WHERE id=? AND userId=?')
      .get(input.fromAccountId, userId) as Account | undefined;
    const to = db.prepare('SELECT * FROM accounts WHERE id=?').get(input.toAccountId) as
      Account | undefined;
    if (!from) throw new HttpError(403, 'Source account not authorized.');
    if (!to || to.id === from.id) throw new HttpError(400, 'Invalid destination account.');
    if (
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0 ||
      input.amountCents > 10000000
    )
      throw new HttpError(400, 'Amount outside simulator limits.');
    if (from.balanceCents < input.amountCents) throw new HttpError(422, 'Insufficient funds.');
    const s = scenario();
    const counter = s.counter + 1;
    db.prepare('UPDATE scenario SET counter=? WHERE id=1').run(counter);
    let fault: string | null = null;
    if (s.profile === 'intermittent' && (counter + s.seed) % 4 === 0) fault = 'lost-response';
    else if (s.profile !== 'normal' && s.profile !== 'intermittent' && counter === 1)
      fault = s.profile;
    if (fault === 'reject-before')
      return { operation: undefined as unknown as Operation, fault, replay: false };
    const operation: Operation = {
      ...input,
      id: randomUUID(),
      userId,
      reference,
      createdAt: new Date().toISOString(),
      status: 'completed',
    };
    db.prepare('UPDATE accounts SET balanceCents=balanceCents-? WHERE id=?').run(
      input.amountCents,
      from.id,
    );
    db.prepare('UPDATE accounts SET balanceCents=balanceCents+? WHERE id=?').run(
      input.amountCents,
      to.id,
    );
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)').run(
      operation.id,
      userId,
      reference,
      from.id,
      to.id,
      input.amountCents,
      input.concept,
      operation.createdAt,
      'completed',
    );
    const stmt = db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?)');
    stmt.run(
      randomUUID(),
      from.id,
      operation.id,
      -input.amountCents,
      `Transfer · ${input.concept}`,
      operation.createdAt,
    );
    stmt.run(
      randomUUID(),
      to.id,
      operation.id,
      input.amountCents,
      `Transfer · ${input.concept}`,
      operation.createdAt,
    );
    if (fault === 'read-unavailable')
      db.prepare('UPDATE scenario SET read_failures=1 WHERE id=1').run();
    return { operation, fault, replay: false };
  })();
}
export function operationByReference(userId: string, reference: string) {
  const db = bankDb();
  const s = scenario();
  if (s.read_failures > 0) {
    db.prepare('UPDATE scenario SET read_failures=read_failures-1 WHERE id=1').run();
    throw new HttpError(503, 'Query temporarily unavailable.');
  }
  return db
    .prepare('SELECT * FROM operations WHERE userId=? AND reference=?')
    .get(userId, reference) as Operation | undefined;
}
