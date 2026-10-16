// UI1 (plan 28): the drawn pieces of the Plan tab. One chart family, hand-drawn SVG at real
// pixels: the balance of the month as a step line, a goal's path, the progress track. Motion is
// an enhancement: with "reduce motion" every value is final at once.
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../Icon';
import {
  balanceScale,
  day,
  dayOf,
  eventLabels,
  eur,
  eurShort,
  monthIndex,
  monthName,
  plannedSoFar,
  shortLabel,
  signed,
  sourceWords,
  STATES,
  timelineLayout,
  type Frame,
} from './logic';
import type { ForecastAccount, GoalState, GoalView, MonthForecast, Timeline } from './types';

// Glyphs in the stroke style of Icon.tsx, for this view only.
const GLYPHS: Record<string, React.ReactNode> = {
  plane: <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5Z" />,
  shield: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6ZM9 12l2 2 4-4" />,
  bike: (
    <>
      <circle cx="6" cy="16" r="3.5" />
      <circle cx="18" cy="16" r="3.5" />
      <path d="m6 16 4-8h5l3 8M10 8l4 8M9 5h3" />
    </>
  ),
  sofa: (
    <path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3ZM6 18v2M18 18v2" />
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="10" rx="2" />
      <path d="M2 19h20" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  pause: <path d="M9 5v14M15 5v14" />,
  back: <path d="m11 6-6 6 6 6M5 12h14" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  ),
  missed: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  trend: <path d="m3 17 6-6 4 4 8-8M15 7h6v6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  route: <path d="M5 12h14m-5-5 5 5-5 5" />,
};
export function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  if (!GLYPHS[name]) return <Icon name={name} size={size} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}
// The state in words with an icon: never by colour alone.
export function Pill({ state }: { state: GoalState }) {
  const s = STATES[state];
  return (
    <span className={`plan-pill ${s.tone}`}>
      <Glyph name={s.icon} size={12} />
      {s.label}
    </span>
  );
}

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// A number that moves to `target` in `ms` whenever the target changes.
export function useTween(target: number, ms: number, initial = target) {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    if (reducedMotion()) {
      current.current = target;
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      current.current = from + (target - from) * ease(t);
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}
// True once the element has been on screen: a chart draws itself when it is seen, not before.
export function useSeen(ref: React.RefObject<Element | null>, threshold = 0.1) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setSeen(true);
        observer.disconnect();
      },
      { threshold },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return seen;
}
// An amount that counts up into place (whole euros while it moves: no jitter of the cents).
export function Count({ cents }: { cents: number }) {
  const value = useTween(cents, 800, 0);
  return <>{eurShort(value === cents ? cents : Math.round(value / 100) * 100)}</>;
}
export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// The progress track: the bar is the target, with a dot at each quarter; the "Today" pin is where
// the plan says the goal should be, so the lime stretch between fill and pin is what is behind.
export function Track({
  savedCents,
  targetCents,
  plannedCents,
  nextCents,
  small,
}: {
  savedCents: number;
  targetCents: number;
  plannedCents: number | null;
  // The next prepared contribution, drawn as a pale stretch after what is saved.
  nextCents?: number;
  small?: boolean;
}) {
  const pct = (c: number) => Math.min(100, (c / targetCents) * 100);
  const saved = pct(savedCents);
  const plan = plannedCents === null ? null : pct(plannedCents);
  return (
    <div
      className={`goal-track${small ? ' small' : ''}${plan === null ? ' no-pin' : ''}`}
      role="img"
      aria-label={`${eur(savedCents)} of ${eur(targetCents)} saved${plannedCents === null ? '' : `; the plan to today is ${eur(plannedCents)}`}`}
    >
      <div className="goal-track-bar">
        {plan !== null && plan > saved && (
          <i className="goal-track-gap" style={{ left: `${saved}%`, width: `${plan - saved}%` }} />
        )}
        {!!nextCents && (
          <i
            className="goal-track-next"
            style={{ left: `${saved}%`, width: `${Math.min(100 - saved, pct(nextCents))}%` }}
          />
        )}
        <i className="goal-track-fill" style={{ width: `${saved}%` }} />
        {!small &&
          [25, 50, 75].map((q) => (
            <i
              className="goal-track-dot"
              key={q}
              data-on={q < saved || undefined}
              style={{ left: `${q}%` }}
            />
          ))}
      </div>
      {plan !== null && (
        <span
          className="plan-today"
          data-edge={plan > 86 ? 'end' : plan < 8 ? 'start' : undefined}
          style={{ left: `${plan}%` }}
        >
          <b>Today</b>
        </span>
      )}
    </div>
  );
}
export function GoalTrack({
  goal,
  small,
  fresh,
}: {
  goal: GoalView;
  small?: boolean;
  fresh?: boolean;
}) {
  const pinned =
    goal.state === 'behind' || goal.state === 'on_track' || goal.state === 'date_passed';
  return (
    <Track
      savedCents={goal.savedCents}
      targetCents={goal.targetCents}
      plannedCents={pinned && goal.history.length && !fresh ? plannedSoFar(goal) : null}
      nextCents={fresh ? goal.prepared?.amountCents : undefined}
      small={small}
    />
  );
}

