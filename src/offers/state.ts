// XS2: what a customer was already suggested, whether a suggestion is allowed in this turn, and
// how an answer is recorded (plan 24 §3, §5). App database only: no bank request, no model call.
// State is events only (D8): they survive a restart, are hash-chained, and seedApp wipes them.
// ponytail: each read scans the customer's events without an index; a table when events pass ~100k rows.
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { appDb, insert } from '../db';
import { recordEvent } from '../telemetry';
import type { ToolContext } from '../types';
import type { OfferId } from './catalogue';
// ponytail: a word list, not a classifier; the first-turn rule and XS3's clean-turn rule carry the weight.
const PROBLEM =
  /\b(problem|error|wrong|fail\w*|complain\w*|fraud|stolen|lost|urgent|queja|problema|fallo|robo|urgente)\b/i;
const exists = (sql: string, ...params: unknown[]) =>
  !!appDb()
    .prepare(sql)
    .get(...params);

export function offerHistory(userId: string): {
  shown: OfferId[];
  lastShownAt: string | null;
  disabled: boolean;
} {
  const rows = appDb()
    .prepare(
      "SELECT kind,data,created_at FROM events WHERE user_id=? AND kind IN ('offer.shown','offers.disabled','offers.enabled') ORDER BY created_at,rowid",
    )
    .all(userId) as { kind: string; data: string; created_at: string }[];
  const shown = rows.filter((r) => r.kind === 'offer.shown');
  return {
    shown: shown.map((r) => JSON.parse(r.data).offerId),
    lastShownAt: shown.at(-1)?.created_at ?? null,
    disabled: rows.filter((r) => r.kind !== 'offer.shown').at(-1)?.kind === 'offers.disabled',
  };
}

// REQ-XS-6: the first rule that refuses names the reason. `attached` = a movement is attached to
// the message; `awaiting` = the previous answer left a question open (round 7).
export function offerGate(a: {
  userId: string;
  conversationId: string;
  content: string;
  attached: boolean;
  awaiting: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const history = offerHistory(a.userId);
  const rules: [string, () => unknown][] = [
    ['off', () => config.offers === 'off'],
    ['disabled', () => history.disabled],
    [
      'first_turn',
      () =>
        !exists(
          "SELECT 1 FROM messages WHERE conversation_id=? AND role='assistant'",
          a.conversationId,
        ),
    ],
    [
      // D7, one suggestion per conversation and never insisting: also done when the customer
      // answered a product here (click or words) or asked about one (review of #117).
      'conversation_done',
      () =>
        exists(
          "SELECT 1 FROM events WHERE conversation_id=? AND (kind IN ('offer.shown','offer.declined','offer.interest') OR (kind='tool.completed' AND json_extract(data,'$.tool') IN ('get_offer_details','offer_response')))",
          a.conversationId,
        ),
    ],
    [
      'cooldown',
      () =>
        history.lastShownAt &&
        Date.now() - Date.parse(history.lastShownAt) < config.offersCooldownDays * 86_400_000,
    ],
  ];
  const reason = rules.find(([, refuses]) => refuses())?.[0] ?? turnTrouble(a);
  return reason ? { ok: false, reason } : { ok: true };
}

// OB1 (plan 26 D7): the trouble rules of the gate above, extracted unchanged so that the chat can
// keep a spending observation out of a turn in trouble. The first rule that holds, or null.
export function turnTrouble(a: {
  userId: string;
  conversationId: string;
  content: string;
  attached: boolean;
  awaiting: boolean;
}): string | null {
  const rules: [string, () => unknown][] = [
    [
      'open_case',
      () =>
        exists(
          "SELECT 1 FROM incidents WHERE conversation_id=? AND status='open'",
          a.conversationId,
        ),
    ],
    [
      'transfer_trouble',
      () =>
        exists(
          "SELECT 1 FROM intents WHERE (conversation_id=? AND status IN ('failed','pending_verification','processing')) OR (user_id=? AND status IN ('pending_verification','processing'))",
          a.conversationId,
          a.userId,
        ),
    ],
    [
      'pending_approval',
      () =>
        exists(
          'SELECT 1 FROM approvals WHERE user_id=? AND consumed_at IS NULL AND expires_at>?',
          a.userId,
          new Date().toISOString(),
        ),
    ],
    [
      // The turn's own run is still 'running': the newest finished one is the previous run.
      'failed_run',
      () =>
        exists(
          "SELECT 1 FROM (SELECT status FROM runs WHERE conversation_id=? AND status<>'running' ORDER BY started_at DESC,rowid DESC LIMIT 1) WHERE status='failed'",
          a.conversationId,
        ),
    ],
    ['mid_flow', () => a.awaiting || a.attached],
    ['problem', () => PROBLEM.test(a.content)],
  ];
  return rules.find(([, refuses]) => refuses())?.[0] ?? null;
}

// Idempotent per customer, offer and kind: a repeated call records nothing and returns the first
// result. `data` goes into the event (`name` and `basis` are what the operator reads).
// REQ-XS-8: interest reuses the conversation's open case or opens one, as request_human does.
export function recordOffer(
  ctx: ToolContext,
  kind: 'shown' | 'declined' | 'interest',
  offerId: OfferId,
  data: Record<string, unknown> = {},
): { status: 'ok'; incidentId?: string } {
  const db = appDb();
  return db.transaction(() => {
    const first = db
      .prepare(
        "SELECT json_extract(data,'$.incidentId') incidentId FROM events WHERE user_id=? AND kind=? AND json_extract(data,'$.offerId')=?",
      )
      .get(ctx.userId, `offer.${kind}`, offerId) as { incidentId: string | null } | undefined;
    if (first)
      return first.incidentId
        ? { status: 'ok' as const, incidentId: first.incidentId }
        : { status: 'ok' as const };
    if (kind !== 'interest') {
      recordEvent(ctx, `offer.${kind}`, { ...data, offerId });
      return { status: 'ok' as const };
    }
    if (!ctx.conversationId) throw new Error('A conversation is required to open a case.');
    const open = db
      .prepare("SELECT id FROM incidents WHERE conversation_id=? AND status='open'")
      .pluck()
      .get(ctx.conversationId) as string | undefined;
    const incidentId = open ?? randomUUID();
    if (!open)
      insert('incidents', {
        id: incidentId,
        user_id: ctx.userId,
        conversation_id: ctx.conversationId,
        summary: `Product interest: ${typeof data.name === 'string' ? data.name : offerId}. The customer asked to be contacted by a manager. Nothing was contracted.`,
        status: 'open',
        created_at: new Date().toISOString(),
      });
    recordEvent(ctx, 'offer.interest', { ...data, offerId, incidentId });
    return { status: 'ok' as const, incidentId };
  })();
}

export function setOffersEnabled(ctx: ToolContext, enabled: boolean): void {
  if (offerHistory(ctx.userId).disabled === enabled)
    recordEvent(ctx, enabled ? 'offers.enabled' : 'offers.disabled', {});
}
