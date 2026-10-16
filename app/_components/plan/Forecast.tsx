// UI1 (plan 28 §4.4, §6): "Month ahead". Every sentence is the server's (`headline` with its
// `explanation`, notes, options, the source line) and is printed as it came; every figure is the
// server's, except the preview of a cover option, which is the same sum with one transfer added
// and says so. "Prepare this" posts the option's `prepare` to the existing POST /api/prepared:
// it prepares, it never sends.
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { BalanceChart, Glyph, TimelineChart, useSeen, useTween, useWidth } from './charts';
import {
  day,
  dayOf,
  eur,
  expectErrors,
  expectOf,
  frameOf,
  hasPrepared,
  lastExpectDate,
  PREPARED_LINE,
  adjustmentWords,
  basisWords,
  hiddenAdjustments,
  monthIndex,
  monthName,
  RANGES,
  endsAfterPending,
  timelineEvents,
  previewLine,
  signed,
  sourceWords,
  withoutEvent,
  withoutPrepared,
  type ExpectForm,
} from './logic';
import type { AdjustmentBody } from './adjustments';
import type { CoverOption, ForecastEvent, MonthForecast, Timeline, TimelineRange } from './types';

// Forecast adjustments (FC2, draft): what the page gives this card when the server takes them.
export type Adjusting = {
  // The usual item being excluded: gone from the line while the server answers.
  pending: ForecastEvent | null;
  busy: boolean;
  // The line under the list after an exclude, with its Undo.
  status: { text: string; undoId: string } | null;
  error: string;
  // The server's refusal of the label of an expected charge (400), shown under that field.
  labelError: string;
  onExclude(accountId: string, event: ForecastEvent): void;
  // Resolves true when the item was added and the forecast read again.
  onExpect(body: AdjustmentBody): Promise<boolean>;
  onRemove(adjustmentId: string): void;
};
// TL2: the balance timeline of the chosen account, read by the page from TL1's route.
export type TimelineView = {
  range: TimelineRange;
  onRange(range: TimelineRange): void;
  // The server answered the route once: the periods can be offered.
  known: boolean;
  // The last answer (kept on screen, quieter, while the next one is read).
  data: Timeline | null;
  loading: boolean;
  error: string;
  onRetry(): void;
};
const EMPTY: ExpectForm = { label: '', amount: '', repeats: 'once', date: '', day: '' };

// What "Prepare this" did on one account, kept by the page across tabs until the next person.
export type Cover = {
  accountId: string;
  options: CoverOption[];
  option: CoverOption;
  // The prepared transfer it created, once the server answered.
  preparedId: string | null;
  phase: 'preparing' | 'done' | 'undoing';
};

export function Done({
  text,
  busy,
  children,
}: {
  text: string;
  busy?: string;
  children?: React.ReactNode;
}) {
  return (
    <p className={`plan-done${busy ? ' busy' : ''}`} role="status">
      {busy ? <span className="spinner" /> : <Icon name="check" size={15} />}
      <span>{busy || text}</span>
      {!busy && children}
    </p>
  );
}

