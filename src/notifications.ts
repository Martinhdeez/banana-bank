// CF5-api: notifications are derived at read time from records that already exist (a verified
// transfer outcome, an expiring or expired proposal, a resolved case), so they can never disagree
// with their source. Only read marks are stored. No bank call, no model call: the list works
// while the bank is down. Text is built on the client from the fields (money, time zone).
import { appDb, insert } from './db';
import { preparedList } from './banking/prepared';
const WINDOW_MS = 30 * 24 * 60 * 60_000,
  EXPIRING_MS = 3 * 60_000,
  MAX_ITEMS = 50;
export type NotificationItem = {
  id: string;
  kind:
    | 'transfer_verified'
    | 'proposal_expiring'
    | 'proposal_expired'
    | 'case_resolved'
    | 'prepared_due';
  at: string;
  read: boolean;
  status?: 'completed' | 'failed';
  amountCents?: number;
  to?: string;
  expiresAt?: string;
  link: { tab: 'transfers' } | { tab: 'assistant'; conversationId: string };
};
type Item = Omit<NotificationItem, 'read'>;
// DV7-B: the destination name recorded with the proposal, else the raw account id. The unary +
// drops i.id's affinity so the lookup uses the events_intent index instead of a scan.
const TO = `COALESCE((SELECT json_extract(p.data,'$.to') FROM events p WHERE p.kind='transfer.proposed'
  AND json_extract(p.data,'$.intentId')=+i.id), json_extract(i.payload,'$.toAccountId'))`;
function derive(userId: string, now: Date): Item[] {
  const db = appDb(),
    iso = now.toISOString(),
    since = new Date(now.getTime() - WINDOW_MS).toISOString(),
    soon = new Date(now.getTime() + EXPIRING_MS).toISOString();
  // settled() writes transfer.verified only when a later check changed the outcome (R7).
  const verified = db
    .prepare(
      `SELECT e.id, e.created_at AS at, json_extract(e.data,'$.status') AS status,
              json_extract(i.payload,'$.amountCents') AS amountCents, ${TO} AS "to"
       FROM events e JOIN intents i ON i.id=json_extract(e.data,'$.intentId') AND i.user_id=e.user_id
       WHERE e.kind='transfer.verified' AND e.user_id=? AND e.created_at>=? AND e.created_at<=?`,
    )
    .all(userId, since, iso) as {
    id: string;
    at: string;
    status: string;
    amountCents: number;
    to: string;
  }[];
  // R8: a proposal is expired when unconsumed past expires_at and its intent still awaits
  // confirmation; a cancel or confirm consumes it, so neither kind appears.
  const proposals = db
    .prepare(
      `SELECT a.id, a.expires_at AS expiresAt, i.status,
              json_extract(i.payload,'$.amountCents') AS amountCents, ${TO} AS "to"
       FROM approvals a JOIN intents i ON i.id=a.intent_id
       WHERE a.user_id=? AND a.consumed_at IS NULL AND a.expires_at>? AND a.expires_at<=?`,
    )
    .all(userId, since, soon) as {
    id: string;
    expiresAt: string;
    status: string;
    amountCents: number;
    to: string;
  }[];
  // The event's user_id is the operator's; the customer is the incident's owner.
  const resolved = db
    .prepare(
      `SELECT e.id, e.created_at AS at, n.conversation_id AS conversationId
       FROM events e JOIN incidents n ON n.id=json_extract(e.data,'$.incidentId')
       WHERE e.kind='case.resolved' AND n.user_id=? AND e.created_at>=? AND e.created_at<=?`,
    )
    .all(userId, since, iso) as { id: string; at: string; conversationId: string }[];
  const transfers = { tab: 'transfers' } as const;
  const items: Item[] = [
    ...verified
      .filter((v) => v.status === 'completed' || v.status === 'failed')
      .map((v): Item => ({
        id: `ev:${v.id}`,
        kind: 'transfer_verified',
        at: v.at,
        status: v.status as 'completed' | 'failed',
        amountCents: v.amountCents,
        to: v.to,
        link: transfers,
      })),
    ...proposals.flatMap((p): Item[] => {
      const base = {
        amountCents: p.amountCents,
        to: p.to,
        expiresAt: p.expiresAt,
        link: transfers,
      };
      if (p.expiresAt > iso)
        return [
          {
            ...base,
            id: `expiring:${p.id}`,
            kind: 'proposal_expiring',
            at: new Date(Date.parse(p.expiresAt) - EXPIRING_MS).toISOString(),
          },
        ];
      return p.status === 'awaiting_confirmation'
        ? [{ ...base, id: `expired:${p.id}`, kind: 'proposal_expired', at: p.expiresAt }]
        : [];
    }),
    ...resolved.map((r): Item => ({
      id: `ev:${r.id}`,
      kind: 'case_resolved',
      at: r.at,
      link: { tab: 'assistant', conversationId: r.conversationId },
    })),
    // PT1: one per due occurrence of a prepared transfer (never for one that waits for the
    // customer, is scheduled or paused). `at` is the due date: nothing happened at an hour.
    ...preparedList(userId, now)
      .filter((p) => p.state === 'due' && p.nextDue! >= since.slice(0, 10))
      .map((p): Item => ({
        id: `prepared-due:${p.id}:${p.nextDue}`,
        kind: 'prepared_due',
        at: p.nextDue!,
        amountCents: p.amountCents,
        to: p.to,
        link: transfers,
      })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS);
}
export function notifications(userId: string, now = new Date()) {
  const read = new Set(
    (
      appDb()
        .prepare('SELECT notification_id FROM notification_reads WHERE user_id=?')
        .all(userId) as { notification_id: string }[]
    ).map((r) => r.notification_id),
  );
  const items: NotificationItem[] = derive(userId, now).map((n) => ({
    ...n,
    read: read.has(n.id),
  }));
  return { unread: items.filter((n) => !n.read).length, items };
}
// Marks only ids in the user's current derived list: client ids are never trusted, and the table
// stays bounded. Idempotent.
export function markRead(userId: string, ids: string[] | 'all', now = new Date()) {
  const wanted = ids === 'all' ? null : new Set(ids);
  const readAt = now.toISOString();
  appDb().transaction(() => {
    for (const n of notifications(userId, now).items)
      if (!n.read && (!wanted || wanted.has(n.id)))
        insert(
          'notification_reads',
          { user_id: userId, notification_id: n.id, read_at: readAt },
          { orIgnore: true },
        );
  })();
  return { unread: notifications(userId, now).unread };
}
