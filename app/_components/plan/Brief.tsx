// UI1 (plan 28 §4.5, §6.1, D7): the brief (the server's headline over what the rules found) and
// the compact Plan card of the Overview. Both print server text; neither works out a figure.
import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Glyph, GoalTrack, Pill, reducedMotion } from './charts';
import { dayOf, eurShort, frameOf, goalIcon, topGoal, verdictAccount } from './logic';
import type { Brief, GoalsResponse, MonthForecast } from './types';

type Finding = Brief['findings'][number];
const LINK = {
  forecast_shortfall: { icon: 'alert', to: 'Month ahead' },
  goal_behind: { icon: 'target', to: 'Open goal' },
  category_up: { icon: 'trend', to: 'Spending' },
};

// The headline types in once (presentation only); with "reduce motion" it is there at once.
export function PlanBrief({ brief, onGo }: { brief: Brief; onGo(f: Finding): void }) {
  const { headline, findings } = brief;
  const total = headline.length + findings.length * 12 + 1;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return setTick(total);
    const timer = setInterval(() => setTick((v) => v + 1), 30);
    const stop = setTimeout(() => clearInterval(timer), (total + 2) * 30);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [total]);
  return (
    <section className="card brief" aria-label="This month in brief" data-testid="plan-brief">
      <span className="brief-mark" aria-hidden="true">
        <Icon name="target" size={18} />
      </span>
      <div className="brief-body">
        <h2 aria-label={headline}>
          <span aria-hidden="true">{headline.slice(0, tick)}</span>
          {tick < headline.length && <i className="brief-caret" aria-hidden="true" />}
          <span className="brief-rest" aria-hidden="true">
            {headline.slice(tick)}
          </span>
        </h2>
        {findings.length > 0 && (
          <ul className="brief-findings">
            {findings.map((f, i) => (
              <li key={i} data-kind={f.kind} data-on={tick > headline.length + i * 12 || undefined}>
                <span className="brief-icon warn" aria-hidden="true">
                  <Glyph name={LINK[f.kind].icon} size={16} />
                </span>
                <span className="brief-text">{f.text}</span>
                <button type="button" className="plan-link" onClick={() => onGo(f)}>
                  {LINK[f.kind].to} →
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// The compact card of the Overview: the verdict of the first short account (else the first), its
// headline with its explanation, the month as a small line drawn from the forecast's own events;
// and the goal that needs attention first.
// On the Overview the brief has no card of its own: with one finding or more, its headline is
// this card's lead line and its findings are compact rows above the two cells (the server's
// texts, each with its link). With no finding nothing of the brief shows here; the Plan tab
// keeps the whole block.
export function PlanCard({
  forecast,
  goals,
  onOpen,
  brief,
  onGo,
}: {
  forecast: MonthForecast | null | undefined;
  goals: GoalsResponse | null | undefined;
  onOpen(): void;
  brief?: Brief | null;
  onGo?(f: Finding): void;
}) {
  const account = forecast?.accounts.length ? verdictAccount(forecast) : null;
  const goal = goals?.goals.length ? topGoal(goals.goals) : null;
  const findings = brief?.findings ?? [];
  if (!account && !goals && !findings.length) return null;
  const W = 132,
    H = 44;
  let spark: React.ReactNode = null;
  if (account && forecast) {
    const frame = frameOf(account, forecast.today);
    const d0 = dayOf(forecast.today),
      d1 = Math.max(dayOf(forecast.until), d0 + 1);
    const values = [account.balanceCents, 0, ...frame.events.map((e) => e.balanceAfterCents)];
    const lo = Math.min(...values),
      hi = Math.max(...values, 1);
    const x = (d: number) => 2 + ((d - d0) / (d1 - d0)) * (W - 4);
    const y = (c: number) => H - 6 - ((c - lo) / (hi - lo)) * (H - 12);
    const low = frame.events.find((e) => e.balanceAfterCents === frame.lowest.balanceCents);
    spark = (
      <svg className="plan-spark" width={W} height={H} aria-hidden="true">
        <line x1={2} x2={W - 2} y1={y(0)} y2={y(0)} />
        <path
          d={`M${x(d0)},${y(account.balanceCents)}${frame.events.map((e) => `H${x(dayOf(e.date))}V${y(e.balanceAfterCents)}`).join('')}H${x(d1)}`}
        />
        {low && <circle cx={x(dayOf(low.date))} cy={y(low.balanceAfterCents)} r={3.5} />}
      </svg>
    );
  }
  const count = goals?.goals.length ?? 0;
  return (
    <section className="card plan-mini" aria-labelledby="plan-mini-title" data-testid="plan-card">
      <div className="plan-mini-head">
        <Icon name="target" size={16} />
        <h2 id="plan-mini-title">Plan</h2>
        <button type="button" className="plan-link" onClick={onOpen}>
          {account && count > 0
            ? `Month ahead and ${count} ${count === 1 ? 'goal' : 'goals'} →`
            : 'Open plan →'}
        </button>
      </div>
      {findings.length > 0 && (
        <div className="plan-mini-brief">
          <p className="plan-mini-lead">{brief!.headline}</p>
          <ul>
            {findings.map((f, i) => (
              <li key={i} data-kind={f.kind}>
                <span className="brief-icon warn" aria-hidden="true">
                  <Glyph name={LINK[f.kind].icon} size={14} />
                </span>
                <span className="brief-text">{f.text}</span>
                {onGo && (
                  <button type="button" className="plan-link" onClick={() => onGo(f)}>
                    {LINK[f.kind].to} →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="plan-mini-grid">
        {account && (
          <div className={`plan-mini-cell verdict ${account.shortfall ? 'short' : 'covered'}`}>
            <span className="verdict-icon" aria-hidden="true">
              <Glyph name={account.shortfall ? 'alert' : 'check'} size={18} />
            </span>
            <p>
              <strong>
                {forecast!.accounts.length > 1 && `${account.label}: `}
                {account.headline}
              </strong>
              <small>{account.explanation}</small>
            </p>
            {spark}
          </div>
        )}
        {goal ? (
          <div className="plan-mini-cell goal" data-icon={goalIcon(goal.name)}>
            <span className="goal-tile" aria-hidden="true">
              <Glyph name={goalIcon(goal.name)} size={18} />
            </span>
            <div>
              <p>
                <strong>
                  <bdi>{goal.name}</bdi>
                </strong>
                <Pill state={goal.state} />
              </p>
              <small>
                {eurShort(goal.savedCents)} of {eurShort(goal.targetCents)} · {goal.headline}
              </small>
              <GoalTrack goal={goal} small />
            </div>
          </div>
        ) : (
          goals && (
            <div className="plan-mini-cell invite">
              <span className="goal-tile" aria-hidden="true">
                <Icon name="target" size={18} />
              </span>
              <p>
                <strong>{goals.canSave ? 'No goal yet' : 'Savings goals'}</strong>
                <small>
                  {goals.canSave
                    ? 'A goal is a name, an amount and a date, with a monthly plan you confirm.'
                    : goals.canSaveReason}
                </small>
              </p>
            </div>
          )
        )}
      </div>
    </section>
  );
}
