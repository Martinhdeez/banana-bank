'use client';
import { useEffect, useState } from 'react';
import type { Receipt as ReceiptData } from '../../src/banking/receipt';
import { formatDate, money, readJson, transferStatusLabel } from '../../src/ui-helpers';
import { Icon } from './Icon';

// CF1-ui: the CF1-api receipt, fetched after mount (times render in the browser only, hydration
// rule 8). A non-final transfer is a "record", never proof of payment; missing facts say so.
const when = (at: string | null, missing: string) =>
  at ? (
    <time dateTime={at}>{formatDate(at)}</time>
  ) : (
    <span className="receipt-missing">{missing}</span>
  );

export function Receipt({ intentId }: { intentId: string }) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch(`/api/transfers/${encodeURIComponent(intentId)}/receipt`, { cache: 'no-store' })
      .then(readJson)
      .then(setReceipt, (e: Error) => setError(e.message));
  }, [intentId]);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {}
  }
  const r = receipt;
  return (
    <main className="receipt-page">
      <header className="receipt-brand">
        <span className="logo-tile">
          <Icon name="banana" size={21} />
        </span>
        <span className="brand-name">
          banana<span className="brand-dot">.</span>
        </span>
      </header>
      <article className="card receipt-card" aria-busy={!r && !error}>
        <div className="eyebrow">BANANA BANK</div>
        <h1>{r && !r.final ? 'Transfer record (not final)' : 'Transfer receipt'}</h1>
        {error ? (
          <p role="alert" className="alert error">
            {error}
          </p>
        ) : !r ? (
          <p className="loading">
            <span className="spinner" /> Loading the receipt…
          </p>
        ) : (
          <>
            {!r.final && (
              <p className="receipt-banner" role="note">
                Being verified with the bank. This is not proof of payment.
              </p>
            )}
            <div className="receipt-amount">{money(r.amountCents)}</div>
            <dl className="receipt-fields">
              <dt>Reference</dt>
              <dd className="receipt-reference">
                <code>{r.reference}</code>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => copy(r.reference)}
                  aria-label="Copy reference"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </dd>
              <dt>Status</dt>
              <dd>{r.final ? 'Completed by the bank' : transferStatusLabel(r.status)}</dd>
              <dt>Amount</dt>
              <dd>{money(r.amountCents)}</dd>
              <dt>From</dt>
              <dd>
                {r.from.label}
                <small>
                  {r.from.iban ? <code>{r.from.iban}</code> : 'IBAN not available right now'}
                </small>
              </dd>
              <dt>To</dt>
              <dd>
                {r.to.label && !r.to.name.includes(r.to.label)
                  ? `${r.to.name} · ${r.to.label}`
                  : r.to.name}
              </dd>
              <dt>Description</dt>
              <dd>{r.concept}</dd>
              <dt>Proposed</dt>
              <dd>{when(r.proposedAt, 'Not recorded')}</dd>
              <dt>Confirmed</dt>
              <dd>{when(r.confirmedAt, 'Not applicable')}</dd>
              <dt>Sent</dt>
              <dd>{when(r.sentAt, 'Not recorded')}</dd>
              {/* UI-1 (review): the Status row above already names the bank; this row is the time. */}
              <dt>Completed</dt>
              <dd>{when(r.executedAt, 'Completion time not recorded')}</dd>
              <dt>Verified</dt>
              <dd>{when(r.verifiedAt, 'Not verified yet')}</dd>
              <dt>Issued</dt>
              <dd>{when(r.issuedAt, '')}</dd>
            </dl>
          </>
        )}
        <div className="receipt-actions">
          {r && (
            <button type="button" className="primary-button" onClick={() => window.print()}>
              Print or save as PDF
            </button>
          )}
          <a className="secondary-button" href="/?tab=transfers">
            Back to transfers
          </a>
        </div>
      </article>
    </main>
  );
}
