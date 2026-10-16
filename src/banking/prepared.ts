// PT1 (plan 25): prepared transfers. The customer leaves a transfer ready (who, how much, from
// where, what for, a note) and sends it later: when they say, on a date, or every month.
// Contract: "A sensitive operation must present its amount, source, and destination for explicit
// review before execution." Nothing here executes: Send only calls proposeTransfer, so the
// existing review and confirmApproval stay the one path that moves money. This file reads and
// writes the app database; its only bank traffic is the two reads inside resolveTransfer.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appDb, insert } from '../db';
import { HttpError } from '../auth';
import { person } from '../people';
import { recordEvent } from '../telemetry';
import { text } from '../http';
import { accountName } from '../ui-helpers';
import { cancelApproval, proposeTransfer, resolveTransfer } from './actions';
import type { ActionResult, IntentStatus, ToolContext } from '../types';
type When =
  { kind: 'manual' } | { kind: 'on_date'; date: string } | { kind: 'monthly'; day: number };
export type PreparedView = {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  // The destination's name when it was prepared (the views that make no bank call show it).
  to: string;
  amountCents: number;
  concept: string;
  note: string | null;
  when: When;
  nextDue: string | null;
  state: 'verifying' | 'awaiting_confirmation' | 'paused' | 'due' | 'scheduled' | 'ready';
  approvalId: string | null;
  expiresAt: string | null;
  lastAttempt: 'expired' | 'cancelled' | 'failed' | null;
  lastSentAt: string | null;
};
type Row = {
  id: string;
  user_id: string;
  from_account_id: string;
  to_account_id: string;
  to_name: string;
  amount_cents: number;
  concept: string;
  note: string | null;
  kind: When['kind'];
  day: number | null;
  next_due: string | null;
  paused: number;
  attempt: number;
  status: 'active' | 'sent' | 'deleted';
  last_sent_at: string | null;
  created_at: string;
  goal_id: string | null;
};
export const MAX_ACTIVE = 20; // FC1: the forecast offers no cover option at the limit
// D9: due is computed on read from dates ('YYYY-MM-DD', compared as strings) in the app's zone.
export const today = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
const parts = (date: string) => date.split('-').map(Number);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const [y, m, d] = parts(date);
  return iso(Date.UTC(y, m - 1, d + days));
};
// The occurrence of anchor `day` in the month of `date`, `months` later: day 31 is 30 Nov, 28 or
// 29 Feb, 31 Mar (the anchor is kept, so it never drifts to 28). Exported for GL1: a goal's plan
// counts the same occurrences its prepared transfer will have (one date rule, not two).
export function occurrence(date: string, day: number, months = 0) {
  const [y, m] = parts(date);
  const lastDay = new Date(Date.UTC(y, m + months, 0)).getUTCDate();
  return iso(Date.UTC(y, m - 1 + months, Math.min(day, lastDay)));
}
export const firstDue = (from: string, day: number) =>
  occurrence(from, day) >= from ? occurrence(from, day) : occurrence(from, day, 1);
const fail = (code: string, error: string): ActionResult => ({ status: 'failed', code, error });
const NOT_ACTIVE = fail(
  'not_active',
  'This prepared transfer is no longer in your list: it was already sent or deleted. No money moved.',
);
const PAUSED = fail(
  'paused',
  'This prepared transfer is paused. Resume it first. Nothing was sent.',
);
// D5: one occurrence (`once`, or the due date of a monthly one) has one intent per send attempt.
const keyOf = (row: Row) => (row.kind === 'monthly' ? row.next_due! : 'once');
const intentIdOf = (row: Row) => `prepared:${row.id}:${keyOf(row)}:${row.attempt}`;
type Attempt = {
  intentId: string;
  // none: no proposal yet. live: a proposal the customer can still confirm. unknown: confirmed
  // and not settled (D6). expired, cancelled, failed: ended with no money moved.
  state: 'none' | 'live' | 'unknown' | 'completed' | 'expired' | 'cancelled' | 'failed';
  approvalId?: string;
  expiresAt?: string;
  consumedAt?: string | null;
  conversationId?: string | null;
};
function attemptOf(row: Row): Attempt {
  const db = appDb(),
    intentId = intentIdOf(row);
  const intent = db
    .prepare('SELECT status, conversation_id FROM intents WHERE id=?')
    .get(intentId) as { status: IntentStatus; conversation_id: string | null } | undefined;
  if (!intent) return { intentId, state: 'none' };
  const approval = db
    .prepare('SELECT id, expires_at, consumed_at FROM approvals WHERE intent_id=?')
    .get(intentId) as { id: string; expires_at: string; consumed_at: string | null } | undefined;
  const { status } = intent;
  // A consumed approval whose intent still awaits confirmation is a confirm in flight: unknown.
  // The expiry is read with the real clock, the one confirmApproval uses, never an injected one.
  const state =
    status === 'completed' || status === 'cancelled' || status === 'failed'
      ? status
      : status === 'awaiting_confirmation' && approval && !approval.consumed_at
        ? approval.expires_at > new Date().toISOString()
          ? 'live'
          : 'expired'
        : 'unknown';
  return {
    intentId,
    state,
    approvalId: approval?.id,
    expiresAt: approval?.expires_at,
    consumedAt: approval?.consumed_at,
    conversationId: intent.conversation_id,
  };
}
const rowOf = (id: string) =>
  appDb().prepare('SELECT * FROM prepared_transfers WHERE id=?').get(id) as Row;
