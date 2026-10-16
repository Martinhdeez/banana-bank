// UI1 (plan 28 §4.3, §5.2, §6): savings goals. The state, `headline`, `basis`, the suggestion
// texts and `canSaveReason` are the server's and are printed as they came. Creating and adjusting
// prepare one monthly transfer and send nothing; sending stays in Transfers. The what-if slider
// is arithmetic over the goal's own figures (D8) and changes nothing until its button is used.
import { useEffect, useRef, useState } from 'react';
import { mainAccount } from '../../../src/banking/recipients';
import { centsFromEuros } from '../../../src/ui-helpers';
import { Icon } from '../Icon';
import { Count, Glyph, GoalTrack, PathChart, Pill, reducedMotion, Track } from './charts';
import { Done } from './Forecast';
import {
  day,
  dayYear,
  eur,
  eurShort,
  fitsLine,
  roomWords,
  goalIcon,
  lateWords,
  monthIndex,
  monthName,
  occurrence,
  PREPARED_LINE,
  preparedWords,
  sliderRange,
  snapPoints,
  STATES,
  streak,
  whatIf,
} from './logic';
import type { GoalView, GoalsResponse, PlanDryRun, Suggestion } from './types';

export type GoalActions = {
  // `goalId`: the what-if of an existing goal (GL1: the plan then starts at its next unpaid
  // occurrence). `targetDate` is always after today: the route answers 400 otherwise.
  plan(body: {
    targetCents: number;
    targetDate: string;
    day: number;
    goalId?: string;
  }): Promise<PlanDryRun>;
  create(body: {
    name: string;
    targetCents: number;
    targetDate: string;
    fromAccountId: string;
    toAccountId: string;
    day: number;
  }): Promise<GoalView>;
  adjust(id: string, body: { monthlyCents: number } | { targetDate: string }): Promise<GoalView>;
  remove(id: string): Promise<void>;
  // The existing action of a paused prepared transfer (POST /api/prepared/:id/resume).
  resume(id: string): Promise<void>;
  openPrepared(id: string): void;
};
// GL1: a paused monthly transfer reads as `no_plan` with `prepared` still carrying it.
const isPaused = (g: GoalView) => g.prepared?.state === 'paused';
// GL1: `behind` because a payment's day has passed unsent has no gap (`behindCents: 0`): the one
// thing to do is to send it. A `behind` with a gap can also come with no suggestion at all
// (neither would change anything, or the new date would be beyond 30 years): the slider stays.
const isWaiting = (g: GoalView) => g.state === 'behind' && g.behindCents === 0;

const subline = (g: GoalView, today: string) =>
  g.state === 'reached' && g.reachedAt
    ? `Reached on ${dayYear(g.reachedAt, today)}`
    : `by ${dayYear(g.targetDate, today)} · ${g.monthlyCents ? `${eurShort(g.monthlyCents)} a month` : 'no monthly transfer'}`;
const nextLine = (g: GoalView, today: string) =>
  g.prepared
    ? `${eur(g.prepared.amountCents)} · ${preparedWords(g.prepared, today)}`
    : g.state === 'reached' || g.state === 'date_passed'
      ? 'The monthly prepared transfer has ended.'
      : g.headline;
const sendLabel = (g: GoalView) =>
  g.prepared!.state === 'awaiting_confirmation' || g.prepared!.state === 'verifying'
    ? 'Review in Transfers'
    : isPaused(g)
      ? 'Resume'
      : 'Review and send';
// What a suggestion's button does, in the interface's words; its sentence is the server's.
const applyLabel = (s: Suggestion, today: string) =>
  s.kind === 'extend'
    ? `Move the date to ${dayYear(s.targetDate, today)}`
    : s.kind === 'raise'
      ? `Prepare ${eur(s.monthlyCents)} a month`
      : 'Prepare it again';
const bodyOf = (s: Suggestion) =>
  s.kind === 'extend' ? { targetDate: s.targetDate } : { monthlyCents: s.monthlyCents };

