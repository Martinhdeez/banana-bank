import { useEffect, useState } from 'react';
import { groupRecipients, mainAccount, type Recipient } from '../../src/banking/recipients';
import type { Person } from '../../src/types';
import {
  accountKind,
  accountName,
  centsFromEuros,
  formatDate,
  money,
  transferStatusLabel,
  type AnyRecord,
} from '../../src/ui-helpers';
import { Icon } from './Icon';

// Money has left (or may be leaving) the account only in these statuses; the rest show an
// unsigned, faint amount.
const SIGNED = new Set(['completed', 'processing', 'pending_verification']);
// Settled transfers show their steps on one compact line; the rest keep the full timeline.
const FINAL = new Set(['completed', 'cancelled', 'failed', 'expired']);

// A7 (polish): the form's rules in the app's own words, shown under each field. The browser's
// bubbles follow the browser's language. U3's rules are unchanged: a strict amount (comma or dot,
// two decimals at most) and a description that is not blank.
// Follow-up 3c/3d: spaces around the amount are ignored, as the server does (`centsFromEuros`
// trims), and a zero amount is refused here. The server's upper limit stays the server's to say.
const AMOUNT = /^\d{1,9}([.,]\d{1,2})?$/;
export const transferFormErrors = (f: {
  from: string;
  to: string;
  amount: string;
  concept: string;
}) => ({
  from: f.from ? '' : 'Choose the account to send from.',
  to: f.to ? '' : 'Choose who to send it to.',
  amount: !f.amount
    ? 'Enter an amount.'
    : !AMOUNT.test(f.amount.trim())
      ? 'Use digits and up to two decimals, for example 12,50 or 12.50.'
      : centsFromEuros(f.amount)
        ? ''
        : `Enter an amount of at least ${money(1)}.`,
  concept: f.concept.trim() ? '' : 'Add a short description.',
});
type Field = keyof ReturnType<typeof transferFormErrors>;

