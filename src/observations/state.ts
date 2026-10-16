// OB1: what a customer dismissed or was told, whether an observation may be shown now, and how
// those answers are recorded (plan 26 §3; REQ-OB-5, REQ-OB-6). App database only: no bank request,
// no model call. State is events only (D6): they survive a restart, are hash-chained, and seedApp
// wipes them.
// ponytail: each read scans the customer's events without an index; a table when events pass ~100k rows.
import { config } from '../config';
import { appDb } from '../db';
import { recordEvent } from '../telemetry';
import type { ToolContext } from '../types';
import { pickObservation } from './detect';
import type { Observation, ObservationInput } from './detect';

const DAY_MS = 86_400_000;
const exists = (sql: string, ...params: unknown[]) =>
  !!appDb()
    .prepare(sql)
    .get(...params);

export function observationHistory(userId: string): {
  dismissed: string[];
  told: string[];
  disabled: boolean;
} {
  const rows = appDb()
    .prepare(
      "SELECT kind,json_extract(data,'$.key') key FROM events WHERE user_id=? AND kind IN ('observation.dismissed','observation.told','observations.disabled','observations.enabled') ORDER BY created_at,rowid",
    )
    .all(userId) as { kind: string; key: string | null }[];
  const keys = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.key!);
  return {
    dismissed: keys('observation.dismissed'),
    told: keys('observation.told'),
    disabled:
      rows.filter((r) => r.kind.startsWith('observations.')).at(-1)?.kind ===
      'observations.disabled',
  };
}

// D7: never during trouble. Customer-wide (the Overview has no conversation); the chat adds the
// turn rules of round 8 (`turnTrouble`, src/offers/state.ts). The first rule that refuses names
// the reason.
// `open_case` is a case opened in the last 24 hours and still open, the window `transfer_trouble`
// gives a failed transfer. Deviation from plan 26 §3 ("has an open incident"): six of the eight
// seeded customers, Lucía and Bruno among them, have an open case from September that no one
// resolves, so the plan's rule would never show them anything.
export function observationGate(userId: string):
  | { ok: true }
  | {
      ok: false;
      reason: 'off' | 'disabled' | 'open_case' | 'transfer_trouble' | 'pending_approval';
    } {
  const recent = new Date(Date.now() - DAY_MS).toISOString();
  const reason =
    config.observations === 'off'
      ? 'off'
      : observationHistory(userId).disabled
        ? 'disabled'
        : exists(
              "SELECT 1 FROM incidents WHERE user_id=? AND status='open' AND created_at>?",
              userId,
              recent,
            )
          ? 'open_case'
          : exists(
                "SELECT 1 FROM intents WHERE user_id=? AND (status IN ('pending_verification','processing') OR (status='failed' AND created_at>?))",
                userId,
                recent,
              )
            ? 'transfer_trouble'
            : // Review of #137: a transfer is waiting for the customer's confirmation.
              exists(
                  'SELECT 1 FROM approvals WHERE user_id=? AND consumed_at IS NULL AND expires_at>?',
                  userId,
                  new Date().toISOString(),
                )
              ? 'pending_approval'
              : null;
  return reason ? { ok: false, reason } : { ok: true };
}

// Gate, history, pick. `page`: the card stays until it is dismissed (D5). `chat`: also never one
// the customer was already told. Never throws: an observation is an extra, so a failure here must
// not take the dashboard or the turn with it.
export function currentObservation(
  userId: string,
  i: ObservationInput,
  channel: 'page' | 'chat' | 'asked',
): Observation | null {
  try {
    if (!observationGate(userId).ok) return null;
    const { dismissed, told } = observationHistory(userId);
    // FC1 (plan 28 D12): the page never shows `month_shortfall` as a card; the Plan tab and the
    // "For you to do" row carry the shortfall, so the same one is not on the screen twice.
    // GL3 (review): `asked` is the chat when the customer asks again: one already told is
    // returned, `month_shortfall` included (the page rule would answer "nothing stands out"
    // about an account the forecast takes below zero).
    return channel === 'chat'
      ? pickObservation(i, [...dismissed, ...told])
      : pickObservation(i, dismissed, channel === 'page' ? ['month_shortfall'] : []);
  } catch {
    return null;
  }
}

// Idempotent per customer and key: a repeat records nothing.
function once(ctx: ToolContext, kind: string, key: string, data: Record<string, unknown>) {
  const db = appDb();
  db.transaction(() => {
    if (
      !exists(
        "SELECT 1 FROM events WHERE user_id=? AND kind=? AND json_extract(data,'$.key')=?",
        ctx.userId,
        kind,
        key,
      )
    )
      recordEvent(ctx, kind, { key, ...data });
  })();
}
export const dismissObservation = (ctx: ToolContext, key: string) =>
  once(ctx, 'observation.dismissed', key, {});
export const recordTold = (ctx: ToolContext, o: Observation) =>
  once(ctx, 'observation.told', o.key, { kind: o.kind, basis: o.basis });

export function setObservationsEnabled(ctx: ToolContext, enabled: boolean): void {
  if (observationHistory(ctx.userId).disabled === enabled)
    recordEvent(ctx, enabled ? 'observations.enabled' : 'observations.disabled', {});
}