function TodayMark({ x, y, bottom }: { x: number; y?: number; bottom: number }) {
  return (
    <g className="chart-today" aria-hidden="true">
      <line x1={x} x2={x} y1={20} y2={bottom} />
      <text x={x} y={13} textAnchor="middle">
        Today
      </text>
      {y !== undefined && <circle cx={x} cy={y} r={5} />}
    </g>
  );
}
// The line draws itself from the left: everything inside this group is clipped to `intro`.
function Reveal({
  id,
  intro,
  left,
  right,
  height,
}: {
  id: string;
  intro: number;
  left: number;
  right: number;
  height: number;
}) {
  return (
    <clipPath id={id}>
      <rect
        x={0}
        y={-30}
        width={intro >= 1 ? right + 200 : left + intro * (right - left) + 3}
        height={height + 60}
      />
    </clipPath>
  );
}
type Tip = { x: number; y: number; title: string; lines: string[] };
function ChartTip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  return (
    <div
      className="chart-tip"
      style={{ left: Math.max(100, Math.min(width - 100, tip.x)), top: tip.y }}
      aria-hidden="true"
    >
      <strong>{tip.title}</strong>
      {tip.lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}
const niceStep = (range: number) =>
  [5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1000000, 2000000].find(
    (s) => range / s <= 4,
  ) ?? 5000000;

// ── The goal's path: saved (solid), the plan (dashed), from the next payment at this pace
// (dotted). `pace` replaces the monthly amount of the projection (the what-if); `minPace` fixes
// the months of the axis so the chart does not rescale while the slider moves. ──
export function PathChart({
  goal,
  today,
  pace,
  minPace,
}: {
  goal: GoalView;
  today: string;
  pace?: number;
  minPace?: number;
}) {
  const [ref, width] = useWidth();
  const seen = useSeen(ref);
  const intro = useTween(seen && width > 0 ? 1 : 0, 900, 0);
  const [tip, setTip] = useState<number | null>(null);
  const clip = useId();
  const now = monthIndex(today);
  const nextAt = goal.prepared?.nextDue ? monthIndex(goal.prepared.nextDue) : now + 1;
  const first = goal.history[0] ? monthIndex(goal.history[0].month) : Math.min(now, nextAt);
  const targetAt = monthIndex(goal.targetDate);
  const lastHistory = first + goal.history.length - 1;
  // Cumulative figures by month, from the month before the first payment (zero).
  const saved: number[] = [];
  goal.history.reduce((sum, h, i) => (saved[i] = sum + h.savedCents), 0);
  const plannedPast: number[] = [];
  goal.history.reduce((sum, h, i) => (plannedPast[i] = sum + h.plannedCents), 0);
  const project = (monthly: number) => {
    let cents = goal.savedCents;
    const points = [{ at: Math.max(first - 1, Math.min(now, nextAt - 1)), cents }];
    for (let at = nextAt; cents < goal.targetCents && points.length < 240; at++)
      points.push({ at, cents: (cents = Math.min(goal.targetCents, cents + monthly)) });
    return points;
  };
  const monthly = pace ?? (goal.prepared ? goal.monthlyCents : null);
  const open = goal.state !== 'reached';
  const projection = open && monthly ? project(monthly) : [];
  const last = Math.max(
    targetAt,
    lastHistory,
    projection.at(-1)?.at ?? 0,
    open && minPace ? project(minPace).at(-1)!.at : 0,
  );
  const count = Math.max(2, last - first + 1);
  const H = width < 400 ? 250 : 300;
  const m = { l: 56, r: 20, t: 40, b: 30 };
  const x = (at: number) => m.l + ((at - first + 1) / count) * (width - m.l - m.r);
  const yMax = goal.targetCents * (goal.state === 'reached' ? 1.14 : 1.25);
  const y = (cents: number) => H - m.b - (cents / yMax) * (H - m.t - m.b);
  const line = (pts: [number, number][]) => pts.map(([px, py]) => `${px},${py}`).join(' ');
  const savedPts: [number, number][] = [
    [x(first - 1), y(0)],
    ...saved.map((c, i) => [x(first + i), y(c)] as [number, number]),
  ];
  // The plan: what fell due each month so far (the server's figures).
  const planPts: [number, number][] = [
    [x(first - 1), y(0)],
    ...plannedPast.map(
      (c, i) => [x(first + i), y(Math.min(goal.targetCents, c))] as [number, number],
    ),
  ];
  const every = Math.ceil((count * 58) / Math.max(1, width - m.l - m.r));
  const reachedAt = goal.reachedAt ? monthIndex(goal.reachedAt) : null;
  const end = projection.at(-1);
  const text = (i: number) => {
    const at = first + i;
    const h = goal.history[i];
    const p = projection.find((q) => q.at === at);
    return {
      title: monthName(at, Math.floor(at / 12) !== Math.floor(now / 12)),
      lines: h
        ? [
            `planned ${eur(h.plannedCents)} · saved ${eur(h.savedCents)}`,
            `${eur(saved[i])} in total`,
          ]
        : p
          ? [`at this pace ${eur(p.cents)}`]
          : ['nothing planned'],
    };
  };
  const col = width > 0 ? x(first + 1) - x(first) : 0;
  return (
    <div className="plan-chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Path of ${goal.name}: saved, plan and pace by month. The table after the chart has the figures.`}
        >
          <defs>
            <Reveal id={clip} intro={intro} left={m.l} right={width - m.r} height={H} />
          </defs>
          {[0, 1, 2].map((i) => {
            const v = (goal.targetCents / 3) * i;
            return (
              <g key={i} className="chart-grid">
                <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
                <text x={m.l - 10} y={y(v) + 4} textAnchor="end">
                  {eurShort(Math.round(v / 100) * 100)}
                </text>
              </g>
            );
          })}
          {/* The target: the lime line with its flag. */}
          <g className="chart-target">
            <line x1={m.l} x2={width - m.r} y1={y(goal.targetCents)} y2={y(goal.targetCents)} />
            <rect
              x={m.l}
              y={y(goal.targetCents) - 22}
              width={eurShort(goal.targetCents).length * 7 + 60}
              height={20}
              rx={6}
            />
            <text x={m.l + 9} y={y(goal.targetCents) - 8}>
              Target {eurShort(goal.targetCents)}
            </text>
          </g>
          {open && (
            <g className="chart-date" aria-hidden="true">
              <line x1={x(targetAt)} x2={x(targetAt)} y1={y(goal.targetCents)} y2={H - m.b} />
              <text x={x(targetAt) - 6} y={H - m.b - 8} textAnchor="end">
                your date
              </text>
            </g>
          )}
          <g clipPath={`url(#${clip})`}>
            <polygon
              className="chart-area"
              points={line([...savedPts, [savedPts.at(-1)![0], y(0)]])}
            />
            <polyline className="chart-plan" points={line(planPts)} />
            {end && projection.length > 1 && (
              <>
                <polyline
                  className="chart-pace"
                  points={line(projection.map((p) => [x(p.at), y(p.cents)]))}
                />
                <circle className="chart-pace-end" cx={x(end.at)} cy={y(end.cents)} r={5} />
              </>
            )}
            <polyline className="chart-saved" points={line(savedPts)} />
            {saved.map((c, i) => (
              <circle className="chart-dot" key={i} cx={x(first + i)} cy={y(c)} r={3.5} />
            ))}
            {reachedAt !== null && (
              <circle className="chart-reached" cx={x(reachedAt)} cy={y(goal.targetCents)} r={7} />
            )}
          </g>
          {open && <TodayMark x={x(now)} bottom={H - m.b} />}
          {Array.from({ length: count }, (_, i) => (
            <text
              key={i}
              className="chart-x"
              x={x(first + i)}
              y={H - 8}
              textAnchor={i === count - 1 ? 'end' : 'middle'}
              // The neighbour of the last label gives way: the last one carries the year.
              visibility={
                (count - 1 - i) % every === 0 && count - 1 - i !== every ? 'visible' : 'hidden'
              }
            >
              {monthName(first + i, i === count - 1 || (first + i) % 12 === 0)}
            </text>
          ))}
          {Array.from({ length: count }, (_, i) => {
            const t = text(i);
            return (
              <rect
                key={i}
                className="chart-hit"
                x={x(first + i) - col / 2}
                y={m.t - 10}
                width={col}
                height={H - m.t - m.b + 10}
                tabIndex={0}
                aria-label={`${t.title} · ${t.lines.join(' · ')}`}
                data-on={tip === i || undefined}
                onMouseEnter={() => setTip(i)}
                onMouseLeave={() => setTip(null)}
                onFocus={() => setTip(i)}
                onBlur={() => setTip(null)}
              />
            );
          })}
        </svg>
      )}
      <ChartTip
        width={width}
        tip={
          tip === null
            ? null
            : {
                x: x(first + tip),
                y: y(Math.max(saved[tip] ?? 0, plannedPast[tip] ?? 0)) - 10,
                ...text(tip),
              }
        }
      />
      <div className="sr-only">
        <table>
          <caption>{goal.name}: planned and saved by month</caption>
          <thead>
            <tr>
              <th>Month</th>
              <th>Planned</th>
              <th>Saved</th>
              <th>Saved in total</th>
            </tr>
          </thead>
          <tbody>
            {goal.history.map((h, i) => (
              <tr key={h.month}>
                <td>{monthName(first + i, true)}</td>
                <td>{eur(h.plannedCents)}</td>
                <td>{eur(h.savedCents)}</td>
                <td>{eur(saved[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Month ahead: the projected balance of one account, day by day, as a step line. Every point
// comes from `frame`: the server's events, or the same sum with a cover option added. ──
export function BalanceChart({
  boxRef,
  width,
  account,
  forecast,
  frame,
  ghost,
  intro,
  domain,
}: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  width: number;
  account: ForecastAccount;
  forecast: MonthForecast;
  frame: Frame;
  ghost: Frame | null;
  intro: number;
  domain: [number, number];
}) {
  const [tip, setTip] = useState<number | null>(null);
  const clip = useId();
  const scale = balanceScale(width, forecast.today, forecast.until, domain);
  const { d0, d1, wide, H, m, range, yMin, yMax, x, y } = scale;
  const step = niceStep(range);
  const ticks = [];
  for (let v = Math.ceil(yMin / step) * step; v < yMax; v += step)
    if (v !== 0 && Math.abs(y(v) - y(0)) > 14) ticks.push(v);
  const build = (f: Frame) => {
    // What comes after an estimated event is itself an estimate (dashed).
    const segments: { d: string; estimated: boolean }[] = [];
    let d = `M${x(d0)},${y(account.balanceCents)}`;
    let px = x(d0),
      py = y(account.balanceCents),
      estimated = false;
    for (const e of f.events) {
      const ex = x(dayOf(e.date)),
        ey = y(e.balanceAfterCents);
      segments.push({ d: `M${px},${py}H${ex}`, estimated });
      estimated ||= e.certainty === 'estimated';
      segments.push({ d: `M${ex},${py}V${ey}`, estimated });
      d += `H${ex}V${ey}`;
      px = ex;
      py = ey;
    }
    segments.push({ d: `M${px},${py}H${x(d1)}`, estimated });
    return { segments, line: `${d}H${x(d1)}`, area: `${d}H${x(d1)}V${y(0)}H${x(d0)}Z` };
  };
  const main = build(frame);
  const low = frame.lowest;
  const label = (i: number) => {
    const e = frame.events[i];
    return {
      title: `${day(e.date)} · ${e.label}`,
      lines: [
        sourceWords(e),
        `${signed(e.amountCents)} · balance after ${eur(e.balanceAfterCents)}`,
      ],
    };
  };
  // A day number too near the dated label of either end would be drawn over it (a phone, "7 Oct10").
  const marks = [...new Set([d0, 10, 15, 20, 25, d1])].filter(
    (d) => d >= d0 && d <= d1 && (d === d0 || x(d) - x(d0) > 52) && (d === d1 || x(d1) - x(d) > 52),
  );
  const dateOf = (d: number) => `${forecast.today.slice(0, 8)}${String(d).padStart(2, '0')}`;
  // The few words beside the key events; one with no free place is left to the tooltip and the list.
  const labels = eventLabels(frame, account.balanceCents, scale, width);
  return (
    <div className="plan-chart" ref={boxRef} style={{ height: H }}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Projected balance of ${account.label} from ${day(forecast.today)} to ${day(forecast.until)}. The list "Coming up this month" has the figures.`}
        >
          <defs>
            <Reveal id={clip} intro={intro} left={m.l} right={width - m.r} height={H} />
            <clipPath id={`${clip}a`}>
              <rect x={0} y={-30} width={width} height={y(0) + 30} />
            </clipPath>
            <clipPath id={`${clip}b`}>
              <rect x={0} y={y(0)} width={width} height={H} />
            </clipPath>
          </defs>
          {ticks.map((v) => (
            <g key={v} className="chart-grid">
              <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
              <text x={m.l - 10} y={y(v) + 4} textAnchor="end">
                {eurShort(v)}
              </text>
            </g>
          ))}
          <g className="chart-zero">
            <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} />
            <text x={m.l - 10} y={y(0) + 4} textAnchor="end">
              €0
            </text>
          </g>
          {Array.from({ length: d1 - d0 + 1 }, (_, i) => (
            <line
              key={i}
              className="chart-tick"
              x1={x(d0 + i)}
              x2={x(d0 + i)}
              y1={H - m.b}
              y2={H - m.b + 4}
            />
          ))}
          {marks.map((d) => (
            <text
              key={d}
              className="chart-x"
              x={x(d)}
              y={H - 8}
              textAnchor={d === d1 ? 'end' : d === d0 ? 'start' : 'middle'}
            >
              {d === d0 || d === d1 ? day(dateOf(d)) : d}
            </text>
          ))}
          <g clipPath={`url(#${clip})`}>
            <path className="chart-area" d={main.area} clipPath={`url(#${clip}a)`} />
            <path className="chart-area below" d={main.area} clipPath={`url(#${clip}b)`} />
            {ghost && (
              <g className="chart-ghost" aria-hidden="true">
                <path d={build(ghost).line} />
                {ghost.events.map(
                  (e, i) =>
                    e.added && (
                      <circle key={i} cx={x(dayOf(e.date))} cy={y(e.balanceAfterCents)} r={5} />
                    ),
                )}
                <text
                  x={width - m.r}
                  y={Math.min(y(ghost.endCents), y(frame.endCents)) - 10}
                  textAnchor="end"
                >
                  with this change
                </text>
              </g>
            )}
            {main.segments.map((s, i) => (
              <path key={i} className={`chart-saved${s.estimated ? ' estimated' : ''}`} d={s.d} />
            ))}
            {frame.events.map((e, i) => (
              <g key={i}>
                {labels[i] && (
                  <text
                    className="chart-event"
                    x={labels[i].x}
                    y={labels[i].y}
                    textAnchor={labels[i].anchor}
                  >
                    <tspan>{shortLabel(e.label)}</tspan>
                    {wide && ` ${signed(e.amountCents)}`}
                  </text>
                )}
                <circle
                  className={`chart-dot ${e.certainty}${e.balanceAfterCents < 0 ? ' short' : ''}${e.added ? ' added' : ''}`}
                  cx={x(dayOf(e.date))}
                  cy={y(e.balanceAfterCents)}
                  r={5}
                />
              </g>
            ))}
          </g>
          <TodayMark x={x(d0)} y={y(account.balanceCents)} bottom={H - m.b} />
          {low.balanceCents < 0 && intro >= 1 && (
            <g
              className="chart-short"
              aria-hidden="true"
              transform={`translate(${Math.max(m.l + 60, Math.min(width - m.r - 60, x(dayOf(low.date))))} ${y(low.balanceCents) + 12})`}
            >
              <g>
                <rect x={-60} y={0} width={120} height={22} rx={7} />
                <text x={0} y={15} textAnchor="middle">
                  {eur(-low.balanceCents)} short
                </text>
              </g>
            </g>
          )}
          {frame.events.map((e, i) => {
            const l = label(i);
            return (
              <circle
                key={i}
                className="chart-hit"
                cx={x(dayOf(e.date))}
                cy={y(e.balanceAfterCents)}
                r={16}
                tabIndex={0}
                aria-label={`${l.title} · ${l.lines.join(' · ')}`}
                data-on={tip === i || undefined}
                onMouseEnter={() => setTip(i)}
                onMouseLeave={() => setTip(null)}
                onFocus={() => setTip(i)}
                onBlur={() => setTip(null)}
              />
            );
          })}
        </svg>
      )}
      <ChartTip
        width={width}
        tip={
          tip === null || !frame.events[tip]
            ? null
            : {
                x: x(dayOf(frame.events[tip].date)),
                y: y(frame.events[tip].balanceAfterCents) - 14,
                ...label(tip),
              }
        }
      />
    </div>
  );
}

// TL2: the balance timeline. The real balance up to Today (solid), the projection after it
// (dashed), the zero line, the future below zero shaded, a dot per event with its tooltip on
// hover and tap. TL2b: the dots are not tab stops; keyboard and screen readers get the same
// events as one list under the chart. No motion: it reads the same under prefers-reduced-motion.
export function TimelineChart({
  width,
  timeline,
  label,
  change,
}: {
  width: number;
  timeline: Timeline;
  label: string;
  // A previewed amount from its day on (a cover option, an expected item), drawn as a ghost.
  change: { date: string; amountCents: number } | null;
}) {
  const [tip, setTip] = useState<number | null>(null);
  const clip = useId();
  const l = timelineLayout(timeline, Math.max(width, 1), change);
  const narrow = width < 520;
  const words = (i: number) => {
    const e = l.dots[i].event;
    return { title: `${day(e.date)} · ${e.label}`, lines: [signed(e.amountCents)] };
  };
  const low = timeline.shortfall;
  return (
    <div className="plan-chart timeline-chart" style={{ height: l.H }}>
      {width > 0 && (
        <svg
          width={width}
          height={l.H}
          role="img"
          aria-label={`Balance of ${label} from ${day(timeline.from)} to ${day(timeline.to)}: the real balance up to today, then the projection.${l.dots.length ? ' Its events are listed under the chart.' : ''}`}
          // TL2b: a tap keeps its tooltip; the mouse events a browser emulates after a tap
          // must not close it, so only a real mouse leaving does.
          onPointerLeave={(e) => e.pointerType === 'mouse' && setTip(null)}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={0} y={l.zeroY} width={width} height={l.H} />
            </clipPath>
          </defs>
          {l.elapsed && (
            <rect
              className="timeline-elapsed"
              data-testid="timeline-elapsed"
              x={l.elapsed.x1}
              y={20}
              width={Math.max(0, l.elapsed.x2 - l.elapsed.x1)}
              height={l.H - l.m.b - 20}
            />
          )}
          {l.monthBands.map((b) => (
            <g key={b.x1} className="timeline-month" data-testid="timeline-month">
              {b.boundary && <line x1={b.x1} x2={b.x1} y1={20} y2={l.H - l.m.b} />}
              {b.x2 - b.x1 >= 26 && (
                <text x={(b.x1 + b.x2) / 2} y={l.H - 8} textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          ))}
          {l.yTicks.map((t) => (
            <g key={t.y} className="chart-grid">
              <line x1={l.m.l} x2={width - l.m.r} y1={t.y} y2={t.y} />
              <text x={l.m.l - 10} y={t.y + 4} textAnchor="end">
                {t.label}
              </text>
            </g>
          ))}
          <g className="chart-zero" data-testid="timeline-zero">
            <line x1={l.m.l} x2={width - l.m.r} y1={l.zeroY} y2={l.zeroY} />
            <text x={l.m.l - 10} y={l.zeroY + 4} textAnchor="end">
              €0
            </text>
          </g>
          {l.xMarks.map((m) => (
            <text key={m.x} className="chart-x" x={m.x} y={l.H - 8} textAnchor={m.anchor}>
              {m.label}
            </text>
          ))}
          {l.shortArea && (
            <path
              className="chart-area below"
              data-testid="timeline-short-area"
              d={l.shortArea}
              clipPath={`url(#${clip})`}
            />
          )}
          {l.ghost && (
            <g className="chart-ghost" aria-hidden="true">
              <path d={l.ghost} />
            </g>
          )}
          <path className="chart-saved" data-testid="timeline-actual" d={l.actual} />
          <path
            className="chart-saved estimated"
            data-testid="timeline-projected"
            d={l.projected}
          />
          {l.todayX !== null && (
            <g
              className="chart-today timeline-today"
              aria-hidden="true"
              data-testid="timeline-today"
            >
              <line x1={l.todayX} x2={l.todayX} y1={22} y2={l.H - l.m.b} />
              <rect
                x={Math.min(Math.max(l.todayX, l.m.l + 24), width - l.m.r - 24) - 24}
                y={2}
                width={48}
                height={18}
                rx={9}
              />
              <text
                x={Math.min(Math.max(l.todayX, l.m.l + 24), width - l.m.r - 24)}
                y={15}
                textAnchor="middle"
              >
                Today
              </text>
              <circle cx={l.todayX} cy={l.todayY!} r={5} />
            </g>
          )}
          {/* TL2b item 6: where "Lowest" under the chart is, at its low within the day. */}
          {l.lowest && (
            <circle
              className={`timeline-lowest${l.lowest.cents < 0 ? ' short' : ''}`}
              data-testid="timeline-lowest"
              data-cents={l.lowest.cents}
              aria-hidden="true"
              cx={l.lowest.x}
              cy={l.lowest.y}
              r={6}
            />
          )}
          {low && (
            <g
              className="chart-short"
              aria-hidden="true"
              transform={`translate(${Math.max(l.m.l + 60, Math.min(width - l.m.r - 60, l.x(low.date)))} ${Math.min(l.y(-low.shortCents) + 12, l.H - l.m.b - 24)})`}
            >
              <rect x={-60} y={0} width={120} height={22} rx={7} />
              <text x={0} y={15} textAnchor="middle">
                {eur(low.shortCents)} short
              </text>
            </g>
          )}
          <g aria-hidden="true">
            {l.dots.map((d, i) => (
              <circle
                key={i}
                className={`chart-dot ${d.event.certainty === 'estimated' ? 'estimated' : 'certain'}${d.y > l.zeroY ? ' short' : ''}`}
                cx={d.x}
                cy={d.y}
                r={narrow ? 3.5 : 4.5}
              />
            ))}
            {l.dots.map((d, i) => (
              <circle
                key={`h${i}`}
                className="chart-hit"
                data-testid="timeline-dot"
                cx={d.x}
                cy={d.y}
                r={narrow ? 22 : 14}
                data-on={tip === i || undefined}
                onMouseEnter={() => setTip(i)}
                onClick={() => setTip(i)}
              />
            ))}
          </g>
        </svg>
      )}
      {tip !== null && l.dots[tip] && (
        <div
          className="chart-tip"
          data-testid="timeline-tip"
          style={{
            left: Math.max(90, Math.min(width - 90, l.dots[tip].x)),
            top: l.dots[tip].y - 14,
          }}
          aria-hidden="true"
        >
          <strong>{words(tip).title}</strong>
          <span>{words(tip).lines[0]}</span>
        </div>
      )}
    </div>
  );
}
