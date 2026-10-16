import { appDb } from '../db';
import type { CategoryId } from '../insights/taxonomy';
import type { OfferExtras, OfferId } from '../offers/catalogue';
import { randomUUID } from 'node:crypto';
import { shortRef } from '../ui-helpers';
// SI6a — contracts.md §2: `message_extras.data`. Everything here is written by the server from bank
// and app records; nothing is taken from the client or from model text.
export type AttachedMovement = {
  id: string;
  title: string;
  amountCents: number;
  createdAt: string;
};
export type MessageExtras = {
  movement?: AttachedMovement;
  quickReplies?: { label: string; value: string }[];
  // What the customer's next answer is about. Server-side only: never sent to the browser.
  awaiting?: { movementIds: string[]; merchantKey: string; offer?: { category: CategoryId } };
  citedMovements?: (AttachedMovement & { category: CategoryId })[];
  // XS3 (plan 24 §6): the suggestion the quick replies of this message are about. Server-side
  // only, like `awaiting`.
  awaitingOffer?: { offerId: OfferId; stage: 'offered' | 'details' };
  // HS2: this message is the stored answer of a turn the assistant could not run or finish: the
  // API `code` of the 502 (missing_openai_api_key, provider_refused, provider_busy, turn_failed,
  // ai_daily_limit), or `no_answer` for a completed turn that produced no text. Never the
  // internal reason.
  turnFailed?: string;
  // HS2: this message confirms a support case the customer opened without the model.
  handoff?: { incidentId: string; reference: string };
  // GL3 (plan 28 D6): the savings plan `plan_goal` showed with this message, every figure the
  // server's. The page draws the plan card from it; `create_goal` creates exactly this plan, and
  // only while this is the conversation's newest answer.
  goalPlan?: GoalPlan;
  // GL3: the goal `create_goal` created in this turn (one monthly prepared transfer; nothing sent).
  goalCreated?: GoalCreated;
} & OfferExtras;
export type GoalCreated = {
  id: string;
  name: string;
  monthlyCents: number;
  firstDue: string;
  targetCents: number;
  targetDate: string;
  today: string; // the bank-local day it was created, as `GoalPlan.today`
};
export type GoalPlan = {
  name: string;
  targetCents: number;
  targetDate: string;
  day: number; // of the month
  from: { id: string; label: string };
  to: { id: string; label: string };
  monthlyCents: number;
  payments: number;
  firstDue: string;
  lastDue: string;
  fits: boolean | null; // against `room`; null when there is no full month to measure it
  room: { monthlyCents: number; months: number } | null;
  today: string; // the day the plan was worked out
};
export function saveExtras(messageId: string, data: MessageExtras) {
  appDb()
    .prepare('INSERT INTO message_extras(message_id,data) VALUES(?,?)')
    .run(messageId, JSON.stringify(data));
}
// HS2: `request_human` called by the customer directly (POST /api/actions, no model) leaves the
// confirmation the customer reads as an assistant message; the model's own handoff is its answer.
// The sentence and the reference format (the operator's case reference) live here only. A repeat
// while this confirmation is still the conversation's newest message stores nothing.
// FX7: at the customer's limit of open requests no case was opened for this conversation and
// `incidentId` is their most recent open one: the sentence says so.
export function storeHandoffMessage(
  conversationId: string,
  incidentId: string,
  limitReached = false,
) {
  const db = appDb();
  db.transaction(() => {
    const newest = db
      .prepare(
        'SELECT e.data FROM messages m LEFT JOIN message_extras e ON e.message_id=m.id WHERE m.conversation_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1',
      )
      .pluck()
      .get(conversationId) as string | null | undefined;
    if (newest && (JSON.parse(newest) as MessageExtras).handoff?.incidentId === incidentId) return;
    const id = randomUUID(),
      reference = shortRef(incidentId);
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
      id,
      conversationId,
      'assistant',
      limitReached
        ? `You already have open support requests (most recent reference ${reference}). A person from the bank will review them. No new request was opened for this conversation.`
        : `A support request is open for this conversation (reference ${reference}). A person from the bank will review it.`,
      new Date().toISOString(),
      null,
    );
    saveExtras(id, { handoff: { incidentId, reference } });
  }).immediate();
}
// The extras of a conversation's messages by message id, as the conversation GET sends them.
export function extrasFor(conversationId: string) {
  const rows = appDb()
    .prepare(
      'SELECT e.message_id,e.data FROM message_extras e JOIN messages m ON m.id=e.message_id WHERE m.conversation_id=?',
    )
    .all(conversationId) as { message_id: string; data: string }[];
  return new Map(
    rows.map((r) => {
      const { awaiting: _, awaitingOffer: __, ...sent } = JSON.parse(r.data) as MessageExtras;
      return [r.message_id, sent] as const;
    }),
  );
}
// The stored extras of the conversation's newest assistant message (`awaiting` included), or null.
export function latestExtras(conversationId: string) {
  const data = appDb()
    .prepare(
      "SELECT e.data FROM messages m LEFT JOIN message_extras e ON e.message_id=m.id WHERE m.conversation_id=? AND m.role='assistant' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
    )
    .pluck()
    .get(conversationId) as string | null | undefined;
  return data ? (JSON.parse(data) as MessageExtras) : null;
}
// The `awaiting` of the conversation's newest assistant message, or null: an answer without one
// closes the question.
export const latestAwaiting = (conversationId: string) =>
  latestExtras(conversationId)?.awaiting ?? null;
// SI6b (review of #102): the target of a quick-reply click. When the customer message of this run
// is exactly a reply value of the newest assistant message, the answer is about that message's
// `awaiting`; otherwise (typed words, no buttons, no target) null.
export function clickedTarget(conversationId: string, runId: string) {
  const last = latestExtras(conversationId);
  if (!last?.awaiting || !last.quickReplies) return null;
  const content = appDb()
    .prepare("SELECT content FROM messages WHERE conversation_id=? AND run_id=? AND role='user'")
    .pluck()
    .get(conversationId, runId);
  return last.quickReplies.some((r) => r.value === content) ? last.awaiting : null;
}
// SI6b: the movement attached to the conversation's newest user message that has one, or null.
// The digest keeps naming it on later turns (tool results of earlier turns are not replayed).
export function latestAttachment(conversationId: string) {
  const data = appDb()
    .prepare(
      "SELECT e.data FROM message_extras e JOIN messages m ON m.id=e.message_id WHERE m.conversation_id=? AND m.role='user' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
    )
    .pluck()
    .get(conversationId) as string | undefined;
  return data ? ((JSON.parse(data) as MessageExtras).movement ?? null) : null;
}