export function MonthAhead({
  forecast,
  accountId,
  onAccount,
  cover,
  error,
  onDismissError,
  onPrepare,
  onUndo,
  onOpenPrepared,
  adjust,
  timeline,
}: {
  forecast: MonthForecast;
  accountId: string;
  onAccount(id: string): void;
  cover: Cover | null;
  // The refusal or failure of the last "Prepare this" or Undo, in the server's words.
  error: string;
  // The customer closes that line.
  onDismissError?(): void;
  onPrepare(accountId: string, options: CoverOption[], option: CoverOption): void;
  onUndo(): void;
  onOpenPrepared(id: string): void;
  // Absent on a server without forecast adjustments: the card is then as before.
  adjust?: Adjusting;
  // Absent on a server without TL1: the chart of this month, as before.
  timeline?: TimelineView;
}) {
  const real = forecast.accounts.find((a) => a.id === accountId) ?? forecast.accounts[0];
  const hidden = hiddenAdjustments(forecast);
  const account = adjust?.pending ? withoutEvent(real, adjust.pending) : real;
  const events = timeline?.data ? timelineEvents(timeline.data) : [];
  // "Add an expected charge": the form, and its item on the line before it is added.
  const [expecting, setExpecting] = useState(false);
  const [form, setForm] = useState<ExpectForm>(EMPTY);
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const errors = expectErrors(form, forecast.today);
  const expected = expecting ? expectOf(form, forecast, real.id) : null;
  const set = (patch: Partial<ExpectForm>) => setForm((f) => ({ ...f, ...patch }));
  useEffect(() => {
    if (expecting) formRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, [expecting]);
  // A refused submit: once the messages are on screen, the first invalid field takes the focus.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (refused) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refused]);
  // Closing the form gives the focus to `to` (the new row's Remove), else back to the opener.
  function closeExpect(to?: () => HTMLElement | null | undefined) {
    setExpecting(false);
    setForm(EMPTY);
    setTried(false);
    setTimeout(() => (to?.() ?? openRef.current)?.focus());
  }
  async function submitExpect() {
    setTried(true);
    if (!expected) return setRefused((n) => n + 1);
    const before = new Set(real.events.map((e) => e.adjustmentId));
    if (await adjust!.onExpect(expected.body))
      closeExpect(() =>
        [...(card.current?.querySelectorAll<HTMLElement>('li[data-adjustment] button') ?? [])].find(
          (b) => !before.has(b.closest('li')!.dataset.adjustment),
        ),
      );
  }
  // What "Prepare this" did stays on screen while the account is covered by it. Once the server
  // offers options again (a charge added since made a new shortfall), that is over: the new
  // options show, with no reload.
  // It is also over once the forecast no longer counts the prepared transfer it left (sent or
  // deleted in Transfers): the line and its Undo are that transfer's, by its id.
  const mine =
    cover?.accountId === account.id &&
    !(
      cover.phase === 'done' &&
      (real.options.length > 0 || (!!cover.preparedId && !hasPrepared(forecast, cover.preparedId)))
    )
      ? cover
      : null;
  const options = mine?.options ?? account.options;
  const [picked, setPicked] = useState('');
  const option = mine?.option ?? options.find((o) => o.id === picked) ?? options[0];
  const [hover, setHover] = useState<string | null>(null);
  const name = useId();
  // The line moves at once (the same arithmetic as the preview) and settles on the server's
  // answer: its forecast then holds the transfer itself, and the sum is the same.
  const applied = !!mine && mine.phase !== 'undoing';
  const last = useRef(mine?.option.change ?? null);
  if (mine) last.current = mine.option.change;
  const t = useTween(applied ? 1 : 0, 700, applied ? 1 : 0);
  const base = mine?.preparedId ? withoutPrepared(account, mine.preparedId) : account;
  // Once the server's forecast holds the transfer, the rows and the line are the server's own.
  const settled = mine?.phase === 'done' && !!mine.preparedId && t >= 1;
  const frame = settled
    ? frameOf(account, forecast.today)
    : frameOf(base, forecast.today, last.current, t);
  const hovered = mine ? undefined : options.find((o) => o.id === hover);
  const ghost = hovered
    ? frameOf(account, forecast.today, hovered.change)
    : expected?.change
      ? frameOf(account, forecast.today, expected.change)
      : null;
  const card = useRef<HTMLElement>(null);
  // Focus follows the action whose button is gone: "Prepare this" → Undo; Undo (or a refusal) →
  // "Prepare this" if it is offered again, else the verdict. Only when no element holds it.
  const headline = useRef<HTMLParagraphElement>(null);
  const was = useRef(mine?.phase);
  useEffect(() => {
    const from = was.current;
    was.current = mine?.phase;
    if (window.document.activeElement !== window.document.body) return;
    const find = (id: string) => card.current?.querySelector<HTMLElement>(`[data-testid=${id}]`);
    if (from === 'preparing' && mine?.phase === 'done') find('forecast-undo')?.focus();
    else if ((from === 'undoing' || from === 'preparing') && !mine)
      (find('forecast-prepare') ?? headline.current)?.focus();
  }, [mine?.phase]);
  // The same after an adjustment: "Not regular" → the Undo of its status line; Remove or "Count
  // it again" → "Add an expected charge".
  const busy = !!adjust?.busy;
  const wasBusy = useRef(busy);
  useEffect(() => {
    const from = wasBusy.current;
    wasBusy.current = busy;
    if (!from || busy || window.document.activeElement !== window.document.body) return;
    (
      card.current?.querySelector<HTMLElement>('[data-testid=forecast-exclude-undo]') ??
      openRef.current
    )?.focus();
  }, [busy]);
  const [box, width] = useWidth();
  const seen = useSeen(card);
  const intro = useTween(seen && width > 0 ? 1 : 0, 900, 0);
  // The scale fits the line as it is; it opens up (animated) for a change that goes above it.
  const span = [frame, ...(ghost ? [ghost] : [])].flatMap((f) => [
    account.balanceCents,
    ...f.events.map((e) => e.balanceAfterCents),
  ]);
  const domain: [number, number] = [
    useTween(Math.min(0, ...span), 350),
    useTween(Math.max(1, ...span), 350),
  ];
  const short = !!account.shortfall;
  // Until the server has answered, what "Prepare this" does is still a preview.
  const preview =
    ghost ?? (mine?.phase === 'preparing' ? frameOf(base, forecast.today, last.current) : null);
  // The three figures are the server's, as they came: they do not count in.
  const n = eur;
  const month = new Intl.DateTimeFormat('en-IE', { month: 'short', timeZone: 'UTC' })
    .format(new Date(forecast.today))
    .replace('Sept', 'Sep');
  const refusal = error && (
    <p className="plan-refused closable" role="alert">
      <span>{error}</span>
      {onDismissError && (
        <button type="button" className="plan-link" onClick={onDismissError}>
          Dismiss
        </button>
      )}
    </p>
  );
  return (
    <section
      className="card month-ahead"
      id="month-ahead"
      ref={card}
      data-testid="plan-forecast"
      aria-labelledby="month-ahead-title"
    >
      <div className="plan-card-head">
        <div>
          <h2 id="month-ahead-title">Month ahead</h2>
          <p>
            {day(forecast.today)} to {day(forecast.until)} · {account.label}
          </p>
        </div>
        {forecast.accounts.length > 1 && (
          <div className="segmented" role="group" aria-label="Account">
            {forecast.accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={a.id === account.id}
                onClick={() => onAccount(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className={`verdict ${short ? 'short' : 'covered'}${intro >= 1 ? ' landed' : ''}`}
        data-testid="forecast-verdict"
        data-state={short ? 'short' : 'covered'}
        // The server's word, never worked out here (a usual charge of the shortfall day counts).
        data-certainty={account.shortfall?.certainty}
      >
        <span className="verdict-icon" aria-hidden="true" key={short ? 'short' : 'covered'}>
          {short ? (
            <Glyph name="alert" size={22} />
          ) : (
            <svg className="check-draw" width="22" height="22" viewBox="0 0 24 24">
              <path d="m5 12 5 5 9-10" pathLength={1} />
            </svg>
          )}
        </span>
        {/* The headline never goes without its explanation: the explanation says "estimate". */}
        <div className="verdict-text" aria-live="polite">
          <p className="verdict-headline" ref={headline} tabIndex={-1}>
            {account.headline}
          </p>
          <p className="verdict-sub">{account.explanation}</p>
        </div>
        {account.shortfall?.preparedId && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onOpenPrepared(account.shortfall!.preparedId!)}
          >
            Review transfer
          </button>
        )}
      </div>
      <div className={`hero-grid${options.length ? ' with-side' : ''}`}>
        <div className="hero-main">
          <dl className="plan-stats">
            <div>
              <dt>Today</dt>
              <dd data-stat="today">{n(account.balanceCents)}</dd>
            </div>
            <div>
              <dt>Lowest · {day(account.lowest.date)}</dt>
              <dd className={account.lowest.balanceCents < 0 ? 'short' : ''} data-stat="lowest">
                {n(account.lowest.balanceCents)}
              </dd>
              {(options.length > 0 || expecting) && (
                <dd className="stat-preview" aria-live="polite" data-stat="preview">
                  {preview
                    ? previewLine(account, preview, expecting && !hovered ? true : undefined)
                    : ' '}
                </dd>
              )}
            </div>
            <div>
              <dt>{day(forecast.until)}</dt>
              <dd data-stat="end">{n(account.endCents)}</dd>
            </div>
          </dl>
          {timeline ? (
            <div className="balance-timeline">
              {timeline.known && (
                <div className="segmented timeline-range" role="group" aria-label="Period">
                  {RANGES.map(([id, words]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={timeline.range === id}
                      onClick={() => timeline.onRange(id)}
                    >
                      {words}
                    </button>
                  ))}
                </div>
              )}
              {/* TL2b: a narrow card has no room for nine buttons: the same periods, natively. */}
              {timeline.known && (
                <label className="timeline-range-pick">
                  <span>Period</span>
                  <select
                    value={timeline.range}
                    onChange={(e) => timeline.onRange(e.target.value as TimelineRange)}
                  >
                    {RANGES.map(([id, words]) => (
                      <option key={id} value={id}>
                        {words}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* The width is read here, on the box that stays while answers come and go. */}
              <div
                ref={box}
                className={`timeline-body${timeline.loading ? ' loading' : ''}`}
                aria-busy={timeline.loading}
                data-testid="timeline"
                data-range={timeline.data?.range}
              >
                {timeline.data ? (
                  <TimelineChart
                    width={width}
                    timeline={timeline.data}
                    label={account.label}
                    change={
                      hovered?.change ??
                      expected?.change ??
                      (mine?.phase === 'preparing' ? mine.option.change : null)
                    }
                  />
                ) : (
                  <div className="plan-chart timeline-wait">
                    <i className="sk" />
                  </div>
                )}
              </div>
              <ul className="chart-legend" aria-hidden="true">
                <li>
                  <i className="solid" /> Real balance
                </li>
                <li>
                  <i className="dashed" /> Projected
                </li>
                {timeline.data?.shortfall && (
                  <li>
                    <i className="below" /> Below zero
                  </li>
                )}
              </ul>
              {timeline.data && (
                <div className="timeline-under" data-testid="timeline-under">
                  <p className="timeline-figures">
                    {timeline.data.lowest && (
                      <span data-stat="timeline-lowest">
                        Lowest {day(timeline.data.lowest.date)}{' '}
                        <b className={timeline.data.lowest.balanceCents < 0 ? 'short' : ''}>
                          {eur(timeline.data.lowest.balanceCents)}
                        </b>
                      </span>
                    )}
                    {timeline.data.points.length > 0 && (
                      <span data-stat="timeline-end">
                        {day(timeline.data.to)}{' '}
                        <b>
                          {eur(timeline.data.points[timeline.data.points.length - 1].balanceCents)}
                        </b>
                      </span>
                    )}
                  </p>
                  {timeline.data.months.length > 1 &&
                    // A week across two months is one piece: no table for it.
                    Date.parse(timeline.data.to) - Date.parse(timeline.data.from) >
                      31 * 86_400_000 && (
                      <div className="timeline-months-wrap">
                        <table className="timeline-months" data-testid="timeline-months">
                          <caption className="sr-only">Month by month</caption>
                          <thead>
                            <tr>
                              <th scope="col">Month</th>
                              <th scope="col">Start</th>
                              <th scope="col">In</th>
                              <th scope="col">Out</th>
                              <th scope="col">End</th>
                            </tr>
                          </thead>
                          <tbody>
                            {timeline.data.months.map((mo) => (
                              <tr key={mo.month} data-actual={mo.actual}>
                                <th scope="row">
                                  {monthName(monthIndex(mo.from))}{' '}
                                  <small>
                                    {mo.actual === 'full'
                                      ? 'actual'
                                      : mo.actual === 'none'
                                        ? 'projected'
                                        : 'actual, then projected'}
                                  </small>
                                </th>
                                <td>{eur(mo.startBalanceCents)}</td>
                                <td>{signed(mo.incomeCents)}</td>
                                <td>{signed(-mo.outCents)}</td>
                                <td>
                                  {eur(mo.endBalanceCents)}
                                  {endsAfterPending(timeline.data!, mo) && (
                                    <small className="after-pending">
                                      {' '}
                                      after today&apos;s pending items
                                    </small>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  {/* TL2b: the dots' events for keyboard and screen readers, one tab stop. */}
                  {events.length > 0 && (
                    <details className="timeline-events" data-testid="timeline-events">
                      <summary>Events in this period ({events.length})</summary>
                      <table className="timeline-months">
                        <thead>
                          <tr>
                            <th scope="col">Date</th>
                            <th scope="col">What</th>
                            <th scope="col">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((e, i) => (
                            <tr key={i}>
                              <td>{day(e.date)}</td>
                              <td>
                                <bdi>{e.label}</bdi>
                              </td>
                              <td>{signed(e.amountCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                  {timeline.data.events.some(
                    (e) => e.source === 'goal' || e.source === 'prepared',
                  ) && (
                    <p className="timeline-note" data-testid="timeline-goal-note">
                      Goal payments and prepared transfers are never sent automatically: you confirm
                      each one in Transfers.
                    </p>
                  )}
                  {timeline.data.basis && (
                    <p className="timeline-basis" data-testid="timeline-basis">
                      {basisWords(timeline.data.basis)}
                    </p>
                  )}
                  {timeline.data.notes
                    .filter((n) => !forecast.notes.includes(n))
                    .map((n) => (
                      <p className="timeline-note" key={n}>
                        {n}
                      </p>
                    ))}
                </div>
              )}
              {timeline.error && (
                <p className="plan-refused closable" role="alert">
                  <span>{timeline.error}</span>
                  <button type="button" className="plan-link" onClick={timeline.onRetry}>
                    Retry
                  </button>
                </p>
              )}
            </div>
          ) : (
            <BalanceChart
              boxRef={box}
              width={width}
              account={account}
              forecast={forecast}
              frame={frame}
              ghost={ghost}
              intro={intro}
              domain={domain}
            />
          )}
          {!timeline && (
            <ul className="chart-legend" aria-hidden="true">
              <li>
                <i className="solid" /> Certain
              </li>
              <li>
                <i className="dashed" /> Estimated
              </li>
              {frame.lowest.balanceCents < 0 && (
                <li>
                  <i className="below" /> Below zero
                </li>
              )}
            </ul>
          )}
          <div className="sr-only">
            <table>
              <caption>
                Projected balance of {account.label}, {day(forecast.today)} to {day(forecast.until)}
              </caption>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>What</th>
                  <th>Amount</th>
                  <th>Balance after</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{day(forecast.today)}</td>
                  <td>Today</td>
                  <td />
                  <td>{eur(account.balanceCents)}</td>
                </tr>
                {account.events.map((e, i) => (
                  <tr key={i}>
                    <td>{day(e.date)}</td>
                    <td>
                      {e.label} ({e.certainty})
                    </td>
                    <td>{signed(e.amountCents)}</td>
                    <td>{eur(e.balanceAfterCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {options.length > 0 && (
          <div className="hero-side cover">
            <fieldset className="plan-options" disabled={!!mine}>
              <legend>{options.length > 1 ? 'Ways to cover it' : 'A way to cover it'}</legend>
              {options.map((o) => (
                <label
                  className="plan-option"
                  key={o.id}
                  data-testid="forecast-cover-option"
                  onMouseEnter={() => setHover(o.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <input
                    type="radio"
                    name={name}
                    checked={option?.id === o.id}
                    onChange={() => setPicked(o.id)}
                    onFocus={() => setHover(o.id)}
                    onBlur={() => setHover(null)}
                  />
                  <span className="plan-option-mark" aria-hidden="true" />
                  <span className="plan-option-text">
                    <strong>{o.title}</strong>
                    {/* UI1 review: once taken, the sentence is the one of the moment it was
                        offered and a later adjustment makes it differ from the figures above. */}
                    {mine?.phase !== 'done' && <small>{o.consequence}</small>}
                  </span>
                </label>
              ))}
            </fieldset>
            {mine ? (
              <Done
                text={PREPARED_LINE}
                busy={
                  mine.phase === 'preparing'
                    ? 'Preparing…'
                    : mine.phase === 'undoing'
                      ? 'Removing…'
                      : ''
                }
              >
                {mine.preparedId && (
                  <button
                    type="button"
                    className="plan-link"
                    onClick={() => onOpenPrepared(mine.preparedId!)}
                  >
                    Open in Transfers
                  </button>
                )}
                <button
                  type="button"
                  className="plan-link"
                  data-testid="forecast-undo"
                  onClick={onUndo}
                >
                  Undo
                </button>
              </Done>
            ) : (
              <div className="plan-actions">
                <button
                  type="button"
                  className="primary-button"
                  data-testid="forecast-prepare"
                  onClick={() => {
                    setHover(null);
                    onPrepare(account.id, options, option);
                  }}
                >
                  Prepare this
                </button>
              </div>
            )}
            {refusal}
          </div>
        )}
      </div>
      {/* UI1 review: a refusal after which the server offers no option (409 `too_many`: at the
          limit there is none) is still said; the block above is gone with the options. */}
      {options.length === 0 && refusal}
      {forecast.notes.map((note) => (
        <p className="plan-quiet" key={note}>
          <Glyph name="alert" size={15} />
          {note}
        </p>
      ))}
      {account.events.length > 0 && (
        <>
          <h3 className="plan-subtitle">Coming up this month</h3>
          <ul className="coming-up">
            {frame.events.map((e, i) => (
              <li
                key={e.adjustmentId ?? i}
                data-testid="forecast-event"
                data-source={e.source}
                data-adjustment={e.adjustmentId}
                className={
                  e.balanceAfterCents < 0
                    ? 'short'
                    : e.added || e.source === 'expected_by_you'
                      ? 'added'
                      : ''
                }
              >
                <span className="coming-date">
                  <b>{dayOf(e.date)}</b>
                  {month}
                </span>
                <span className="coming-main">
                  <strong>{e.label}</strong>
                  <small>
                    {e.added ? 'Being prepared · you confirm it' : sourceWords(e)}
                    {e.note && <em> · {e.note}</em>}
                  </small>
                  {adjust && e.merchantKey && e.source !== 'prepared' && !e.adjustmentId && (
                    <button
                      type="button"
                      className="plan-link quiet row-action"
                      data-testid="forecast-exclude"
                      aria-label={`Do not count ${e.label}`}
                      disabled={adjust.busy}
                      onClick={() => adjust.onExclude(real.id, e)}
                    >
                      Not regular
                    </button>
                  )}
                  {adjust && e.source === 'expected_by_you' && e.adjustmentId && (
                    <button
                      type="button"
                      className="plan-link quiet row-action"
                      data-testid="forecast-adjustment-remove"
                      disabled={adjust.busy}
                      onClick={() => adjust.onRemove(e.adjustmentId!)}
                    >
                      Remove
                    </button>
                  )}
                </span>
                <span className={`coming-amount${e.amountCents > 0 ? ' credit' : ''}`}>
                  {signed(e.amountCents)}
                </span>
                <span className="coming-after">
                  {e.balanceAfterCents < 0 ? (
                    <span className="plan-pill warn">
                      <Glyph name="alert" size={12} />
                      {eur(-e.balanceAfterCents)} short
                    </span>
                  ) : (
                    <>
                      <small>balance after </small>
                      {eur(e.balanceAfterCents)}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* RG1b: what falls due in the first days of next month, outside this month's line. */}
      {!!account.nextMonth?.length && (
        <div className="next-month" data-testid="forecast-next-month">
          <h3 className="plan-subtitle" id="next-month-title">
            Early next month
          </h3>
          <ul aria-labelledby="next-month-title">
            {account.nextMonth.map((e) => (
              <li key={`${e.date}-${e.label}`}>
                <span className="next-month-date">{day(e.date)}</span>
                <span className="next-month-label">{e.label}</span>
                <span className={`next-month-amount${e.amountCents > 0 ? ' credit' : ''}`}>
                  {signed(e.amountCents)}
                </span>
                {/* RG1b: an item the customer added; its way out, as in the rows above. */}
                {adjust && e.adjustmentId && (
                  <button
                    type="button"
                    className="plan-link quiet row-action"
                    data-testid="forecast-adjustment-remove"
                    aria-label={`Remove ${e.label}`}
                    disabled={adjust.busy}
                    onClick={() => adjust.onRemove(e.adjustmentId!)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {adjust?.status && (
        <Done text={adjust.status.text}>
          <button
            type="button"
            className="plan-link"
            data-testid="forecast-exclude-undo"
            disabled={adjust.busy}
            onClick={() => adjust.onRemove(adjust.status!.undoId)}
          >
            Undo
          </button>
        </Done>
      )}
      {adjust &&
        (expecting ? (
          <form
            ref={formRef}
            className="expect-form"
            data-testid="forecast-expect-form"
            aria-label="Add an expected charge"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submitExpect();
            }}
          >
            <label className="goal-field">
              <span>What for</span>
              <input
                value={form.label}
                maxLength={40}
                aria-invalid={(tried && !!errors.label) || !!adjust.labelError || undefined}
                onChange={(e) => set({ label: e.target.value })}
              />
              {((tried && errors.label) || adjust.labelError) && (
                <span
                  className="field-error"
                  role="alert"
                  data-testid="forecast-expect-label-error"
                >
                  {(tried && errors.label) || adjust.labelError}
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
            <div className="goal-field">
              <span id={`${name}r`}>Repeats</span>
              <div className="segmented" role="group" aria-labelledby={`${name}r`}>
                {(['once', 'monthly'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={form.repeats === r}
                    onClick={() => set({ repeats: r })}
                  >
                    {r === 'once' ? 'Once' : 'Every month'}
                  </button>
                ))}
              </div>
            </div>
            {form.repeats === 'once' ? (
              <label className="goal-field">
                <span>Date</span>
                <input
                  type="date"
                  min={forecast.today}
                  max={lastExpectDate(forecast.today)}
                  value={form.date}
                  aria-invalid={(tried && !!errors.date) || undefined}
                  onChange={(e) => set({ date: e.target.value })}
                />
                {tried && errors.date && (
                  <span className="field-error" role="alert">
                    {errors.date}
                  </span>
                )}
              </label>
            ) : (
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
            )}
            <p className="expect-note" aria-live="polite">
              {expected && !expected.change
                ? `It falls outside ${day(forecast.today)} to ${day(forecast.until)}, so this month's line does not change.`
                : 'Counted as an estimate in this account. It is not a transfer: nothing is prepared or sent.'}
            </p>
            {adjust.error && (
              <p className="plan-refused" role="alert">
                {adjust.error}
              </p>
            )}
            <div className="expect-actions">
              <button
                type="submit"
                className="primary-button"
                data-testid="forecast-expect-submit"
                disabled={adjust.busy}
              >
                {adjust.busy ? 'Adding…' : 'Add'}
              </button>
              <button type="button" className="secondary-button" onClick={() => closeExpect()}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              ref={openRef}
              type="button"
              className="plan-link expect-open"
              data-testid="forecast-expect-open"
              onClick={() => setExpecting(true)}
            >
              <Glyph name="plus" size={15} /> Add an expected charge
            </button>
            {adjust.error && (
              <p className="plan-refused" role="alert">
                {adjust.error}
              </p>
            )}
          </>
        ))}
      {forecast.notCounted.length > 0 && (
        <details
          className="not-counted"
          open={forecast.notCounted.some((c) => c.adjustmentId) || undefined}
        >
          <summary>Not counted · {forecast.notCounted.length}</summary>
          <ul>
            {forecast.notCounted.map((c) => (
              <li key={c.adjustmentId ?? c.text ?? c.label}>
                {c.text ?? c.label}
                {adjust && c.adjustmentId && (
                  <button
                    type="button"
                    className="plan-link"
                    data-testid="forecast-adjustment-remove"
                    disabled={adjust.busy}
                    onClick={() => adjust.onRemove(c.adjustmentId!)}
                  >
                    {c.reason === 'excluded_by_you' ? 'Count it again' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* FC2: the adjustments no row above shows. They count against the cap, so each has its
          way out here. */}
      {adjust && hidden.length > 0 && (
        <details className="not-counted" data-testid="forecast-adjustments">
          <summary>Your adjustments not in this month · {hidden.length}</summary>
          <ul>
            {hidden.map((a) => (
              <li key={a.id}>
                <span className="adjustment-words">{adjustmentWords(a, forecast.today)}</span>
                {/* RG2c: the same payment as another regular item, counted once. */}
                {a.countedWith && (
                  <small className="counted-with">Counted once with {a.countedWith.label}</small>
                )}
                <button
                  type="button"
                  className="plan-link"
                  data-testid="forecast-adjustment-remove"
                  disabled={adjust.busy}
                  onClick={() => adjust.onRemove(a.id)}
                >
                  {a.kind === 'exclude' ? 'Count it again' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="plan-source">{forecast.sourceLine}</p>
    </section>
  );
}
// While the forecast is read: the shape of the card, then the draw-in.
export function MonthSkeleton() {
  return (
    <section
      className="card month-ahead skeleton"
      aria-busy="true"
      aria-label="Reading the month ahead"
    >
      <i className="sk" style={{ width: 140, height: 20 }} />
      <i className="sk" style={{ height: 92 }} />
      <i className="sk" style={{ width: '46%', height: 44 }} />
      <i className="sk" style={{ height: 300 }} />
      <i className="sk" style={{ height: 56 }} />
      <i className="sk" style={{ height: 56 }} />
    </section>
  );
}
