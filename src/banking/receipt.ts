// CF1-api: proof of a transfer the app sent to the bank. Contract: "Customer-facing status should
// match verified facts" and "Historical evidence that was never recorded must not be invented".
// Every field is a stored row, a recorded event or a bank read; bank reads only degrade fields.
import { appDb } from '../db';
import { HttpError } from '../auth';
import { bankRequest } from './client';
import { failedUnverified, verifyIntent } from './actions';
import { accountName } from '../ui-helpers';
import { log } from '../http';
import type { Account, IntentStatus, Operation, TransferInput } from '../types';
import type { Contact } from './recipients';
export type Receipt = {
  intentId: string;
  reference: string;
  operationId: string | null;
  status: 'completed' | 'pending_verification' | 'processing';
  final: boolean;
  amountCents: number;
  concept: string;
  from: { accountId: string; label: string; iban: string | null };
  to: { accountId: string; name: string; label: string | null };
  proposedAt: string;
  confirmedAt: string | null;
  sentAt: string | null;
  executedAt: string | null;
  verifiedAt: string | null;
  issuedAt: string;
};
type Intent = {
  id: string;
  payload: string;
  status: IntentStatus;
  bank_reference: string | null;
  operation_id: string | null;
  created_at: string;
};
const RECEIPT_STATUSES = ['completed', 'pending_verification', 'processing'] as const;
const readIntent = (userId: string, intentId: string) =>
  appDb().prepare('SELECT * FROM intents WHERE id=? AND user_id=?').get(intentId, userId) as
    Intent | undefined;
export async function transferReceipt(userId: string, intentId: string): Promise<Receipt> {
  let intent = readIntent(userId, intentId);
  if (!intent) throw new HttpError(404, 'Transfer not found.');
  let lookedUp: Operation | undefined;
  // A non-final intent is re-checked once (the status tool's call); if that errors, the stored
  // status stands.
  // FX1: so is a `failed` one that neither the bank's rejection nor a lookup vouches for.
  if (
    intent.bank_reference &&
    intent.status !== 'completed' &&
    (intent.status !== 'failed' || failedUnverified(intentId))
  ) {
    const result = await verifyIntent(userId, intentId).catch((e) => {
      log('warn', 'receipt_verify_failed', { intentId, error: String(e) });
      return undefined;
    });
    lookedUp = result?.operation as Operation | undefined;
    intent = readIntent(userId, intentId)!;
  }
  // FX1: still unverified (the lookup above failed), so "no money moved" would be a guess.
  if (failedUnverified(intentId))
    throw new HttpError(
      503,
      'The bank could not confirm this transfer right now. Try again in a moment.',
    );
  if (intent.status === 'failed')
    throw new HttpError(409, 'No money moved, so there is no receipt.');
  const status = RECEIPT_STATUSES.find((s) => s === intent.status);
  const reference = intent.bank_reference;
  if (!reference || !status)
    throw new HttpError(409, 'This transfer was never sent, so there is no receipt.');
  const db = appDb();
  const approval = db
    .prepare('SELECT consumed_at FROM approvals WHERE intent_id=?')
    .get(intentId) as { consumed_at: string | null } | undefined;
  const events = db
    .prepare(
      "SELECT kind,data,created_at FROM events WHERE json_extract(data,'$.intentId')=? AND kind IN ('transfer.proposed','transfer.started','transfer.completed','transfer.verified') ORDER BY created_at,rowid",
    )
    .all(intentId) as { kind: string; data: string; created_at: string }[];
  const event = (kind: string, match: (data: any) => boolean = () => true) => {
    const e = events.find((e) => e.kind === kind && match(JSON.parse(e.data)));
    return e && { at: e.created_at, data: JSON.parse(e.data) };
  };
  const completed = event('transfer.completed');
  const verified = event('transfer.verified', (d) => d.status === 'completed');
  const recordedName: string | undefined = event('transfer.proposed')?.data.to;
  // FX1: a verification records the execution time too, so its receipt needs no second lookup.
  const recordedExecution: string | undefined =
    completed?.data.operation?.createdAt ?? verified?.data.executedAt;
  const transfer = JSON.parse(intent.payload) as TransferInput;
  const needsLookup = status === 'completed' && !recordedExecution && !lookedUp?.createdAt;
  const [accounts, contacts, operation] = await Promise.allSettled([
    bankRequest<Account[]>(userId, '/v1/accounts'),
    bankRequest<Contact[]>(userId, '/v1/contacts'),
    needsLookup
      ? bankRequest<Operation>(userId, `/v1/operations/${encodeURIComponent(reference)}`)
      : Promise.resolve(undefined),
  ]);
  const own =
    accounts.status === 'fulfilled'
      ? accounts.value.find((a) => a.id === transfer.fromAccountId)
      : undefined;
  const contactList = contacts.status === 'fulfilled' ? contacts.value : [];
  const contact = contactList.find((c) => c.id === transfer.toAccountId);
  return {
    intentId,
    reference,
    operationId: intent.operation_id,
    status,
    final: status === 'completed',
    amountCents: transfer.amountCents,
    concept: transfer.concept,
    from: {
      accountId: transfer.fromAccountId,
      label: own?.label || transfer.fromAccountId,
      iban: own?.iban ?? null,
    },
    to: {
      accountId: transfer.toAccountId,
      name: recordedName ?? accountName(transfer.toAccountId, { contacts: contactList }),
      label: contact?.label ?? null,
    },
    proposedAt: intent.created_at,
    confirmedAt: approval?.consumed_at ?? null,
    sentAt: event('transfer.started')?.at ?? null,
    executedAt:
      recordedExecution ??
      lookedUp?.createdAt ??
      (operation.status === 'fulfilled' ? (operation.value?.createdAt ?? null) : null),
    verifiedAt: status === 'completed' ? (completed?.at ?? verified?.at ?? null) : null,
    issuedAt: new Date().toISOString(),
  };
}
