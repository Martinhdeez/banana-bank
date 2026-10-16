// OPX1: case export (evidence bundle). Contract: "Operators need to understand the conversation,
// relevant steps, and effects. Historical evidence that was never recorded must not be invented."
// The bundle is the case detail as served (bank read live), what was never recorded said plainly,
// the audit chain status, and a SHA-256 of the case recorded in a `case.exported` event, so a file
// can be checked against the audit trail later. Read-only: no money action, no customer message.
import { createHash, randomUUID } from 'node:crypto';
import { recordEvent } from '../telemetry';
import type { AuditStatus } from '../audit';
import { person } from '../people';
import { money, operatorTransferStatusLabel, shortRef, stripBidi } from '../ui-helpers';
import { caseDetail } from './view';
type Row = Record<string, any>;
export async function exportCase(operatorId: string, id: string, format: 'json' | 'html') {
  // caseDetail checks the role (403) and the case (404) and records no view.
  const { events: _inRuns, ...detail } = await caseDetail(operatorId, id);
  const exportedAt = new Date().toISOString();
  const kase = detail as Row;
  const sha256 = createHash('sha256').update(JSON.stringify(kase)).digest('hex');
  // INT1: verifyAuditChain() already ran inside caseDetail; reuse it (one full events scan, not two).
  const audit = kase.audit as AuditStatus;
  const b = audit.brokenAt;
  const bundle = {
    format: 'banana-case-bundle',
    version: 1,
    exportedAt,
    exportedBy: { id: operatorId, name: person(operatorId)?.name ?? operatorId },
    case: kase,
    // FX2-a — contract: "Historical evidence that was never recorded must not be invented": a
    // failed bank read has no read time.
    bankVerifiedAt: 'error' in kase.bank ? null : exportedAt,
    notRecorded: notRecorded(kase),
    integrity: {
      sha256,
      chain: {
        status: audit.status,
        ...(b
          ? {
              detail: `${b.reason} at event ${b.eventId ?? 'unknown'}${b.kind ? ` (${b.kind})` : ''}`,
            }
          : audit.legacy
            ? {
                detail: `${audit.legacy.count} events recorded before the audit log existed are known unchanged only since ${audit.legacy.at}.`,
              }
            : {}),
      },
    },
  };
  recordEvent(
    {
      userId: operatorId,
      conversationId: kase.incident.conversation_id,
      runId: randomUUID(),
      intentId: '',
    },
    'case.exported',
    { incidentId: id, operatorId, format, sha256 },
  );
  const filename = `case-${shortRef(id).slice(1)}-${exportedAt.slice(0, 10).replace(/-/g, '')}.${format}`;
  return format === 'json'
    ? { body: JSON.stringify(bundle, null, 2), contentType: 'application/json', filename }
    : { body: renderHtml(bundle), contentType: 'text/html; charset=utf-8', filename };
}
// Only what the detail already exposes, stated as not recorded; nothing reconstructed.
function notRecorded(c: Row) {
  const out: string[] = [...c.gaps];
  if (c.summary.handoffSource === 'not_recorded')
    out.push('No assistant handoff summary was recorded.');
  for (const i of c.intents)
    if (!i.bankReference) out.push(`Intent ${i.id}: no bank reference was recorded.`);
  if (c.incident.status === 'closed' && !c.incident.waiting.resolvedAt)
    out.push('Resolution time was not recorded.');
  if (!c.activitySince) out.push('Views and exports before this version were not recorded.');
  else if (c.incident.created_at < c.activitySince)
    out.push(`Views and exports before ${utc(c.activitySince)} were not recorded.`);
  out.push(
    'This export itself is recorded as a case.exported event after the file was built; it is not listed in the activity above.',
  );
  return out;
}
const utc = (iso: string | null | undefined) =>
  iso ? `${iso.replace('T', ' ').slice(0, 19)} UTC` : 'not recorded';
// FX3: no bidi control reaches the report (stored sentences carry customer text), and `bdi`
// isolates a customer or bank value from the app's words on the same line.
const esc = (v: unknown) =>
  stripBidi(String(v ?? '')).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const bdi = (v: unknown) => `<bdi>${esc(v)}</bdi>`;
