// RG2: "Regular money", right after "Month ahead", for the account chosen there. Every item and
// figure is the server's (RG1: forecast.accounts[].regular); the totals are the sums of what it
// listed. The actions are FC2's adjustment routes: "Not regular" excludes a detected item by its
// id, the add form expects a monthly item with its direction, Remove deletes the customer's own.
import { useEffect, useRef, useState } from 'react';
import { Glyph } from './charts';
import { Done } from './Forecast';
import {
  aroundDay,
  chipOf,
  expectErrors,
  fromNextMonth,
  irregularWords,
  regularTotal,
  seenWords,
  signed,
} from './logic';
import { centsFromEuros } from '../../../src/ui-helpers';
import type { AdjustmentBody } from './adjustments';
import type { Regular, RegularItem } from './types';

type Direction = 'income' | 'charge';
export type RegularActions = {
  busy: boolean;
  // After "Not regular": the line with its Undo.
  status: { text: string; undoId: string } | null;
  error: string;
  // The server's refusal of the label (400), under that field.
  labelError: string;
  onExclude(accountId: string, item: RegularItem): void;
  // Resolves true when the item was added and the dashboard read again.
  onAdd(body: AdjustmentBody): Promise<boolean>;
  onRemove(adjustmentId: string): void;
};
const EMPTY = { label: '', amount: '', day: '' };

