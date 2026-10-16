'use client';
// UI1 (plan 28, round 13): the "Plan" tab: the brief, "Month ahead" (the forecast of FC1) and
// "Goals" (GL1), with the Plan card and the shortfall row of the Overview. Each part shows only
// when its server part answers, so this file is safe on a server without them: no `forecast` on
// the dashboard and no goals → no nav entry, nothing rendered.
// Contract: "A sensitive operation must present its amount, source, and destination for explicit
// review before execution." Nothing here sends: "Prepare this" and the goal routes leave a
// prepared transfer, and the Transfers tab stays the one place that sends and confirms.
import { useEffect, useMemo, useRef, useState } from 'react';
import { transferFeedback, type AnyRecord } from '../../src/ui-helpers';
import { Glyph, GoalTrack, reducedMotion } from './plan/charts';
import { PlanBrief, PlanCard } from './plan/Brief';
import { addAdjustment, isRefusedLabel, removeAdjustment } from './plan/adjustments';
import {
  Done,
  MonthAhead,
  MonthSkeleton,
  type Adjusting,
  type Cover,
  type TimelineView,
} from './plan/Forecast';
import { RegularMoney, type RegularActions } from './plan/Regular';
import {
  CreateDrawer,
  GoalDetail,
  GoalsSection,
  type GoalActions,
  type Template,
} from './plan/Goals';
import {
  asksGoals,
  briefOf,
  eurShort,
  forecastOf,
  isAdjustable,
  LABEL_HINT,
  goalIcon,
  planParts,
  PREPARED_LINE,
  STATES,
} from './plan/logic';
import type {
  Brief,
  CoverOption,
  ForecastEvent,
  GoalView,
  GoalsResponse,
  Timeline,
  TimelineRange,
} from './plan/types';

type Api = (path: string, body?: unknown, method?: string) => Promise<AnyRecord>;

