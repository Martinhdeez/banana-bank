import { useEffect, useRef, useState } from 'react';
import type { Person } from '../../src/types';
import {
  activityNote,
  attachmentName,
  auditLine,
  caseWait,
  duration,
  exportUrl,
  formatDate,
  money,
  newestFirst,
  readJson,
  shortRef,
  operatorTransferStatusLabel,
  type AnyRecord,
  type Waiting,
  stripBidi,
} from '../../src/ui-helpers';
import { Icon } from './Icon';
import { runUsageLine } from './AiUsage';
const date = (value: string) => formatDate(value);
// O3: operator case detail shows account names resolved by the server; unknown ids stay as recorded.
const caseAccount = (c: AnyRecord, id?: string) => (id ? (c.accountNames?.[id] ?? id) : undefined);
// OPX2-ui: the server's wait and level as of the last fetch ("Refresh" updates it; no timers).
function CaseWait({ waiting }: { waiting?: Waiting }) {
  const w = caseWait(waiting);
  return (
    w && (
      <span className={`case-wait ${w.level ?? ''}`.trim()} title={w.title}>
        {w.text}
      </span>
    )
  );
}
// OPX3: priority reason filter (server codes on every inbox row).
const REASONS: [string, string][] = [
  ['pending_verification', 'Pending verification'],
  ['sent_failed', 'Failed, not verified'],
  ['rejected_attempt', 'Rejected attempt'],
  ['waiting', 'Waiting for support'],
];
type CaseFilters = { q: string; money: boolean; reason: string };

