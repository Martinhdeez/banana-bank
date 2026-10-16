import type { Person } from '../../src/types';
import type { AnyRecord, Tab } from '../../src/ui-helpers';
import { Icon } from './Icon';

const NAV: Record<'customer' | 'operator', [Tab, string, string][]> = {
  customer: [
    ['overview', 'overview', 'Overview'],
    ['assistant', 'chat', 'Assistant'],
    ['transfers', 'transfer', 'Transfers'],
    // UI1 (plan 28 D7): shown only when the server has a forecast or goals for this customer.
    ['goals', 'target', 'Plan'],
    ['documents', 'document', 'Documents'],
  ],
  operator: [
    ['cases', 'overview', 'Cases'],
    ['documents', 'document', 'Documents'],
    ['usage', 'sparkle', 'AI usage'],
  ],
};

export function Brand() {
  return (
    <>
      <span className="logo-tile">
        <Icon name="banana" size={21} />
      </span>
      <span className="brand-name">
        banana<span className="brand-dot">.</span>
      </span>
    </>
  );
}

export function Shell({
  operator,
  tab,
  onTab,
  collapsed,
  onToggleSidebar,
  people,
  current,
  personId,
  onPerson,
  conversations,
  conversationId,
  onOpenConversation,
  onNewConversation,
  topbarActions,
  plan,
  footAction,
  children,
}: {
  operator: boolean;
  tab: Tab;
  onTab(t: Tab): void;
  collapsed: boolean;
  onToggleSidebar(): void;
  people: Person[];
  current: Person | null;
  personId: string;
  onPerson(id: string): void;
  conversations: AnyRecord[];
  conversationId: string | null;
  onOpenConversation(id: string): void;
  onNewConversation(): void;
  topbarActions?: React.ReactNode;
  // UI1: the "Plan" entry is in the navigation.
  plan?: boolean;
  // UI2: a small control at the end of the user block (a customer's assistant controls).
  footAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  const nav = NAV[operator ? 'operator' : 'customer'].filter(([id]) => id !== 'goals' || plan);
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <>
      {/* U6: first focusable element; jumps past the sidebar to the view. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-head">
            <a className="brand" href="/" aria-label="Banana Bank home">
              <Brand />
            </a>
            <button
              className="sidebar-toggle"
              type="button"
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={onToggleSidebar}
            >
              {collapsed ? (
                <span className="logo-tile">
                  <Icon name="banana" className="glyph-banana" size={21} />
                  <Icon name="expand" className="glyph-expand" size={18} />
                </span>
              ) : (
                <Icon name="sidebar" size={18} />
              )}
            </button>
          </div>
          <div className="workspace-label">
            {operator ? 'CUSTOMER SUPPORT' : 'PERSONAL BANKING'}
          </div>
          {/* The only <nav>: sidebar on desktop, bottom tab bar on phones. Labels stay in the DOM
              when collapsed (visually hidden), so e2e `nav button` locators keep working. */}
          <nav aria-label="Sections">
            {nav.map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${tab === id ? 'active' : ''}`}
                aria-current={tab === id ? 'page' : undefined}
                title={collapsed ? label : undefined}
                onClick={() => onTab(id)}
              >
                <span className="nav-icon">
                  <Icon name={icon} size={18} />
                </span>
                <span className="nav-label">{label}</span>
                {id === 'assistant' && <span className="ai-badge">AI</span>}
              </button>
            ))}
          </nav>
          {!operator && (
            <div className="history">
              <div className="history-heading">
                CONVERSATIONS
                <button type="button" aria-label="New conversation" onClick={onNewConversation}>
                  +
                </button>
              </div>
              <div className="conversation-list">
                {conversations.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={conversationId === c.id ? 'selected' : ''}
                    onClick={() => onOpenConversation(c.id)}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="sidebar-foot">
            <span className="avatar" style={{ background: current?.color }}>
              {current?.initials || '·'}
            </span>
            <span className="foot-text">
              <strong>{current?.name ?? ' '}</strong>
              <small>
                <i className="live-dot" />
                Demo environment
              </small>
            </span>
            {!operator && footAction}
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <a className="topbar-brand" href="/" aria-label="Banana Bank home">
              <Brand />
            </a>
            <div className="breadcrumb">
              {operator ? 'Customer support' : 'Personal banking'} <span>/</span>{' '}
              <strong>{nav.find(([id]) => id === tab)?.[2]}</strong>
            </div>
            {topbarActions}
            <div className="persona-control">
              <span className="demo-label">VIEW AS</span>
              <label className="persona-pill">
                <span className="avatar small" style={{ background: current?.color }}>
                  {current?.initials || '·'}
                </span>
                {/* U1: enabled as soon as people load, so a failed session can switch person. */}
                <select
                  aria-label="Switch person"
                  value={current?.id || personId || ''}
                  disabled={people.length === 0}
                  onChange={(e) => onPerson(e.target.value)}
                >
                  <option value="" disabled>
                    Loading…
                  </option>
                  <optgroup label="Customers">
                    {people
                      .filter((p) => p.role === 'customer')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Operators">
                    {people
                      .filter((p) => p.role === 'operator')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · Operator
                        </option>
                      ))}
                  </optgroup>
                </select>
                <Icon name="chevron" size={12} className="persona-chevron" />
              </label>
            </div>
          </header>
          <main id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}

export function Alerts({
  error,
  notice,
  warning,
  onDismiss,
}: {
  error: string;
  notice: string;
  warning: string;
  onDismiss(kind: 'error' | 'notice' | 'warning'): void;
}) {
  return (
    <>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => onDismiss('error')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="alert notice" role="status">
          {notice}
          <button onClick={() => onDismiss('notice')} aria-label="Dismiss notice">
            ×
          </button>
        </div>
      )}
      {warning && (
        <div className="alert warning" role="status">
          {warning}
          <button onClick={() => onDismiss('warning')} aria-label="Dismiss warning">
            ×
          </button>
        </div>
      )}
    </>
  );
}

// U1: the session or dashboard could not be loaded; say so and offer Retry instead of a spinner.
// B3: `busy` while a retry runs: the card stays (no flash of the spinner) and says so. `inline`
// is the one-line form above the assistant, which stays open for reading with the bank down.
export function LoadError({
  message,
  onRetry,
  busy = false,
  inline = false,
}: {
  message: string;
  onRetry(): void;
  busy?: boolean;
  inline?: boolean;
}) {
  if (inline)
    return (
      <div className="alert error load-error" role="alert">
        <span>We could not load your banking. {message} Your conversations can still be read.</span>
        <button type="button" onClick={onRetry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    );
  return (
    <section className="card load-error" role="alert">
      <h2>We could not load your banking</h2>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={onRetry} disabled={busy}>
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </section>
  );
}
