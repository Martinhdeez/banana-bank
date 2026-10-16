import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appDb, insert } from '../db';
import { HttpError } from '../auth';
import { person } from '../people';
import { authorizeTransfer } from './authorization';
import { dispatchTransfer } from './dispatch';
import { findRecipients, groupRecipients, type Contact } from './recipients';
import { bankRequest, BankError } from './client';
import { recordEvent } from '../telemetry';
import { log, text } from '../http';
import { config } from '../config';
import { documents, readDocument } from '../ingestion/pipeline';
import { accountName, centsFromEuros, money, stripBidi, transferFeedback } from '../ui-helpers';
import type {
  Account,
  ActionResult,
  IntentStatus,
  Operation,
  SearchResult,
  ToolContext,
  TransferInput,
} from '../types';
const transferSchema = z
  .object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    amountCents: z.number().int().positive().max(10000000),
    // S1: trimmed, so a whitespace-only concept never reaches a proposal or the bank.
    // FX3: bidi controls removed first (text()).
    concept: text(z.string().trim().min(1).max(200)),
  })
  .strict();
// F7: a proposal may leave the source empty (null) when the customer did not name it.
// T5: secondTransfer is true only once the customer said an identical request is a new transfer.
// R2: the destination is a person (`recipient`, resolved to their main account) or an exact
// account (`toAccountId`, which wins: the customer asked for that account).
const proposalSchema = transferSchema
  .extend({
    fromAccountId: z.string().min(1).nullable(),
    toAccountId: z.string().min(1).nullish(),
    recipient: text(z.string().trim().min(1).max(200)).nullish(),
    secondTransfer: z.boolean().nullish(),
  })
  .refine((a) => a.toAccountId || a.recipient, { path: ['recipient'] });