export function Cases({
  current,
  dashboard,
  people,
  selectedCase,
  caseBusy,
  confirmResolve,
  onConfirmResolve,
  onRefresh,
  onOpenCase,
  detailRef,
  filters,
  onFilters,
  filtered,
  filtering,
}: {
  current: Person;
  dashboard: AnyRecord;
  people: Person[];
  selectedCase: AnyRecord | null;
  caseBusy: boolean;
  confirmResolve: boolean;
  onConfirmResolve(v: boolean): void;
  onRefresh(caseId?: string, resolve?: boolean): void;
  onOpenCase(id: string): void;
  detailRef: React.RefObject<HTMLElement | null>;
  filters: CaseFilters;
  onFilters(f: CaseFilters): void;
  // OPX3: the server's filtered inbox, null when no filter is set.
  filtered: AnyRecord[] | null;
  filtering: boolean;
}) {
  const [view, setView] = useState<'open' | 'closed'>('open');
  const incidents: AnyRecord[] = dashboard.incidents ?? [];
  const person = (id: string) => people.find((p) => p.id === id);
  const moneyCount = incidents.filter((c) => c.priority === 'money').length;
  // OPX3: tabs count the filtered list; the heading counters stay on the whole inbox.
  const list = filtered ?? incidents;
  const openCount = list.filter((c) => c.status === 'open').length;
  const closedCount = list.filter((c) => c.status === 'closed').length;
  const anyFilter = !!(filters.q.trim() || filters.money || filters.reason);
  const clear = () => onFilters({ q: '', money: false, reason: '' });
  // Server order (money, open, closed) kept within the filtered list.
  const shown = list.filter((c) => c.status === view);
  const incident = selectedCase?.incident;
  const customer = incident ? person(incident.user_id) : undefined;
  const bank = selectedCase?.bank;
  const audit = auditLine(selectedCase?.audit);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER SUPPORT</div>
          <h1>Every case, a person.</h1>
          <p>
            Hello, {current.name.split(' ')[0]}. Cases handed over by the assistant, with the
            evidence to act on them.
          </p>
        </div>
        <div className="case-counters">
          <span className="counter">
            {incidents.filter((c) => c.status === 'open').length} open
          </span>
          {moneyCount > 0 && (
            <span className="counter money">{moneyCount} with money at stake</span>
          )}
          <button
            className="secondary-button is-small"
            disabled={caseBusy}
            onClick={() => onRefresh(incident?.id)}
          >
            {caseBusy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="operator-grid">
        <section className="card case-list" aria-label="Inbox" aria-busy={filtering}>
          <div className="segmented">
            <button aria-pressed={view === 'open'} onClick={() => setView('open')}>
              Open · {openCount}
            </button>
            <button aria-pressed={view === 'closed'} onClick={() => setView('closed')}>
              Resolved · {closedCount}
            </button>
          </div>
          <label className="case-search">
            <Icon name="search" size={14} />
            <input
              aria-label="Search cases"
              placeholder="Search customer, topic or #ref"
              maxLength={100}
              value={filters.q}
              onChange={(e) => onFilters({ ...filters, q: e.target.value })}
            />
          </label>
          <div className="case-filters">
            <button
              className="chip"
              aria-pressed={filters.money}
              onClick={() => onFilters({ ...filters, money: !filters.money })}
            >
              Money at stake
            </button>
            <select
              className="chip"
              aria-label="Priority reason"
              value={filters.reason}
              onChange={(e) => onFilters({ ...filters, reason: e.target.value })}
            >
              <option value="">Any reason</option>
              {REASONS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            {anyFilter && (
              <button className="text-button" onClick={clear}>
                Clear
              </button>
            )}
          </div>
          {shown.map((c) => (
            <button
              key={c.id}
              className={`case-item ${incident?.id === c.id ? 'selected' : ''}`}
              onClick={() => onOpenCase(c.id)}
            >
              <span className="avatar" style={{ background: person(c.user_id)?.color }}>
                {person(c.user_id)?.initials}
              </span>
              <span className="case-body">
                <span className="case-top">
                  <strong>{person(c.user_id)?.name}</strong>
                  <span className="case-ref">{shortRef(c.id)}</span>
                </span>
                <span className="case-summary">{c.summary}</span>
                {/* OP2: the server's priority and its reason (recorded facts only). */}
                {c.priority !== 'closed' && (
                  <span className="case-chips">
                    <span className={`case-priority ${c.priority}`}>{c.priorityReason}</span>
                    <CaseWait waiting={c.waiting} />
                  </span>
                )}
                {/* S5: the server's one status vocabulary. */}
                <small>
                  {date(c.created_at)} · {c.statusLabel}
                </small>
                {c.status !== 'closed' && c.waiting?.sinceCustomerMs != null && (
                  <small>Customer wrote {duration(c.waiting.sinceCustomerMs)} ago</small>
                )}
              </span>
            </button>
          ))}
          {shown.length === 0 && (
            <p className="empty-state">
              No cases here.
              {anyFilter && (
                <>
                  {' '}
                  <button className="text-button" onClick={clear}>
                    Clear filters
                  </button>
                </>
              )}
            </p>
          )}
        </section>
        <section className="card case-detail" ref={detailRef} tabIndex={-1}>
          {selectedCase ? (
            <>
              <header className="case-head">
                <span className="avatar" style={{ background: customer?.color }}>
                  {customer?.initials}
                </span>
                <span className="case-who">
                  <strong>{selectedCase.customer.name}</strong>
                  <small>
                    {shortRef(incident.id)} · opened {date(incident.created_at)}
                  </small>
                </span>
                <span className="case-actions">
                  <span className={`status-pill ${incident.status}`}>{incident.statusLabel}</span>
                  <CaseWait waiting={incident.waiting} />
                  <ExportMenu
                    key={incident.id}
                    caseId={incident.id}
                    onExported={() => onRefresh(incident.id)}
                  />
                  {/* U4 / S6: resolving takes an explicit second step; the API needs {confirm:true}. */}
                  {incident.status !== 'closed' && !confirmResolve && (
                    <button
                      className="primary-button is-small"
                      disabled={caseBusy}
                      onClick={() => onConfirmResolve(true)}
                    >
                      <Icon name="check" size={14} />
                      Mark resolved
                    </button>
                  )}
                </span>
                {incident.status !== 'closed' && confirmResolve && (
                  <div className="resolve-confirm" role="group" aria-label="Confirm resolution">
                    <span>Are you sure? This closes the case and notifies the customer.</span>
                    <button
                      className="primary-button is-small"
                      disabled={caseBusy}
                      onClick={() => onRefresh(incident.id, true)}
                    >
                      Yes, mark resolved
                    </button>
                    <button
                      className="secondary-button is-small"
                      disabled={caseBusy}
                      onClick={() => onConfirmResolve(false)}
                    >
                      Keep open
                    </button>
                  </div>
                )}
              </header>
              {/* F5c: summary built from recorded facts only. */}
              {selectedCase.summary && (
                <section className="handoff">
                  <h3>
                    <Icon name="sparkle" size={12} />
                    HANDOFF SUMMARY
                  </h3>
                  {/* FX2-d: every recorded handoff, in order, each with its time. */}
                  {selectedCase.summary.handoffs?.map((h: AnyRecord, n: number) => (
                    <p key={n}>
                      Assistant handoff · {date(h.at)}: {h.summary}
                    </p>
                  ))}
                  {selectedCase.summary.text
                    // The "Name · Status" line repeats the header; drop only that exact line.
                    .filter(
                      (line: string) =>
                        line !== `${selectedCase.customer.name} · ${incident.statusLabel}` &&
                        !line.startsWith('Assistant handoff: '),
                    )
                    .map((line: string) => (
                      <p key={line}>{line}</p>
                    ))}
                </section>
              )}
              {selectedCase.history?.length > 0 ? (
                <>
                  <h3 className="block-title">Conversation</h3>
                  <div className="case-thread">
                    {selectedCase.history.map((m: AnyRecord) => {
                      const who = m.role === 'user' ? 'customer' : 'assistant';
                      return (
                        <div className={`bubble-row ${who}`} key={m.id}>
                          <span className="bubble-meta">
                            {who === 'customer'
                              ? selectedCase.customer.name.split(' ')[0]
                              : 'Assistant'}{' '}
                            · {date(m.created_at)}
                          </span>
                          {/* FX3: a stored sentence (the outcome note carries the concept). */}
                          <div className="case-bubble">{stripBidi(m.content)}</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="case-latest">
                  <h3 className="block-title">Latest message</h3>
                  <blockquote>{selectedCase.lastMessage?.text}</blockquote>
                  <p className="muted">Received {date(incident.created_at)}</p>
                </div>
              )}
            </>
          ) : (
            <div className="case-empty">
              <Icon name="chat" />
              <h2>Open a case</h2>
              <p>Select a case to see what the assistant recorded.</p>
            </div>
          )}
        </section>
        {selectedCase && (
          <aside className="case-rail" aria-label="Evidence">
            {/* INT1-ui: whether the recorded steps below are as written (verifyAuditChain). */}
            {audit && (
              <section className={`card audit-status ${audit.tone}`} aria-label="Audit log">
                <p className="audit-line">
                  <Icon
                    name={
                      audit.tone === 'verified'
                        ? 'check'
                        : audit.tone === 'broken'
                          ? 'help'
                          : 'clock'
                    }
                    size={14}
                  />
                  {audit.text}
                </p>
                {audit.note && <p className="muted">{audit.note}</p>}
              </section>
            )}
            <section className="card">
              <h3>Customer</h3>
              {bank?.accounts ? (
                bank.accounts.map((a: AnyRecord) => (
                  <div className="rail-row" key={a.id}>
                    <span>{a.label}</span>
                    <strong>{money(a.balanceCents)}</strong>
                  </div>
                ))
              ) : (
                <p className="muted">Bank data not available.</p>
              )}
              <div className="rail-row">
                <span>Open cases</span>
                <strong>
                  {
                    incidents.filter((c) => c.user_id === incident.user_id && c.status === 'open')
                      .length
                  }
                </strong>
              </div>
            </section>
            {bank?.operations && (
              <BankOperations
                key={incident.id}
                operations={bank.operations}
                account={(id) => caseAccount(selectedCase, id)}
              />
            )}
            {/* F5b: recorded intents and bank-verified effects; gaps stated, never filled in. */}
            {selectedCase.intents?.length > 0 && (
              <section className="card">
                <h3>Transfer intents</h3>
                {selectedCase.intents.map((i: AnyRecord) => (
                  <div className="evidence-row" key={i.id}>
                    <span
                      className={`dot ${i.verified.status === 'completed' ? 'completed' : ''}`}
                    />
                    <span>
                      <strong>
                        {money(i.payload.amountCents)} ·{' '}
                        <bdi>{caseAccount(selectedCase, i.payload.fromAccountId)}</bdi> →{' '}
                        <bdi>{caseAccount(selectedCase, i.payload.toAccountId)}</bdi> ·{' '}
                        <bdi>{i.payload.concept}</bdi>
                      </strong>
                      <small>
                        App: {operatorTransferStatusLabel(i.status)} · Bank:{' '}
                        {i.verified.status === 'completed'
                          ? `completed (${i.verified.operation.id})`
                          : `not verified (${i.verified.reason})`}
                      </small>
                      <small>
                        Created {date(i.createdAt)} · Reference {i.bankReference || 'not recorded'}
                        {i.error ? ` · error: ${i.error}` : ''}
                      </small>
                    </span>
                  </div>
                ))}
              </section>
            )}
            {/* O1: refused by the app before any bank call; only a tool event records them. */}
            {selectedCase.rejectedAttempts?.length > 0 && (
              <section className="card">
                <h3>Rejected transfer attempts</h3>
                {selectedCase.rejectedAttempts.map((a: AnyRecord) => (
                  <div className="evidence-row" key={a.eventId}>
                    <span className="dot rejected" />
                    <span>
                      {/* S3: amount and both sides in words from the server. */}
                      <strong>
                        {a.amountCents ? money(a.amountCents) : 'Invalid amount'} · {a.source} →{' '}
                        {a.destination}
                      </strong>
                      <small>
                        Rejected before reaching the bank · {date(a.at)}
                        {a.error ? ` · ${a.error}` : ''}
                      </small>
                    </span>
                  </div>
                ))}
              </section>
            )}
            {selectedCase.runs?.length > 0 && (
              <section className="card">
                <h3>Assistant steps</h3>
                {selectedCase.runs.map((r: AnyRecord) => (
                  <div key={r.id}>
                    <p className="muted">
                      {r.recorded
                        ? `Assistant turn · ${r.status} · ${date(r.started_at)}`
                        : 'Action outside an assistant turn'}
                      {r.error ? ` · ${r.error}` : ''}
                    </p>
                    {/* TR2: what the turn spent on models (counts only), when it was recorded. */}
                    {runUsageLine(r.usage) && (
                      <p className="muted usage-run-line">{runUsageLine(r.usage)}</p>
                    )}
                    <ol className="steps">
                      {r.events.map((e: AnyRecord) => (
                        <li key={e.id}>
                          <details>
                            {/* S5: a readable line; the raw data stays behind the toggle. */}
                            <summary>
                              <bdi>{e.description}</bdi> · {date(e.created_at)}
                            </summary>
                            <pre>{JSON.stringify(e.data, null, 2)}</pre>
                          </details>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </section>
            )}
            {selectedCase.gaps?.length > 0 && (
              <section className="card gaps">
                <h3>
                  <Icon name="help" size={14} />
                  Evidence gaps
                </h3>
                {selectedCase.gaps.map((g: string) => (
                  <p key={g}>{g}</p>
                ))}
              </section>
            )}
            {/* OPX4-ui: who viewed, resolved or exported this case (recorded events, newest first). */}
            {selectedCase.activity && (
              <CaseActivity
                key={incident.id}
                activity={selectedCase.activity}
                note={activityNote(selectedCase.activitySince, incident.created_at)}
              />
            )}
          </aside>
        )}
      </div>
    </>
  );
}

// OPX1-ui: the links keep the real export URL (open in a new tab, copy link); a click fetches it
// with the session cookie so a 401/403/404 shows here instead of a failed browser download, and
// the case refreshes once the server has recorded the export in "Case activity".
function ExportMenu({ caseId, onExported }: { caseId: string; onExported(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // OP5: a pointer press outside closes the menu. Focus only closes it when it moves to an element
  // outside (Tab out): Safari does not focus a clicked link, so its blur has no relatedTarget and
  // closing on that would hide the menu before the click lands.
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  async function download(e: React.MouseEvent<HTMLAnchorElement>, format: 'json' | 'html') {
    e.preventDefault();
    if (busy) return;
    const menu = e.currentTarget.closest('details')!;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(exportUrl(caseId, format), { cache: 'no-store' });
      // SEC3: a 401 goes through the refresh, which takes the page back to person selection.
      if (response.ok || response.status === 401) onExported();
      if (!response.ok) await readJson(response);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = attachmentName(response.headers.get('Content-Disposition'), `case.${format}`);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url));
      menu.open = false;
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'The export could not be downloaded. Check the connection and try again.'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      ref={ref}
      className="export-menu"
      onToggle={(e) => {
        if (!e.currentTarget.open) setError('');
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !e.currentTarget.open) return;
        e.currentTarget.open = false;
        e.currentTarget.querySelector('summary')?.focus();
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          e.currentTarget.open = false;
      }}
    >
      <summary className="secondary-button is-small" aria-busy={busy}>
        {busy ? 'Exporting…' : 'Export'}
        <Icon name="chevron" size={14} />
      </summary>
      <div className="export-options">
        <a href={exportUrl(caseId, 'html')} download onClick={(e) => download(e, 'html')}>
          Printable report (HTML)
        </a>
        <a href={exportUrl(caseId, 'json')} download onClick={(e) => download(e, 'json')}>
          Evidence bundle (JSON)
        </a>
        {error && (
          <p className="export-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

// FX2-b: the bank's operations newest first; more than five expand on demand, as in CaseActivity.
const OPERATIONS_LIMIT = 5;
function BankOperations({
  operations,
  account,
}: {
  operations: AnyRecord[];
  account: (id?: string) => string | undefined;
}) {
  const [all, setAll] = useState(false);
  const sorted = newestFirst(operations);
  return (
    <section className="card">
      <h3>Bank operations · verified</h3>
      {operations.length === 0 && (
        <p className="muted">The bank listing returned no operations for this customer.</p>
      )}
      {(all ? sorted : sorted.slice(0, OPERATIONS_LIMIT)).map((o: AnyRecord) => (
        <div className="evidence-row" key={o.id}>
          <span className={`dot ${o.status === 'completed' ? 'completed' : ''}`} />
          <span>
            <strong>
              {money(o.amountCents)} to <bdi>{account(o.toAccountId)}</bdi>
            </strong>
            <small>
              {/* FX3: the bank's concept cannot reverse the date and the reference. */}
              <bdi>{o.concept}</bdi> · {date(o.createdAt)} · {o.reference}
            </small>
          </span>
        </div>
      ))}
      {operations.length > OPERATIONS_LIMIT && (
        <button className="text-button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${operations.length}`}
        </button>
      )}
    </section>
  );
}

// OPX4-ui: newest rows first; longer lists expand on demand.
const ACTIVITY_LIMIT = 8;
function CaseActivity({ activity, note }: { activity: AnyRecord[]; note: string | null }) {
  const [all, setAll] = useState(false);
  const rows = all ? activity : activity.slice(0, ACTIVITY_LIMIT);
  return (
    <section className="card case-activity" aria-label="Case activity">
      <h3>Case activity</h3>
      {activity.length === 0 ? (
        <p className="muted">No views, resolutions or exports recorded yet.</p>
      ) : (
        <ol className="activity-list">
          {rows.map((a) => (
            <li key={a.id}>
              <strong>{a.description}</strong>
              <small>
                <time dateTime={a.at}>{date(a.at)}</time>
              </small>
            </li>
          ))}
        </ol>
      )}
      {activity.length > ACTIVITY_LIMIT && (
        <button className="text-button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${activity.length}`}
        </button>
      )}
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
