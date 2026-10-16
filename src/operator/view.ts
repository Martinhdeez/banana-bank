import { randomUUID } from 'node:crypto';
import { recordEvent } from '../telemetry';
import { appDb, insert } from '../db';
import { config } from '../config';
import { verifyAuditChain, type AuditStatus } from '../audit';
import { person } from '../people';
import { HttpError } from '../auth';
import { bankRequest } from '../banking/client';
import { findRecipients, fold, type Contact } from '../banking/recipients';
import { centsFromEuros } from '../banking/actions';
import {
  money,
  operatorTransferStatusLabel,
  outcomeUnknown,
  parseMessage,
  shortRef,
  stripBidi,
} from '../ui-helpers';
import { categoryLabel, isCategory } from '../insights/taxonomy';
import type { Account } from '../types';
import { usageByRun } from '../usage/report';
type BankOperation = { id: string; reference: string; status: string; [key: string]: unknown };
type Row = Record<string, any>;
// INT1: one sentence per way the audit chain can break.
function auditGap({ eventId, kind, at, reason }: NonNullable<AuditStatus['brokenAt']>) {
  const step = `event ${eventId}${kind ? `, ${kind}` : ''}${at ? `, ${at}` : ''}`;
  if (reason === 'hash_mismatch')
    return `Audit log: a recorded step was changed after it was written (${step}). Steps from that point may not be as recorded.`;
  if (reason === 'head_mismatch')
    return `Audit log: the newest recorded steps are missing (the last logged step was ${step}, which may no longer exist). Steps may have been deleted.`;
  return `Audit log: a step was added outside the log (${step}). Steps from that point may not be as recorded.`;
}
// F5b: "Operators need to understand the conversation, relevant steps, and effects. Historical
// evidence that was never recorded must not be invented." Everything below is read from what was
// recorded (messages, runs, events, intents) or verified with the bank; missing records are stated
// as gaps, never reconstructed.
export async function caseDetail(operatorId: string, id: string) {
  if (person(operatorId)?.role !== 'operator') throw new HttpError(403, 'Operator role required.');
  const db = appDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(id) as any;
  if (!incident) throw new HttpError(404, 'Case not found.');
  const conversationId = incident.conversation_id;
  const history = db
    .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid')
    .all(conversationId) as Row[];
  const lastMessage = history.at(-1);
  const events: Row[] = (
    db
      .prepare('SELECT * FROM events WHERE conversation_id=? ORDER BY created_at,rowid')
      .all(conversationId) as Row[]
  )
    // OPX4: views and exports are operator activity, not case steps: listed in `activity` only.
    .filter((e) => !AUDIT_ONLY.has(e.kind))
    .map((e) => ({ ...e, data: JSON.parse(e.data) }));
  const runs = caseRuns(conversationId, events);
  const { bank, contacts, accountNames } = await caseBank(operatorId, incident.user_id);
  // PT4 (review): a bank may not give the operator another customer's account (the demo bank:
  // "Transfer proposed: €20.00 to acc-lucia"). The destination's name was recorded with the
  // proposal (DV7-B) and with prepared.created: the steps and the summary read that recorded name
  // where the bank gave none.
  // FX6-a (ALT-3b): a transfer_money result (a proposal, or a refusal for insufficient funds)
  // records the destination the customer's session resolved; read the same way. Only this case's
  // own steps are read: a name another customer's session recorded is not this case's evidence.
  const names = { ...accountNames };
  for (const e of events) {
    if (/^(transfer\.proposed|prepared\.created)$/.test(e.kind) && e.data.to && e.data.input)
      names[e.data.input.toAccountId] ??= String(e.data.to);
    const [id, name] = recordedDestination(e.data.output);
    if (id && name) names[id] ??= name;
  }
  const intents = caseIntents(conversationId, bank);
  // O1: a transfer_money call refused by the app (validation, ownership, insufficient funds) never
  // creates an intent and never reaches the bank; it exists only as a tool event. Contract:
  // "Operators need to understand ... relevant steps" — list it from that recorded event.
  const rejectedAttempts = rejectedTransferEvents(events, intents).map((e) => ({
    eventId: e.id,
    runId: e.run_id,
    at: e.created_at,
    arguments: e.data.arguments ?? null,
    // S3: the amount as cents whether it was sent as cents or as typed euros (S1); null if invalid.
    amountCents: attemptCents(e.data.arguments),
    // S3: both sides in words, never "null" / "no destination".
    source: e.data.arguments?.fromAccountId
      ? (names[e.data.arguments.fromAccountId] ?? e.data.arguments.fromAccountId)
      : 'source account not chosen',
    destination: requestedDestination(e.data.arguments, names, contacts, e.data.output),
    code: e.data.output?.code ?? null,
    error: e.data.error ?? e.data.output?.error ?? null,
  }));
  const gaps: string[] = [];
  // FX6-c: a recorded chat run with no step (a turn that failed, or answered without a tool) is
  // a recorded run: the gap is stated only when there is neither a run nor a step.
  if (!runs.some((r) => r.recorded) && !events.some((e) => !e.kind.startsWith('case.')))
    gaps.push('No assistant runs or tool steps were recorded for this conversation.');
  for (const i of intents)
    if (!runs.some((r) => r.id === i.runId))
      gaps.push(`Intent ${i.id}: the run that created it was not recorded (historical record).`);
  if ('error' in bank) gaps.push(bank.error);
  // INT1: whether the recorded steps are as written. Stated, never repaired.
  const audit = verifyAuditChain(db);
  if (audit.brokenAt) gaps.push(auditGap(audit.brokenAt));
  if (audit.legacy && events.some((e) => e.created_at <= audit.legacy!.at))
    gaps.push(
      `Steps before ${audit.legacy.at} were recorded before the audit log existed: they are known unchanged only since then.`,
    );
  const customer = person(incident.user_id);
  // S5: each step as one readable line; the raw data stays in `data` for the detail toggle.
  for (const e of events) e.description = describeEvent(e, names, contacts);
  return {
    // S5: one status vocabulary for inbox, detail and summary.
    incident: {
      ...incident,
      statusLabel: statusLabel(incident.status),
      waiting: waitingTimes(incident),
    },
    customer,
    // S5: `text` is the content without markdown, for a plain "Latest message".
    lastMessage: lastMessage && { ...lastMessage, text: plainText(lastMessage.content) },
    history,
    events,
    runs,
    intents,
    rejectedAttempts,
    bank,
    // FX6-e: the bank's names (OP1) and the destinations this case's steps recorded, so the intents
    // card and the export name what the steps name when the bank gives no contacts or is down.
    // A source account's name is recorded nowhere: without the bank it stays an id.
    accountNames: names,
    gaps,
    audit,
    activity: caseActivity(id),
    activitySince:
      (db.prepare("SELECT value FROM meta WHERE key='case-activity-since'").pluck().get() as
        string | undefined) ?? null,
    summary: summarize(
      incident,
      customer?.name ?? incident.user_id,
      history,
      events,
      intents,
      rejectedAttempts,
      names,
    ),
  };
}
// OPX4: who viewed, resolved or exported a case, from recorded events only (newest first). Views
// and exports before `case-activity-since` were never recorded; the detail says so, never invents.
const AUDIT_ONLY = new Set(['case.viewed', 'case.exported']);
const ACTIVITY_VERB: Record<string, (d: Row) => string> = {
  'case.viewed': () => 'Viewed',
  'case.resolved': () => 'Marked resolved',
  'case.exported': (d) => `Exported as ${String(d.format ?? '').toUpperCase()}`,
};
function caseActivity(incidentId: string) {
  return (
    appDb()
      .prepare(
        "SELECT * FROM events WHERE json_extract(data,'$.incidentId')=? AND kind IN ('case.viewed','case.resolved','case.exported') ORDER BY created_at DESC, rowid DESC",
      )
      .all(incidentId) as Row[]
  ).map((e) => {
    const d = JSON.parse(e.data);
    const operatorName = person(d.operatorId)?.name ?? d.operatorId;
    return {
      id: e.id as string,
      kind: e.kind as 'case.viewed' | 'case.resolved' | 'case.exported',
      at: e.created_at as string,
      operatorId: d.operatorId as string,
      operatorName,
      description: `${ACTIVITY_VERB[e.kind](d)} by ${operatorName}`,
      ...(d.format ? { format: d.format as string } : {}),
    };
  });
}
// ponytail: fixed 10-minute window per operator and case; a setting if operators ask for another.
const VIEW_THROTTLE_MS = 10 * 60_000;
// OPX4: GET /api/incidents/:id. Records a `case.viewed` event (hash-chained through insert) unless
// this operator viewed this case in the last 10 minutes, then returns the detail.
export async function viewCase(operatorId: string, id: string) {
  if (person(operatorId)?.role !== 'operator') throw new HttpError(403, 'Operator role required.');
  const db = appDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(id) as Row | undefined;
  if (!incident) throw new HttpError(404, 'Case not found.');
  // OPX4: check and write under one IMMEDIATE lock, so two processes cannot both record a view.
  db.transaction(() => {
    const last = db
      .prepare(
        "SELECT max(created_at) FROM events WHERE kind='case.viewed' AND json_extract(data,'$.incidentId')=? AND json_extract(data,'$.operatorId')=?",
      )
      .pluck()
      .get(id, operatorId) as string | null;
    if (!last || Date.now() - Date.parse(last) >= VIEW_THROTTLE_MS)
      recordEvent(
        {
          userId: operatorId,
          conversationId: incident.conversation_id,
          runId: randomUUID(),
          intentId: '',
        },
        'case.viewed',
        { incidentId: id, operatorId },
      );
  }).immediate();
  return caseDetail(operatorId, id);
}
type CaseBank = { accounts: Account[]; operations: BankOperation[] } | { error: string };
// K8: the case's chat runs with their events, plus steps recorded outside a chat run.
function caseRuns(conversationId: string, events: Row[]) {
  // TR1 (plan 27 §6): what each chat run spent on models (tokens and estimated cost, counts
  // only), or null when none of its requests was recorded. A failed read loses the figures only.
  let usage: ReturnType<typeof usageByRun> | undefined;
  try {
    usage = usageByRun(conversationId);
  } catch {}
  const runs: Row[] = (
    appDb()
      .prepare('SELECT * FROM runs WHERE conversation_id=? ORDER BY started_at,rowid')
      .all(conversationId) as Row[]
  ).map((r) => ({
    ...r,
    recorded: true,
    events: events.filter((e) => e.run_id === r.id),
    usage: usage?.get(r.id) ?? null,
  }));
  // Steps outside a chat run (direct actions, approval confirmations, operator actions) keep their
  // run id but are marked as not being a recorded chat run.
  for (const e of events)
    if (!runs.some((r) => r.id === e.run_id))
      runs.push({
        id: e.run_id,
        recorded: false,
        events: events.filter((x) => x.run_id === e.run_id),
      });
  return runs;
}
// K8: what the bank says about the case's customer, and the account names it gives.
async function caseBank(operatorId: string, userId: string) {
  // F5b: the bank is asked as the operator (actor from the server session), never with model input.
  // O3: operators read account names, not ids. /v1/contacts asked as the operator lists every
  // customer account with its holder; if it fails, ids stay as recorded (nothing invented).
  // K2: both reads run concurrently; each failure keeps its own handling.
  const [customerRead, contactsRead] = await Promise.allSettled([
    bankRequest<{ accounts: Account[]; operations: BankOperation[] }>(
      operatorId,
      `/v1/operator/customer?id=${encodeURIComponent(userId)}`,
    ),
    bankRequest<Contact[]>(operatorId, '/v1/contacts'),
  ]);
  const bank: CaseBank =
    customerRead.status === 'fulfilled'
      ? customerRead.value
      : {
          error: `Bank status could not be verified: ${customerRead.reason instanceof Error ? customerRead.reason.message : customerRead.reason}`,
        };
  const accountNames: Record<string, string> = {};
  const contacts: Contact[] = contactsRead.status === 'fulfilled' ? contactsRead.value : [];
  for (const c of contacts) accountNames[c.id] = [c.name, c.label].filter(Boolean).join(' · ');
  // OP1 (ALT-3): /v1/contacts for operators is not in the contract and a bank may refuse it. The
  // contract's operator endpoint returns the customer's own accounts with labels: name those.
  // Contract: "Historical evidence that was never recorded must not be invented" — only labels the
  // bank returned are used; recipients without a name stay as recorded ids.
  if ('accounts' in bank) {
    const holder = person(userId)?.name;
    for (const a of bank.accounts)
      accountNames[a.id] ??= [holder, a.label].filter(Boolean).join(' · ');
  }
  return { bank, contacts, accountNames };
}
// K8: the case's transfer intents, each with its approval and what the bank confirms.
function caseIntents(conversationId: string, bank: CaseBank) {
  const db = appDb();
  return (
    db
      .prepare('SELECT * FROM intents WHERE conversation_id=? ORDER BY created_at,rowid')
      .all(conversationId) as Row[]
  ).map((i) => {
    const approval = db
      .prepare('SELECT * FROM approvals WHERE intent_id=? ORDER BY rowid DESC LIMIT 1')
      .get(i.id) as Row | undefined;
    const operation =
      'operations' in bank
        ? bank.operations.find((o) => o.reference === i.bank_reference)
        : undefined;
    return {
      id: i.id,
      runId: i.run_id,
      status: i.status,
      payload: JSON.parse(i.payload),
      bankReference: i.bank_reference,
      operationId: i.operation_id,
      error: i.error,
      createdAt: i.created_at,
      approval: approval
        ? { id: approval.id, expiresAt: approval.expires_at, consumedAt: approval.consumed_at }
        : null,
      verified: !i.bank_reference
        ? { status: 'unverified', reason: 'No bank reference was recorded for this intent.' }
        : 'error' in bank
          ? { status: 'unverified', reason: bank.error }
          : operation
            ? { status: 'completed', operation }
            : // O4: absence from a listing (possibly partial or paginated) is not a verified
              // fact; contract: status must "match verified facts", so say "not verified".
              {
                status: 'unverified',
                reason:
                  "Not in the bank's operator listing for this customer; status not verified.",
              },
    };
  });
}
function attemptCents(args: Row | null | undefined) {
  const cents =
    args?.amountCents ?? (typeof args?.amount === 'string' ? centsFromEuros(args.amount) : null);
  return Number.isSafeInteger(cents) && cents > 0 ? (cents as number) : null;
}
const attemptWhat = (cents: number | null, destination: string) =>
  cents ? `${money(cents)} to ${destination}` : `to ${destination} with an invalid amount`;
