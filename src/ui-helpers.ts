// Pure helpers for app/page.tsx (tested in tests/ui-helpers.test.ts).
import type { TransferInput, TransferStatus } from './types';
import type { AuditStatus } from './audit';
import type { RowCategory } from './insights/taxonomy';

export type Inline =
  { kind: 'text' | 'strong'; text: string } | { kind: 'link'; text: string; href: string };
type Block =
  | { kind: 'p'; inlines: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; start: number; items: Inline[][] };

// FX3: the bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069).
// Inside customer or bank text they reorder the app's own words on the same line ("every month on
// day 31" painted backwards). Removed at every free-text input (`text()` in src/http.ts) and when a
// stored sentence is shown. The marks U+200E, U+200F and U+061C stay: they have no scope, cannot
// reverse a run, and right-to-left text legitimately carries them.
export const stripBidi = (s: string) => s.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const INLINE = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// U6: Markdown-like chat text to data (paragraphs, lists, bold, links). Never HTML: React
// renders the result, so text is always escaped; only http(s) and mailto become links.
export function parseMessage(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', inlines: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line),
      numbered = NUMBERED.exec(line);
    if (bullet || numbered) flush();
    const last = blocks.at(-1);
    if (bullet) {
      const item = parseInline(bullet[1]);
      if (last?.kind === 'ul') last.items.push(item);
      else blocks.push({ kind: 'ul', items: [item] });
    } else if (numbered) {
      const item = parseInline(numbered[2]);
      if (last?.kind === 'ol') last.items.push(item);
      else blocks.push({ kind: 'ol', start: Number(numbered[1]), items: [item] });
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

// U7: a proxy or crash can answer with HTML or nothing; fail with a readable message
// instead of a raw SyntaxError from response.json().
export async function readJson(response: Response) {
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = null;
  }
  if (!response.ok)
    throw new Error(data?.error || `The request could not be completed (${response.status}).`);
  if (data === null) throw new Error('The server sent an unexpected response.');
  return data;
}

type Named = { id: string; label?: string; name?: string };
// U8: show an account by its label (own account) or holder name and label (contact).
export function accountName(
  id: string,
  { accounts = [], contacts = [] }: { accounts?: Named[]; contacts?: Named[] },
) {
  const own = accounts.find((a) => a.id === id);
  if (own) return own.label || id;
  const contact = contacts.find((c) => c.id === id);
  return contact ? [contact.name, contact.label].filter(Boolean).join(' · ') : id;
}
// PL1 (round 6): the one account-type line (Overview cards, Transfers From tiles). "Savings
// account" when the label says savings; else "Main account" for the main account (mainAccount in
// src/banking/recipients.ts) when `mainId` is given; else "Current account". Overview omits
// `mainId`: its Main badge already names the main account.
export const accountKind = (account: AnyRecord, mainId?: string) =>
  /savings/i.test(account.label ?? '')
    ? 'Savings account'
    : account.id === mainId
      ? 'Main account'
      : 'Current account';

// U3: how a transfer result is shown. Only a completed transfer is a (green) notice; an unknown
// outcome is a warning (never invite a retry, F3) and a rejection an error.
// R1: a proposal has its own "pending" tone: no money has moved until the customer confirms it.
export function transferFeedback(result: { status?: string; message?: string; error?: string }): {
  tone: 'notice' | 'pending' | 'warning' | 'error';
  text: string;
} {
  switch (result.status) {
    case 'completed':
      // A8 (polish): there is no "activity" in the app; the list is "Your transfers" (Transfers).
      return {
        tone: 'notice',
        text: 'Transfer completed. You can see it under “Your transfers”, on the Transfers page.',
      };
    case 'requires_confirmation':
    case 'possible_duplicate':
      return {
        tone: 'pending',
        text: 'Pending your confirmation. No money has moved yet: review the proposal and confirm it to send the money.',
      };
    case 'pending_verification':
      return {
        tone: 'warning',
        text: result.message || 'We are verifying this transfer with the bank. Do not repeat it.',
      };
    case 'cancelled':
      return { tone: 'warning', text: 'Proposal cancelled. No money moved.' };
    case 'processing':
      return { tone: 'warning', text: 'This transfer is still being processed. Do not repeat it.' };
    case 'needs_source_account':
      return { tone: 'warning', text: 'Choose the account to send from.' };
    default:
      return { tone: 'error', text: result.error || 'The transfer could not be completed.' };
  }
}

// S1: strict euros text to cents: digits with at most two decimals after "." or ","; exponent,
// sign and other forms are refused (null). Shared by the server and the form estimate (U3).
export function centsFromEuros(text: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

// S1/S2: the one euro format, shared by the UI and every server text (e.g. "€2,889.00").
export const money = (cents: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

// Documents and answers are evaluated as of this date (not today); the UI labels it as such.
export const referenceDate = '2026-09-24';

// A10: three-letter months everywhere. `en-IE` abbreviates September as "Sept", beside the "Sep"
// of the spending card's periods.
const shortDate = (options: Intl.DateTimeFormatOptions, date: Date) =>
  new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', ...options })
    .format(date)
    .replace('Sept', 'Sep');

// X5: the one date format of the UI, always on real timestamps. The document reference date
// (src/config.ts) is for documents and answers; it is never shown as "today".
export function formatDate(value: string | Date, time = true) {
  return shortDate(
    { year: 'numeric', ...(time && { hour: '2-digit', minute: '2-digit' }) },
    new Date(value),
  );
}

// PT2: a date with no hour ('YYYY-MM-DD', e.g. a prepared transfer's due date) in words: "1 Nov",
// with the year when it is not this year. Read as UTC, so it is the same day in every time zone.
export function formatDay(date: string, now = new Date()) {
  const d = new Date(date);
  return shortDate(
    { timeZone: 'UTC', ...(d.getUTCFullYear() !== now.getFullYear() && { year: 'numeric' }) },
    d,
  );
}

// CF8: the chip line for a person's newest payment across their accounts ("Paid 23 Sep"; the
// year only when it is not this year), or undefined when none of their accounts was paid.
export function paidLine(
  accounts: { id: string }[],
  recent: { accountId: string; lastAt: string }[],
  now = new Date(),
) {
  const last = recent
    .filter((r) => accounts.some((a) => a.id === r.accountId))
    .map((r) => new Date(r.lastAt))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (!last) return undefined;
  return `Paid ${shortDate(last.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}, last)}`;
}

// OPX2-ui: a server-measured wait in words ("12 min", "3 h 5 min", "6 d 4 h"); never computed here.
export function duration(ms: number) {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
  if (h) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return m ? `${m} min` : 'under 1 min';
}

type WaitLevel = 'ok' | 'warn' | 'breach';
export type Waiting = {
  openedAt: string;
  openMs: number | null;
  resolvedAt: string | null;
  level: WaitLevel | null;
  thresholds: { warnMinutes: number; breachMinutes: number };
};
const WAIT_LEVEL_LABELS: Record<WaitLevel, string> = {
  ok: 'Within target',
  warn: 'Near target',
  breach: 'Over target',
};
// OPX2-ui: the badge for the inbox and the case header. The level is the server's and is always in
// the text, so colour is never the only signal.
export function caseWait(w: Waiting | undefined) {
  if (!w) return null;
  const opened = `Opened ${formatDate(w.openedAt)}`;
  if (w.openMs !== null && w.level) {
    const { warnMinutes, breachMinutes } = w.thresholds;
    return {
      level: w.level,
      text: `Waiting ${duration(w.openMs)} · ${WAIT_LEVEL_LABELS[w.level]}`,
      title: `${opened} · near target after ${duration(warnMinutes * 60_000)}, target ${duration(breachMinutes * 60_000)}`,
    };
  }
  return {
    level: null,
    text: w.resolvedAt
      ? `Resolved after ${duration(Date.parse(w.resolvedAt) - Date.parse(w.openedAt))}`
      : 'Resolution time not recorded',
    title: opened,
  };
}

// FX2-b: the bank's operations newest first, whatever order the bank returns them in.
export const newestFirst = <T extends { createdAt?: string }>(operations: T[]) =>
  [...operations].sort(
    (a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0),
  );

// R8, K4: a transfer's status in words. A Record over the union: a new status without a label
// fails the typecheck.
export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  created: 'Being prepared',
  awaiting_confirmation: 'Pending your confirmation',
  processing: 'Being sent',
  pending_verification: 'Being verified',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};
export const transferStatusLabel = (status: string) =>
  TRANSFER_STATUS_LABELS[status as TransferStatus] ?? status;
// FX2-c: the same map for an operator, who is not the "you" of the customer's labels.
export const operatorTransferStatusLabel = (status: string) =>
  transferStatusLabel(status).replace(/\byour\b/, "the customer's");

// K4: sent (or being sent) to the bank with no verified outcome yet, so money may be moving.
export function outcomeUnknown(status: TransferStatus): boolean {
  switch (status) {
    case 'processing':
    case 'pending_verification':
      return true;
    case 'created':
    case 'awaiting_confirmation':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'expired':
      return false;
    default:
      return status satisfies never;
  }
}

// CF1-ui: the CF1-api rule for which transfers have a receipt: sent to the bank (a reference) and
// completed or still being verified. A failed or never-sent transfer gets a 409 there.
export const hasReceipt = (t: { status?: string; reference?: string | null }) =>
  !!t.reference && ['completed', 'pending_verification', 'processing'].includes(t.status ?? '');

// CF4-ui: the account ids a favourite toggle must POST. The toggle sends the person's main
// account (R2); pinning stores that one, unpinning removes every pinned account of that person,
// so a person pinned through another of their accounts stops being a favourite.
export function favouriteChange(
  people: { accounts: { id: string }[] }[],
  favourites: string[],
  mainId: string,
  favourite: boolean,
): string[] {
  if (favourite) return [mainId];
  const person = people.find((p) => p.accounts.some((a) => a.id === mainId));
  const pinned = favourites.filter((id) => person?.accounts.some((a) => a.id === id));
  return pinned.length ? pinned : [mainId];
}

// K4: the one duplicate rule, shared by the server (findDuplicate in src/banking/actions.ts, same
// fields in SQL) and the UI: same source, destination and amount. The concept is ignored: it is
// free text the assistant may reword ("Cinema" / "cinema tickets").
const transferKey = (t: TransferInput) => [t.fromAccountId, t.toAccountId, t.amountCents].join('|');

// X3: ids of pending proposals that are duplicates of another pending one (transferKey); both
// stay confirmable: two identical intentions may be legitimate.
export function duplicateProposals(approvals: { id: string; payload: TransferInput }[]) {
  const counts = new Map<string, number>();
  for (const { payload } of approvals)
    counts.set(transferKey(payload), (counts.get(transferKey(payload)) ?? 0) + 1);
  return new Set(approvals.filter((a) => counts.get(transferKey(a.payload))! > 1).map((a) => a.id));
}

// R6: a transfer outcome message stored by the server has run_id `outcome:<tone>:<intentId>`.
export function outcomeTone(runId: string | null | undefined) {
  return /^outcome:(\w+):/.exec(runId ?? '')?.[1] ?? null;
}

// U10: display only; the stored message text keeps the full UUID.
export const shortRefs = (text: string) =>
  text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) =>
    shortRef(id.toLowerCase()),
  );

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (value: string) => {
    if (!value) return;
    const prev = out.at(-1);
    if (prev?.kind === 'text') prev.text += value;
    else out.push({ kind: 'text', text: value });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1]) out.push({ kind: 'strong', text: m[1] });
    else if (m[2]) {
      if (SAFE_HREF.test(m[3])) out.push({ kind: 'link', text: m[2], href: m[3] });
      else push(m[0]);
    } else {
      // Trailing punctuation ends the sentence, not the URL.
      const url = m[4].replace(/[.,;:!?'"]+$/, '');
      out.push({ kind: 'link', text: url, href: url });
      push(m[4].slice(url.length));
    }
  }
  push(text.slice(at));
  return out;
}

