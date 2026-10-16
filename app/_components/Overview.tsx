import { useState } from 'react';
import { groupRecipients, mainAccount, type Recipient } from '../../src/banking/recipients';
import type { Person } from '../../src/types';
import {
  accountActivity,
  accountKind,
  accountName,
  formatDate,
  money,
  type ActivityRow,
  type AnyRecord,
  type Tab,
} from '../../src/ui-helpers';
import { ASK_SPENDING, accountSuggestions } from './ChatInsights';
import { Icon } from './Icon';

const piggy = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <path d="M5 11a7 6 0 0 1 13-2h2v4h-2a7 6 0 0 1-3 3v3h-3v-2h-2v2H7v-3a6 6 0 0 1-2-5Z" />
  </svg>
);
// A24c: the tile of an account, on its Overview row and in its drawer.
export const accountIcon = (isMain: boolean) => (isMain ? <Icon name="card" size={17} /> : piggy);
const arrowIn = <path d="M17 7 7 17M7 8v9h9" />,
  arrowOut = <path d="M7 17 17 7M8 7h9v9" />;
const glyph = (d: React.ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);

// U7 (round 4): the amount as shown. A proposal is not money gone (no sign); a credit gets "+".
export function amountText(r: ActivityRow) {
  return `${r.kind === 'movement' && r.amountCents > 0 ? '+' : ''}${money(r.amountCents)}`;
}

function RowIcon({ row }: { row: ActivityRow }) {
  const tone =
    row.kind === 'pending'
      ? 'pending'
      : row.kind === 'verifying'
        ? 'verifying'
        : row.kind === 'internal' || row.title === 'Between your accounts'
          ? 'internal'
          : row.amountCents > 0
            ? 'credit'
            : 'debit';
  return (
    <span className={`movement-icon ${tone}`} aria-hidden="true">
      {tone === 'pending' || tone === 'verifying' ? (
        <Icon name="clock" size={16} />
      ) : tone === 'internal' ? (
        <Icon name="transfer" size={16} />
      ) : (
        glyph(tone === 'credit' ? arrowIn : arrowOut)
      )}
    </span>
  );
}

function ActivityTable({
  rows,
  mainId,
  emptyText,
  rowExtra,
}: {
  rows: ActivityRow[];
  mainId: string;
  // CF3-ui: a search with no results replaces the text and drops the column headers.
  emptyText?: string;
  // SI7-slots: one line of small controls under the description; no wrapper when it is empty.
  rowExtra?: (row: ActivityRow) => React.ReactNode;
}) {
  const extra = (row: ActivityRow) => {
    const node = rowExtra?.(row);
    return node ? <div className="movement-extra">{node}</div> : null;
  };
  return (
    <>
      {!(emptyText && rows.length === 0) && (
        <div className="movements-head" aria-hidden="true">
          <span />
          <span>Description</span>
          <span>Account</span>
          <span>Date</span>
          <span>Amount</span>
        </div>
      )}
      {rows.length === 0 && <p className="empty-state">{emptyText ?? 'No transactions yet.'}</p>}
      {rows.map((m) => (
        <div className={`movement ${m.kind}`} key={m.id}>
          <RowIcon row={m} />
          <div className="movement-main">
            {/* R3: proposals and transfers being verified are not confirmed movements. */}
            {m.kind === 'pending' && (
              <span className="pending-badge">Pending your confirmation</span>
            )}
            {m.kind === 'verifying' && (
              <span className="pending-badge verifying">Being verified</span>
            )}
            {/* U7 (round 1): direction in words, not only arrow and colour. */}
            {m.kind === 'movement' && !/^(Received|Sent) /.test(m.title) && (
              <span className="sr-only">{m.amountCents > 0 ? 'Received: ' : 'Sent: '}</span>
            )}
            <strong>{m.title}</strong>
            {m.detail && <span className="movement-sub">{m.detail}</span>}
            {extra(m)}
          </div>
          <div className="movement-meta">
            {/* R4: the customer's account it hit, and when (X5: always with the year). */}
            <span className="movement-account">
              <i className={`dot ${m.accountId === mainId ? 'main' : 'other'}`} />
              {m.account}
            </span>
            <small className="movement-date">
              {m.kind === 'pending'
                ? `Expires ${formatDate(m.createdAt)}`
                : formatDate(m.createdAt)}
            </small>
          </div>
          <b
            className={`amount ${m.kind === 'pending' ? 'neutral' : m.kind === 'verifying' ? 'verifying' : m.kind === 'movement' && m.amountCents > 0 ? 'credit' : ''}`}
          >
            {amountText(m)}
            {/* U7 (round 4): a proposal has not left the account. */}
            {m.kind === 'pending' && <span className="amount-note">Not sent yet</span>}
          </b>
        </div>
      ))}
    </>
  );
}