// S5: one name per case state, used by the inbox, the detail and the summary.
const STATUS_LABELS: Record<string, string> = { open: 'Open', closed: 'Resolved' };
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
// S5: markdown (bold, links, lists) reduced to its text, one line per paragraph or list item.
const plainText = (content: string) =>
  parseMessage(content)
    .flatMap((b) => (b.kind === 'p' ? [b.inlines] : b.items))
    .map((inlines) => inlines.map((i) => i.text).join(''))
    .join('\n');
const TOOL_NAMES: Record<string, string> = {
  transfer_money: 'Transfer proposal',
  cancel_transfer: 'Proposal cancellation',
  operation_status: 'Transfer status check',
  request_human: 'Support case request',
  list_accounts: 'Accounts and contacts lookup',
  list_movements: 'Movements lookup',
  search_documents: 'Document search',
  // XS5: the spending tools of round 7 (src/agent/insights.ts).
  get_spending_summary: 'Spending summary',
  list_unresolved_movements: 'Movements to review lookup',
  suggest_category_choices: 'Category choices',
  set_movement_category: 'Category change',
  remove_category_rule: 'Category rule removal',
  // XS2: the product-suggestion tools (plan 24 §4).
  get_offer_details: 'Product sheet lookup',
  offer_response: 'Product suggestion answer',
  set_product_suggestions: 'Product suggestions setting',
  // OB1: the spending-observation tools (plan 26 §5).
  get_spending_observation: 'Spending observation lookup',
  set_spending_observations: 'Spending observations setting',
  // PT1: the prepared-transfer tools (plan 25 §5).
  prepare_transfer: 'Prepared transfer',
  list_prepared_transfers: 'Prepared transfers lookup',
  send_prepared_transfer: 'Prepared transfer proposal',
};
// PT1: a due date ('YYYY-MM-DD') as "11 Oct".
const dayMonth = (date: unknown) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
const OUTCOMES: Record<string, string> = {
  requires_confirmation: "awaiting the customer's confirmation",
  possible_duplicate: 'flagged as a possible duplicate, customer asked',
  needs_source_account: 'customer asked which account to send from',
};
const line = (text: unknown) =>
  String(text ?? 'no reason recorded')
    .replace(/\s+/g, ' ')
    .trim();
