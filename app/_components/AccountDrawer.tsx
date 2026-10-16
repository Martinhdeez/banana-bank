import { useEffect, useRef, useState } from 'react';
import { accountActivity, formatDate, money, type AnyRecord } from '../../src/ui-helpers';
import { Icon } from './Icon';
import { accountIcon, amountText } from './Overview';

// Account details: a drawer on desktop, a bottom sheet at ≤760px (CSS only). Native <dialog>:
// showModal() traps focus, Esc and the backdrop close it, and focus returns to the opener.
export function AccountDrawer({
  account,
  isMain,
  holder,
  dashboard,
  onClose,
  onTransferFrom,
}: {
  account: AnyRecord | null;
  isMain: boolean;
  holder: string;
  dashboard: AnyRecord;
  onClose(): void;
  onTransferFrom(id: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // The 20 s refresh passes the account again by id; it closes if the account is gone.
    if (account && !dialog.open) dialog.showModal();
    if (!account && dialog.open) dialog.close();
  }, [account]);
  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const raw = (account?.iban ?? '').replace(/\s+/g, '');
  const rows = account ? accountActivity(dashboard, account.id, 5) : [];
  return (
    <dialog
      ref={ref}
      className="account-drawer"
      aria-labelledby="account-drawer-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      {account && (
        <>
          <div className="drawer-head">
            <h2 id="account-drawer-title">Account details</h2>
            <button
              className="icon-button close"
              aria-label="Close"
              onClick={() => ref.current?.close()}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className={`drawer-summary ${isMain ? 'main' : ''}`}>
            <div className="drawer-account">
              <span className="drawer-tile" aria-hidden="true">
                {accountIcon(isMain)}
              </span>
              <span>
                <strong>{account.label}</strong>
                {isMain && <small>Main account</small>}
              </span>
            </div>
            <div className="drawer-label">Available balance</div>
            <div className="drawer-balance">{money(account.balanceCents)}</div>
            <button className="primary-button" onClick={() => onTransferFrom(account.id)}>
              <Icon name="transfer" size={15} /> Transfer from here
            </button>
          </div>
          <dl className="drawer-details">
            <div>
              <dt>Account holder</dt>
              <dd>{holder}</dd>
            </div>
            <div>
              <dt>IBAN</dt>
              <dd className="drawer-iban">
                <span className="iban">{raw.replace(/(.{4})(?=.)/g, '$1 ')}</span>
                <button
                  className="copy"
                  aria-label="Copy IBAN"
                  onClick={() =>
                    navigator.clipboard.writeText(raw).then(
                      () => setCopied('done'),
                      () => setCopied('failed'),
                    )
                  }
                >
                  <Icon name={copied === 'done' ? 'check' : 'copy'} size={14} />
                </button>
                <span role="status" className="copy-status">
                  {copied === 'done'
                    ? 'Copied'
                    : copied === 'failed'
                      ? 'Copy failed, select the IBAN'
                      : ''}
                </span>
              </dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>EUR</dd>
            </div>
          </dl>
          <h3 className="drawer-subtitle">Recent transactions</h3>
          {rows.length === 0 && <p className="empty-state">No transactions yet.</p>}
          {rows.map((r) => (
            <div className="drawer-row" key={r.id}>
              <span>
                <strong>{r.title}</strong>
                <small>
                  {r.kind === 'pending'
                    ? `Expires ${formatDate(r.createdAt)}`
                    : formatDate(r.createdAt)}
                </small>
              </span>
              <b
                className={`amount ${r.kind === 'movement' && r.amountCents > 0 ? 'credit' : r.kind === 'pending' ? 'neutral' : ''}`}
              >
                {amountText(r)}
                {r.kind === 'pending' && <span className="amount-note">Not sent yet</span>}
              </b>
            </div>
          ))}
        </>
      )}
    </dialog>
  );
}
