import { randomUUID } from 'node:crypto';
import { bankRequest, BankError } from './client';
import { appDb } from '../db';
import { recordEvent } from '../telemetry';
import { log } from '../http';
import type { Operation, ToolContext, TransferInput } from '../types';
// F1: "Retrying that intent must not multiply its effects". The bank deduplicates by
// actor + reference, so each intent gets exactly one reference, assigned once (race-safe)
// and reused by every attempt and every later call with the same intentId.
function intentReference(intentId: string): string {
  const db = appDb();
  db.prepare('UPDATE intents SET bank_reference=? WHERE id=? AND bank_reference IS NULL').run(
    randomUUID(),
    intentId,
  );
  const row = db.prepare('SELECT bank_reference FROM intents WHERE id=?').get(intentId) as
    { bank_reference: string | null } | undefined;
  if (!row?.bank_reference) throw new Error('Transfer intent not found.');
  return row.bank_reference;
}
export async function dispatchTransfer(ctx: ToolContext, input: TransferInput): Promise<Operation> {
  const reference = intentReference(ctx.intentId);
  let uncertain = false;
  // SC2: one log line per retry, written once the retried attempt answers: the request id (from
  // log()), intent id, first failure and the retry's result. No transfer body, amount or reference.
  let reason = '';
  const logRetry = (outcome: string) =>
    log('warn', 'transfer_retry', { intentId: ctx.intentId, attempt: 2, reason, outcome });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const operation = await bankRequest<Operation>(ctx.userId, '/v1/transfers', 'POST', {
        ...input,
        reference,
      });
      if (attempt) logRetry(operation.status);
      return operation;
    } catch (e) {
      if (attempt)
        logRetry(e instanceof BankError ? `bank ${e.status}` : `error ${(e as Error).name}`);
      if (!(e instanceof BankError)) throw e;
      // T3: "A transport error or timeout does not prove that the bank rejected the operation."
      // Once an attempt was uncertain, the bank may still be committing it, so any later
      // non-2xx (409 key in use, 4xx) for the same reference is uncertain too.
      e.uncertain ||= uncertain;
      if (e.status < 500 || attempt === 1) throw e;
      uncertain = true;
      reason = `${e.status} ${e.message}`;
      // O2: operators see the retry in the case steps (status and bank message only).
      recordEvent(ctx, 'transfer.retry', {
        status: 'retrying',
        attempt: attempt + 2,
        reason,
        intentId: ctx.intentId,
      });
    }
  }
  throw new BankError(504, 'The operation could not be completed.');
}
