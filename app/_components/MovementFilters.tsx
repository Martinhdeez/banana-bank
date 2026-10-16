'use client';
// CF3-ui: movement search on Overview, on top of GET /api/movements (CF3-api). Home only wires
// the designer's three Overview slots (toolbar, rows, onAccountFilterChange) from the hook below.
import { useEffect, useRef, useState } from 'react';
import { parseMovementFilters, type MovementWindow } from '../../src/banking/movements';
import { centsFromEuros, formatDate, type ActivityRow } from '../../src/ui-helpers';

type MovementFilterValue = {
  q: string;
  from: string; // YYYY-MM-DD, local day
  to: string;
  min: string; // euros as typed
  max: string;
  direction: '' | 'sent' | 'received' | 'internal';
};
export const emptyFilters: MovementFilterValue = {
  q: '',
  from: '',
  to: '',
  min: '',
  max: '',
  direction: '',
};

// S4: dates are local days, so they go to the API as instants for the local day bounds.
const dayStart = (d: string, next = 0) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day + next).getTime();
};
// The query for GET /api/movements, checked with the API's own parser before it is sent.
// null = no filter (the table shows the dashboard rows); the account alone is Overview's filter.
export function movementQuery(
  v: MovementFilterValue,
  account: string | null,
): { query: string } | { error: string } | null {
  const p = new URLSearchParams();
  if (v.q.trim()) p.set('q', v.q.trim());
  if (v.from) p.set('from', new Date(dayStart(v.from)).toISOString());
  if (v.to) p.set('to', new Date(dayStart(v.to, 1) - 1).toISOString());
  for (const k of ['min', 'max'] as const) {
    const s = v[k].trim();
    if (!s) continue;
    if (!centsFromEuros(s)) return { error: 'Enter amounts in euros, like 12.50.' };
    p.set(k, s);
  }
  if (v.direction) p.set('direction', v.direction);
  if (![...p.keys()].length) return null;
  if (account) p.set('account', account);
  const parsed = parseMovementFilters(p);
  return 'error' in parsed ? { error: parsed.error } : { query: p.toString() };
}

// CF2: the CSV link carries the search query (or the account alone, or nothing: every movement);
// no link while the filters are invalid. It follows the applied filters, as the table does.
export function movementExportHref(v: MovementFilterValue, account: string | null) {
  const built = movementQuery(v, account);
  if (built && 'error' in built) return null;
  const query = built ? built.query : account ? new URLSearchParams({ account }).toString() : '';
  return `/api/movements/export.csv${query ? `?${query}` : ''}`;
}

type Result = { rows: ActivityRow[]; window: MovementWindow };