// F2: "A sensitive operation must present its amount, source, and destination for explicit
// review before execution." Proposals are single-use and expire.
const APPROVAL_TTL_MS = 10 * 60_000;
type IntentRow = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  payload: string;
  status: IntentStatus;
  bank_reference: string | null;
  operation_id: string | null;
  error: string | null;
  created_at: string;
};
type ApprovalRow = {
  id: string;
  user_id: string;
  intent_id: string;
  payload: string;
  expires_at: string;
  consumed_at: string | null;
};
const proposal = (a: ApprovalRow): ActionResult => ({
  status: a.expires_at > new Date().toISOString() ? 'requires_confirmation' : 'expired',
  approval: { id: a.id, expiresAt: a.expires_at, ...(JSON.parse(a.payload) as TransferInput) },
  intentId: a.intent_id,
});
// PT1: the checks of a proposal that write nothing (customer role, input, the two bank reads, an
// owned source, an existing destination), shared with prepareTransfer (src/banking/prepared.ts).
// Returns the resolved transfer, or the result to answer instead.
export async function resolveTransfer(ctx: ToolContext, args: unknown) {
  if (person(ctx.userId)?.role !== 'customer')
    throw new HttpError(403, 'A customer account is required.');
  const invalid = invalidInput(args);
  if (invalid) return { status: 'failed', ...invalid, intentId: ctx.intentId } as ActionResult;
  const { secondTransfer, recipient, ...parsed } = proposalSchema.parse(normalizeInput(args));
  const accounts = await bankRequest<Account[]>(ctx.userId, '/v1/accounts');
  // F7 (faq-two-accounts): "If you have multiple accounts and did not specify one, the
  // assistant should ask for clarification." Never pick one silently.
  if (!parsed.fromAccountId && accounts.length !== 1)
    return {
      status: 'needs_source_account',
      message: 'Ask the customer which account to send from. Do not choose one for them.',
      accounts: accounts.map(({ id, label, balanceCents }) => ({ id, label, balanceCents })),
    };
  const source = accounts.find((a) => a.id === (parsed.fromAccountId || accounts[0].id));
  if (!source) throw new HttpError(403, plainErrors[403]);
  const contacts = await bankRequest<Contact[]>(ctx.userId, '/v1/contacts');
  const toAccountId = resolveDestination(
    ctx,
    parsed.toAccountId,
    recipient,
    source.id,
    accounts,
    contacts,
  );
  if (typeof toAccountId !== 'string') return toAccountId;
  // Key order is fixed: the stored payload is compared as JSON on every retry of the intent.
  const input: TransferInput = {
    fromAccountId: source.id,
    toAccountId,
    amountCents: parsed.amountCents,
    concept: parsed.concept,
  };
  return { input, accounts, contacts, source, secondTransfer };
}
// F2: the agent tool and POST /api/actions only create an intent plus an approval.
// Nothing here calls the bank endpoint that moves money.
export async function proposeTransfer(
  ctx: ToolContext,
  args: unknown,
  { checkDuplicates = false } = {},
): Promise<ActionResult> {
  const resolved = await resolveTransfer(ctx, args);
  if ('status' in resolved) return resolved;
  const { input, accounts, contacts, source, secondTransfer } = resolved,
    db = appDb();
  // F2b: everything below is synchronous, so concurrent requests with the same intentId
  // (double submit) converge on one proposal.
  const previous = db.prepare('SELECT * FROM intents WHERE id=?').get(ctx.intentId) as
    IntentRow | undefined;
  if (previous && (previous.user_id !== ctx.userId || previous.payload !== JSON.stringify(input)))
    throw new HttpError(409, 'This intent belongs to a different payload.');
  const existing = db.prepare('SELECT * FROM approvals WHERE intent_id=?').get(ctx.intentId) as
    ApprovalRow | undefined;
  // T7: an intent without an approval was created by the execution path; report its outcome
  // instead of colliding with it on insert.
  if (previous && (!existing || existing.consumed_at))
    return intentOutcome(ctx.userId, previous.id);
  const destination = describeDestination(input.toAccountId, accounts, contacts);
  if (existing) return { ...proposal(existing), destination };
  if (checkDuplicates && !secondTransfer) {
    const duplicate = findDuplicate(ctx.userId, input);
    if (duplicate) return { ...duplicate, destination };
  }
  // F6: answer case-diego before proposing something the bank will reject.
  // FX6-a (ALT-3b): the refusal carries the destination resolved in the customer's session, as
  // every proposal does, so the recorded step names it for an operator the bank gives no contacts.
  if (source.balanceCents < input.amountCents)
    return {
      status: 'failed',
      ...insufficientFunds(input, accounts),
      intentId: ctx.intentId,
      destination,
    };
  const to = accountName(input.toAccountId, { accounts, contacts });
  return { ...proposal(saveProposal(ctx, input, to)), destination };
}
// K8: the destination account of a proposal, or the failure to return instead. R2: a person
// resolves to their main account here, on the server; the review still shows (and the payload
// stores) the exact destination account.
function resolveDestination(
  ctx: ToolContext,
  toAccountId: string | null | undefined,
  recipient: string | null | undefined,
  sourceId: string,
  accounts: Account[],
  contacts: Contact[],
): string | ActionResult {
  if (!toAccountId) {
    const matches = findRecipients(contacts, recipient!);
    if (matches.length !== 1)
      return {
        status: 'failed',
        code: matches.length ? 'ambiguous_recipient' : 'invalid_destination',
        error: matches.length
          ? `"${recipient}" matches several recipients: ${matches.map((p) => p.name).join(', ')}. Ask the customer which person. No money moved.`
          : `No recipient called "${recipient}" is among your contacts. No money moved. Choose one of your recipients.`,
        recipients: (matches.length ? matches : groupRecipients(contacts)).map((p) => p.name),
        intentId: ctx.intentId,
      };
    toAccountId = matches[0].main.id;
  }
  // T6: "Source and destination must exist and differ." Checked before review, so the
  // customer is never asked to confirm a transfer the bank must reject.
  if (toAccountId === sourceId)
    return {
      status: 'failed',
      code: 'same_account',
      error: 'The destination must be a different account from the source. No money moved.',
      intentId: ctx.intentId,
    };
  if (![...contacts, ...accounts].some((a) => a.id === toAccountId))
    return {
      status: 'failed',
      code: 'invalid_destination',
      error:
        'That destination account does not exist or is not among your recipients. No money moved. Choose one of your contacts or your own accounts.',
      intentId: ctx.intentId,
    };
  return toAccountId;
}
// K8: the intent and its single-use, expiring approval, written together.
// DV7-B: `to` is the destination's name at proposal time, recorded for the outcome notes.
function saveProposal(ctx: ToolContext, input: TransferInput, to: string): ApprovalRow {
  const db = appDb();
  const approval: ApprovalRow = {
    id: randomUUID(),
    user_id: ctx.userId,
    intent_id: ctx.intentId,
    payload: JSON.stringify(input),
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    consumed_at: null,
  };
  db.transaction(() => {
    insert('intents', {
      id: ctx.intentId,
      user_id: ctx.userId,
      conversation_id: ctx.conversationId,
      run_id: ctx.runId,
      payload: approval.payload,
      status: 'awaiting_confirmation',
      created_at: new Date().toISOString(),
    });
    insert('approvals', approval);
  })();
  recordEvent(ctx, 'transfer.proposed', {
    status: 'requires_confirmation',
    input,
    to,
    intentId: ctx.intentId,
  });
  return approval;
}
// S1: every proposal (chat tool, form, API) states its amount as integer cents (`amountCents`) or
// as decimal euros text (`amount`, what the customer typed). The text is strict: digits with at
// most two decimals after "." or ","; exponent, hex, sign, Infinity and NaN are refused, never
// coerced through Number() (the form turned "1e3" into €1,000.00). Plain words, no field names.
export const MAX_AMOUNT_CENTS = 10_000_000; // FC2 reuses the ceiling
// The parser lives in src/ui-helpers.ts (pure) so the transfer form can estimate with it.
export { centsFromEuros };
type RawInput = Record<string, unknown> | null;
const amountOf = (a: RawInput) =>
  a?.amountCents === undefined && typeof a?.amount === 'string'
    ? centsFromEuros(a.amount)
    : a?.amountCents;
