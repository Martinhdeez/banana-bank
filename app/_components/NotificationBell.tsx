import { useRef, useState } from 'react';
import type { NotificationItem } from '../../src/notifications';
import { formatDate, formatDay, money } from '../../src/ui-helpers';
import { Icon } from './Icon';

// CF5-ui: text is built here, not on the server, so money and times use the viewer's locale and
// time zone (hydration rule 8). Wording from the CF5 plan table.
export function notificationText(n: NotificationItem): string {
  const what = `${money(n.amountCents ?? 0)} to ${n.to}`;
  switch (n.kind) {
    case 'transfer_verified':
      return n.status === 'completed'
        ? `${what} was completed by the bank.`
        : `${what} was not registered by the bank. No money moved.`;
    case 'proposal_expiring':
      return `Confirm or cancel soon: ${what} expires at ${formatDate(n.expiresAt!)}.`;
    case 'proposal_expired':
      return `${what} expired without confirmation. No money moved.`;
    case 'case_resolved':
      return 'A support agent marked your request as resolved.';
    case 'prepared_due': // PT1 (plan 25 §6)
      return `Your prepared transfer of ${what} is due. It is not sent until you send it.`;
  }
}
export const badgeText = (unread: number) => (unread > 9 ? '9+' : String(unread));
export const bellLabel = (unread: number) =>
  unread ? `Notifications, ${unread} unread` : 'Notifications';

// Native <dialog> with showModal(): Esc, the focus trap and focus return come free; a click on
// the backdrop (the dialog element itself) closes it. Opening it marks the unread items read
// (Home); they keep their highlight until the panel closes.
export function NotificationBell({
  unread,
  items,
  onOpen,
  onGo,
}: {
  unread: number;
  items: NotificationItem[];
  onOpen(): void;
  onGo(link: NotificationItem['link']): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  function open() {
    setSeen(new Set(items.filter((n) => !n.read).map((n) => n.id)));
    ref.current?.showModal();
    onOpen();
  }
  return (
    <>
      <button
        type="button"
        className="icon-button notification-bell"
        aria-haspopup="dialog"
        aria-label={bellLabel(unread)}
        onClick={open}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="count-badge" aria-hidden="true">
            {badgeText(unread)}
          </span>
        )}
      </button>
      <dialog
        ref={ref}
        className="notification-panel"
        aria-labelledby="notification-panel-title"
        onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      >
        <div className="notification-head">
          <h2 id="notification-panel-title">Notifications</h2>
          <button
            type="button"
            className="icon-button close"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {items.length === 0 ? (
          <p className="notification-empty">
            Nothing new. Transfer outcomes, expiring proposals and resolved requests appear here.
          </p>
        ) : (
          <ul className="notification-list">
            {items.map((n) => {
              const fresh = !n.read || seen.has(n.id);
              return (
                <li key={n.id} className={`notification-item ${fresh ? 'unread' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      ref.current?.close();
                      onGo(n.link);
                    }}
                  >
                    <span className="notification-dot" aria-hidden="true" />
                    <span className="notification-body">
                      {fresh && <span className="sr-only">New. </span>}
                      <span className="notification-text">{notificationText(n)}</span>
                      {/* PT2: a due date has no hour (it would print as midnight). */}
                      <time dateTime={n.at}>
                        {n.kind === 'prepared_due' ? formatDay(n.at) : formatDate(n.at)}
                      </time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </dialog>
    </>
  );
}