export function useMovementSearch(
  api: (path: string) => Promise<any>,
  personId: string | null,
  dashboard: unknown,
) {
  const [text, setText] = useState(''),
    [value, setValue] = useState(emptyFilters),
    [account, setAccount] = useState<string | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef(0);
  // A persona switch starts with no filters (Overview remounts with "All").
  useEffect(() => {
    setText('');
    setValue(emptyFilters);
    setAccount(null);
  }, [personId]);
  // The text is debounced; Enter applies it at once.
  useEffect(() => {
    const t = setTimeout(() => setValue((v) => (v.q === text ? v : { ...v, q: text })), 300);
    return () => clearTimeout(t);
  }, [text]);
  // Re-run on each dashboard read too, so results follow the 20 s refresh.
  useEffect(() => {
    const id = ++request.current;
    const built = movementQuery(value, account);
    setError(built && 'error' in built ? built.error : '');
    if (!built || 'error' in built) {
      setResult(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    api(`movements?${built.query}`)
      .then((r: Result) => id === request.current && setResult(r))
      .catch((e: Error) => {
        // Bank or 400 error: say it inline; the table keeps the dashboard rows.
        if (id !== request.current) return;
        setError(e.message);
        setResult(null);
      })
      .finally(() => id === request.current && setBusy(false));
  }, [value, account, dashboard, personId]);
  const exportHref = movementExportHref(value, account);
  const clear = () => {
    setText('');
    setValue(emptyFilters);
  };
  return {
    rows: result?.rows,
    // The designer's empty state for a search with no results (hides headers and View all).
    emptyText: result?.rows.length === 0 ? 'No transactions match these filters.' : undefined,
    onAccountFilterChange: setAccount,
    toolbar: (
      <MovementFilters
        text={text}
        value={value}
        onText={setText}
        onChange={setValue}
        onClear={clear}
        busy={busy}
        error={error}
        result={result}
        exportHref={exportHref}
      />
    ),
  };
}

// Exported for tests/polish-overview.test.ts (A24e).
export function MovementFilters({
  text,
  value,
  onText,
  onChange,
  onClear,
  busy,
  error,
  result,
  exportHref,
}: {
  text: string;
  value: MovementFilterValue;
  onText(q: string): void;
  onChange(v: MovementFilterValue): void;
  onClear(): void;
  busy: boolean;
  error: string;
  result: Result | null;
  exportHref: string | null;
}) {
  const set = (k: keyof MovementFilterValue) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: e.target.value });
  const [open, setOpen] = useState(false);
  const more = [value.from, value.to, value.min, value.max, value.direction].filter(Boolean).length;
  const active = !!text.trim() || more > 0;
  const n = result?.rows.length;
  const w = result?.window;
  return (
    <search className="movement-filters">
      <form
        role="search"
        aria-label="Transactions"
        onSubmit={(e) => {
          e.preventDefault();
          onChange({ ...value, q: text });
        }}
      >
        <div className="filters-row">
          <label className="filter-search">
            <span className="sr-only">Search transactions</span>
            <input
              type="search"
              placeholder="Search transactions"
              maxLength={100}
              value={text}
              onChange={(e) => onText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="filter-toggle"
            aria-expanded={open}
            aria-controls="movement-filter-panel"
            onClick={() => setOpen(!open)}
          >
            Filters{more > 0 && <span className="filter-count">({more})</span>}
          </button>
          {/* A24e: an empty result has its own "Clear filters" in the status line below. */}
          {active && n !== 0 && (
            <button type="button" className="text-link filter-clear" onClick={onClear}>
              Clear
            </button>
          )}
          {open && (
            <div
              id="movement-filter-panel"
              className="filter-panel"
              role="group"
              aria-label="More filters"
            >
              <label>
                From
                <input type="date" value={value.from} onChange={set('from')} />
              </label>
              <label>
                To
                <input type="date" value={value.to} onChange={set('to')} />
              </label>
              <label>
                Min amount (€)
                <input
                  inputMode="decimal"
                  pattern={'\\d{1,9}([.,]\\d{1,2})?'}
                  placeholder="0.00"
                  value={value.min}
                  onChange={set('min')}
                />
              </label>
              <label>
                Max amount (€)
                <input
                  inputMode="decimal"
                  pattern={'\\d{1,9}([.,]\\d{1,2})?'}
                  placeholder="0.00"
                  value={value.max}
                  onChange={set('max')}
                />
              </label>
              <label className="filter-direction">
                Direction
                <select value={value.direction} onChange={set('direction')}>
                  <option value="">All</option>
                  <option value="sent">Sent</option>
                  <option value="received">Received</option>
                  <option value="internal">Between your accounts</option>
                </select>
              </label>
            </div>
          )}
          {/* CF2: a plain link (the browser sends the session cookie, same origin). After the panel,
              so the Filters toggle is followed by its panel in the tab order. */}
          {exportHref && (
            <span className="filter-export">
              <a
                className="filter-toggle"
                href={exportHref}
                download
                aria-describedby="movement-export-hint"
              >
                Download CSV
              </a>
              <span id="movement-export-hint" className="filter-hint">
                Amounts in EUR
              </span>
            </span>
          )}
        </div>
        <p className="filter-status" role="status" aria-busy={busy}>
          {error ? (
            <span className="filter-error">{error}</span>
          ) : n === 0 ? (
            <>
              0 results.{' '}
              <button type="button" className="text-link" onClick={onClear}>
                Clear filters
              </button>
            </>
          ) : n !== undefined ? (
            `${n} ${n === 1 ? 'result' : 'results'}`
          ) : null}
        </p>
        {w?.mayBeTruncated && (
          <p className="filter-window">
            Only the bank&apos;s {w.limit} most recent movements can be searched
            {w.oldestAt ? ` (from ${formatDate(w.oldestAt, false)})` : ''}. The CSV file has the
            same limit.
          </p>
        )}
      </form>
    </search>
  );
}