function invalidInput(args: unknown) {
  const a = (typeof args === 'object' ? args : null) as RawInput,
    cents = amountOf(a);
  if (
    a?.amountCents !== undefined &&
    a?.amount !== undefined &&
    centsFromEuros(String(a.amount)) !== a.amountCents
  )
    return {
      code: 'invalid_request',
      error:
        'The amount was given twice with different values (amountCents and amount). Send only one. No money moved.',
    };
  if (!(
    Number.isSafeInteger(cents) &&
    (cents as number) >= 1 &&
    (cents as number) <= MAX_AMOUNT_CENTS
  ))
    return {
      code: 'invalid_request',
      error: `Enter an amount in euros between ${money(1)} and ${money(MAX_AMOUNT_CENTS)}, with at most two decimals (for example 12.50). No money moved.`,
    };
  // FX3: a concept of bidi controls only is an empty concept.
  if (typeof a?.concept !== 'string' || !stripBidi(a.concept).trim())
    return {
      code: 'invalid_request',
      error: 'Add a short description of what the transfer is for. No money moved.',
    };
}
function normalizeInput(args: unknown) {
  const { amount, ...rest } = args as Record<string, unknown>;
  return { ...rest, amountCents: amountOf(args as RawInput) };
}
// R2: the exact account the proposal sends to, named for the review; `main` says whether it is
// the recipient's main account (false = the customer asked for another of their accounts).
function describeDestination(id: string, accounts: Account[], contacts: Contact[]) {
  const own = accounts.find((a) => a.id === id);
  if (own) return { accountId: id, name: null, label: own.label, own: true };
  const contact = contacts.find((c) => c.id === id)!;
  const person = groupRecipients(contacts).find((p) => p.accounts.includes(contact));
  return {
    accountId: id,
    name: contact.name ?? null,
    label: contact.label ?? null,
    main: person?.main.id === id,
  };
}
// T5: "Retrying that intent must not multiply its effects. Two distinct legitimate intentions
// may have identical amounts and destinations." A chat request identical to a proposal still
// awaiting confirmation, or to a transfer still being verified, is surfaced instead of
// duplicated; the customer decides whether it is a second transfer (secondTransfer: true).
function findDuplicate(userId: string, input: TransferInput): ActionResult | undefined {
  const db = appDb(),
    // K4: the duplicate rule of transferKey (src/ui-helpers.ts): same source, destination and
    // amount; the concept is free text the model may reword.
    same =
      "json_extract(payload,'$.fromAccountId')=? AND json_extract(payload,'$.toAccountId')=? AND json_extract(payload,'$.amountCents')=?",
    key = [input.fromAccountId, input.toAccountId, input.amountCents];
  const pending = db
    .prepare(
      `SELECT * FROM approvals WHERE user_id=? AND ${same} AND consumed_at IS NULL AND expires_at>? ORDER BY expires_at DESC`,
    )
    .get(userId, ...key, new Date().toISOString()) as ApprovalRow | undefined;
  if (pending)
    return {
      ...proposal(pending),
      status: 'possible_duplicate',
      message:
        'An identical transfer proposal is already awaiting confirmation. Show it and ask the customer whether this is a second, separate transfer. Only if they say yes, call transfer_money again with secondTransfer true.',
    };
  const unverified = db
    .prepare(
      `SELECT * FROM intents WHERE user_id=? AND ${same} AND status IN ('processing','pending_verification') ORDER BY created_at DESC`,
    )
    .get(userId, ...key) as IntentRow | undefined;
  if (unverified)
    return {
      status: 'possible_duplicate',
      transfer: JSON.parse(unverified.payload),
      reference: unverified.bank_reference,
      intentId: unverified.id,
      message:
        'An identical transfer was already sent and its outcome is still being verified, so it may have gone through. Tell the customer not to repeat it until it is verified (use operation_status). Only if they say this is a second, separate transfer, call transfer_money again with secondTransfer true.',
    };
}
// F6: bank rejections in plain words, with the next step the documentation gives.
const plainErrors: Record<number, string> = {
  // T7: a 400 does not say which detail was wrong (the known causes are checked at proposal).
  400: 'The bank rejected the transfer details as invalid. No money moved.',
  403: 'This source account does not belong to you, so the transfer cannot be made from it. No money moved.',
  404: 'The bank could not find that account or operation. No money moved.',
  409: 'The bank already has a different operation registered under this transfer reference, so nothing new was sent. Ask for human support to review it.',
};
const errorCodes: Record<number, string> = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};
// T8: "make its evidence traceable": the FAQ cited below travels as a real source, so the
// answer's citation resolves to a document (src/agent/run.ts adds tool sources to the pool).
function faqSource(id: string): SearchResult[] {
  const doc = documents().find((d) => d.id === id);
  if (!doc) return [];
  const { file, family, ...meta } = doc;
  return [{ ...meta, id, documentId: id, text: readDocument(doc).slice(0, 1500), score: 1 }];
}
// S2: customer text in the shared money format, with no document ids (the FAQ travels as
// `sources`), saying who refused it: the app before sending, or the bank (422) at execution.
function insufficientFunds(
  input: TransferInput,
  accounts: Account[] = [],
  by: 'app' | 'bank' = 'app',
) {
  const account = accounts.find((a) => a.id === input.fromAccountId);
  const available = account
    ? ` but ${account.label} has ${money(account.balanceCents)} available`
    : '';
  // T8: suggest another account only when the customer has one that can pay.
  const other = accounts.find(
    (a) => a.id !== input.fromAccountId && a.balanceCents >= input.amountCents,
  );
  const options = other
    ? `send a smaller amount, use another of your accounts (${other.label}), or ask for human support`
    : 'send a smaller amount or ask for human support';
  const refused = by === 'app' ? 'so the app did not send it' : 'so the bank refused it';
  return {
    code: 'insufficient_funds',
    error: `Insufficient funds: this transfer needs ${money(input.amountCents)}${available}, ${refused}. No money moved and no debt was created. You can ${options}.`,
    availableCents: account?.balanceCents,
    sources: faqSource('faq-insufficient-funds'),
  };
}
async function explainBankError(userId: string, e: BankError, input: TransferInput) {
  if (e.status === 422) {
    const accounts = await bankRequest<Account[]>(userId, '/v1/accounts').catch((read) => {
      warn('transfer_balance_unavailable', read, { userId });
      return [];
    });
    return insufficientFunds(input, accounts, 'bank');
  }
  // K6: the bank's own wording stays in the server log, never in customer text.
  if (!plainErrors[e.status]) warn('transfer_rejected_unmapped', e, { status: e.status });
  return {
    code: errorCodes[e.status] || 'rejected',
    error: plainErrors[e.status] || 'The bank rejected the transfer. No money moved.',
  };
}
// K6: a non-fatal failure is logged (name and message, no payload), never swallowed silently.
function warn(event: string, e: unknown, context: Record<string, unknown>) {
  const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  log('warn', event, { ...context, error });
}
// F2: POST /api/approvals/:id/confirm is the only path that executes a transfer.
// The approval is consumed atomically, so it executes at most once; a repeated confirm
// returns the outcome of the same intent instead of sending again.
export async function confirmApproval(userId: string, approvalId: string): Promise<ActionResult> {
  const db = appDb();
  const approval = db
    .prepare('SELECT * FROM approvals WHERE id=? AND user_id=?')
    .get(approvalId, userId) as ApprovalRow | undefined;
  if (!approval) throw new HttpError(404, 'Proposal not found.');
  const intent = db
    .prepare('SELECT * FROM intents WHERE id=? AND user_id=?')
    .get(approval.intent_id, userId) as IntentRow | undefined;
  if (!intent) throw new HttpError(404, 'Intent not found.');
  const now = new Date().toISOString();
  const consumed = db
    .prepare(
      'UPDATE approvals SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',
    )
    .run(now, approval.id, now).changes;
  if (!consumed) {
    // R5: a cancelled proposal never executes; say so plainly (no bank call).
    const { status } = db.prepare('SELECT status FROM intents WHERE id=?').get(intent.id) as {
      status: IntentStatus;
    };
    if (status === 'cancelled') throw new HttpError(409, CANCELLED_MESSAGE);
    if (!approval.consumed_at)
      throw new HttpError(410, 'This proposal has expired. Ask for a new one to review.');
    return { ...(await intentOutcome(userId, intent.id)), approvalId: approval.id };
  }
  const result = await transferMoney(
    {
      userId,
      conversationId: intent.conversation_id,
      runId: randomUUID(),
      intentId: intent.id,
      approvalId: approval.id,
    },
    JSON.parse(approval.payload),
  ).catch((e) => {
    // F3: a throw before dispatch (e.g. the ownership read is unavailable) sent nothing: record
    // it as failed so a repeated confirm does not report "processing" for money that never moved.
    const error =
      e instanceof HttpError
        ? e.message
        : 'The transfer was not sent because the bank could not be reached. No money moved. Ask for a new proposal.';
    const { changes } = db
      .prepare("UPDATE intents SET status='failed',error=? WHERE id=? AND bank_reference IS NULL")
      .run(error, intent.id);
    if (e instanceof HttpError) throw e;
    // PT1-F1: with a reference the bank was or may have been called, so "not sent" is not a
    // verified fact: answer the unknown outcome. The intent is verified later (recheckPending).
    if (!changes)
      return {
        status: 'pending_verification',
        message: PENDING_MESSAGE,
        intentId: intent.id,
      } as ActionResult;
    return { status: 'failed', error, intentId: intent.id } as ActionResult;
  });
  await noteOutcome(intent, result);
  return { ...result, approvalId: approval.id };
}
// R6: the outcome of a confirm, a cancel or a later verification is written into the intent's
// conversation on the server, so every browser, the operator's history and the agent's next turn
// see the same line. It says only what the result says (transferFeedback, as in the panel).
// run_id `outcome:<tone>:<intentId>` marks the message for the UI.
async function noteOutcome(
  intent: Pick<IntentRow, 'id' | 'user_id' | 'conversation_id' | 'payload'>,
  result: ActionResult,
) {
  if (!intent.conversation_id) return;
  const { tone, text } = transferFeedback(result as { status: string });
  const transfer = JSON.parse(intent.payload) as TransferInput;
  // DV7-B: the name recorded with the proposal; the bank may be unreachable right now (a
  // pending_verification note), so it is read only for intents proposed before DV7-B.
  const recorded = appDb()
    .prepare(
      "SELECT json_extract(data,'$.to') AS to_name FROM events WHERE kind='transfer.proposed' AND json_extract(data,'$.intentId')=?",
    )
    .get(intent.id) as { to_name: string | null } | undefined;
  const to = recorded?.to_name ?? (await liveAccountName(intent, transfer.toAccountId));
  insert('messages', {
    id: randomUUID(),
    conversation_id: intent.conversation_id,
    role: 'assistant',
    content: `${money(transfer.amountCents)} to ${to} (${transfer.concept}): ${text}`,
    created_at: new Date().toISOString(),
    run_id: `outcome:${tone}:${intent.id}`,
  });
}
// K6: without the names the note keeps the account id; the failed read is logged.
async function liveAccountName(intent: Pick<IntentRow, 'id' | 'user_id'>, id: string) {
  const [accounts, contacts] = await Promise.all(
    ['/v1/accounts', '/v1/contacts'].map((path) =>
      bankRequest<Contact[]>(intent.user_id, path).catch((e) => {
        warn('transfer_note_names_unavailable', e, { intentId: intent.id, path });
        return [];
      }),
    ),
  );
  return accountName(id, { accounts, contacts });
}
// R5: the customer may cancel a proposal while it awaits confirmation. The approval is consumed
// atomically (a concurrent confirm and cancel cannot both win), the intent becomes 'cancelled'
// and the step is recorded for the operator and the timeline. Cancelling again is a no-op.
const CANCELLED_MESSAGE = 'This proposal was cancelled. No money moved.';
// AR1-a: `reason` records who closed it when it was not the customer: 'replaced' by a correction,
// or 'withdrawn' by the app (a correction whose target was closed first). The timelines word the
// step from it ("Customer-facing status should match verified facts").
export async function cancelApproval(
  userId: string,
  approvalId: string,
  reason?: 'replaced' | 'withdrawn',
): Promise<ActionResult> {
  const db = appDb();
  const approval = db
    .prepare('SELECT * FROM approvals WHERE id=? AND user_id=?')
    .get(approvalId, userId) as ApprovalRow | undefined;
  if (!approval) throw new HttpError(404, 'Proposal not found.');
  const now = new Date().toISOString();
  const cancelled = db.transaction(() => {
    const changes = db
      .prepare(
        'UPDATE approvals SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',
      )
      .run(now, approval.id, now).changes;
    if (changes)
      db.prepare("UPDATE intents SET status='cancelled',error=? WHERE id=?").run(
        CANCELLED_MESSAGE,
        approval.intent_id,
      );
    return changes > 0;
  })();
  const intent = db
    .prepare('SELECT * FROM intents WHERE id=?')
    .get(approval.intent_id) as IntentRow;
  if (intent.status !== 'cancelled') {
    // The row read above may predate a racing confirm: only an unconsumed, past-expiry one expired.
    if (!approval.consumed_at && approval.expires_at <= now)
      throw new HttpError(410, 'This proposal has expired, so there is nothing to cancel.');
    throw new HttpError(
      409,
      'This proposal was already confirmed, so it can no longer be cancelled.',
    );
  }
  const result = {
    status: 'cancelled',
    message: CANCELLED_MESSAGE,
    transfer: JSON.parse(approval.payload),
    intentId: intent.id,
    approvalId: approval.id,
  };
  if (cancelled) {
    recordEvent(
      { userId, conversationId: intent.conversation_id, runId: randomUUID(), intentId: intent.id },
      'transfer.cancelled',
      { status: 'cancelled', approvalId: approval.id, intentId: intent.id, reason },
    );
    await noteOutcome(intent, result);
  }
  return result;
}
// Outcome of an intent that was already confirmed: never dispatches again.
async function intentOutcome(userId: string, intentId: string): Promise<ActionResult> {
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as IntentRow;
  if (intent.status === 'failed' || intent.status === 'cancelled')
    return { status: intent.status, error: intent.error, intentId };
  // T4: with a saved reference, even a 'processing' intent is verified (see verifyIntent).
  if (!intent.bank_reference) return { status: 'processing', intentId };
  return verifyIntent(userId, intentId);
}
// F3: "A transport error or timeout does not prove that the bank rejected the operation.
// Customer-facing status should match verified facts." The persisted F1 reference is looked
// up at the bank; only a found operation or a proven absence changes the status.
const PENDING_MESSAGE =
  'The bank did not confirm the result in time, so the transfer may already have gone through. Do not repeat it: we are verifying it with the bank. Ask about its status in a moment.';