export function RegularMoney({
  regular,
  accountId,
  accountLabel,
  today,
  actions,
  onOpenGoal,
  onOpenPrepared,
}: {
  regular: Regular;
  accountId: string;
  accountLabel: string;
  today: string;
  // Absent when the server takes no adjustments: the lists only.
  actions?: RegularActions;
  onOpenGoal(goalId: string): void;
  onOpenPrepared(preparedId: string): void;
}) {
  const [adding, setAdding] = useState<Direction | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const card = useRef<HTMLElement>(null);
  const errors = expectErrors({ ...form, repeats: 'monthly', date: '' }, today);
  const invalid = !!(errors.label || errors.amount || errors.day);
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));
  useEffect(() => {
    if (adding) formRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, [adding]);
  // A refused submit: the first invalid field takes the focus.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (refused) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refused]);
  // An action whose button is gone leaves the focus on the Undo of its line, else the heading.
  const busy = !!actions?.busy;
  const wasBusy = useRef(busy);
  useEffect(() => {
    const from = wasBusy.current;
    wasBusy.current = busy;
    if (!from || busy || window.document.activeElement !== window.document.body) return;
    (
      card.current?.querySelector<HTMLElement>('[data-testid=regular-undo]') ??
      card.current?.querySelector<HTMLElement>('h2')
    )?.focus();
  }, [busy]);
  function close(direction: Direction) {
    setAdding(null);
    setForm(EMPTY);
    setTried(false);
    setTimeout(() =>
      card.current?.querySelector<HTMLElement>(`[data-testid=regular-add-${direction}]`)?.focus(),
    );
  }
  async function submit(direction: Direction) {
    setTried(true);
    if (invalid) return setRefused((n) => n + 1);
    const ok = await actions!.onAdd({
      kind: 'expect',
      direction,
      accountId,
      label: form.label.trim(),
      amountCents: centsFromEuros(form.amount)!,
      repeats: 'monthly',
      day: Number(form.day),
    });
    if (ok) close(direction);
  }
  const noHistory =
    !regular.income.length && !regular.charges.length && regular.irregularSpend === null;

  function list(direction: Direction, items: RegularItem[]) {
    const title = direction === 'income' ? 'Regular income' : 'Regular charges';
    const id = `regular-${direction}-title`;
    return (
      <div className="regular-list" data-testid={`regular-${direction}`}>
        <div className="regular-list-head">
          <h3 id={id}>{title}</h3>
          {items.some((i) => i.thisMonth !== 'next_month') && (
            <span className="regular-total" data-testid={`regular-${direction}-total`}>
              {signed(regularTotal(items))} a month
            </span>
          )}
        </div>
        {/* RG2b: a payment whose first one is next month is not in this month's total. */}
        {items.some((i) => i.thisMonth === 'next_month') && (
          <div className="regular-total regular-next" data-testid={`regular-${direction}-next`}>
            From next month: {signed(fromNextMonth(items))}
          </div>
        )}
        {items.length > 0 ? (
          <ul aria-labelledby={id}>
            {items.map((item) => (
              <li key={item.id} data-testid="regular-item" data-source={item.source}>
                <span className="regular-main">
                  <strong>{item.label}</strong>
                  <small>
                    {aroundDay(item.usualDay)} · {seenWords(item)}
                  </small>
                </span>
                <span className={`regular-amount${item.amountCents > 0 ? ' credit' : ''}`}>
                  {signed(item.amountCents)}
                </span>
                <span className="regular-side">
                  <span
                    className={`plan-pill ${chipOf(item).tone}`}
                    data-this-month={item.thisMonth}
                  >
                    {chipOf(item).label}
                  </span>
                  {/* RG1b: a prepared item has no action here, only its way to the goal or
                      the prepared transfer, where it is changed. */}
                  {item.source === 'prepared' && (
                    <button
                      type="button"
                      className="plan-link quiet row-action"
                      data-testid="regular-open"
                      aria-label={
                        item.goalId
                          ? `Open the goal of ${item.label}`
                          : `Open ${item.label} in Transfers`
                      }
                      onClick={() =>
                        item.goalId
                          ? onOpenGoal(item.goalId)
                          : onOpenPrepared(item.preparedId ?? item.id)
                      }
                    >
                      {item.goalId ? 'Open goal' : 'Open in Transfers'}
                    </button>
                  )}
                  {actions && item.source === 'detected' && item.excludable && (
                    <button
                      type="button"
                      className="plan-link quiet row-action"
                      data-testid="regular-exclude"
                      aria-label={`${item.label} is not regular`}
                      disabled={busy}
                      onClick={() => actions.onExclude(accountId, item)}
                    >
                      Not regular
                    </button>
                  )}
                  {actions && item.source === 'added_by_you' && item.adjustmentId && (
                    <button
                      type="button"
                      className="plan-link quiet row-action"
                      data-testid="regular-remove"
                      aria-label={`Remove ${item.label}`}
                      disabled={busy}
                      onClick={() => actions.onRemove(item.adjustmentId!)}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          !noHistory && (
            <p className="regular-empty">
              {direction === 'income'
                ? 'No regular income found yet.'
                : 'No regular charges found yet.'}
            </p>
          )
        )}
        {actions &&
          (adding === direction ? (
            <form
              ref={formRef}
              className="expect-form regular-form"
              data-testid="regular-form"
              aria-label={direction === 'income' ? 'Add regular income' : 'Add a regular charge'}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submit(direction);
              }}
            >
              <label className="goal-field">
                <span>What for</span>
                <input
                  value={form.label}
                  maxLength={40}
                  aria-invalid={(tried && !!errors.label) || !!actions.labelError || undefined}
                  onChange={(e) => set({ label: e.target.value })}
                />
                {((tried && errors.label) || actions.labelError) && (
                  <span className="field-error" role="alert">
                    {(tried && errors.label) || actions.labelError}
                  </span>
                )}
              </label>
              <label className="goal-field">
                <span>Amount</span>
                <span className="goal-money">
                  <i aria-hidden="true">€</i>
                  <input
                    inputMode="decimal"
                    value={form.amount}
                    aria-invalid={(tried && !!errors.amount) || undefined}
                    onChange={(e) => set({ amount: e.target.value })}
                  />
                </span>
                {tried && errors.amount && (
                  <span className="field-error" role="alert">
                    {errors.amount}
                  </span>
                )}
              </label>
              <label className="goal-field day">
                <span>Day of the month</span>
                <input
                  inputMode="numeric"
                  value={form.day}
                  aria-invalid={(tried && !!errors.day) || undefined}
                  onChange={(e) => set({ day: e.target.value })}
                />
                {tried && errors.day && (
                  <span className="field-error" role="alert">
                    {errors.day}
                  </span>
                )}
              </label>
              <p className="expect-note">
                Every month, counted as an estimate in this account. Nothing is prepared or sent.
              </p>
              {actions.error && (
                <p className="plan-refused" role="alert">
                  {actions.error}
                </p>
              )}
              <div className="expect-actions">
                <button
                  type="submit"
                  className="primary-button"
                  data-testid="regular-submit"
                  disabled={busy}
                >
                  {busy ? 'Adding…' : 'Add'}
                </button>
                <button type="button" className="secondary-button" onClick={() => close(direction)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="plan-link expect-open"
              data-testid={`regular-add-${direction}`}
              disabled={!!adding}
              onClick={() => {
                setForm(EMPTY);
                setTried(false);
                setAdding(direction);
              }}
            >
              <Glyph name="plus" size={15} />{' '}
              {direction === 'income' ? 'Add regular income' : 'Add a regular charge'}
            </button>
          ))}
      </div>
    );
  }

  return (
    <section
      className="card regular-money"
      id="regular-money"
      ref={card}
      data-testid="plan-regular"
      aria-labelledby="regular-money-title"
    >
      <div className="plan-card-head">
        <div>
          <h2 id="regular-money-title" tabIndex={-1}>
            Regular money
          </h2>
          <p>{accountLabel} · what comes in and goes out every month</p>
        </div>
      </div>
      {noHistory && (
        <p className="plan-quiet" data-testid="regular-no-history">
          Regular money appears here after a few full months of movements in this account.
        </p>
      )}
      <div className="regular-lists">
        {list('income', regular.income)}
        {list('charge', regular.charges)}
      </div>
      {actions?.status && (
        <Done text={actions.status.text}>
          <button
            type="button"
            className="plan-link"
            data-testid="regular-undo"
            disabled={busy}
            onClick={() => actions.onRemove(actions.status!.undoId)}
          >
            Undo
          </button>
        </Done>
      )}
      {actions?.error && !adding && (
        <p className="plan-refused" role="alert">
          {actions.error}
        </p>
      )}
      {regular.irregularSpend && (
        <p className="regular-irregular" data-testid="regular-irregular">
          {irregularWords(regular.irregularSpend)}
        </p>
      )}
    </section>
  );
}