export function Transfers({
  dashboard,
  people,
  from,
  to,
  amount,
  concept,
  onFrom,
  onTo,
  onAmount,
  onConcept,
  busy,
  onSubmit,
  approvals,
  recipientList,
  favourite,
  onToggleFavourite,
  rowAction,
  recentPaid,
  prepared,
  formExtra,
}: {
  dashboard: AnyRecord;
  people: Person[];
  from: string;
  to: string;
  amount: string;
  concept: string;
  onFrom(id: string): void;
  onTo(id: string): void;
  onAmount(v: string): void;
  onConcept(v: string): void;
  busy: boolean;
  onSubmit(): void;
  approvals: React.ReactNode;
  // Round-5 extension points (unused today; nothing renders when absent):
  // CF4 ranked recipients, shown in the order given, with a star on favourites (by person key).
  recipientList?: Recipient[];
  favourite?: (key: string) => boolean;
  // CF4 a star toggle beside each chip; Home persists it (POST /api/recipients/favourites).
  onToggleFavourite?: (accountId: string, favourite: boolean) => void;
  // CF1 an action at the end of a history row (e.g. a receipt link).
  rowAction?: (t: AnyRecord) => React.ReactNode;
  // CF8: a muted line under a chip name (by person key), shown as given, e.g. "Paid 23 Sept".
  recentPaid?: (key: string) => string | undefined;
  // PT-slots (prepared transfers): a block between the approvals and the form, and a control in
  // the summary between the review button and its note. Nothing renders without them.
  prepared?: React.ReactNode;
  formExtra?: React.ReactNode;
}) {
  const all: AnyRecord[] = dashboard.accounts ?? [],
    main = mainAccount(all),
    // A6 (polish): the main account first, as in Overview.
    accounts = main ? [main, ...all.filter((a) => a !== main)] : all,
    recipients = recipientList ?? groupRecipients(dashboard.contacts ?? []),
    recipient = recipients.find((p) => p.accounts.some((a) => a.id === to)),
    source = accounts.find((a) => a.id === from),
    cents = centsFromEuros(amount),
    mainId = main?.id,
    after = source && cents !== null ? source.balanceCents - cents : null,
    over = after !== null && after < 0;
  // A7: a message shows once its field was left with something in it, or after a submit. A form
  // emptied again (after a proposal, a saved prepared transfer, a change of person) shows none.
  const [shown, setShown] = useState<Partial<Record<Field | 'all', boolean>>>({});
  useEffect(() => {
    if (!to && !amount && !concept) setShown({});
  }, [to, amount, concept]);
  const errors = transferFormErrors({ from, to, amount, concept }),
    error = (field: Field) => (shown.all || shown[field] ? errors[field] : ''),
    // The attributes of a field with a message: marked invalid and described by it.
    flagged = (field: Field) =>
      error(field)
        ? { 'aria-invalid': true, 'aria-describedby': `transfer-${field}-error` }
        : undefined,
    message = (field: Field) =>
      error(field) && (
        // UI-1 (review): role="alert" — a submit from the invalid field itself moves no focus.
        <span id={`transfer-${field}-error`} className="field-error" role="alert">
          {error(field)}
        </span>
      ),
    left = (field: Field) => (e: React.FocusEvent<HTMLInputElement>) => {
      if (e.target.value) setShown((s) => ({ ...s, [field]: true }));
    };
  // "Review transfer" and "Save prepared transfer" both ask the form whether it is valid; each
  // invalid field then lands here: no browser bubble, every message shown, focus on the first.
  function invalid(e: React.FormEvent<HTMLInputElement | HTMLSelectElement>) {
    e.preventDefault();
    setShown({ all: true });
    e.currentTarget.form?.querySelector<HTMLElement>('input:invalid, select:invalid')?.focus();
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">FROM ONE ACCOUNT TO ANOTHER</div>
          <h1>Transfers</h1>
          {/* U9: no "in this environment". */}
          <p>Review every transfer before it is sent.</p>
        </div>
      </div>
      {approvals}
      {prepared || null}
      <form
        className="transfer-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (e.currentTarget.checkValidity()) onSubmit();
        }}
      >
        <div className="card transfer-details">
          <fieldset className="account-tiles">
            <legend className="step">1 · From</legend>
            <div className="tile-grid">
              {accounts.map((a) => (
                <label key={a.id} className="from-tile">
                  <input
                    className="sr-only"
                    type="radio"
                    name="from"
                    value={a.id}
                    checked={a.id === from}
                    onChange={() => onFrom(a.id)}
                    onInvalid={invalid}
                    required
                  />
                  <span>
                    <strong>
                      <i className={`dot${a.id === mainId ? ' main' : ''}`} aria-hidden="true" />
                      {a.label}
                    </strong>
                    <small>{accountKind(a, mainId)}</small>
                  </span>
                  <span className="tile-balance">{money(a.balanceCents)}</span>
                </label>
              ))}
            </div>
            {message('from')}
          </fieldset>
          <div className="step">2 · To</div>
          <div className="recipient-chips" role="group" aria-label="Recipients">
            {recipients.map((r) => {
              const p = people.find((x) => x.id === r.key),
                first = r.name.split(' ')[0],
                isFav = favourite?.(r.key) ?? false,
                paid = recentPaid?.(r.key);
              const chip = (
                <button
                  key={r.key}
                  type="button"
                  className="recipient-chip"
                  aria-pressed={recipient?.key === r.key}
                  onClick={() => onTo(r.main.id)}
                >
                  <span className="avatar" style={{ background: p?.color }} aria-hidden="true">
                    {p?.initials ?? r.name.slice(0, 1)}
                    {isFav && <i className="fav">★</i>}
                  </span>
                  {first}
                  {isFav && <span className="sr-only">, favourite</span>}
                  {paid && <small className="chip-paid">{paid}</small>}
                </button>
              );
              if (!onToggleFavourite) return chip;
              // CF4-ui: favourites are read per person (key) but stored per account id; the
              // toggle sends the person's main account id (R2). Home maps it back when unpinning
              // a person whose pinned account is not the main one.
              return (
                <span key={r.key} className="chip-slot">
                  {chip}
                  <button
                    type="button"
                    className="favourite-toggle"
                    aria-pressed={isFav}
                    aria-label={
                      isFav ? `Remove ${r.name} from favourites` : `Add ${r.name} to favourites`
                    }
                    onClick={() => onToggleFavourite(r.main.id, !isFav)}
                  >
                    <Icon name="star" size={12} className={isFav ? 'filled' : undefined} />
                  </button>
                </span>
              );
            })}
          </div>
          {/* R2: recipients are people; their main account unless another is chosen. */}
          <div className="recipient-fields">
            <label className="field">
              Recipient
              <span className="select-wrap">
                <select
                  aria-label="Recipient"
                  value={recipient?.key ?? ''}
                  onChange={(e) =>
                    onTo(recipients.find((p) => p.key === e.target.value)?.main.id ?? '')
                  }
                  onInvalid={invalid}
                  {...flagged('to')}
                  required
                >
                  <option value="">Select a person</option>
                  {recipients.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" />
              </span>
            </label>
            {recipient && recipient.accounts.length > 1 && (
              <label className="field">
                Recipient account
                <span className="select-wrap">
                  <select
                    aria-label="Recipient account"
                    value={to}
                    onChange={(e) => onTo(e.target.value)}
                    onInvalid={invalid}
                    required
                  >
                    {recipient.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {a.id === recipient.main.id ? ' (main account)' : ''}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron" />
                </span>
              </label>
            )}
          </div>
          <p className="sending-to">
            {to ? (
              <>
                Sending to <strong>{accountName(to, dashboard)}</strong>
              </>
            ) : (
              message('to')
            )}
          </p>
          <div className="step">3 · Amount</div>
          {/* U3: strict format, comma decimals accepted; type=number would refuse "12,50" and
              accept "1e3". The submit is blocked while the pattern does not match. */}
          <label className="amount-field">
            <span className="cur" aria-hidden="true">
              €
            </span>
            <input
              aria-label="Amount in euros"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              required
              pattern={'\\s*(?!0+([.,]0+)?\\s*$)\\d{1,9}([.,]\\d{1,2})?\\s*'}
              placeholder="0.00"
              value={amount}
              onChange={(e) => onAmount(e.target.value)}
              onBlur={left('amount')}
              onInvalid={invalid}
              {...flagged('amount')}
            />
            {source && <span className="available">Available {money(source.balanceCents)}</span>}
          </label>
          {message('amount')}
          {/* A14 (polish): one name for this field everywhere, "Description". */}
          <label className="concept-field">
            <span>Description</span>
            {/* U3: a blank (spaces only) description is refused before any request. */}
            <input
              value={concept}
              onChange={(e) => onConcept(e.target.value)}
              placeholder="What is this transfer for?"
              maxLength={200}
              required
              pattern={'.*\\S.*'}
              onBlur={left('concept')}
              onInvalid={invalid}
              {...flagged('concept')}
            />
          </label>
          {message('concept')}
        </div>
        <aside className="card transfer-summary">
          <h2>Summary</h2>
          <div className={`summary-amount${cents === null ? ' empty' : ''}`}>
            {money(cents ?? 0)}
          </div>
          <dl className="summary-rows">
            <dt>From</dt>
            <dd>{source?.label ?? '—'}</dd>
            <dt>To</dt>
            <dd>{to ? accountName(to, dashboard) : '—'}</dd>
            <dt>Description</dt>
            <dd>{concept.trim() || '—'}</dd>
            <dt>Balance after</dt>
            {/* A7: an amount above the balance is said here at once; the server still refuses it. */}
            <dd className={`estimate${over ? ' over' : ''}`}>
              <span>{after !== null ? money(after) : '—'}</span>
              <small>{over ? 'More than the available balance' : 'Estimated, if confirmed'}</small>
            </dd>
          </dl>
          <button className="primary-button" disabled={busy}>
            {/* R1: the form prepares a proposal to review; it never sends by itself. */}
            {busy ? 'Preparing review…' : 'Review transfer'}
            <Icon name="arrow" />
          </button>
          {formExtra || null}
          <p className="summary-note">Nothing is sent until you confirm it.</p>
        </aside>
      </form>
      {/* R8: each transfer's steps, only as recorded by the app. */}
      {dashboard.transfers?.length > 0 && (
        <section className="card transfer-history">
          <div className="history-title">
            <h2>Your transfers</h2>
            <span>Every step as recorded</span>
          </div>
          <div className="history-head" aria-hidden="true">
            <span>Recipient</span>
            <span>From</span>
            <span>Date</span>
            <span>Status</span>
            <span>Amount</span>
          </div>
          {dashboard.transfers.map((t: AnyRecord) => {
            const contact = (dashboard.contacts ?? []).find(
                (c: AnyRecord) => c.id === t.transfer.toAccountId,
              ),
              // FX1: the transfer's own date (execution, else creation), not its last step's.
              last = t.date ?? t.steps.at(-1)?.at;
            return (
              <article
                key={t.intentId}
                className={`transfer-item${FINAL.has(t.status) ? ' final' : ''}`}
              >
                <div className="transfer-row">
                  <span className="transfer-to">
                    <strong>
                      <bdi>{contact?.name ?? accountName(t.transfer.toAccountId, dashboard)}</bdi>
                    </strong>
                    <small>
                      <bdi>{t.transfer.concept}</bdi>
                    </small>
                  </span>
                  <span className="transfer-meta">
                    <span className="transfer-from">
                      {accountName(t.transfer.fromAccountId, dashboard)}
                    </span>
                    {last && <time dateTime={last}>{formatDate(last)}</time>}
                  </span>
                  <span className={`status-badge ${t.status}`}>
                    {transferStatusLabel(t.status)}
                  </span>
                  <b className={`transfer-amount${SIGNED.has(t.status) ? '' : ' unsent'}`}>
                    {money(SIGNED.has(t.status) ? -t.transfer.amountCents : t.transfer.amountCents)}
                  </b>
                  {rowAction && <span className="row-action">{rowAction(t)}</span>}
                </div>
                <ol className="timeline">
                  {t.steps.map((s: AnyRecord, i: number) => (
                    <li key={i} className={s.kind}>
                      <i className="step-dot" aria-hidden="true" />
                      <span>{s.label}</span>
                      <time dateTime={s.at}>{formatDate(s.at)}</time>
                    </li>
                  ))}
                </ol>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