// S5: a recorded step in words (operators read these; the raw event stays available).
const categoryName = (id: unknown) => (isCategory(id) ? categoryLabel(id) : line(id));
function describeEvent(e: Row, accountNames: Record<string, string>, contacts: Contact[]) {
  const d = e.data,
    tool = TOOL_NAMES[d.tool] ?? d.tool,
    name = (id: string) => accountNames[id] ?? id;
  switch (e.kind) {
    case 'tool.started':
      return `${tool} started`;
    case 'tool.failed':
      return `${tool} failed: ${line(d.error)}`;
    case 'tool.completed': {
      if (d.tool === 'transfer_money') {
        const what = attemptWhat(
          attemptCents(d.arguments),
          requestedDestination(d.arguments, accountNames, contacts, d.output),
        );
        return d.output?.status === 'failed'
          ? `${tool} ${what} refused by the app: ${line(d.output.error)}`
          : `${tool} ${what}: ${OUTCOMES[d.output?.status] ?? line(d.output?.status).replace(/_/g, ' ')}`;
      }
      if (d.tool === 'request_human')
        // FX7: at the customer's limit of open requests the call opened nothing.
        return d.output?.limitReached
          ? 'Support case requested: none opened, the customer is at the limit of open requests'
          : 'Support case opened for a person to review';
      if (d.tool === 'search_documents' && d.arguments?.query)
        return `${tool} for "${line(d.arguments.query)}"`;
      // PT3 (review): a refused or unfinished prepare / send is not "completed" (contract:
      // "status should match verified facts"), worded as the transfer_money refusals above.
      // PT4 (review): a saved prepare is not a "completed" payment either: say it was not sent;
      // a send that proposed nothing new (the last attempt's outcome) names that outcome.
      if (/^(prepare_transfer|send_prepared_transfer)$/.test(d.tool)) {
        const status = d.output?.status;
        if (status === 'failed') return `${tool} refused by the app: ${line(d.output.error)}`;
        if (status === 'prepared') return 'Transfer prepared for later: not sent';
        return `${tool}: ${OUTCOMES[status] ?? `nothing new proposed, the transfer is ${line(status).replace(/_/g, ' ')}`}`;
      }
      return `${tool} completed`;
    }
    case 'transfer.proposed':
      return `Transfer proposed: ${money(d.input.amountCents)} to ${name(d.input.toAccountId)}, awaiting the customer's confirmation`;
    case 'transfer.started':
      return 'Transfer sent to the bank';
    case 'transfer.retry':
      return 'The bank did not confirm; sent again with the same reference'; // PL1: timeout or 5xx
    case 'transfer.completed':
      return 'Transfer completed by the bank';
    case 'transfer.pending_verification':
      return 'Bank outcome unknown; verification pending';
    case 'transfer.failed':
      return `Transfer rejected: ${line(d.error)}`;
    case 'transfer.cancelled':
      // AR1-a: the recorded actor; events without a reason are customer cancels.
      return d.reason === 'replaced'
        ? 'Proposal replaced by a corrected proposal. No money moved'
        : d.reason === 'withdrawn'
          ? 'Correction withdrawn by the app: the proposal it corrected was already closed. No money moved'
          : 'Proposal cancelled by the customer. No money moved';
    case 'transfer.verified':
      return d.status === 'completed'
        ? 'Verified with the bank: completed'
        : 'Verified with the bank: not registered, no money moved';
    case 'case.resolved':
      return `Case marked resolved by ${person(d.operatorId)?.name ?? d.operatorId}`;
    // SI5: spend-category changes (channel: the overview or the chat).
    case 'category.set':
      return d.source === 'user_rule'
        ? `Movement category set to ${categoryName(d.to)} by the customer's rule`
        : `Movement category set to ${categoryName(d.to)} by the customer`;
    case 'rule.created':
      return `Category rule created: ${line(d.merchantKey)} is ${categoryName(d.category)}`;
    case 'rule.removed':
      return `Category rule removed: ${line(d.merchantKey)}`;
    // XS2: product suggestions (plan 24 §5). The name is recorded with the event.
    case 'offer.shown':
      return `Product suggestion shown: ${line(d.name ?? d.offerId)} — ${line(d.basis)}`;
    case 'offer.declined':
      return `Suggestion declined: ${line(d.name ?? d.offerId)}`;
    case 'offer.interest':
      return `Interest noted for ${line(d.name ?? d.offerId)}; nothing was contracted`;
    case 'offers.disabled':
      return 'Customer turned product suggestions off';
    case 'offers.enabled':
      return 'Customer turned product suggestions on';
    // OB1: spending observations (plan 26 §3). The kind is the first part of the key.
    case 'observation.dismissed':
      return `Customer dismissed a spending observation (${
        String(d.key).startsWith('prepared_uncovered:')
          ? 'a prepared transfer the balance does not cover'
          : String(d.key).startsWith('month_shortfall:') // FC1
            ? 'an estimated shortfall before the month ends'
            : 'a category that went up'
      })`;
    case 'observation.told':
      return `Spending observation given in the chat: ${line(d.basis)}`;
    case 'observations.disabled':
      return 'Customer turned spending observations off';
    case 'observations.enabled':
      return 'Customer turned spending observations on';
    // PT1: prepared transfers (plan 25 §8). Preparing, skipping, pausing and deleting send nothing;
    // a send attempt is the `transfer.proposed` step that follows.
    case 'prepared.created': {
      const when =
        d.when?.kind === 'monthly'
          ? `due every month on day ${d.when.day}`
          : d.when?.kind === 'on_date'
            ? `due on ${dayMonth(d.when.date)}`
            : 'to send when they decide';
      const note = d.note ? ` — note: "${line(d.note)}"` : '';
      return `Customer prepared a transfer: ${money(d.input.amountCents)} to ${accountNames[d.input.toAccountId] ?? line(d.to)}, ${when}${note}. Nothing was sent`;
    }
    case 'prepared.sent':
      return 'Prepared transfer sent by the customer (transfer completed)';
    case 'prepared.skipped':
      return `Customer skipped the prepared transfer due on ${dayMonth(d.occurrence)}. Nothing was sent`;
    case 'prepared.paused':
    case 'prepared.resumed':
    case 'prepared.deleted':
      return `Customer ${e.kind.slice('prepared.'.length)} a prepared transfer. Nothing was sent`;
    default:
      return e.kind;
  }
}
// FX6-a: the destination a transfer_money result recorded (`describeDestination`, resolved with
// the customer's own bank read): [account id, "Holder · Label"], or [] when none was recorded.
function recordedDestination(output: Row | null | undefined): [string?, string?] {
  const d = output?.destination;
  return d?.accountId ? [d.accountId, [d.name, d.label].filter(Boolean).join(' · ')] : [];
}
// S3: where a transfer attempt was meant to go, as recorded: the account's name, else the person
// the customer named (their full name when it matches exactly one contact), never "null".
// FX6-a: `accountNames` holds the bank's names and the ones this case's steps recorded; an
// account neither names stays an id, said to be one (nothing invented).
function requestedDestination(
  args: Row | null | undefined,
  accountNames: Record<string, string>,
  contacts: Contact[],
  output?: Row | null,
) {
  const id = args?.toAccountId ?? recordedDestination(output)[0];
  if (id) return accountNames[id] ?? `account ${id}`;
  const recipient = typeof args?.recipient === 'string' ? args.recipient.trim() : '';
  if (!recipient) return 'a recipient that was not named';
  const matches = findRecipients(contacts, recipient);
  if (matches.length !== 1) return `"${recipient}" (as the customer named them)`;
  return accountNames[matches[0].main.id] ?? matches[0].name;
}
// O1: transfer_money calls refused by the app before any bank call (no intent row was created).
const rejectedTransferEvents = (events: Row[], intents: Row[]) =>
  events.filter(
    (e) =>
      e.data.tool === 'transfer_money' &&
      (e.kind === 'tool.failed' ||
        (e.kind === 'tool.completed' &&
          e.data.output?.status === 'failed' &&
          !intents.some((i) => i.id === e.data.output.intentId))),
  );