const NOT_REGISTERED_MESSAGE =
  'The bank has not registered this transfer yet, but it may still be processing it. Do not repeat it: ask about its status again in a couple of minutes.';
// T1: every bank request is signed with x-bank-time and the contract's 60-second clock window,
// so a request signed more than 60 s ago can no longer be accepted by any conforming bank. Each
// retry is signed afresh, so a 404 proves "no money moved" after an uncertain attempt only once
// the LAST attempt is older than that window, doubled for clock skew (a skew beyond 60 s fails
// every request), plus one bank timeout (the ownership read signed before the first attempt).
const ABSENCE_PROOF_MS = 120_000 + config.bankTimeoutMs;
// A live dispatch ends within 2 POST timeouts plus 3 verification lookups.
const STALE_PROCESSING_MS = 10 * config.bankTimeoutMs;
const LOOKUP_BACKOFF_MS = [250, 750];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Dispatch starts when the approval is consumed (confirm); direct executions have no approval.
function dispatchStartedAt(intent: IntentRow): number {
  const approval = appDb()
    .prepare('SELECT consumed_at FROM approvals WHERE intent_id=?')
    .get(intent.id) as { consumed_at: string | null } | undefined;
  return Date.parse(approval?.consumed_at || intent.created_at);
}
// T1: the retry (O2 event, recorded in the same tick that signs it) moves the window forward.
function lastAttemptAt(intent: IntentRow): number {
  const retry = appDb()
    .prepare(
      "SELECT MAX(created_at) at FROM events WHERE kind='transfer.retry' AND json_extract(data,'$.intentId')=?",
    )
    .get(intent.id) as { at: string | null };
  return Math.max(dispatchStartedAt(intent), retry.at ? Date.parse(retry.at) : 0);
}
// R6: `note` is false only inside a confirm, which notes its own final result.
export async function verifyIntent(
  userId: string,
  intentId: string,
  lookups = 1,
  note = true,
): Promise<ActionResult> {
  const db = appDb();
  const intent = db
    .prepare('SELECT * FROM intents WHERE id=? AND user_id=?')
    .get(intentId, userId) as IntentRow | undefined;
  if (!intent) throw new HttpError(404, 'Transfer not found.');
  const reference = intent.bank_reference,
    transfer = JSON.parse(intent.payload) as TransferInput;
  // T4: a dispatch outlives STALE_PROCESSING_MS only if the process died mid-transfer (restart);
  // its reference was saved before the POST, so it is verified like an uncertain outcome.
  if (
    !reference ||
    (intent.status === 'processing' && Date.now() - dispatchStartedAt(intent) < STALE_PROCESSING_MS)
  )
    return { status: intent.status, transfer, intentId };
  // T2: the bank itself returned this operation, and it commits the ledger atomically, so it
  // is a verified fact; a later failed or empty re-lookup must never downgrade it.
  if (intent.status === 'completed' && intent.operation_id)
    return {
      status: 'completed',
      verified: true,
      operation: { ...transfer, id: intent.operation_id, reference, status: 'completed' },
      reference,
      transfer,
      intentId,
    };
  // T1: a 404 is final only for a definitive rejection (no uncertain attempt) or once the
  // signature window of every attempt has closed.
  const absenceProven =
    intent.status === 'failed' || Date.now() - lastAttemptAt(intent) > ABSENCE_PROOF_MS;
  let notFound = false;
  for (let attempt = 0; attempt < lookups; attempt++) {
    if (attempt) await sleep(LOOKUP_BACKOFF_MS[attempt - 1] ?? 1000);
    try {
      const operation = await bankRequest<Operation>(
        userId,
        `/v1/operations/${encodeURIComponent(reference)}`,
      );
      // FX1: `intent` was read before the bank call, so several calls may get here for one
      // transition. The write is conditional and only the call that changed the row records the
      // event and the note (the same guard as PT1-F1 below).
      const transition = db
        .prepare(
          "UPDATE intents SET status='completed',operation_id=?,error=NULL WHERE id=? AND status<>'completed'",
        )
        .run(operation.id, intentId).changes;
      // A stored `completed` with no operation id only gains the id.
      if (!transition)
        db.prepare('UPDATE intents SET operation_id=?,error=NULL WHERE id=?').run(
          operation.id,
          intentId,
        );
      const result = {
        status: 'completed',
        verified: true,
        operation,
        reference,
        transfer,
        intentId,
      };
      if (transition) await settled(intent, result, note);
      return result;
    } catch (e) {
      // K6: an app error here (e.g. writing the note) is logged; the lookup is retried as before.
      if (!(e instanceof BankError)) warn('transfer_verify_failed', e, { intentId });
      if (!(e instanceof BankError && e.status === 404)) continue;
      notFound = true;
      if (!absenceProven) continue;
      const error =
        intent.status === 'failed' && intent.error
          ? intent.error
          : 'The bank has no record of this transfer, so no money moved.';
      // FX1 / PT1-F1: `failed` is never written over a `completed` a concurrent lookup stored,
      // and only the call that made the transition records it.
      const transition = db
        .prepare(
          "UPDATE intents SET status='failed',error=? WHERE id=? AND status NOT IN ('completed','failed')",
        )
        .run(error, intentId).changes;
      const result = { status: 'failed', verified: true, error, reference, transfer, intentId };
      if (transition) await settled(intent, result, note);
      // FX1: a `failed` nothing vouched for is now a verified absence: recorded once (no note,
      // the customer-facing status did not change), so it is not looked up again. The check and
      // the event are in one tick, so one call of this process records it.
      else if (failedUnverified(intentId)) await settled(intent, result, false);
      else {
        const now = db.prepare('SELECT status,error FROM intents WHERE id=?').get(intentId) as {
          status: IntentStatus;
          error: string | null;
        };
        if (now.status !== 'failed')
          return { status: now.status, verified: false, reference, transfer, intentId };
        result.error = now.error ?? error;
      }
      return result;
    }
  }
  if (intent.status === 'completed' || intent.status === 'failed')
    return {
      status: intent.status,
      verified: false,
      error: intent.error,
      reference,
      transfer,
      intentId,
    };
  return {
    status: 'pending_verification',
    message: notFound ? NOT_REGISTERED_MESSAGE : PENDING_MESSAGE,
    reference,
    transfer,
    intentId,
  };
}
// R7/R8: a verification that changed the intent's status is a recorded fact (timeline, operator
// steps) and, outside a confirm (R6), a note in the conversation.
async function settled(intent: IntentRow, result: ActionResult, note: boolean) {
  recordEvent(
    {
      userId: intent.user_id,
      conversationId: intent.conversation_id,
      runId: randomUUID(),
      intentId: intent.id,
    },
    'transfer.verified',
    {
      status: result.status,
      from: intent.status,
      intentId: intent.id,
      // FX1: the bank's execution time, so the transfer's date is not the time of this check.
      executedAt: (result.operation as Operation | undefined)?.createdAt,
    },
  );
  if (note) await noteOutcome(intent, result);
}
// FX1: "Customer-facing status should match verified facts." A `failed` intent that carries a
// bank reference is a verified fact only if the bank rejected it (transfer.failed) or a lookup
// proved its absence (transfer.verified). With neither (a record from before F3, which wrote
// `failed` on a timeout) the bank may hold the operation, so it is looked up until it answers.
const UNVERIFIED_FAILURE =
  "status='failed' AND bank_reference IS NOT NULL AND NOT EXISTS (SELECT 1 FROM events WHERE kind IN ('transfer.failed','transfer.verified') AND json_extract(data,'$.intentId')=intents.id)";
