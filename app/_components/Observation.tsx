'use client';
// OB2 (plan 26 §6, REQ-OB-9…11): the "Worth a look" card of Overview. One fact the server found
// in the customer's own data (`dashboard.observation`, OB1): its title and basis are server text
// and are rendered as text. A fact with its figures, never advice. Nothing here computes or
// decides: Dismiss and "Don't show these" post to /api/observations and the dashboard is re-read.
import { useEffect, useRef, useState } from 'react';
// Type only: the module pulls server code at run time.
import type { Observation } from '../../src/observations/detect';
import type { AnyRecord } from '../../src/ui-helpers';

// `off`: the customer has just turned observations off; the line stays until the next load.
export function ObservationCard({
  observation,
  off = false,
  error = '',
  onAction,
  onDismiss,
  onOff,
  onUndo,
}: {
  observation: Observation | null;
  off?: boolean;
  error?: string;
  onAction?(o: Observation): void;
  onDismiss?(o: Observation): void;
  onOff?(): void;
  onUndo?(): void;
}) {
  if (off)
    return (
      <aside className="card observation is-off" aria-label="Worth a look">
        <p role="status" data-testid="observation-off-status">
          Observations are off. You can turn these back on in “What the assistant may do”.
        </p>
        {error && (
          <p className="observation-error" role="alert">
            {error}
          </p>
        )}
        {/* Mounted by the click on "Don't show these": the keyboard continues here. */}
        <button type="button" data-testid="observation-undo" autoFocus onClick={onUndo}>
          Undo
        </button>
      </aside>
    );
  if (!observation) return null;
  const o = observation;
  return (
    <aside
      className="card observation"
      aria-label="Worth a look"
      aria-live="polite"
      data-testid="observation-card"
      data-kind={o.kind}
    >
      <p className="eyebrow">Worth a look</p>
      <h2>{o.title}</h2>
      <p className="observation-basis" data-testid="observation-basis">
        {o.basis}
      </p>
      {error && (
        <p className="observation-error" role="alert">
          {error}
        </p>
      )}
      {/* One wrapping row: the two buttons, the footer line, and "Don't show these" (the
          stylesheet puts it at the end of the buttons' row when wide, of the footer line when
          narrow). */}
      <div className="observation-bottom">
        <div className="observation-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="observation-action"
            onClick={() => onAction?.(o)}
          >
            {o.kind === 'prepared_uncovered' ? 'See prepared transfer' : 'Ask the assistant'}
          </button>
          <button type="button" data-testid="observation-dismiss" onClick={() => onDismiss?.(o)}>
            Dismiss
          </button>
        </div>
        <p className="observation-foot">A fact from your movements, not advice.</p>
        <button
          type="button"
          className="observation-quiet"
          data-testid="observation-off"
          onClick={onOff}
        >
          Don’t show these
        </button>
      </div>
    </aside>
  );
}

// The requests and their state, so the page passes one node. Null when there is nothing to show:
// the `insights` slot of Overview then stays as it was.
export function useObservation({
  api,
  customerId,
  dashboard,
  refresh,
  goTransfers,
  ask,
}: {
  api(path: string, body?: unknown): Promise<AnyRecord>;
  customerId: string | null;
  dashboard: AnyRecord | null;
  refresh(): Promise<void>;
  goTransfers(): void;
  ask(text: string): void;
}) {
  // `hidden`: the key just dismissed, so the card goes at once and not when the request answers.
  const [hidden, setHidden] = useState(''),
    [off, setOff] = useState(false),
    [error, setError] = useState('');
  // A double click must not start two requests.
  const lock = useRef(false),
    who = useRef(customerId);
  who.current = customerId;
  useEffect(() => {
    setHidden('');
    setOff(false);
    setError('');
    lock.current = false;
  }, [customerId]);
  const found = (dashboard?.observation ?? null) as Observation | null;
  const observation = found && found.key !== hidden ? found : null;

  // `undo` puts back what the click removed when the request fails: nothing was recorded.
  async function post(body: AnyRecord, undo: () => void) {
    if (lock.current) return;
    lock.current = true;
    const me = customerId;
    setError('');
    try {
      await api('observations', body);
      if (who.current === me) await refresh().catch(() => {});
    } catch (e) {
      if (who.current === me) {
        undo();
        setError((e as Error).message);
      }
    } finally {
      lock.current = false;
    }
  }
  function action(o: Observation) {
    if (o.kind === 'category_up') return ask(`What is behind "${o.title}"?`);
    // As Overview's "For you to do" row does for a due one: Transfers, that card in view
    // and focused (Prepared.tsx gives each card the id `prepared-<id>`).
    goTransfers();
    setTimeout(() => {
      const card = document.getElementById(`prepared-${o.preparedId}`);
      card?.scrollIntoView({ block: 'center' });
      card?.focus({ preventScroll: true });
    });
  }
  if (!customerId || (!observation && !off)) return null;
  return (
    <ObservationCard
      observation={observation}
      off={off}
      error={error}
      onAction={action}
      onDismiss={(o) => {
        setHidden(o.key);
        // The control that was used is gone: the keyboard continues from the top of the page.
        document.getElementById('main')?.focus({ preventScroll: true });
        post({ dismiss: o.key }, () => setHidden(''));
      }}
      onOff={() => {
        setOff(true);
        post({ enabled: false }, () => setOff(false));
      }}
      onUndo={() => {
        setOff(false);
        document.getElementById('main')?.focus({ preventScroll: true });
        post({ enabled: true }, () => setOff(true));
      }}
    />
  );
}