// D10: a sent occurrence is closed when it is next read. The UPDATE is guarded by the occurrence
// and attempt it read, so `prepared.sent` is recorded once however many readers race. Returns the
// row as it is now, with the open occurrence's attempt.
function settle(row: Row): { row: Row; attempt: Attempt } {
  const attempt = attemptOf(row);
  if (row.status !== 'active' || attempt.state !== 'completed') return { row, attempt };
  const db = appDb(),
    at = attempt.consumedAt ?? new Date().toISOString();
  db.transaction(() => {
    const { changes } =
      row.kind === 'monthly'
        ? db
            .prepare(
              "UPDATE prepared_transfers SET next_due=?,attempt=0,last_sent_at=? WHERE id=? AND status='active' AND next_due=? AND attempt=?",
            )
            .run(occurrence(row.next_due!, row.day!, 1), at, row.id, row.next_due, row.attempt)
        : db
            .prepare(
              "UPDATE prepared_transfers SET status='sent',last_sent_at=? WHERE id=? AND status='active' AND attempt=?",
            )
            .run(at, row.id, row.attempt);
    if (changes)
      recordEvent(
        {
          userId: row.user_id,
          conversationId: attempt.conversationId ?? null,
          runId: randomUUID(),
          intentId: attempt.intentId,
        },
        'prepared.sent',
        { preparedId: row.id, occurrence: keyOf(row), intentId: attempt.intentId },
      );
  })();
  const now = rowOf(row.id);
  return { row: now, attempt: attemptOf(now) };
}
const whenOf = (row: Row): When =>
  row.kind === 'monthly'
    ? { kind: 'monthly', day: row.day! }
    : row.kind === 'on_date'
      ? { kind: 'on_date', date: row.next_due! }
      : { kind: 'manual' };