export const failedUnverified = (intentId: string) =>
  !!appDb().prepare(`SELECT 1 FROM intents WHERE id=? AND ${UNVERIFIED_FAILURE}`).get(intentId);
// R7: transfers whose outcome is unknown are re-checked without the customer asking: on each
// dashboard load, at most 3 per load, each at most once every RECHECK_MS, one lookup each.
// FX1: so is a `failed` one nothing vouches for, until the bank answers (found, or a 404).
// ponytail: throttle kept in process memory; move it to the intents table if several app
// processes serve the same data.
const RECHECK_MS = 30_000;
const lastRecheck = new Map<string, number>();
export async function recheckPending(userId: string) {
  const rows = appDb()
    .prepare(
      `SELECT id FROM intents WHERE user_id=? AND bank_reference IS NOT NULL AND (status IN ('pending_verification','processing') OR (${UNVERIFIED_FAILURE})) ORDER BY created_at DESC LIMIT 20`,
    )
    .all(userId) as { id: string }[];
  const due = rows
    .filter((r) => Date.now() - (lastRecheck.get(r.id) ?? 0) > RECHECK_MS)
    .slice(0, 3);
  for (const r of due) lastRecheck.set(r.id, Date.now());
  // K6: a failed recheck stays non-fatal (the next load retries it) but is logged.
  await Promise.all(
    due.map((r) =>
      verifyIntent(userId, r.id).catch((e) =>
        warn('transfer_recheck_failed', e, { intentId: r.id }),
      ),
    ),
  );
}
// R4: banks list movements without the other side. When the app sent the operation, its intent
// names both accounts and the concept; other movements keep only the bank's description.
// CF3-api: one query for the whole list (was one per movement).
export function withCounterparties<T extends { operationId?: string | null }>(movements: T[]) {
  const ids = movements.flatMap((m) => (m.operationId ? [m.operationId] : []));
  const payloads = new Map(
    (
      appDb()
        .prepare(
          'SELECT operation_id, payload FROM intents WHERE operation_id IN (SELECT value FROM json_each(?))',
        )
        .all(JSON.stringify(ids)) as { operation_id: string; payload: string }[]
    ).map((r) => [r.operation_id, r.payload]),
  );
  return movements.map((m) => {
    const payload = m.operationId ? payloads.get(m.operationId) : undefined;
    if (!payload) return m;
    const { fromAccountId, toAccountId, concept } = JSON.parse(payload) as TransferInput;
    return { ...m, fromAccountId, toAccountId, concept };
  });
}
// R8: "Historical evidence that was never recorded must not be invented." Each step of a
// transfer's timeline is a stored row or event: the intent (proposed), its approval (confirmed,
// or expired unconfirmed) and the transfer.* events of dispatch, retry and verification.
const STEP_LABELS: Record<string, string> = {
  // AR1-a: events from before the reason was recorded keep the customer wording.
  cancelled: 'Cancelled by you. No money moved',
  'cancelled:replaced': 'Replaced by a corrected proposal. No money moved',
  'cancelled:withdrawn':
    'Withdrawn automatically: the proposal it corrected was already closed. No money moved',
  started: 'Sent to the bank',
  // PL1: a retry follows a timeout or a 5xx answer (reject-before), so the copy covers both.
  retry: 'The bank did not confirm; sent again with the same reference',
  completed: 'Completed by the bank',
  pending_verification: 'Outcome unknown; verifying with the bank',
  failed: 'Rejected. No money moved',
};
export function transferTimelines(userId: string, limit = 8) {
  const db = appDb(),
    now = new Date().toISOString();
  const intents = db
    .prepare('SELECT * FROM intents WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as IntentRow[];
  return intents.map((i) => {
    const approval = db.prepare('SELECT * FROM approvals WHERE intent_id=?').get(i.id) as
      ApprovalRow | undefined;
    const events = db
      .prepare(
        "SELECT kind,data,created_at FROM events WHERE kind LIKE 'transfer.%' AND kind<>'transfer.proposed' AND json_extract(data,'$.intentId')=? ORDER BY created_at,rowid",
      )
      .all(i.id) as { kind: string; data: string; created_at: string }[];
    const expired = !!approval && !approval.consumed_at && approval.expires_at <= now;
    const steps = [
      {
        kind: 'proposed',
        label: approval ? 'Proposed for your review' : 'Requested',
        at: i.created_at,
      },
      ...(approval?.consumed_at && i.status !== 'cancelled'
        ? [{ kind: 'confirmed', label: 'Confirmed by you', at: approval.consumed_at }]
        : []),
      ...(expired
        ? [{ kind: 'expired', label: 'Expired without confirmation', at: approval.expires_at }]
        : []),
      ...events.map((e) => {
        const kind = e.kind.slice('transfer.'.length),
          data = JSON.parse(e.data);
        const label =
          kind === 'verified'
            ? data.status === 'completed'
              ? 'Verified with the bank: completed'
              : 'Verified with the bank: not registered, no money moved'
            : (STEP_LABELS[`${kind}:${data.reason}`] ?? STEP_LABELS[kind] ?? kind);
        return { kind, label, at: e.created_at };
      }),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return {
      intentId: i.id,
      approvalId: approval?.id ?? null,
      status: expired && i.status === 'awaiting_confirmation' ? 'expired' : i.status,
      transfer: JSON.parse(i.payload) as TransferInput,
      reference: i.bank_reference,
      // FX1: the transfer's own date: the bank's execution time once recorded (by the completion
      // or by a verification), else when it was asked for. Never the time of a later check.
      date:
        events
          .map((e) => JSON.parse(e.data))
          .map((d) => d.operation?.createdAt ?? d.executedAt)
          .find(Boolean) ?? i.created_at,
      steps,
    };
  });
}
// F3: follow-up "did my transfer go through?" - the customer's latest transfers, verified.
export async function recentTransfers(userId: string): Promise<ActionResult> {
  const rows = appDb()
    .prepare(
      'SELECT id FROM intents WHERE user_id=? AND bank_reference IS NOT NULL ORDER BY created_at DESC LIMIT 5',
    )
    .all(userId) as { id: string }[];
  // K2: the (at most 5) lookups run concurrently; Promise.all keeps the newest-first order.
  const transfers = await Promise.all(rows.map((row) => verifyIntent(userId, row.id)));
  return { status: 'ok', transfers };
}
// Execution path (F1: one bank reference per intent). In the app it runs only from
// confirmApproval, after the review (F2); tests call it directly.
export async function transferMoney(ctx: ToolContext, args: unknown): Promise<ActionResult> {
  if (person(ctx.userId)?.role !== 'customer')
    throw new HttpError(403, 'A customer account is required.');
  const input = transferSchema.parse(args),
    db = appDb();
  const previous = db
    .prepare('SELECT user_id,payload FROM intents WHERE id=?')
    .get(ctx.intentId) as { user_id: string; payload: string } | undefined;
  if (previous && (previous.user_id !== ctx.userId || previous.payload !== JSON.stringify(input)))
    throw new HttpError(409, 'This intent belongs to a different payload.');
  insert(
    'intents',
    {
      id: ctx.intentId,
      user_id: ctx.userId,
      conversation_id: ctx.conversationId,
      run_id: ctx.runId,
      payload: JSON.stringify(input),
      status: 'created',
      created_at: new Date().toISOString(),
    },
    { orIgnore: true },
  );
  await authorizeTransfer(ctx, input);
  db.prepare('UPDATE intents SET status=? WHERE id=?').run('processing', ctx.intentId);
  recordEvent(ctx, 'transfer.started', { status: 'processing', input, intentId: ctx.intentId });
  try {
    const operation = await dispatchTransfer(ctx, input);
    db.prepare('UPDATE intents SET status=?,operation_id=?,error=NULL WHERE id=?').run(
      'completed',
      operation.id,
      ctx.intentId,
    );
    recordEvent(ctx, 'transfer.completed', {
      status: 'completed',
      operation,
      intentId: ctx.intentId,
    });
    return { status: 'completed', operation, intentId: ctx.intentId };
  } catch (e) {
    // F3: a 5xx or transport error/timeout (504) after the retries is an unknown outcome,
    // never a failure: mark it pending and verify by reference. T3: so is any error that
    // follows an uncertain attempt.
    if (e instanceof BankError && (e.status >= 500 || e.uncertain)) {
      db.prepare('UPDATE intents SET status=?,error=? WHERE id=?').run(
        'pending_verification',
        e.message,
        ctx.intentId,
      );
      recordEvent(ctx, 'transfer.pending_verification', {
        status: 'pending_verification',
        error: e.message,
        intentId: ctx.intentId,
      });
      return verifyIntent(ctx.userId, ctx.intentId, 3, false);
    }
    // K6: an unexpected app error is logged with its stack; the customer gets plain words.
    if (!(e instanceof BankError)) {
      log('error', 'transfer_failed_internal', {
        intentId: ctx.intentId,
        ...(e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : { error: String(e) }),
      });
      // PT1-F1: "A transport error or timeout does not prove that the bank rejected the
      // operation." The reference is saved before the first POST, so once it exists the bank was
      // or may have been called: an app error from there on (the result or a retry could not be
      // written) is an unknown outcome to verify, never `failed`; a stored `completed` stays.
      const { bank_reference } = db
        .prepare('SELECT bank_reference FROM intents WHERE id=?')
        .get(ctx.intentId) as { bank_reference: string | null };
      if (bank_reference) {
        const unknown = db
          .prepare(
            "UPDATE intents SET status='pending_verification',error=? WHERE id=? AND status<>'completed'",
          )
          .run(PENDING_MESSAGE, ctx.intentId).changes;
        if (unknown)
          recordEvent(ctx, 'transfer.pending_verification', {
            status: 'pending_verification',
            error: 'The app could not record the result.',
            intentId: ctx.intentId,
          });
        return verifyIntent(ctx.userId, ctx.intentId, 3, false);
      }
    }
    const explained =
      e instanceof BankError
        ? await explainBankError(ctx.userId, e, input)
        : {
            error:
              'The transfer could not be completed because of an error in the app. Ask for human support before trying again.',
          };
    db.prepare('UPDATE intents SET status=?,error=? WHERE id=?').run(
      'failed',
      explained.error,
      ctx.intentId,
    );
    recordEvent(ctx, 'transfer.failed', {
      status: 'failed',
      error: explained.error,
      intentId: ctx.intentId,
    });
    return { status: 'failed', ...explained, intentId: ctx.intentId };
  }
}