type Movement = {
  id: string;
  accountId: string;
  amountCents: number;
  description: string;
  createdAt: string;
  // Set by GET /api/dashboard when the operation is one the app sent (R4).
  operationId?: string | null;
  fromAccountId?: string;
  toAccountId?: string;
  concept?: string;
  category?: RowCategoryOut;
};
// SI5 (plan 23, contracts.md §3): a row's category plus the ids to send when changing that row:
// one id, or both legs of a merged "Between your accounts" row.
export type RowCategoryOut = RowCategory & { movementIds: string[] };
type Proposal = { id: string; expires_at: string; payload: TransferInput };
type TransferState = {
  intentId: string;
  status: TransferStatus;
  transfer: TransferInput;
  steps: { at: string }[];
};
export type ActivityRow = {
  id: string;
  kind: 'pending' | 'verifying' | 'internal' | 'movement';
  title: string;
  detail: string;
  amountCents: number;
  account: string;
  accountId: string;
  createdAt: string;
  // CF3-api: computed here so search (GET /api/movements) and the table share one rule.
  direction: 'sent' | 'received' | 'internal' | 'pending';
  // SI5: bank movements only (when the caller passed categories); proposal rows have none.
  category?: RowCategoryOut;
};
type ActivitySource = {
  movements?: Movement[];
  accounts?: Named[];
  contacts?: Named[];
  approvals?: Proposal[];
  transfers?: TransferState[];
};
// Recent activity, as the product owner asked for it:
// R4 (ALT-1): newest first whatever order the bank returns; each row names the customer's account
// it hit, and "Received from X" / "Sent to Y" with the counterparty's name when the app knows the
// operation (else the bank's description). A move between two of the customer's own accounts is
// one "Between your accounts" row, not two.
// R3: proposals awaiting confirmation, and sent transfers whose outcome is being verified, come
// first with their own kind: they are not movements the bank has confirmed.
export function activityRows(
  { movements = [], accounts = [], contacts = [], approvals = [], transfers = [] }: ActivitySource,
  limit = 7,
  // U7 (round 4): only this account's rows (the Overview filter and the account drawer).
  accountId: string | null = null,
): ActivityRow[] {
  const name = (id: string) => accountName(id, { accounts, contacts });
  const own = (id: string) => accountName(id, { accounts });
  const rows: ActivityRow[] = [
    // U7 (round 4): a proposal is not money gone: unsigned amount; its expiry is the date cell.
    ...approvals
      .filter((a) => !accountId || a.payload.fromAccountId === accountId)
      .map((a) => ({
        id: a.id,
        kind: 'pending' as const,
        title: `To ${name(a.payload.toAccountId)}`,
        detail: a.payload.concept,
        amountCents: a.payload.amountCents,
        account: own(a.payload.fromAccountId),
        accountId: a.payload.fromAccountId,
        createdAt: a.expires_at,
        direction: 'pending' as const,
      })),
    ...transfers
      .filter(
        (t) => outcomeUnknown(t.status) && (!accountId || t.transfer.fromAccountId === accountId),
      )
      .map((t) => ({
        id: t.intentId,
        kind: 'verifying' as const,
        title: `To ${name(t.transfer.toAccountId)}`,
        detail: t.transfer.concept,
        amountCents: -t.transfer.amountCents,
        account: own(t.transfer.fromAccountId),
        accountId: t.transfer.fromAccountId,
        createdAt: t.steps.at(-1)?.at ?? '',
        direction: 'pending' as const,
      })),
  ];
  const sorted = [...movements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mine = new Set(accounts.map((a) => a.id));
  const merged = new Set<string>();
  // SI5: additive; no `category` key at all when the movement carries none.
  const categoryOf = (m: Movement) => (m.category ? { category: m.category } : {});
  const between = (m: Movement, concept: string, fromId: string, toId: string) => ({
    id: m.id,
    kind: 'movement' as const,
    title: 'Between your accounts',
    detail: `${stripBidi(concept)} · ${own(fromId)} → ${own(toId)}`,
    amountCents: m.amountCents,
    account: own(m.accountId),
    accountId: m.accountId,
    createdAt: m.createdAt,
    direction: 'internal' as const,
    ...categoryOf(m),
  });
  for (const m of sorted) {
    if (accountId && m.accountId !== accountId) continue;
    const pair = m.operationId
      ? sorted.filter((x) => x.operationId === m.operationId && mine.has(x.accountId))
      : [];
    if (pair.length === 2) {
      const [from, to] = pair[0].amountCents < 0 ? pair : [pair[1], pair[0]];
      const concept = pair.find((x) => x.concept)?.concept ?? m.description;
      // Filtered to one account: that account's signed leg of the internal move.
      if (accountId) {
        rows.push(between(m, concept, from.accountId, to.accountId));
        continue;
      }
      if (merged.has(m.operationId!)) continue;
      merged.add(m.operationId!);
      rows.push({
        id: m.operationId!,
        kind: 'internal',
        title: 'Between your accounts',
        detail: `${stripBidi(concept)} · ${own(from.accountId)} → ${own(to.accountId)}`,
        amountCents: Math.abs(m.amountCents),
        account: own(to.accountId),
        accountId: to.accountId,
        createdAt: m.createdAt,
        direction: 'internal',
        // SI5: the debit leg's category; a change from this row posts both legs.
        ...(from.category && {
          category: { ...from.category, movementIds: [from.id, to.id] },
        }),
      });
      continue;
    }
    const credit = m.amountCents > 0,
      other = credit ? m.fromAccountId : m.toAccountId;
    // An internal move whose other leg is not in the list (e.g. past the bank's 100 movements).
    if (other && mine.has(other)) {
      const concept = m.concept ?? m.description;
      rows.push(
        credit ? between(m, concept, other, m.accountId) : between(m, concept, m.accountId, other),
      );
      continue;
    }
    rows.push({
      id: m.id,
      kind: 'movement',
      title: other ? `${credit ? 'Received from' : 'Sent to'} ${name(other)}` : m.description,
      detail: other ? (m.concept ?? m.description) : '',
      amountCents: m.amountCents,
      account: own(m.accountId),
      accountId: m.accountId,
      createdAt: m.createdAt,
      direction: m.amountCents < 0 ? 'sent' : 'received',
      ...categoryOf(m),
    });
  }
  const pinned = rows.filter((r) => r.kind === 'pending' || r.kind === 'verifying').length;
  return rows.slice(0, Math.max(limit, pinned));
}
// U7 (round 4): one account's activity (null = all accounts, same as activityRows).
export const accountActivity = (d: ActivitySource, accountId: string | null, limit = 7) =>
  activityRows(d, limit, accountId);

export type AnyRecord = Record<string, any>;
// UI1 (plan 28 D7): `goals` is the customer's "Plan" tab.
export type Tab =
  'overview' | 'assistant' | 'transfers' | 'goals' | 'documents' | 'cases' | 'usage';
const TABS: Record<'customer' | 'operator', Tab[]> = {
  customer: ['overview', 'assistant', 'transfers', 'goals', 'documents'],
  operator: ['cases', 'documents', 'usage'],
};
// U5: the tab named in `?tab=` when the role has it, else the role's first tab.
export function parseTab(search: string, role: 'customer' | 'operator'): Tab {
  const tab = new URLSearchParams(search).get('tab') as Tab;
  return TABS[role].includes(tab) ? tab : TABS[role][0];
}

// Short, stable case reference shown instead of the raw id (U10).
export function shortRef(id: string): string {
  let h = 0x811c9dc5;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return '#' + h.toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

// INT1-ui: the case rail's audit line, in words so the state is never colour only. Nothing is
// claimed beyond the server's verifyAuditChain result.
export function auditLine(audit: AuditStatus | undefined) {
  if (!audit) return null;
  if (audit.brokenAt) {
    const { kind, at } = audit.brokenAt;
    return {
      tone: 'broken' as const,
      text: kind
        ? `Audit log broken at step ${kind}${at ? ` · ${formatDate(at)}` : ''}`
        : 'Audit log broken · the newest steps are missing',
      note: 'Steps from that point may not be as recorded. See Evidence gaps.',
    };
  }
  if (audit.status === 'empty')
    return { tone: 'empty' as const, text: 'Audit log empty · no steps recorded yet', note: null };
  // One chain per database: `checked` is the whole log, so say so rather than imply this case's count.
  const steps = `${audit.checked} step${audit.checked === 1 ? '' : 's'}`;
  return {
    tone: 'verified' as const,
    text: `Audit log verified · ${steps} across all cases, no changes detected`,
    note: audit.legacy
      ? `${audit.legacy.count} steps were recorded before the audit log existed (${formatDate(audit.legacy.at)}): they are known unchanged only since then.`
      : null,
  };
}

// OPX4-ui: views and exports were not recorded before `case-activity-since`; say so for cases
// opened before it, instead of implying nobody looked.
export function activityNote(activitySince: string | null | undefined, openedAt: string) {
  if (!activitySince) return 'Views and exports before this version were not recorded.';
  if (new Date(openedAt) >= new Date(activitySince)) return null;
  return `Views and exports are recorded since ${formatDate(activitySince)}. Earlier ones were not recorded.`;
}

// OPX1-ui: the case export download (OPX1-api) and the file name the server gave it.
export const exportUrl = (caseId: string, format: 'json' | 'html') =>
  `/api/incidents/${encodeURIComponent(caseId)}/export?format=${format}`;
export const attachmentName = (contentDisposition: string | null, fallback: string) =>
  contentDisposition?.match(/filename="([^"]+)"/)?.[1] ?? fallback;

// U11: search hits under this score are not results for anyone.
// ponytail: fixed cut-off from audit scores (relevant 0.57–0.67, nonsense 0.18,
// .scratch/audit-04/ux/walk1b.txt); calibrate if the embedding model changes.
export const RELEVANT_SCORE = 0.35;
export const relevantSources = (sources: AnyRecord[]) =>
  sources.filter((s) => s.score >= RELEVANT_SCORE);
// U11: a document's text without its "# <title>" line and its "Document <id>. Version N. …
// Audience: …" paragraph (the reader shows both as its title and chips).
export const stripDocHeader = (text: string) =>
  text.replace(/^# .*\n+/, '').replace(/^Document \S+\. Version .*Audience: .*(\n+|$)/, '');
// U11: a chunk's readable body: the text after its "<title>[\n<heading>]" header (else all of it),
// without the document header and the markdown "#" marks.
export function excerptText(chunk: string) {
  const i = chunk.indexOf('\n\n');
  return stripDocHeader(i < 0 ? chunk : chunk.slice(i + 2)).replace(/^#{1,6} /gm, '');
}