function Fits({ fits, room }: { fits: boolean | null; room: GoalsResponse['room'] }) {
  return (
    <p className={`goal-fits${fits === false ? ' over' : ''}`}>
      <Glyph name={fits ? 'check' : 'alert'} size={15} />
      {fitsLine(fits, room)}
    </p>
  );
}

export function GoalCard({
  goal,
  today,
  fresh,
  onOpen,
  onOpenPrepared,
  onResume,
}: {
  goal: GoalView;
  today: string;
  // Just created here: highlighted once.
  fresh?: boolean;
  onOpen(): void;
  onOpenPrepared(id: string): void;
  onResume(id: string): void;
}) {
  const run = streak(goal);
  const icon = goalIcon(goal.name);
  return (
    <article
      className={`card goal-card${fresh ? ' new glow' : ''}`}
      data-icon={icon}
      data-testid="goal-card"
      data-state={goal.state}
      id={`goal-${goal.id}`}
    >
      <header>
        <span className="goal-tile" aria-hidden="true">
          <Glyph name={icon} size={24} />
        </span>
        <div className="goal-card-title">
          <h3>
            {/* The whole card opens the goal (the button's ::after covers it). */}
            <button type="button" className="goal-open" onClick={onOpen}>
              <bdi>{goal.name}</bdi>
            </button>
          </h3>
          <p>{subline(goal, today)}</p>
        </div>
        {fresh ? <span className="plan-pill new">New</span> : <Pill state={goal.state} />}
      </header>
      <div className="goal-figure">
        <p className="goal-amount">
          <strong>{eurShort(goal.savedCents)}</strong> of {eurShort(goal.targetCents)}
        </p>
        {run >= 3 && (
          <span className="goal-streak">
            <Glyph name="check" size={13} />
            {run} months in a row
          </span>
        )}
      </div>
      <GoalTrack goal={goal} fresh={fresh} />
      <footer>
        <span>{nextLine(goal, today)}</span>
        {goal.prepared ? (
          <button
            type="button"
            className="plan-link"
            onClick={() => (isPaused(goal) ? onResume : onOpenPrepared)(goal.prepared!.id)}
          >
            {sendLabel(goal)}
          </button>
        ) : goal.suggestion ? (
          <button type="button" className="plan-link" onClick={onOpen}>
            {goal.suggestion.kind === 'extend' ? 'Set a new date' : 'Prepare it again'}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

export function GoalDetail({
  goal,
  data,
  actions,
  onClose,
  onDeleted,
}: {
  goal: GoalView;
  data: GoalsResponse;
  actions: GoalActions;
  onClose(): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const range = sliderRange(goal);
  const [monthly, setMonthly] = useState(goal.monthlyCents ?? range.min);
  const [dry, setDry] = useState<{ for: number; plan: PlanDryRun } | null>(null);
  const slider =
    !!goal.prepared &&
    !!goal.monthlyCents &&
    !isWaiting(goal) &&
    (goal.state === 'behind' || goal.state === 'on_track');
  const now = slider ? whatIf(goal, monthly) : null;
  // The dry run, once the slider rests: the route's payments and last date replace the browser's.
  // The amount shown stays the slider's (the customer's choice): the route's `monthlyCents` is
  // the amount REQUIRED for that date and can be below it. Never asked for today or earlier (400).
  useEffect(() => {
    if (!now || monthly === goal.monthlyCents || now.lastDue <= data.today) return;
    let live = true;
    const timer = setTimeout(
      () =>
        actions
          .plan({
            targetCents: goal.remainingCents,
            targetDate: now.lastDue,
            day: now.day,
            goalId: goal.id,
          })
          .then((plan) => live && setDry({ for: monthly, plan }))
          .catch(() => {}),
      400,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [monthly]);
  const settled = dry?.for === monthly ? dry.plan : null;
  const reachedOn = settled?.lastDue ?? now?.lastDue;
  const payments = settled?.payments ?? now?.payments;
  // The route's `fits` is about its required amount: the slider's own value is compared here.
  const fits = data.room ? monthly <= data.room.monthlyCents : null;
  // The reached moment plays once per goal, remembered in this browser.
  const [celebrate] = useState(() => {
    if (goal.state !== 'reached' || reducedMotion()) return false;
    try {
      if (localStorage.getItem(`plan_reached_${goal.id}`)) return false;
      localStorage.setItem(`plan_reached_${goal.id}`, '1');
    } catch {}
    return true;
  });
  async function run(key: string, work: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(key);
    setError('');
    setDone(false);
    try {
      await work();
      if (after) after();
      else setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const adjust = (key: string, body: Parameters<GoalActions['adjust']>[1]) =>
    run(key, () => actions.adjust(goal.id, body));
  const icon = goalIcon(goal.name);
  const recent = goal.history
    .filter((h) => h.plannedCents > 0)
    .slice(-3)
    .reverse();
  const confirmed = goal.history.filter(
    (h) => h.plannedCents > 0 && h.savedCents >= h.plannedCents,
  );
  const closing = goal.state === 'date_passed' || goal.state === 'reached';
  const p = goal.prepared;
  return (
    <div className="goal-detail" data-icon={icon} data-testid="goal-detail" data-state={goal.state}>
      <header className="goal-detail-head">
        <span className="goal-tile large" aria-hidden="true">
          <Glyph name={icon} size={26} />
        </span>
        <div className="goal-detail-title">
          <h1>
            <bdi>{goal.name}</bdi> <Pill state={goal.state} />
          </h1>
          <p>
            {eurShort(goal.targetCents)} by {dayYear(goal.targetDate, data.today)} · to{' '}
            {goal.to.label}
          </p>
        </div>
      </header>

      <section className="card goal-hero" aria-label="Path">
        <dl className="plan-stats">
          <div>
            <dt>Saved</dt>
            <dd className="big">
              <Count cents={goal.savedCents} />
            </dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{eurShort(goal.targetCents)}</dd>
          </div>
          <div>
            <dt>{goal.state === 'reached' ? 'Reached' : 'Still to save'}</dt>
            <dd>
              {goal.state === 'reached' && goal.reachedAt
                ? dayYear(goal.reachedAt, data.today)
                : eurShort(goal.remainingCents)}
            </dd>
          </div>
          <div>
            <dt>Each month</dt>
            <dd>{goal.monthlyCents ? eurShort(goal.monthlyCents) : '—'}</dd>
          </div>
        </dl>
        <div className={`hero-grid${slider ? ' with-side' : ''}`}>
          <div className="hero-main">
            <PathChart
              goal={goal}
              today={data.today}
              pace={slider ? monthly : undefined}
              minPace={slider ? range.min : undefined}
            />
            <ul className="chart-legend" aria-hidden="true">
              <li>
                <i className="solid" /> Saved
              </li>
              <li>
                <i className="dashed" /> Plan
              </li>
              {goal.state !== 'reached' && p && (
                <li>
                  <i className="dotted" /> At this pace
                </li>
              )}
              <li>
                <i className="target" /> Target
              </li>
            </ul>
          </div>
          {slider && now && (
            <div className="hero-side whatif" data-testid="goal-whatif">
              <h3>What if you set aside…</h3>
              <label className="whatif-slider">
                <span className="whatif-amount">
                  <strong>{eurShort(monthly)}</strong> a month
                </span>
                <input
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={100}
                  value={monthly}
                  disabled={!!busy}
                  aria-label="Each month"
                  aria-valuetext={`${eurShort(monthly)} a month: reached ${dayYear(reachedOn!, data.today)}, ${lateWords(now.monthsLate)}`}
                  style={
                    {
                      '--p': `${((monthly - range.min) / (range.max - range.min)) * 100}%`,
                    } as React.CSSProperties
                  }
                  onChange={(e) => {
                    setDone(false);
                    setMonthly(Number(e.target.value));
                  }}
                />
                <span className="whatif-range" aria-hidden="true">
                  <span>{eurShort(range.min)}</span>
                  <span>{eurShort(range.max)}</span>
                </span>
              </label>
              <div className="whatif-snaps" role="group" aria-label="Amounts the plan names">
                {snapPoints(goal).map((cents) => (
                  <button
                    key={cents}
                    type="button"
                    aria-pressed={monthly === cents}
                    disabled={!!busy}
                    onClick={() => {
                      setDone(false);
                      setMonthly(cents);
                    }}
                  >
                    {eurShort(cents)} · {lateWords(whatIf(goal, cents)!.monthsLate)}
                  </button>
                ))}
              </div>
              <p className="whatif-readout" aria-live="polite">
                <small>
                  {payments} {payments === 1 ? 'payment' : 'payments'}, the last on
                </small>
                <strong>{dayYear(reachedOn!, data.today)}</strong>
                <span className={`plan-pill ${now.monthsLate > 0 ? 'warn' : 'ok'}`}>
                  {lateWords(now.monthsLate)}
                </span>
              </p>
              <Fits fits={fits} room={data.room} />
              {done ? (
                <Done text={PREPARED_LINE}>
                  {p && (
                    <button
                      type="button"
                      className="plan-link"
                      onClick={() => actions.openPrepared(p.id)}
                    >
                      Open in Transfers
                    </button>
                  )}
                </Done>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  data-testid="goal-whatif-apply"
                  disabled={!!busy || monthly === goal.monthlyCents}
                  onClick={() => adjust('slider', { monthlyCents: monthly })}
                >
                  {busy === 'slider' ? 'Preparing…' : `Prepare ${eurShort(monthly)} a month`}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="goal-detail-grid">
        <section className={`card stand ${goal.state}`} aria-labelledby="stand-title">
          <div className="stand-head">
            <Icon name="target" size={16} />
            <h2 id="stand-title">Where you stand</h2>
          </div>
          {goal.state === 'reached' && (
            <span className={`reached-badge${celebrate ? ' play' : ''}`} aria-hidden="true">
              <svg viewBox="0 0 88 88">
                <circle className="reached-ring" cx="44" cy="44" r="40" pathLength={1} />
                <circle className="reached-disc" cx="44" cy="44" r="31" />
                <path className="reached-check" d="m31 45 9 9 17-19" pathLength={1} />
              </svg>
              {celebrate &&
                Array.from({ length: 14 }, (_, i) => (
                  <i
                    key={i}
                    style={
                      {
                        '--a': `${i * (360 / 14) + (i % 2) * 9}deg`,
                        '--r': `${54 + (i % 3) * 14}px`,
                      } as React.CSSProperties
                    }
                  />
                ))}
            </span>
          )}
          <p className="stand-headline" data-testid="goal-headline">
            {goal.headline}
          </p>
          <p className="stand-sub" data-testid="goal-basis">
            {goal.basis}
          </p>
          {goal.state === 'reached' && (
            <dl className="plan-stats reached-strip">
              <div>
                <dt>Months</dt>
                <dd>{goal.history.length}</dd>
              </div>
              <div>
                <dt>Payments confirmed</dt>
                <dd>{confirmed.length}</dd>
              </div>
              {goal.reachedAt && (
                <div>
                  <dt>Reached</dt>
                  <dd>{dayYear(goal.reachedAt, data.today)}</dd>
                </div>
              )}
            </dl>
          )}
          {/* The adjustments the rules found: the sentence is the server's, the button applies it. */}
          {[goal.suggestion, goal.alternative].map(
            (s, i) =>
              s &&
              // A paused transfer is resumed, not prepared a second time.
              !(s.kind === 'prepare_again' && p) && (
                <div className="goal-adjustment" key={s.kind} data-testid="goal-adjustment">
                  <p>{s.text}</p>
                  <button
                    type="button"
                    className={i ? 'secondary-button' : 'primary-button'}
                    disabled={!!busy}
                    onClick={() => adjust(s.kind, bodyOf(s))}
                  >
                    {busy === s.kind ? 'Preparing…' : applyLabel(s, data.today)}
                  </button>
                </div>
              ),
          )}
          {done && !slider && <Done text={PREPARED_LINE} />}
          {error && (
            <p className="plan-refused" role="alert">
              {error}
            </p>
          )}
          {asking ? (
            <div className="plan-actions goal-confirm" role="group" aria-label="Delete this goal?">
              <span>
                Delete this goal? Its monthly prepared transfer is deleted too. Nothing that was
                sent is undone.
              </span>
              <button
                type="button"
                className="secondary-button danger"
                disabled={!!busy}
                onClick={() => run('delete', () => actions.remove(goal.id), onDeleted)}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                className="secondary-button"
                autoFocus
                disabled={!!busy}
                onClick={() => setAsking(false)}
              >
                Keep
              </button>
            </div>
          ) : (
            <div className="plan-actions">
              <button
                type="button"
                className="plan-link quiet"
                data-testid="goal-delete"
                onClick={() => setAsking(true)}
              >
                {closing ? 'Close goal' : 'Delete goal'}
              </button>
            </div>
          )}
        </section>

        <section className="card goal-plan" aria-labelledby="goal-plan-title">
          <h2 id="goal-plan-title">Plan</h2>
          {p ? (
            <>
              <p className="goal-plan-amount">
                <strong>{eur(p.amountCents)}</strong>
                {p.when.kind === 'monthly' && ` on day ${p.when.day} of each month`}
              </p>
              <p className="goal-plan-route">
                {goal.from.label} <Glyph name="route" size={14} /> {goal.to.label}
              </p>
              <div className="prepared-card" data-state={p.state}>
                <span className="prepared-state">
                  <i aria-hidden="true" />
                  {preparedWords(p, data.today)}
                </span>
                <p className="prepared-title">
                  <strong>{eur(p.amountCents)}</strong> to <bdi>{p.to}</bdi>
                </p>
                <p className="prepared-meta">
                  <bdi>{p.concept}</bdi>
                  {p.lastSentAt && ` · last sent ${day(p.lastSentAt.slice(0, 10))}`}
                </p>
                {p.note && (
                  <p className="prepared-note">
                    “<bdi>{p.note}</bdi>”
                  </p>
                )}
                <div className="prepared-actions">
                  <button
                    type="button"
                    className="primary-button"
                    data-testid={isPaused(goal) ? 'goal-resume' : 'goal-send'}
                    disabled={!!busy}
                    onClick={() =>
                      isPaused(goal)
                        ? run('resume', () => actions.resume(p.id))
                        : actions.openPrepared(p.id)
                    }
                  >
                    {busy === 'resume' ? 'Resuming…' : sendLabel(goal)}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="goal-plan-none">
              {closing
                ? 'The monthly prepared transfer has ended.'
                : 'There is no monthly prepared transfer for this goal.'}
            </p>
          )}
          {recent.length > 0 && (
            <>
              <h3>
                Last months
                {streak(goal) >= 3 && (
                  <span className="goal-streak">
                    <Glyph name="check" size={13} />
                    {streak(goal)} in a row
                  </span>
                )}
              </h3>
              <ul className="goal-history">
                {recent.map((h) => {
                  const sent = h.savedCents >= h.plannedCents;
                  return (
                    <li key={h.month}>
                      <span
                        className={`goal-history-mark ${sent ? 'sent' : 'missed'}`}
                        aria-hidden="true"
                      >
                        <Glyph name={sent ? 'check' : 'missed'} size={14} />
                      </span>
                      <span>
                        {monthName(
                          monthIndex(h.month),
                          h.month.slice(0, 4) !== data.today.slice(0, 4),
                        )}
                      </span>
                      <small>
                        {sent
                          ? 'Confirmed and sent'
                          : h.savedCents
                            ? `${eur(h.savedCents)} sent`
                            : 'Not sent'}
                      </small>
                      <b>{eur(h.plannedCents)}</b>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <p className="plan-source">
            Saved counts the transfers of this goal that you confirmed, not the balance of{' '}
            {goal.to.label}.
          </p>
        </section>
      </div>
      <button type="button" className="plan-link back bottom" onClick={onClose}>
        <Glyph name="back" size={15} /> All goals
      </button>
    </div>
  );
}

// Starting points: a name, an amount and how many months ahead. The customer edits all three.
const TEMPLATES = [
  { id: 'holiday', label: 'Holiday', name: 'Summer trip', amount: '1200', months: 8 },
  { id: 'fund', label: 'Emergency fund', name: 'Emergency fund', amount: '3000', months: 14 },
  { id: 'purchase', label: 'Big purchase', name: 'New laptop', amount: '1500', months: 5 },
  { id: 'other', label: 'Something else', name: '', amount: '', months: 0 },
];
export type Template = (typeof TEMPLATES)[number];
export function Templates({ picked, onPick }: { picked?: string; onPick(t: Template): void }) {
  return (
    <div className="goal-templates" role="group" aria-label="Start from">
      {TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={picked === undefined ? undefined : picked === t.id}
          onClick={() => onPick(t)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// The plan block of the "New goal" form and, since UI4, of the plan card in the chat: one block
// for one set of figures (the server's dry run). `empty`: what stands in it while there is none.
// `live`: the form's block announces its new figures; in a chat message it must not (the message
// list would re-announce it).
export function PlanPreview({
  plan,
  targetCents,
  targetDate,
  today,
  room,
  empty,
  live = true,
}: {
  plan: PlanDryRun | null | undefined;
  targetCents: number;
  targetDate: string;
  today: string;
  room: GoalsResponse['room'];
  empty?: string;
  live?: boolean;
}) {
  return (
    <section
      className="goal-preview"
      aria-live={live ? 'polite' : undefined}
      aria-label="Your plan"
      data-testid="goal-plan-preview"
    >
      <span className="goal-preview-label">Your plan</span>
      {plan ? (
        <>
          <p className="goal-preview-amount">
            <strong>{eur(plan.monthlyCents)}</strong> a month · {plan.payments}{' '}
            {plan.payments === 1 ? 'payment' : 'payments'}
          </p>
          <p className="goal-preview-dates">
            first on {dayYear(plan.firstDue, today)}, last on {dayYear(plan.lastDue, today)}
          </p>
          <Track
            savedCents={0}
            targetCents={targetCents}
            plannedCents={null}
            nextCents={plan.monthlyCents}
            small
          />
          <Fits fits={plan.fits} room={room} />
          {/* GL1: a first occurrence after the date is one payment after it. Said, not blocked. */}
          {plan.lastDue > targetDate && (
            <p className="goal-preview-late" data-testid="goal-plan-late">
              The last payment is after your date, so the goal will read behind plan.
            </p>
          )}
        </>
      ) : (
        <p className="goal-preview-empty">{empty}</p>
      )}
    </section>
  );
}

export function CreateDrawer({
  open,
  data,
  template,
  actions,
  onClose,
  onCreated,
}: {
  open: boolean;
  data: GoalsResponse;
  template: Template | null;
  actions: GoalActions;
  onClose(): void;
  onCreated(goal: GoalView): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [dayOfMonth, setDayOfMonth] = useState('3'); // GL6
  // GL1 lists `accounts` in the bank's order, where the savings account can come first: the
  // money leaves the main account by default, as the Overview names it.
  const [from, setFrom] = useState(mainAccount(data.accounts)?.id ?? '');
  const [to, setTo] = useState(data.accounts.find((a) => a.id !== from)?.id ?? '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [plan, setPlan] = useState<{ key: string; plan: PlanDryRun | null; error?: string } | null>(
    null,
  );
  const pick = (t: Template) => {
    setPicked(t.id);
    setName(t.name);
    setAmount(t.amount);
    setDate(t.months ? occurrence(data.today, 31, t.months) : '');
  };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setTried(false);
      setFailure('');
      if (template) pick(template);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const cents = centsFromEuros(amount);
  const dayNumber = Number(dayOfMonth);
  const errors = {
    name: name.trim() ? '' : 'Give the goal a name.',
    amount: cents && cents > 0 ? '' : 'Enter an amount in euros, for example 1200.',
    date: date > data.today ? '' : 'Choose a date after today.',
    // GL1 takes 1–31: the 31st falls on the last day of a shorter month.
    day:
      Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 31 ? '' : 'A day from 1 to 31.',
    to: from !== to ? '' : 'Choose another account of yours.',
  };
  // The plan is the server's dry run of what is typed, asked once the typing rests.
  const key = !errors.amount && !errors.date && !errors.day ? `${cents}|${date}|${dayNumber}` : '';
  useEffect(() => {
    if (!open || !key) return;
    let live = true;
    const timer = setTimeout(
      () =>
        actions
          .plan({ targetCents: cents!, targetDate: date, day: dayNumber })
          .then((p) => live && setPlan({ key, plan: p }))
          .catch((e) => live && setPlan({ key, plan: null, error: (e as Error).message })),
      350,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, open]);
  const shown = plan?.key === key ? plan : null;
  const error = (field: keyof typeof errors) =>
    tried && errors[field] ? (
      <span className="field-error" role="alert">
        {errors[field]}
      </span>
    ) : null;
  const invalid = (field: keyof typeof errors) => (tried && !!errors[field]) || undefined;
  async function submit() {
    setTried(true);
    if (Object.values(errors).some(Boolean) || busy) return;
    setBusy(true);
    setFailure('');
    try {
      onCreated(
        await actions.create({
          name: name.trim(),
          targetCents: cents!,
          targetDate: date,
          fromAccountId: from,
          toAccountId: to,
          day: dayNumber,
        }),
      );
      setPicked('');
      setName('');
      setAmount('');
      setDate('');
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="account-drawer goal-drawer"
      aria-labelledby="goal-drawer-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="drawer-head">
        <h2 id="goal-drawer-title">New goal</h2>
        <button
          type="button"
          className="icon-button close"
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <form
        className="goal-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Templates picked={picked} onPick={pick} />
        <label className="goal-field">
          <span>Name</span>
          <input
            value={name}
            maxLength={60}
            aria-invalid={invalid('name')}
            onChange={(e) => setName(e.target.value)}
          />
          {error('name')}
        </label>
        <div className="goal-field-row three">
          <label className="goal-field">
            <span>Target amount</span>
            <span className="goal-money">
              <i aria-hidden="true">€</i>
              <input
                inputMode="decimal"
                value={amount}
                aria-invalid={invalid('amount')}
                onChange={(e) => setAmount(e.target.value)}
              />
            </span>
            {error('amount')}
          </label>
          <label className="goal-field">
            <span>By date</span>
            <input
              type="date"
              min={data.today}
              value={date}
              aria-invalid={invalid('date')}
              onChange={(e) => setDate(e.target.value)}
            />
            {error('date')}
          </label>
          <label className="goal-field day">
            <span>Day of month</span>
            <input
              inputMode="numeric"
              value={dayOfMonth}
              aria-invalid={invalid('day')}
              onChange={(e) => setDayOfMonth(e.target.value)}
            />
            {error('day')}
          </label>
        </div>
        <div className="goal-field-row">
          <label className="goal-field">
            <span>From</span>
            <span className="select-wrap">
              <select
                value={from}
                onChange={(e) => {
                  // The other end is never the same account (the server: 400 "Choose two of
                  // your own accounts.").
                  setFrom(e.target.value);
                  if (e.target.value === to)
                    setTo(data.accounts.find((a) => a.id !== e.target.value)?.id ?? '');
                }}
              >
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={16} />
            </span>
          </label>
          <label className="goal-field">
            <span>To</span>
            <span className="select-wrap">
              <select
                value={to}
                aria-invalid={invalid('to')}
                onChange={(e) => setTo(e.target.value)}
              >
                {data.accounts
                  .filter((a) => a.id !== from)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
              </select>
              <Icon name="chevron" size={16} />
            </span>
            {error('to')}
          </label>
        </div>
        <PlanPreview
          plan={shown?.plan}
          targetCents={cents ?? 0}
          targetDate={date}
          today={data.today}
          room={data.room}
          empty={
            shown?.error ??
            (key ? 'Working out the plan…' : 'Enter an amount and a date to see the monthly plan.')
          }
        />
        <p className="goal-form-note">
          Creating the goal prepares one monthly transfer. You confirm each payment in Transfers;
          nothing is sent on its own.
        </p>
        {failure && (
          <p className="plan-refused" role="alert">
            {failure}
          </p>
        )}
        <div className="goal-form-actions">
          <button type="button" className="secondary-button" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            data-testid="goal-create"
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create goal'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function GoalsSection({
  data,
  fresh,
  note,
  onOpen,
  onCreate,
  onOpenPrepared,
  onResume,
}: {
  data: GoalsResponse;
  // The goal created in this visit, highlighted once.
  fresh: string;
  // The line after a create or a delete.
  note: React.ReactNode;
  onOpen(id: string): void;
  onCreate(t?: Template): void;
  onOpenPrepared(id: string): void;
  onResume(id: string): void;
}) {
  const next = data.goals
    .filter((g) => g.prepared?.nextDue)
    .sort((a, b) => a.prepared!.nextDue!.localeCompare(b.prepared!.nextDue!))[0];
  const behind = data.goals.filter((g) => g.state === 'behind').length;
  return (
    <section className="goals-section" id="goals-section" aria-labelledby="goals-title">
      <div className="goals-head">
        <div>
          <h2 id="goals-title">Goals</h2>
          <p>Save for something, with a plan you confirm each month.</p>
        </div>
        {data.canSave && data.goals.length > 0 && (
          <button
            type="button"
            className="primary-button"
            data-testid="goal-new"
            onClick={() => onCreate()}
          >
            <Glyph name="plus" size={15} /> New goal
          </button>
        )}
      </div>
      {note}
      {!data.canSave ? (
        <div className="card goals-single" data-testid="goals-cannot-save">
          <span className="goal-tile large" aria-hidden="true">
            <Icon name="target" size={22} />
          </span>
          <div>
            <h3>Savings goals</h3>
            <p>{data.canSaveReason}</p>
          </div>
        </div>
      ) : data.goals.length === 0 ? (
        <div className="card goals-empty" data-testid="goals-empty">
          <div className="goals-empty-text">
            <h3>Give your savings a destination</h3>
            <p>
              Name it, set an amount and a date, and get a monthly plan. Each transfer waits for
              your confirmation.
            </p>
            {data.room && (
              <p className="goals-room">
                {roomWords(data.room) ?? (
                  <>
                    Over your last {data.room.months} full{' '}
                    {data.room.months === 1 ? 'month' : 'months'} you had about{' '}
                    <strong>{eurShort(data.room.monthlyCents)}</strong> left each month.
                  </>
                )}
              </p>
            )}
            <Templates onPick={onCreate} />
            <button
              type="button"
              className="primary-button"
              data-testid="goal-new"
              onClick={() => onCreate()}
            >
              <Glyph name="plus" size={15} /> New goal
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="card plan-stats goals-summary">
            <div>
              <dt>Goals</dt>
              <dd>
                {data.goals.length}
                <small> · {behind} behind plan</small>
              </dd>
            </div>
            {next && (
              <div>
                <dt>Next to confirm</dt>
                <dd>
                  {eur(next.prepared!.amountCents)}
                  <small>
                    {' '}
                    on {dayYear(next.prepared!.nextDue!, data.today)} · <bdi>{next.name}</bdi>
                  </small>
                </dd>
              </div>
            )}
            {data.room && (
              <div>
                <dt>Usually left each month</dt>
                <dd>
                  {data.room.monthlyCents > 0 ? eurShort(data.room.monthlyCents) : 'Nothing'}
                  <small>
                    {' '}
                    · last {data.room.months} full {data.room.months === 1 ? 'month' : 'months'}
                  </small>
                </dd>
              </div>
            )}
          </dl>
          <div className="goal-grid">
            {data.goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                today={data.today}
                fresh={g.id === fresh}
                onOpen={() => onOpen(g.id)}
                onOpenPrepared={onOpenPrepared}
                onResume={onResume}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
export { STATES };