const list = (items: string[], empty: string) =>
  items.length
    ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(empty)}</p>`;
// Self-contained printable report: inline CSS, no scripts, no external URLs, every value escaped.
function renderHtml(bundle: Row) {
  const c = bundle.case,
    ref = shortRef(c.incident.id),
    name = (accountId: string) => c.accountNames[accountId] ?? accountId,
    customer = c.customer?.name ?? c.incident.user_id;
  const when = (iso: string) => `<small>${esc(utc(iso))}</small>`;
  const sections: [string, string][] = [
    ['Not recorded', list(bundle.notRecorded.map(esc), 'Nothing listed.')],
    [
      'Handoff summary',
      list(
        // FX2-d: each recorded handoff with its time; the other lines as they are.
        [
          ...(c.summary.handoffs ?? []).map(
            (h: Row) => `Assistant handoff: ${esc(h.summary)} ${when(h.at)}`,
          ),
          ...c.summary.text
            .filter((line: string) => !line.startsWith('Assistant handoff: '))
            .map(esc),
        ],
        'No summary.',
      ),
    ],
    [
      'Conversation',
      list(
        c.history.map(
          (m: Row) =>
            `<strong>${esc(m.role)}</strong> ${when(m.created_at)}<p>${esc(m.content)}</p>`,
        ),
        'No messages were recorded.',
      ),
    ],
    [
      'Assistant steps',
      c.runs.length
        ? c.runs
            .map(
              (r: Row) =>
                // FX6-d: a failed turn's error, as stored (marked "Internal (…)" by the app).
                `<h3>Run ${esc(r.id)}${r.recorded ? '' : ' (not a recorded chat run)'}</h3>${
                  r.error ? `<p>Turn failed · ${esc(r.error)}</p>` : ''
                }${list(
                  r.events.map((e: Row) => `${esc(e.description)} ${when(e.created_at)}`),
                  'No steps.',
                )}`,
            )
            .join('')
        : '<p class="muted">No assistant runs or tool steps were recorded.</p>',
    ],
    [
      'Transfer intents',
      list(
        c.intents.map(
          (i: Row) =>
            `<strong>${esc(money(i.payload.amountCents))}</strong> ${bdi(name(i.payload.fromAccountId))} → ${bdi(name(i.payload.toAccountId))}` +
            `<br>App status: ${esc(operatorTransferStatusLabel(i.status))} · Bank: ${esc(i.verified.status)}${i.verified.reason ? ` (${esc(i.verified.reason)})` : ''}` +
            `<br>Reference: ${esc(i.bankReference ?? 'not recorded')} ${when(i.createdAt)}`,
        ),
        'No transfer intents were recorded.',
      ),
    ],
    [
      'Rejected attempts',
      list(
        c.rejectedAttempts.map(
          (a: Row) =>
            `${esc(a.amountCents ? money(a.amountCents) : 'invalid amount')} ${bdi(a.source)} → ${bdi(a.destination)}: ${esc(a.error)} ${when(a.at)}`,
        ),
        'None recorded.',
      ),
    ],
    [
      bundle.bankVerifiedAt ? `Bank (read ${utc(bundle.bankVerifiedAt)})` : 'Bank (not read)',
      'error' in c.bank
        ? `<p>${esc(c.bank.error)}</p>`
        : `<h3>Accounts</h3>${list(
            c.bank.accounts.map(
              (a: Row) => `${bdi(name(a.id))} · ${esc(a.iban)} · ${esc(money(a.balanceCents))}`,
            ),
            'No accounts.',
          )}<h3>Operations</h3>${list(
            c.bank.operations.map(
              (o: Row) =>
                `${esc(o.reference)} · ${esc(o.status)}${typeof o.amountCents === 'number' ? ` · ${esc(money(o.amountCents))}` : ''}${o.createdAt ? ` ${when(o.createdAt)}` : ''}`,
            ),
            'No operations.',
          )}`,
    ],
    [
      'Case activity',
      list(
        c.activity.map((a: Row) => `${esc(a.description)} ${when(a.at)}`),
        'No activity recorded.',
      ),
    ],
    [
      'Integrity',
      `<p>SHA-256 of the case data: <code>${esc(bundle.integrity.sha256)}</code></p>` +
        `<p>Audit chain: ${esc(bundle.integrity.chain.status)}${bundle.integrity.chain.detail ? ` · ${esc(bundle.integrity.chain.detail)}` : ''}</p>`,
    ],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Case ${esc(ref)} · ${esc(customer)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#1d1d1f;background:#fff;max-width:860px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:13px;margin:12px 0 4px}
ul{padding-left:18px;margin:0}li{margin:6px 0}li p{margin:2px 0;white-space:pre-wrap}small,.muted{color:#6e6e73}code{word-break:break-all}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}li{break-inside:avoid}}
</style></head><body>
<h1>Case ${esc(ref)} · ${bdi(customer)}</h1>
<p class="muted">${esc(c.incident.statusLabel)} · opened ${esc(utc(c.incident.created_at))} · exported ${esc(utc(bundle.exportedAt))} by ${esc(bundle.exportedBy.name)}. Times in UTC.</p>
${sections.map(([title, html]) => `<h2>${esc(title)}</h2>${html}`).join('\n')}
</body></html>
`;
}