export function usePlan({
  api,
  customerId,
  dashboard,
  refresh,
  active,
  goPlan,
  goOverview,
  openPrepared,
}: {
  // Rejects with an Error that carries the response's `status`.
  api: Api;
  customerId: string | null;
  dashboard: AnyRecord | null;
  refresh(): Promise<void>;
  // The Plan tab is the one on screen.
  active: boolean;
  goPlan(): void;
  goOverview(): void;
  // Opens one prepared transfer in the Transfers tab.
  openPrepared(id: string): void;
}) {
  // undefined: not asked or not answered yet; null: this server has no goals (404).
  const [goals, setGoals] = useState<GoalsResponse | null | undefined>(undefined),
    [goalsError, setGoalsError] = useState(''),
    [accountId, setAccountId] = useState(''),
    [cover, setCover] = useState<Cover | null>(null),
    // The refusal of "Prepare this" or Undo, with the forecast it was said about (null: not read yet).
    [coverError, setCoverError] = useState<{ text: string; about: string | null } | null>(null),
    [openId, setOpenId] = useState(''),
    [creating, setCreating] = useState<{ template: Template | null } | null>(null),
    [fresh, setFresh] = useState(''),
    [note, setNote] = useState(''),
    [retrying, setRetrying] = useState(false),
    // Forecast adjustments (FC2, draft).
    [pending, setPending] = useState<ForecastEvent | null>(null),
    [adjustBusy, setAdjustBusy] = useState(false),
    [adjustStatus, setAdjustStatus] = useState<Adjusting['status']>(null),
    [adjustError, setAdjustError] = useState(''),
    [labelError, setLabelError] = useState(''),
    // RG2: which card the last adjustment came from; its busy state, line and refusal show there.
    [origin, setOrigin] = useState<'month' | 'regular'>('month'),
    // TL2: the balance timeline of the account on screen, for the chosen period.
    [range, setRange] = useState<TimelineRange>('this_month'),
    [timeline, setTimeline] = useState<Timeline | null>(null),
    [timelineBusy, setTimelineBusy] = useState(false),
    [timelineError, setTimelineError] = useState(''),
    // Bumped by every change, so the timeline is read again with the dashboard.
    [version, setVersion] = useState(0),
    // null: not known yet; false: this server has no timeline route (404), the chart of the
    // month as before.
    [hasTimeline, setHasTimeline] = useState<boolean | null>(null);
  const who = useRef(customerId),
    timelineAsk = useRef(0),
    lastReplan = useRef(0),
    lock = useRef(false),
    // This server answered 404 to GET /api/goals (no GL1): not asked again until a reload.
    noGoals = useRef(false);
  who.current = customerId;
  useEffect(() => {
    setGoals(noGoals.current ? null : undefined);
    setGoalsError('');
    setAccountId('');
    setCover(null);
    setCoverError(null);
    setOpenId('');
    setCreating(null);
    setFresh('');
    setNote('');
    setPending(null);
    setAdjustBusy(false);
    setAdjustStatus(null);
    setAdjustError('');
    setLabelError('');
    setRange('this_month');
    setTimeline(null);
    setTimelineError('');
    lock.current = false;
  }, [customerId]);

  const asks = !!customerId && asksGoals(dashboard);
  async function loadGoals() {
    const me = customerId;
    try {
      const data = (await api('goals')) as GoalsResponse;
      if (who.current !== me) return;
      setGoals(data);
      setGoalsError('');
    } catch (e) {
      if (who.current !== me) return;
      if ((e as { status?: number }).status === 404) {
        noGoals.current = true;
        setGoals(null);
      } else setGoalsError((e as Error).message);
    }
  }
  // Read once the dashboard shows a server of this round, and again whenever the Plan tab or a
  // new dashboard comes up (a payment confirmed in Transfers changes what is saved). A server
  // that answered 404 is not asked again, for any customer: no card, no retry, nothing logged.
  useEffect(() => {
    if (asks && !noGoals.current) loadGoals();
  }, [asks, active, dashboard?.prepared?.length]);

  const forecast = forecastOf(dashboard);
  // A refusal line stays while the forecast it was said about stands and the Plan tab is on
  // screen: a forecast read again that differs, or leaving the tab, ends it (so does Dismiss).
  const read = useMemo(() => JSON.stringify(forecast ?? null), [forecast]);
  useEffect(() => {
    if (!coverError) return;
    if (!active || (coverError.about !== null && coverError.about !== read)) setCoverError(null);
    else if (coverError.about === null) setCoverError({ ...coverError, about: read });
  }, [coverError, read, active]);
  const brief = briefOf(dashboard);
  const viewed = forecast?.accounts.find((a) => a.id === accountId) ?? forecast?.accounts[0];
  // TL2: one refresh for every change made from the Plan: the dashboard and the timeline at once.
  const replan = () => {
    setVersion((v) => v + 1);
    return refresh();
  };
  // Goals and prepared transfers also change from the chat and the Transfers tab: both are read
  // again when the Plan tab comes up and when the window gets the focus back.
  useEffect(() => {
    if (!active || !customerId) return;
    replan().catch(() => {});
    // Focus and visibility often come together: one read for both.
    const again = () => {
      if (window.document.visibilityState !== 'visible' || Date.now() - lastReplan.current < 1000)
        return;
      lastReplan.current = Date.now();
      replan().catch(() => {});
    };
    window.addEventListener('focus', again);
    window.document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      window.document.removeEventListener('visibilitychange', again);
    };
  }, [active, customerId]);
  const viewedId = viewed?.id;
  useEffect(() => {
    if (!active || !viewedId || hasTimeline === false) return;
    const ask = ++timelineAsk.current,
      me = customerId;
    setTimelineBusy(true);
    api(`forecast/timeline?accountId=${encodeURIComponent(viewedId)}&range=${range}`)
      .then((data) => {
        if (ask !== timelineAsk.current || who.current !== me) return;
        setTimeline(data as Timeline);
        setHasTimeline(true);
        setTimelineError('');
      })
      .catch((e) => {
        if (ask !== timelineAsk.current || who.current !== me) return;
        // A server without TL1: the month's chart, and no second ask.
        if ((e as { status?: number }).status === 404 && hasTimeline === null)
          setHasTimeline(false);
        else setTimelineError((e as Error).message);
      })
      .finally(() => {
        if (ask === timelineAsk.current) setTimelineBusy(false);
      });
    // TL2b: not keyed on `active` or the customer: the Plan tab coming up and a new customer
    // already bump `version` (the effect above), so each is one read, not two.
  }, [viewedId, range, version]);
  const timelineView: TimelineView | undefined =
    hasTimeline === false
      ? undefined
      : {
          range,
          onRange: setRange,
          known: hasTimeline === true,
          // An answer for another account is not drawn as this one's.
          data: timeline?.accountId === viewedId ? timeline : null,
          loading: timelineBusy,
          error: timelineError,
          onRetry: () => setVersion((v) => v + 1),
        };
  const parts = planParts(dashboard, goals);
  const available = !!customerId && (parts.forecast || parts.goals);

  // ── "Prepare this": one prepared transfer through the existing route; Undo deletes it. ──
  async function prepare(account: string, options: CoverOption[], option: CoverOption) {
    if (lock.current) return;
    lock.current = true;
    const me = customerId;
    setCoverError(null);
    setCover({ accountId: account, options, option, preparedId: null, phase: 'preparing' });
    try {
      const result = await api('prepared', option.prepare);
      if (who.current !== me) return;
      if (result.status !== 'prepared') throw new Error(transferFeedback(result).text);
      // The line settles on the server's own forecast, which now holds this transfer.
      await replan().catch(() => {});
      if (who.current !== me) return;
      setCover((c) => c && { ...c, preparedId: result.prepared.id, phase: 'done' });
    } catch (e) {
      if (who.current !== me) return;
      // Said about the forecast as it reads after the refusal: the next one that differs ends it.
      // The forecast first, so the focus goes to what is on screen then (the option, if any).
      await replan().catch(() => {});
      if (who.current !== me) return;
      setCover(null);
      setCoverError({ text: (e as Error).message, about: null });
    } finally {
      lock.current = false;
    }
  }
  async function undo() {
    if (lock.current || !cover?.preparedId) return;
    lock.current = true;
    const me = customerId,
      id = cover.preparedId;
    setCoverError(null);
    setCover({ ...cover, phase: 'undoing' });
    try {
      await api(`prepared/${id}`, undefined, 'DELETE');
      await replan().catch(() => {});
      if (who.current === me) setCover(null);
    } catch (e) {
      if (who.current !== me) return;
      setCover((c) => c && { ...c, phase: 'done' });
      setCoverError({ text: (e as Error).message, about: null });
    } finally {
      lock.current = false;
    }
  }

  // ── Forecast adjustments (FC2): one call, then the dashboard again. A refusal prints the
  // server's sentence (409 at the cap, 404 for an account that is not the customer's); the 400
  // of an expected charge is its label, said under that field. ──
  async function adjusting(work: () => Promise<Adjusting['status'] | void>, expect = false) {
    if (lock.current) return false;
    lock.current = true;
    const me = customerId;
    setAdjustBusy(true);
    setAdjustError('');
    setLabelError('');
    let ok = false;
    try {
      const status = await work();
      await replan().catch(() => {});
      if (who.current === me) setAdjustStatus(status ?? null);
      ok = true;
    } catch (e) {
      if (who.current === me) {
        if (expect && isRefusedLabel(e)) setLabelError((e as Error).message || LABEL_HINT);
        else setAdjustError((e as Error).message);
      }
    } finally {
      if (who.current === me) {
        setPending(null);
        setAdjustBusy(false);
      }
      lock.current = false;
    }
    return ok;
  }
  const mine = (o: typeof origin) => origin === o;
  const adjust: Adjusting = {
    pending,
    busy: adjustBusy && mine('month'),
    status: mine('month') ? adjustStatus : null,
    error: mine('month') ? adjustError : '',
    labelError: mine('month') ? labelError : '',
    onExclude(account, event) {
      setOrigin('month');
      setPending(event);
      adjusting(async () => {
        const made = await addAdjustment(api, {
          kind: 'exclude',
          accountId: account,
          merchantKey: event.merchantKey!,
        });
        return { text: `${event.label} is no longer counted.`, undoId: made.id };
      });
    },
    onExpect(body) {
      setOrigin('month');
      return adjusting(async () => void (await addAdjustment(api, body)), true);
    },
    onRemove(id) {
      setOrigin('month');
      void adjusting(async () => void (await removeAdjustment(api, id)));
    },
  };
  // RG2: "Regular money" uses the same routes, one at a time with the card above (the same lock).
  const regularActions: RegularActions = {
    busy: adjustBusy && mine('regular'),
    status: mine('regular') ? adjustStatus : null,
    error: mine('regular') ? adjustError : '',
    labelError: mine('regular') ? labelError : '',
    onExclude(account, item) {
      setOrigin('regular');
      adjusting(async () => {
        const made = await addAdjustment(api, {
          kind: 'exclude',
          accountId: account,
          merchantKey: item.id,
        });
        return { text: `${item.label} is no longer counted as regular.`, undoId: made.id };
      });
    },
    onAdd(body) {
      setOrigin('regular');
      return adjusting(async () => void (await addAdjustment(api, body)), true);
    },
    onRemove(id) {
      setOrigin('regular');
      void adjusting(async () => void (await removeAdjustment(api, id)));
    },
  };

  // ── Goals: every change is a route of GL1, then both reads again. ──
  const reread = () => Promise.all([loadGoals(), replan().catch(() => {})]);
  const actions: GoalActions = {
    plan: (body) => api('goals/plan', body) as Promise<never>,
    // A refusal of any of them (409 `too_many`, `reached`, `prepared_in_progress`, …) keeps the
    // server's sentence, shown inline; the goals are read again either way.
    async create(body) {
      try {
        const { goal } = await api('goals', body);
        return goal as GoalView;
      } finally {
        await reread();
      }
    },
    async adjust(id, body) {
      try {
        const { goal } = await api(`goals/${id}/adjust`, body);
        return goal as GoalView;
      } finally {
        await reread();
      }
    },
    async remove(id) {
      try {
        await api(`goals/${id}`, undefined, 'DELETE');
      } finally {
        await reread();
      }
    },
    async resume(id) {
      try {
        await api(`prepared/${id}/resume`, {});
      } finally {
        await reread();
      }
    },
    openPrepared,
  };
  const jump = (id: string) =>
    setTimeout(() =>
      window.document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }),
    );
  function go(f: Brief['findings'][number]) {
    if (f.kind === 'category_up') {
      goOverview();
      return setTimeout(() =>
        window.document
          .querySelector('.overview-insights')
          ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }),
      );
    }
    goPlan();
    if (f.kind === 'goal_behind' && f.goalId) {
      setOpenId(f.goalId);
      window.scrollTo(0, 0);
    } else {
      setOpenId('');
      if (f.accountId) setAccountId(f.accountId);
      jump('month-ahead');
    }
  }
  const briefCard = brief && <PlanBrief brief={brief} onGo={go} />;
  const open = goals?.goals.find((g) => g.id === openId);
  const show = (id: string) => {
    setOpenId(id);
    setNote('');
    window.scrollTo(0, 0);
  };

  const page = available && (
    <div className="plan-page">
      {open && goals ? (
        <div className="goal-detail-layout">
          <aside className="goal-rail" aria-label="Goals">
            <button type="button" className="plan-link back" onClick={() => show('')}>
              <Glyph name="back" size={15} /> Plan
            </button>
            {goals.goals.map((g) => (
              <button
                key={g.id}
                type="button"
                className="goal-rail-row"
                data-icon={goalIcon(g.name)}
                aria-current={g.id === open.id ? 'true' : undefined}
                onClick={() => show(g.id)}
              >
                <span className="goal-tile" aria-hidden="true">
                  <Glyph name={goalIcon(g.name)} size={16} />
                </span>
                <span>
                  <strong>
                    <bdi>{g.name}</bdi>
                  </strong>
                  <small>
                    {eurShort(g.savedCents)} of {eurShort(g.targetCents)} · {STATES[g.state].label}
                  </small>
                  <GoalTrack goal={g} small />
                </span>
              </button>
            ))}
            {goals.canSave && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setCreating({ template: null })}
              >
                <Glyph name="plus" size={15} /> New goal
              </button>
            )}
          </aside>
          <GoalDetail
            key={open.id}
            goal={open}
            data={goals}
            actions={actions}
            onClose={() => show('')}
            onDeleted={() => {
              show('');
              setNote(
                'Goal deleted. Its monthly prepared transfer was deleted too; nothing was sent.',
              );
            }}
          />
        </div>
      ) : (
        <>
          <section className="page-heading plan-heading">
            <div>
              <h1>Plan</h1>
              <p>The month ahead, and what you are saving for.</p>
            </div>
          </section>
          {briefCard}
          {parts.forecast &&
            (retrying ? (
              <MonthSkeleton />
            ) : forecast?.accounts.length ? (
              <>
                <MonthAhead
                  // The width of the chart is read on its box: a new box when the kind changes.
                  key={timelineView ? 'timeline' : 'month'}
                  timeline={timelineView}
                  forecast={forecast}
                  // The server puts a short account first: the first one is the view.
                  accountId={viewed!.id}
                  onAccount={setAccountId}
                  cover={cover}
                  error={coverError?.text ?? ''}
                  onDismissError={() => setCoverError(null)}
                  onPrepare={prepare}
                  onUndo={undo}
                  onOpenPrepared={openPrepared}
                  adjust={isAdjustable(forecast) ? adjust : undefined}
                />
                {/* RG2: the same account as Month ahead, chosen by its switch. */}
                {viewed!.regular && (
                  <RegularMoney
                    key={viewed!.id}
                    regular={viewed!.regular}
                    accountId={viewed!.id}
                    accountLabel={viewed!.label}
                    today={forecast.today}
                    actions={isAdjustable(forecast) ? regularActions : undefined}
                    onOpenGoal={show}
                    onOpenPrepared={openPrepared}
                  />
                )}
              </>
            ) : (
              <section className="card load-error" role="alert">
                <h2>We could not work out your month ahead</h2>
                <p>Your accounts could not be read just now. Nothing was changed.</p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setRetrying(true);
                    refresh()
                      .catch(() => {})
                      .finally(() => setRetrying(false));
                  }}
                >
                  Retry
                </button>
              </section>
            ))}
          {goals ? (
            <GoalsSection
              data={goals}
              fresh={fresh}
              note={
                note && (
                  <Done text={note}>
                    {fresh && goals.goals.find((g) => g.id === fresh)?.prepared && (
                      <button
                        type="button"
                        className="plan-link"
                        onClick={() =>
                          openPrepared(goals.goals.find((g) => g.id === fresh)!.prepared!.id)
                        }
                      >
                        Open in Transfers
                      </button>
                    )}
                  </Done>
                )
              }
              onOpen={show}
              onCreate={(template) => setCreating({ template: template ?? null })}
              onOpenPrepared={openPrepared}
              onResume={(id) => void actions.resume(id).catch((e) => setNote((e as Error).message))}
            />
          ) : (
            goalsError && (
              <section className="card load-error" role="alert">
                <h2>We could not load your goals</h2>
                <p>{goalsError}</p>
                <button type="button" className="primary-button" onClick={loadGoals}>
                  Retry
                </button>
              </section>
            )
          )}
        </>
      )}
      {goals?.canSave && (
        <CreateDrawer
          open={!!creating}
          data={goals}
          template={creating?.template ?? null}
          actions={actions}
          onClose={() => setCreating(null)}
          onCreated={(goal) => {
            setCreating(null);
            setOpenId('');
            setFresh(goal.id);
            setNote(PREPARED_LINE);
            jump('goals-section');
          }}
        />
      )}
    </div>
  );

  // D12, D15: the shortfall is a row of "For you to do", made only from the brief's finding (its
  // text ends " An estimate."), never from the forecast. The server leaves the finding out when
  // the customer turned observations off; without a brief (no PL1) there is no row.
  const attention = (brief?.findings ?? [])
    .filter((f) => f.kind === 'forecast_shortfall')
    .map((f) => ({
      id: `plan-shortfall-${f.accountId ?? ''}`,
      title: f.text,
      detail: 'Month ahead',
      actionLabel: 'See the month ahead →',
      onAction: () => go(f),
    }));
  return {
    // UI4: "See it in Plan" of the chat. A goal that is no longer there leaves the Plan tab.
    openGoal(id: string) {
      goPlan();
      show(id);
    },
    available,
    // Known for this customer: both reads answered (or goals are not asked on this server).
    known: !!dashboard && (!asks || goals !== undefined || !!goalsError),
    page,
    attention,
    overview: available && (
      <>
        {/* The Overview has no brief card of its own: its findings, when there are any, are the
            top part of the Plan card. */}
        <PlanCard forecast={forecast} goals={goals} onOpen={goPlan} brief={brief} onGo={go} />
      </>
    ),
  };
}