// OPX2: how long a case has waited, from recorded timestamps only (contract: evidence that was
// never recorded must not be invented). A missing record is null, never estimated.
export function waitingTimes(incident: Row, now = new Date()) {
  const db = appDb();
  const lastCustomerMessageAt =
    (
      db
        .prepare(
          "SELECT max(created_at) AS at FROM messages WHERE conversation_id=? AND role='user'",
        )
        .get(incident.conversation_id) as { at: string | null }
    ).at ?? null;
  const open = incident.status !== 'closed';
  // OPX4: served by the events_incident index (migration 4).
  const resolvedAt = open
    ? null
    : ((
        db
          .prepare(
            "SELECT max(created_at) AS at FROM events WHERE kind='case.resolved' AND json_extract(data,'$.incidentId')=?",
          )
          .get(incident.id) as { at: string | null }
      ).at ?? null);
  const since = (at: string) => Math.max(0, now.getTime() - Date.parse(at));
  const openMs = open ? since(incident.created_at) : null;
  const { caseWaitWarnMinutes: warnMinutes, caseWaitBreachMinutes: breachMinutes } = config;
  return {
    asOf: now.toISOString(),
    openedAt: incident.created_at as string,
    openMs,
    lastCustomerMessageAt,
    sinceCustomerMs: lastCustomerMessageAt ? since(lastCustomerMessageAt) : null,
    resolvedAt,
    level:
      openMs === null
        ? null
        : openMs >= breachMinutes * 60_000
          ? 'breach'
          : openMs >= warnMinutes * 60_000
            ? 'warn'
            : 'ok',
    thresholds: { warnMinutes, breachMinutes },
  };
}
// OP2: inbox order. Contract: "Operators need to understand the conversation, relevant steps, and
// effects." Priority comes only from what the app recorded (intents, rejected attempts, case
// status and age); the bank is not asked, so the reason never claims a verified bank outcome.
// Money at stake first, then open cases, both oldest first (waiting longest); closed cases last.
export function inbox() {
  const db = appDb();
  const now = new Date(); // OPX2: one clock for the whole list, so every row has the same asOf.
  const rank = { money: 0, open: 1, closed: 2 };
  return (db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all() as Row[])
    .map((c): Row => {
      c = { ...c, statusLabel: statusLabel(c.status), waiting: waitingTimes(c, now) };
      // OPX3: `reasons` are stable codes for the facts behind `priority` (filters use them).
      if (c.status === 'closed')
        return { ...c, priority: 'closed', priorityReason: 'Resolved', reasons: ['resolved'] };
      const intents = db
        .prepare('SELECT id,status,bank_reference FROM intents WHERE conversation_id=?')
        .all(c.conversation_id) as Row[];
      const events = (
        db
          .prepare("SELECT * FROM events WHERE conversation_id=? AND kind LIKE 'tool.%'")
          .all(c.conversation_id) as Row[]
      ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
      const count = (test: (i: Row) => boolean) => intents.filter(test).length;
      const facts = [
        [
          count((i) => outcomeUnknown(i.status)),
          'Transfer pending verification',
          'pending_verification',
        ],
        [
          count((i) => i.status === 'failed' && !!i.bank_reference),
          'Sent to the bank, recorded failed, outcome not verified',
          'sent_failed',
        ],
        [
          count((i) => i.status === 'failed' && !i.bank_reference) +
            rejectedTransferEvents(events, intents).length,
          'Rejected transfer attempt',
          'rejected_attempt',
        ],
      ] as [number, string, string][];
      const found = facts.filter(([n]) => n > 0);
      const money = found.map(([n, what]) => `${what} (${n})`);
      return money.length
        ? {
            ...c,
            priority: 'money',
            priorityReason: `Money at stake: ${money.join(' · ')}`,
            reasons: found.map(([, , code]) => code),
          }
        : {
            ...c,
            priority: 'open',
            // S4: no time in server text; the UI shows created_at in the viewer's time zone.
            priorityReason: 'Waiting for support',
            reasons: ['waiting'],
          };
    })
    .sort(
      (a, b) =>
        rank[a.priority as keyof typeof rank] - rank[b.priority as keyof typeof rank] ||
        (a.priority === 'closed' ? -1 : 1) * a.created_at.localeCompare(b.created_at),
    );
}
// OPX3: inbox filters (GET /api/incidents?q=&status=&money=&reason=), applied to inbox() rows.
export const INBOX_REASONS = [
  'pending_verification',
  'sent_failed',
  'rejected_attempt',
  'waiting',
  'resolved',
] as const;
type InboxFilters = {
  q?: string;
  status?: 'open' | 'closed';
  money?: boolean;
  reason?: string;
};
// ponytail: in-memory filter over every case; move to SQL when the inbox is paginated.
export function filterInbox(rows: Row[], f: InboxFilters) {
  const bare = (s: string) => fold(s).replace(/^#/, '');
  const q = f.q ? bare(f.q) : '';
  return rows.filter(
    (c) =>
      (!f.status || c.status === f.status) &&
      (f.money === undefined || (c.priority === 'money') === f.money) &&
      (!f.reason || c.reasons.includes(f.reason)) &&
      (!q ||
        [person(c.user_id)?.name ?? c.user_id, c.summary, shortRef(c.id)].some((s) =>
          bare(s).includes(q),
        )),
  );
}
// F5c: a case summary built only from recorded facts (handoff summary, messages, intents, bank
// verification). The seeded incidents.summary is the customer's last message, so the handoff is
// taken from the request_human event, and stated as not recorded when there is none.
function summarize(
  incident: Row,
  name: string,
  history: Row[],
  events: Row[],
  intents: Row[],
  rejectedAttempts: Row[],
  accountNames: Record<string, string>,
) {
  const account = (id: string) => accountNames[id] ?? id;
  // FX2-d: every recorded handoff, in order: a second request in the same conversation adds a
  // line, it does not replace the first. `handoff` stays the latest one.
  const handoffs = events
    .filter(
      (e) =>
        e.kind === 'tool.completed' &&
        e.data.tool === 'request_human' &&
        e.data.output?.incidentId === incident.id &&
        e.data.arguments?.summary,
    )
    // FX6-e: a summary recorded before FX3 may hold bidi controls; none reaches the screen.
    .map((e) => ({
      at: e.created_at as string,
      summary: stripBidi(String(e.data.arguments.summary)),
    }));
  const handoff = handoffs.at(-1)?.summary ?? null;
  // FX7 (review): a request refused at the customer's limit of open requests opened no case of
  // its own and named this one to the customer; its step is recorded in a conversation no case
  // shows. Its summary is read here, on the case the customer was pointed to: one line per
  // conversation and summary, the newest 10 and the number of the rest.
  // ponytail: scans the events table (no index on user_id); index '$.output.incidentId' if slow.
  const capped = (
    appDb()
      .prepare(
        `SELECT max(created_at) at, conversation_id conversationId, json_extract(data,'$.arguments.summary') summary
           FROM events WHERE user_id=? AND kind='tool.completed' AND json_extract(data,'$.tool')='request_human'
            AND json_extract(data,'$.output.limitReached') AND json_extract(data,'$.output.incidentId')=?
          GROUP BY conversation_id, summary ORDER BY at DESC`,
      )
      .all(incident.user_id, incident.id) as Row[]
  ).map((c) => ({ ...c, summary: stripBidi(String(c.summary)) }));
  const cappedRequests = capped.slice(0, 10);
  const said = history.filter((m) => m.role === 'user');
  const text = [
    // S4: the opening time is incident.created_at, formatted by the UI in local time.
    `${name} · ${statusLabel(incident.status)}`,
    // S4: no time in the text; `handoffs` carries it for the UI and the export.
    ...(handoffs.length
      ? handoffs.map((h) => `Assistant handoff: ${h.summary}`)
      : ['No assistant handoff summary was recorded for this case.']),
    ...cappedRequests.map(
      (c) =>
        `Later request with no case of its own (the customer was at the limit of open requests and was given this case's reference): ${c.summary}`,
    ),
    ...(capped.length > 10
      ? [`${capped.length - 10} earlier requests of the same kind are not listed.`]
      : []),
  ];
  if (said[0]) text.push(`Customer asked: ${said[0].content}`);
  if (!intents.length && !rejectedAttempts.length)
    text.push('No transfer intents were recorded in this conversation.');
  // O1: refused by the app before any bank call, so "rejected before reaching the bank".
  for (const a of rejectedAttempts) {
    const what = attemptWhat(a.amountCents, a.destination);
    text.push(`Transfer attempt ${what}: rejected before reaching the bank (${a.error}).`);
  }
  for (const i of intents) {
    const what = `${money(i.payload.amountCents)} to ${account(i.payload.toAccountId)}`;
    // FX2-c: the status in the words the customer reads (one vocabulary, "your" as "the
    // customer's"), not the enum value; lower case because it sits inside a sentence.
    const status = operatorTransferStatusLabel(i.status).toLowerCase();
    // A reference is assigned just before dispatch: without one the intent never reached the
    // bank (an unconfirmed proposal, or rejected before sending).
    if (!i.bankReference) text.push(`Transfer intent ${what}: ${status}, never sent to the bank.`);
    else if (i.verified.status === 'unverified')
      text.push(`Transfer intent ${what}: app shows ${status}, bank status not verified.`);
    else if (i.verified.status === 'completed' && i.status !== 'completed')
      text.push(
        `Transfer intent ${what}: app shows ${status}, bank confirms completed (${i.bankReference}).`,
      );
    else text.push(`Transfer intent ${what}: ${status}, consistent with the bank.`);
  }
  if (said.length > 1) text.push(`Last customer message: ${said.at(-1)!.content}`);
  return {
    text: text.map(stripBidi),
    handoff,
    handoffs,
    cappedRequests,
    cappedRequestsTotal: capped.length,
    handoffSource: handoff ? 'assistant' : 'not_recorded',
  };
}
// F5d: an operator can mark a case resolved; the change is audited as a `case.resolved` event on
// the case's conversation so it appears in the case steps. Resolving a closed case is a no-op.
// OP3: it also leaves a note (timestamped by its created_at) in the customer's conversation.
// S6: only an explicit confirmation (confirm === true) resolves; one click resolved a case by
// mistake in the audit. A resolved case is not reopened, so the operator must mean it.
export async function resolveCase(operatorId: string, id: string, confirm: unknown) {
  if (person(operatorId)?.role !== 'operator') throw new HttpError(403, 'Operator role required.');
  if (confirm !== true)
    throw new HttpError(
      400,
      'Resolving a case needs explicit confirmation: it closes the case and notifies the customer. Send {"confirm": true} to resolve it.',
    );
  const db = appDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(id) as Row | undefined;
  if (!incident) throw new HttpError(404, 'Case not found.');
  // K7: close, audit and note in one transaction: a failure leaves the case open with neither.
  db.transaction(() => {
    if (
      !db.prepare("UPDATE incidents SET status='closed' WHERE id=? AND status<>'closed'").run(id)
        .changes
    )
      return;
    const runId = randomUUID(),
      at = new Date().toISOString();
    recordEvent(
      { userId: operatorId, conversationId: incident.conversation_id, runId, intentId: '' },
      'case.resolved',
      { status: 'closed', incidentId: id, operatorId },
    );
    // OP3: the customer learns the case was resolved, in their own conversation. Contract:
    // "Customer-facing status should match verified facts": the note states only the recorded
    // action, linked to the audit event by run id. No free-text operator reply. S4: no time in the
    // text (it said "21:28 UTC" beside a 23:28 local timestamp); the message's created_at is it.
    insert('messages', {
      id: randomUUID(),
      conversation_id: incident.conversation_id,
      role: 'assistant',
      content: 'A support agent marked your request as resolved.',
      created_at: at,
      run_id: runId,
    });
  })();
  return caseDetail(operatorId, id);
}