function view(row: Row, attempt: Attempt, now: Date): PreparedView {
  const live = attempt.state === 'live';
  return {
    id: row.id,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    to: row.to_name,
    amountCents: row.amount_cents,
    concept: row.concept,
    note: row.note,
    when: whenOf(row),
    nextDue: row.next_due,
    state:
      attempt.state === 'unknown'
        ? 'verifying'
        : live
          ? 'awaiting_confirmation'
          : row.paused
            ? 'paused'
            : row.kind === 'manual'
              ? 'ready'
              : row.next_due! <= today(now)
                ? 'due'
                : 'scheduled',
    approvalId: live ? attempt.approvalId! : null,
    expiresAt: live ? attempt.expiresAt! : null,
    lastAttempt:
      attempt.state === 'expired' || attempt.state === 'cancelled' || attempt.state === 'failed'
        ? attempt.state
        : null,
    lastSentAt: row.last_sent_at,
  };
}
const ORDER = ['due', 'awaiting_confirmation', 'verifying', 'scheduled', 'ready', 'paused'];
// The customer's prepared transfers, due first (oldest first). App database only: no bank call.
export function preparedList(userId: string, now = new Date()): PreparedView[] {
  const rows = appDb()
    .prepare(
      "SELECT * FROM prepared_transfers WHERE user_id=? AND status='active' ORDER BY created_at,rowid",
    )
    .all(userId) as Row[];
  return rows
    .map(settle)
    .filter((s) => s.row.status === 'active')
    .map((s) => view(s.row, s.attempt, now))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
        (a.nextDue ?? '').localeCompare(b.nextDue ?? ''),
    );
}
// Customer-only, actor from the session; another customer's id is the same 404 as an unknown one.
function owned(ctx: ToolContext, id: string) {
  if (person(ctx.userId)?.role !== 'customer')
    throw new HttpError(403, 'A customer account is required.');
  const row = appDb()
    .prepare('SELECT * FROM prepared_transfers WHERE id=? AND user_id=?')
    .get(id, ctx.userId) as Row | undefined;
  if (!row) throw new HttpError(404, 'Prepared transfer not found.');
  return row;
}
const whenSchema = z.object({
  note: text(z.string().trim().max(140)).nullish(), // FX3
  when: z.enum(['manual', 'on_date', 'monthly']),
  date: z.string().nullish(),
  inDays: z.number().int().nullish(),
  day: z.number().int().min(1).max(31).nullish(),
});
// D8: source, destination, amount and concept are checked now (resolveTransfer); the balance is
// not, the money has to be there on the day it is sent. Writes one row; no intent, no approval.
// GL1: `goalId` ties the row to a savings goal. It is an argument of the server's own callers
// (src/goals/store.ts), never read from `args`: a request body cannot attach a transfer to a goal.
export async function prepareTransfer(
  ctx: ToolContext,
  args: unknown,
  now = new Date(),
  goalId?: string,
): Promise<ActionResult> {
  if (person(ctx.userId)?.role !== 'customer')
    throw new HttpError(403, 'A customer account is required.');
  const { note, when, date, inDays, day, ...transfer } = (
    args && typeof args === 'object' ? args : {}
  ) as Record<string, unknown>;
  const parsed = whenSchema.safeParse({ note, when, date, inDays, day });
  if (!parsed.success || (parsed.data.when === 'monthly' && !parsed.data.day))
    return fail(
      'invalid_request',
      parsed.error?.issues[0].path[0] === 'note'
        ? 'The note can have at most 140 characters. Nothing was sent.'
        : 'Say when it should be ready: when you say, on a date, or a day of the month from 1 to 31. Nothing was sent.',
    );
  const w = parsed.data,
    from = today(now);
  let nextDue: string | null = null;
  if (w.when === 'monthly') nextDue = firstDue(from, w.day!);
  if (w.when === 'on_date') {
    // "In 7 days" becomes a date here, on the server; a date wins when both are given.
    nextDue = w.date ?? (w.inDays && w.inDays > 0 ? addDays(from, w.inDays) : '');
    const real = /^\d{4}-\d{2}-\d{2}$/.test(nextDue) && addDays(nextDue, 0) === nextDue;
    if (!real || nextDue < from || nextDue > addDays(from, 366))
      return fail(
        'invalid_date',
        'Choose a date from today to one year ahead, or a number of days from 1 to 366. Nothing was sent.',
      );
  }
  const resolved = await resolveTransfer(ctx, {
    ...transfer,
    fromAccountId: transfer.fromAccountId ?? null,
  });
  if ('status' in resolved) return resolved;
  const { input, accounts, contacts } = resolved,
    db = appDb(),
    id = randomUUID(),
    to = accountName(input.toAccountId, { accounts, contacts });
  // Synchronous from here: the limit and the insert cannot interleave with another request.
  const { n } = db
    .prepare("SELECT COUNT(*) n FROM prepared_transfers WHERE user_id=? AND status='active'")
    .get(ctx.userId) as { n: number };
  if (n >= MAX_ACTIVE)
    return fail(
      'too_many',
      `You already have ${MAX_ACTIVE} prepared transfers. Delete one before preparing another. Nothing was sent.`,
    );
  db.transaction(() => {
    insert('prepared_transfers', {
      id,
      user_id: ctx.userId,
      from_account_id: input.fromAccountId,
      to_account_id: input.toAccountId,
      to_name: to,
      amount_cents: input.amountCents,
      concept: input.concept,
      note: w.note || null,
      kind: w.when,
      day: w.when === 'monthly' ? w.day : null,
      next_due: nextDue,
      created_at: new Date().toISOString(),
      goal_id: goalId,
    });
    const row = rowOf(id);
    recordEvent(ctx, 'prepared.created', {
      preparedId: id,
      input,
      to,
      when: whenOf(row),
      note: row.note,
    });
  })();
  const row = rowOf(id);
  return { status: 'prepared', prepared: view(row, attemptOf(row), now) };
}
// D3: Send is not the confirmation. It creates the usual proposal, re-validated now (ownership,
// destination, limit, balance); the customer confirms it in the existing card.
export async function sendPrepared(ctx: ToolContext, id: string): Promise<ActionResult> {
  owned(ctx, id);
  const db = appDb();
  // No await before this write. One transaction closes a completed occurrence (D10), then picks
  // the attempt: a new number only after one that ended with no money moved (D5). A second tap or
  // a parallel request reads the same number, so proposeTransfer converges on one proposal (the
  // intent id is its primary key); with an unknown or completed outcome the number is kept, so
  // proposeTransfer answers that outcome and creates nothing (D6).
  const picked = db
    .transaction(() => {
      const { row, attempt } = settle(owned(ctx, id));
      if (row.status !== 'active') return NOT_ACTIVE;
      if (row.paused) return PAUSED;
      const ended = ['expired', 'cancelled', 'failed'].includes(attempt.state);
      if (ended || !row.attempt)
        db.prepare('UPDATE prepared_transfers SET attempt=attempt+1 WHERE id=?').run(id);
      return rowOf(id);
    })
    .immediate();
  if ('status' in picked && picked.status === 'failed') return picked as ActionResult;
  const row = picked as Row;
  const result = await proposeTransfer(
    { ...ctx, intentId: intentIdOf(row) },
    {
      fromAccountId: row.from_account_id,
      toAccountId: row.to_account_id,
      amountCents: row.amount_cents,
      concept: row.concept,
    },
  );
  // A skip, pause or delete that ran during the bank reads above saw no proposal to refuse on:
  // the proposal made for the occurrence it closed is withdrawn before it can be confirmed.
  if (result.status === 'requires_confirmation') {
    const now = rowOf(id);
    if (now.status !== 'active' || now.paused || keyOf(now) !== keyOf(row)) {
      await cancelApproval(ctx.userId, (result.approval as { id: string }).id);
      return now.status === 'active' && now.paused ? PAUSED : NOT_ACTIVE;
    }
  }
  return result;
}
export function changePrepared(
  ctx: ToolContext,
  id: string,
  action: 'skip' | 'pause' | 'resume' | 'delete',
  now = new Date(),
): ActionResult {
  const db = appDb();
  return db
    .transaction((): ActionResult => {
      if (action === 'delete' && owned(ctx, id).status === 'deleted') return { status: 'deleted' };
      const { row, attempt } = settle(owned(ctx, id));
      if (row.status !== 'active') return NOT_ACTIVE;
      // D6: with a proposal waiting or an outcome the bank has not confirmed, nothing changes.
      if (attempt.state === 'live')
        return fail(
          'prepared_in_progress',
          'This prepared transfer has a proposal waiting for you. Confirm or cancel it first. Nothing was sent.',
        );
      if (attempt.state === 'unknown')
        return fail(
          'prepared_in_progress',
          'The bank has not confirmed the last send yet, so this prepared transfer cannot change now. Do not send it again.',
        );
      const event = (kind: string, data = {}) =>
        recordEvent(ctx, `prepared.${kind}`, { preparedId: id, ...data });
      if (action === 'delete') {
        db.prepare("UPDATE prepared_transfers SET status='deleted' WHERE id=?").run(id);
        event('deleted');
        return { status: 'deleted' };
      }
      if (row.kind !== 'monthly')
        return fail(
          'not_monthly',
          'Only a monthly prepared transfer can be skipped, paused or resumed. Nothing was sent.',
        );
      if (action === 'skip') {
        if (row.paused) return PAUSED;
        // D11: the next occurrence is the month after the skipped one, not after today.
        db.prepare('UPDATE prepared_transfers SET next_due=?,attempt=0 WHERE id=?').run(
          occurrence(row.next_due!, row.day!, 1),
          id,
        );
        event('skipped', { occurrence: row.next_due });
      } else if (action === 'pause' && !row.paused) {
        db.prepare('UPDATE prepared_transfers SET paused=1 WHERE id=?').run(id);
        event('paused');
      } else if (action === 'resume' && row.paused) {
        // Months missed while paused are dropped; a month already paid early is not reopened.
        const next = [row.next_due!, firstDue(today(now), row.day!)].sort()[1];
        db.prepare(
          'UPDATE prepared_transfers SET paused=0,next_due=?,attempt=CASE WHEN next_due=? THEN attempt ELSE 0 END WHERE id=?',
        ).run(next, next, id);
        event('resumed');
      }
      const fresh = rowOf(id);
      return { status: 'ok', prepared: view(fresh, attemptOf(fresh), now) };
    })
    .immediate();
}