// PT-slots (prepared transfers): an extra row of the attention card, after the approvals.
type AttentionItem = {
  id: string;
  title: string;
  detail: string;
  actionLabel: string;
  onAction(): void;
};

function AttentionCard({
  approvals,
  attention = [],
  dashboard,
  onReview,
}: {
  approvals: AnyRecord[];
  attention?: AttentionItem[];
  dashboard: AnyRecord;
  onReview(): void;
}) {
  const sorted = [...approvals].sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  return (
    <section className="card attention" aria-labelledby="attention-title">
      <div className="attention-head">
        <h2 id="attention-title">For you to do</h2>
        <span className="count-badge">{approvals.length + attention.length}</span>
      </div>
      <ul className={`attention-list ${sorted.length + attention.length === 1 ? 'single' : ''}`}>
        {sorted.map((a) => (
          <li className="attention-item" key={a.id}>
            <i className="dot pending" aria-hidden="true" />
            <span className="attention-text">
              <strong>
                {money(a.payload.amountCents)} to{' '}
                <bdi>{accountName(a.payload.toAccountId, dashboard)}</bdi>
              </strong>
              <small>
                <bdi>{a.payload.concept}</bdi> · expires {formatDate(a.expires_at)}
              </small>
            </span>
            <button className="text-link" onClick={onReview}>
              Review in Transfers →
            </button>
          </li>
        ))}
        {attention.map((a) => (
          <li className="attention-item" key={a.id}>
            <i className="dot pending" aria-hidden="true" />
            <span className="attention-text">
              <strong>{a.title}</strong>
              <small>{a.detail}</small>
            </span>
            <button className="text-link" onClick={a.onAction}>
              {a.actionLabel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecipientsCard({
  recipients,
  people,
  onPick,
  onAll,
  favourite,
}: {
  recipients: Recipient[];
  people: Person[];
  // CF4: a star on favourites (by person key), as in the Transfers chips.
  favourite?: (key: string) => boolean;
  onPick(accountId?: string): void;
  onAll(): void;
}) {
  return (
    <section className="card recipients" aria-labelledby="recipients-title">
      <div className="recipients-head">
        <h2 id="recipients-title">Recipients</h2>
        {/* A11: it opens the empty transfer form; there is no list of recipients to open. */}
        <button className="text-link" onClick={onAll}>
          New transfer
        </button>
      </div>
      <div className="recipient-row">
        {recipients.slice(0, 5).map((r) => {
          const person = people.find((p) => p.id === r.key);
          const initials =
            person?.initials ??
            r.name
              .split(/\s+/)
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase();
          const isFav = favourite?.(r.key);
          return (
            <button className="recipient" key={r.key} onClick={() => onPick(r.main.id)}>
              <span className="avatar" style={{ background: person?.color }} aria-hidden="true">
                {initials}
                {isFav && <i className="fav">★</i>}
              </span>
              {r.name.split(' ')[0]}
              {isFav && <span className="sr-only">, favourite</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function Overview({
  current,
  people,
  dashboard,
  allActivity,
  onToggleAll,
  onTab,
  onOpenAccount,
  onStartTransfer,
  toolbar,
  onAccountFilterChange,
  rows,
  emptyText,
  recipientList,
  favourite,
  insights,
  rowExtra,
  attention,
  onAsk,
  plan,
}: {
  current: Person;
  people: Person[];
  dashboard: AnyRecord;
  allActivity: boolean;
  onToggleAll(): void;
  onTab(t: Tab): void;
  onOpenAccount(id: string): void;
  onStartTransfer(p: { from?: string; to?: string }): void;
  // Optional extension points for round 5 (CF2/CF3 search and filters); unused today.
  toolbar?: React.ReactNode;
  onAccountFilterChange?(accountId: string | null): void;
  rows?: ActivityRow[];
  // CF3-ui: text for an empty `rows` (a search with no results); hides headers and View all.
  emptyText?: string;
  // CF4 ranked recipients (shown in the order given) and favourites by person key.
  recipientList?: Recipient[];
  favourite?: (key: string) => boolean;
  // SI7-slots (round 7, spend insights): a full-width block above the transactions, and an
  // extra line in each movement row. Nothing renders without them.
  insights?: React.ReactNode;
  rowExtra?: (row: ActivityRow) => React.ReactNode;
  // PT-slots: more rows for "For you to do", after the approvals; counted in its badge.
  attention?: AttentionItem[];
  // Overview v3: opens the Assistant and sends this text; without it the card has no composer.
  onAsk?(text: string): void;
  // UI1 (plan 28 D7): the brief and the compact Plan card, after the Assistant card.
  plan?: React.ReactNode;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const accounts: AnyRecord[] = dashboard.accounts ?? [];
  const main = mainAccount(accounts);
  const ordered = main ? [main, ...accounts.filter((a) => a !== main)] : [];
  const total = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const [int, dec] = money(total).split('.');
  const recipients = recipientList ?? groupRecipients(dashboard.contacts ?? []);
  const approvals: AnyRecord[] = dashboard.approvals ?? [];
  // A filter on an account that is gone (persona switch) falls back to All.
  const shown = accounts.some((a) => a.id === filter) ? filter : null;
  const activity = rows ?? accountActivity(dashboard, shown, allActivity ? Infinity : 7);
  // v3 nits, AS1: the suggestions name what this customer holds (one rule with the Assistant).
  const suggestions = [ASK_SPENDING, ...accountSuggestions(accounts)];
  return (
    <>
      <section className="page-heading overview-heading">
        <div>
          {/* X5: the real date, not the document reference date. */}
          <span className="date-chip">Today · {formatDate(new Date(), false)}</span>
          {/* PL1 (round 6): the h1 is the greeting only; "Total balance" labels the amount. */}
          <h1 className="greeting">
            Hello, {current.name.split(' ')[0]}
            <span className="hello-dot">.</span>
          </h1>
        </div>
        <div className="heading-actions">
          <button className="primary-button" onClick={() => onStartTransfer({})}>
            <Icon name="transfer" size={15} /> Transfer
          </button>
          {main && (
            <button className="secondary-button" onClick={() => onOpenAccount(main.id)}>
              <Icon name="card" size={15} /> Account details
            </button>
          )}
          <button className="secondary-button" onClick={() => onTab('assistant')}>
            <Icon name="sparkle" size={15} /> Ask
          </button>
          <button className="secondary-button mobile-only" onClick={() => onTab('documents')}>
            <Icon name="document" size={15} /> Fees
          </button>
        </div>
      </section>
      {/* Overview v3: the balance card (total, one row per account) beside the side column. */}
      <section className="overview-top">
        <section className="card balance-card">
          <div className="total-balance" role="group" aria-labelledby="total-balance-label">
            <span id="total-balance-label" className="total-label">
              Total balance
            </span>
            <div className="total-amount">
              {int}
              {dec && <span className="dec">.{dec}</span>}
            </div>
            <span className="total-count">
              · {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
            </span>
          </div>
          <div className="account-grid">
            {ordered.map((a) => {
              // The real last four digits; the full IBAN is in the account details.
              const last4 = (a.iban ?? '').replace(/\s+/g, '').slice(-4);
              return (
                <button
                  className={`account-card ${a === main ? 'main' : ''}`}
                  key={a.id}
                  aria-label={`${a.label} details`}
                  onClick={() => onOpenAccount(a.id)}
                >
                  <span className="account-tile">{accountIcon(a === main)}</span>
                  <span className="account-text">
                    <span className="account-name">{a.label}</span>
                    <span className="account-sub">
                      {accountKind(a)}
                      {last4 && (
                        <span className="account-iban">
                          {' · ···· '}
                          <span>{last4}</span>
                        </span>
                      )}
                    </span>
                    {a === main && <span className="badge-main">Main</span>}
                  </span>
                  <span className="account-balance">{money(a.balanceCents)}</span>
                  <span className="account-chevron">
                    <Icon name="chevron" size={16} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <div className="overview-side">
          {/* "For you to do" names a pending money task: it comes straight after the balance card
              in the markup, so it is on the first screen of a phone. From 1240px it is drawn under
              the balance card and the Assistant card is the right column, so Tab goes down the
              left column and then once to the top of the right one. */}
          {approvals.length + (attention?.length ?? 0) > 0 && (
            <AttentionCard
              approvals={approvals}
              attention={attention}
              dashboard={dashboard}
              onReview={() => onTab('transfers')}
            />
          )}
          <section className="card assistant-card" aria-labelledby="assistant-card-title">
            <div className="assistant-head">
              <Icon name="sparkle" size={16} />
              <h2 id="assistant-card-title">Assistant</h2>
              <button className="text-link" onClick={() => onTab('assistant')}>
                Open chat →
              </button>
            </div>
            {onAsk && (
              <>
                <form
                  className="assistant-ask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (question.trim()) onAsk(question.trim());
                  }}
                >
                  <input
                    aria-label="Ask about your money"
                    placeholder="Ask about your money"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                  <button type="submit" aria-label="Send to the assistant">
                    <Icon name="arrow" size={14} />
                  </button>
                </form>
                <div className="assistant-chips">
                  {suggestions.map((q) => (
                    <button key={q} onClick={() => onAsk(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
          {plan}
        </div>
      </section>
      {insights && (
        <div className="overview-insights" data-testid="overview-insights">
          {insights}
        </div>
      )}
      {/* A4: Recipients is a row above the table, which takes the whole width (its descriptions
          were cut beside a short Recipients card). */}
      <section className="overview-bottom">
        {recipients.length > 0 && (
          <RecipientsCard
            recipients={recipients}
            people={people}
            // Always opens the review flow: it only fills the form on Transfers; nothing is sent.
            onPick={(to) => onStartTransfer({ to })}
            onAll={() => onStartTransfer({})}
            favourite={favourite}
          />
        )}
        {/* SI7-slots: with rowExtra the description column takes the spare room. */}
        <section className={`card movements${rowExtra ? ' has-row-extra' : ''}`}>
          <div className="movements-top">
            <h2>Transactions</h2>
            <div className="movements-tools">
              {accounts.length > 1 && (
                <div className="segmented" role="group" aria-label="Filter by account">
                  {[{ id: null, label: 'All' }, ...ordered].map((a) => (
                    <button
                      key={a.id ?? 'all'}
                      aria-pressed={shown === a.id}
                      onClick={() => {
                        setFilter(a.id);
                        onAccountFilterChange?.(a.id);
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              {/* R4: the bank returns up to 100 movements; show them all on request. */}
              {/* CF7: search rows (`rows`) are the whole result; View all would change nothing. */}
              {!rows && (dashboard.movements?.length ?? 0) > 7 && (
                <button className="text-link" aria-expanded={allActivity} onClick={onToggleAll}>
                  {allActivity ? 'Show less' : 'View all'}
                </button>
              )}
            </div>
          </div>
          {toolbar && <div className="activity-toolbar">{toolbar}</div>}
          <ActivityTable
            rows={activity}
            mainId={main?.id ?? ''}
            emptyText={emptyText}
            rowExtra={rowExtra}
          />
        </section>
      </section>
    </>
  );
}
