import {
  accountName,
  duplicateProposals,
  formatDate,
  money,
  transferFeedback,
  type AnyRecord,
} from '../../src/ui-helpers';
import { Icon } from './Icon';

// Proposal cards and the result stay direct children of .approvals (e2e: `.approvals > div`);
// the head is an h2 so it never matches.

// A24b (polish): on the Transfers page there is nobody to ask, and the status resolves by itself:
// the page reads the dashboard every 20 s while it is visible, and that read looks the transfer
// up at the bank again (recheckPending). The chat keeps the server's wording ("ask about its
// status"), where there is an assistant to ask.
const PAGE_TEXT: Record<string, string> = {
  // A8: the list is on this same page.
  completed: 'Transfer completed. It is listed under “Your transfers” below.',
  pending_verification:
    'The bank has not confirmed this transfer yet, so it may already have gone through. Do not repeat it. This page checks with the bank again by itself and updates the status under “Your transfers”; you do not need to do anything.',
};
// Follow-up 3a: an unconfirmed result whose transfer a later dashboard read shows settled says
// that outcome, in the words of a direct success or failure; the card and the row under "Your
// transfers" never disagree. The failure text is the server's for a verified absence
// (`verifyIntent`): the only way an unknown outcome ends in `failed`.
export function settledResult(result: AnyRecord | null, transfers: AnyRecord[] = []) {
  if (result?.status !== 'pending_verification' && result?.status !== 'processing') return result;
  const row = transfers.find((t) => t.intentId && t.intentId === result.intentId);
  if (row?.status !== 'completed' && row?.status !== 'failed') return result;
  return {
    ...result,
    ...transferFeedback({
      status: row.status,
      error: 'The bank has no record of this transfer, so no money moved.',
    }),
    status: row.status,
  };
}
export function Approvals({
  dashboard,
  confirmResult: given,
  confirming,
  onAct,
  onDismissResult,
  resultRef,
  variant = 'page',
}: {
  dashboard: AnyRecord;
  confirmResult: AnyRecord | null;
  confirming: string;
  onAct(a: AnyRecord, action: 'confirm' | 'cancel'): void;
  onDismissResult(): void;
  resultRef: React.RefObject<HTMLDivElement | null>;
  variant?: 'page' | 'chat';
}) {
  const list = (dashboard.approvals ?? []) as AnyRecord[];
  const confirmResult = settledResult(given, dashboard.transfers);
  if (!(list.length > 0 || confirmResult)) return null;
  const duplicates = duplicateProposals(dashboard.approvals ?? []);
  // U8: newest first. Every approval has the same TTL, so the latest expiry is the newest.
  const sorted = [...list].sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  // U9: one vocabulary: "Transfers to confirm", "Confirm transfer", "Cancel".
  const head = (
    <h2 className="approvals-head">
      <Icon name="clock" />
      Transfers to confirm
      <span className="count-badge">{list.length}</span>
    </h2>
  );
  const result = confirmResult && (
    <div
      ref={resultRef}
      tabIndex={-1}
      className={`alert ${confirmResult.tone} confirm-result`}
      role={confirmResult.tone === 'error' ? 'alert' : 'status'}
    >
      <span>
        <strong>{money(confirmResult.payload.amountCents)}</strong> to{' '}
        <bdi>{accountName(confirmResult.payload.toAccountId, dashboard)}</bdi> ·{' '}
        <bdi>{confirmResult.payload.concept}</bdi>
        <br />
        {(variant === 'page' && PAGE_TEXT[confirmResult.status]) || confirmResult.text}
      </span>
      <button type="button" onClick={onDismissResult} aria-label="Dismiss result">
        ×
      </button>
    </div>
  );
  // A8 (polish): a result is not something "to confirm": it has a neutral heading and no clock.
  // Follow-up 3b: on the page it is its own neutral card, above the yellow panel when proposals
  // are still waiting (it sat inside that panel). The chat keeps one panel, result first.
  const split = variant === 'page' && list.length > 0;
  const resultHead = <h2 className="approvals-head">Transfer result</h2>;
  return (
    <>
      {result && split && (
        <section className={`card approvals ${variant} settled`}>
          {resultHead}
          {result}
        </section>
      )}
      <section className={`card approvals ${variant}${list.length ? '' : ' settled'}`}>
        {list.length === 0 && resultHead}
        {!split && result}
        {list.length > 0 && head}
        {sorted.map((a) => (
          <div
            key={a.id}
            id={`proposal-${a.id}`}
            className="proposal"
            tabIndex={-1}
            aria-label={`Pending your confirmation: ${money(a.payload.amountCents)} to ${accountName(a.payload.toAccountId, dashboard)}`}
          >
            <span className="pending-badge">Pending your confirmation</span>
            <p className="proposal-title">
              <strong>
                {money(a.payload.amountCents)} to{' '}
                <bdi>{accountName(a.payload.toAccountId, dashboard)}</bdi>
              </strong>
              <span>expires {formatDate(a.expires_at)}</span>
            </p>
            <p className="proposal-meta">
              {/* FX3 */}
              <bdi>{a.payload.concept}</bdi> · from{' '}
              <bdi>{accountName(a.payload.fromAccountId, dashboard)}</bdi>
            </p>
            {duplicates.has(a.id) && (
              <p className="duplicate-flag">
                Identical to another transfer to confirm. Confirming both sends the money twice.
              </p>
            )}
            <div className="proposal-actions">
              <button
                type="button"
                className="primary-button is-small"
                disabled={!!confirming}
                onClick={() => onAct(a, 'confirm')}
              >
                {confirming === `confirm:${a.id}` ? 'Confirming…' : 'Confirm transfer'}
              </button>
              <button
                type="button"
                className="secondary-button is-small"
                disabled={!!confirming}
                onClick={() => onAct(a, 'cancel')}
              >
                {confirming === `cancel:${a.id}` ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
