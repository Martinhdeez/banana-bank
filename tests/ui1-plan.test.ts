// UI1 (plan 28, REQ-PL-27, REQ-PL-28): the Plan tab against the plan's shapes. The forecast
// fixtures are FC1's captures of the real server (PR #177) and, for three more states, the output
// of its function; the goals, the brief and the FC2 drafts follow the plan by hand
// (.scratch/after/feat-ui1-plan-tab/make-fixtures.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePlan } from '../app/_components/Plan';
import { PlanBrief, PlanCard } from '../app/_components/plan/Brief';
import { MonthAhead } from '../app/_components/plan/Forecast';
import { CreateDrawer, GoalDetail, GoalsSection } from '../app/_components/plan/Goals';
import {
  asksGoals,
  frameOf,
  paymentsLeft,
  planAvailable,
  PREPARED_LINE,
  dayYear,
  fitsLine,
  previewLine,
  whatIf,
  withoutPrepared,
} from '../app/_components/plan/logic';
import type { Brief, GoalsResponse, MonthForecast } from '../app/_components/plan/types';
import { Overview } from '../app/_components/Overview';
import { Shell } from '../app/_components/Shell';
import { money, parseTab } from '../src/ui-helpers';
import type { Person } from '../src/types';

const read = <T>(name: string) =>
  JSON.parse(fs.readFileSync(`tests/plan-fixtures/${name}.json`, 'utf8')) as T;
const forecasts = Object.fromEntries(
  [
    'lucia-before',
    'short-estimated',
    'short-covered-by-option',
    'short-certain',
    'not-counted',
    'no-history',
    'bruno',
    'carla',
  ].map((n) => [n, read<MonthForecast>(`forecast-${n}`)]),
);
const goals = read<GoalsResponse>('goals-list');
const oneAccount = read<GoalsResponse>('goals-one-account');
// PL1's own briefs (#185): nothing, a shortfall, a shortfall and a goal, observations off (the
// goal finding stays), a category that is up.
const briefs = ['0', '1', '2', 'off', 'up'].map((n) => read<Brief>(`brief-${n}`));
const noop = () => {};
// React escapes these in text; the page shows the server's characters.
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
// What the customer reads: the text between the tags.
const words = (html: string) => html.replace(/<[^>]+>/g, ' ');
const monthProps = (f: MonthForecast) => ({
  forecast: f,
  accountId: f.accounts[0].id,
  onAccount: noop,
  cover: null,
  error: '',
  onPrepare: noop,
  onUndo: noop,
  onOpenPrepared: noop,
});
const month = (f: MonthForecast, accountId = f.accounts[0].id, over = {}) =>
  text(
    renderToStaticMarkup(
      createElement(MonthAhead, {
        forecast: f,
        accountId,
        onAccount: noop,
        cover: null,
        error: '',
        onPrepare: noop,
        onUndo: noop,
        onOpenPrepared: noop,
        ...over,
      }),
    ),
  );

test('Month ahead prints every server text as it came, the headline never without its explanation', () => {
  for (const [name, f] of Object.entries(forecasts)) {
    for (const a of f.accounts) {
      const html = month(f, a.id);
      const verdict = html.slice(html.indexOf('data-testid="forecast-verdict"'));
      assert.ok(
        verdict.includes(
          `<p class="verdict-headline" tabindex="-1">${a.headline}</p><p class="verdict-sub">${a.explanation}</p>`,
        ),
        `${name} ${a.id}: the headline with its explanation`,
      );
      for (const note of f.notes) assert.ok(html.includes(note), `${name}: note`);
      for (const n of f.notCounted)
        assert.ok(html.includes(`<li>${n.text}</li>`), `${name}: ${n.text}`);
      assert.ok(
        html.includes(`<p class="plan-source">${f.sourceLine}</p>`),
        `${name}: source line`,
      );
      for (const o of a.options)
        assert.ok(
          html.includes(`<strong>${o.title}</strong><small>${o.consequence}</small>`),
          `${name}: option`,
        );
      assert.equal(html.split('data-testid="forecast-event"').length - 1, a.events.length);
      assert.equal(html.split('data-testid="forecast-cover-option"').length - 1, a.options.length);
      assert.equal(html.includes('data-testid="forecast-prepare"'), a.options.length > 0);
      assert.ok(html.includes('data-testid="plan-forecast"'));
      // The three figures are the server's, to the cent.
      for (const [stat, cents] of [
        ['today', a.balanceCents],
        ['lowest', a.lowest.balanceCents],
        ['end', a.endCents],
      ] as const)
        assert.ok(
          new RegExp(`data-stat="${stat}">${money(cents).replace(/[.$]/g, '\\$&')}<`).test(html),
          `${name} ${stat}`,
        );
      assert.doesNotMatch(words(html), /automatic|scheduled|should/i, name);
    }
  }
  // The plan's own example (§6.1), on the merged seed's names.
  assert.equal(
    forecasts['short-estimated'].accounts[0].explanation,
    'If Digi Spain Telecom (€39.90, around the 10th) and Spotify (€10.99, around the 14th) come as in July–September, on 20 Oct you would be €28.28 short for your prepared transfer to Bruno Vidal · Horizon account. An estimate.',
  );
  // "Review transfer" only when a prepared transfer is what goes uncovered.
  assert.ok(month(forecasts['short-estimated']).includes('Review transfer'));
  assert.ok(!month(forecasts['not-counted']).includes('Review transfer'));
  // One account: no account switch, no cover option.
  assert.ok(!month(forecasts.bruno).includes('aria-label="Account"'));
});

test('a late event prints its note; a refusal prints the server sentence', () => {
  const f: MonthForecast = structuredClone(forecasts['not-counted']);
  const note = 'Usually around the 3rd, not seen yet this month. An estimate.';
  Object.assign(f.accounts[0].events[0], { late: true, note });
  assert.ok(month(f).includes(note));
  const refused =
    'You already have 20 prepared transfers. Delete one before preparing another. Nothing was sent.';
  assert.ok(
    month(forecasts['short-estimated'], undefined, { error: refused }).includes(
      `<p class="plan-refused closable" role="alert"><span>${refused}</span></p>`,
    ),
  );
});

test('the preview of a cover option is the same sum as the server makes', () => {
  const f = forecasts['short-estimated'],
    after = forecasts['short-covered-by-option'];
  const [account] = f.accounts,
    [option] = account.options;
  const coverId = after.accounts[0].events.find(
    (e) => e.amountCents > 0 && e.source === 'prepared',
  )!.preparedId!;
  // Without a change the frame is the server's own figures.
  const plain = frameOf(account, f.today);
  assert.deepEqual(plain.lowest, account.lowest);
  assert.equal(plain.endCents, account.endCents);
  assert.deepEqual(
    plain.events.map((e) => e.balanceAfterCents),
    account.events.map((e) => e.balanceAfterCents),
  );
  // With the option: the lowest point of its `consequence`, and of the server's forecast once
  // the transfer is really prepared.
  const ghost = frameOf(account, f.today, option.change);
  assert.equal(option.consequence, 'Lowest point €1.72 on 20 Oct. An estimate.');
  assert.deepEqual(ghost.lowest, { date: '2026-10-20', balanceCents: 172 });
  assert.deepEqual(ghost.lowest, after.accounts[0].lowest);
  assert.equal(ghost.endCents, after.accounts[0].endCents);
  assert.deepEqual(
    ghost.events.map((e) => [e.date, e.amountCents, e.balanceAfterCents]),
    after.accounts[0].events.map((e) => [e.date, e.amountCents, e.balanceAfterCents]),
  );
  // A figure worked out here from estimated items says so.
  assert.equal(previewLine(account, ghost), '€1.72 with this change. An estimate.');
  assert.equal(
    previewLine(
      forecasts['no-history'].accounts[0],
      frameOf(forecasts['no-history'].accounts[0], f.today),
    ),
    `${money(forecasts['no-history'].accounts[0].lowest.balanceCents)} with this change`,
  );
  // Undo plays back from the server's forecast: without the transfer it is the short one again.
  const back = frameOf(withoutPrepared(after.accounts[0], coverId), f.today);
  assert.deepEqual(back.lowest, account.lowest);
  // After "Prepare this" the page shows the option it prepared, the fixed line and Undo.
  const html = month(after, undefined, {
    cover: {
      accountId: account.id,
      options: account.options,
      option,
      preparedId: coverId,
      phase: 'done',
    },
  });
  assert.ok(html.includes(PREPARED_LINE) && html.includes('data-testid="forecast-undo"'));
  assert.ok(
    html.includes(after.accounts[0].headline) && html.includes(after.accounts[0].explanation),
  );
});

// The goals of the fixtures are GL1's own answers, one per state (ids named after the state).
const goal = (id: string) => goals.goals.find((g) => g.id === `goal-${id}`)!;
test("the what-if of a goal is the arithmetic of plan 28 §5.2, on the server's own figures", () => {
  const trip = goal('behind');
  // Next due 7 Nov, target 31 Mar 2027: Nov, Dec, Jan, Feb, Mar = 5; required = ceil(1000 / 5).
  assert.equal(paymentsLeft(trip.prepared!.nextDue!, 7, trip.targetDate), 5);
  assert.equal(Math.ceil(trip.remainingCents / 5), trip.requiredMonthlyCents);
  // At the current amount: the server's `behindCents`, the {projected} of its basis, and the
  // date of its `extend` alternative.
  const now = whatIf(trip, trip.monthlyCents!)!;
  assert.equal(now.shortCents, trip.behindCents);
  assert.ok(trip.basis.includes(`you reach ${money(now.projectedCents)} by`));
  assert.deepEqual([now.payments, now.monthsLate], [7, 2]);
  assert.deepEqual(trip.alternative, {
    ...trip.alternative!,
    kind: 'extend',
    targetDate: now.lastDue,
  });
  // The raise the server suggests ends on time; more ends early; day 31 keeps its anchor.
  const raise = whatIf(trip, (trip.suggestion as { monthlyCents: number }).monthlyCents)!;
  assert.deepEqual([raise.payments, raise.monthsLate, raise.shortCents], [5, 0, 0]);
  assert.ok(whatIf(trip, 40000)!.monthsLate < 0);
  assert.equal(paymentsLeft('2026-10-31', 31, '2027-02-28'), 5);
  assert.equal(whatIf(goal('no_plan'), 12000), null);
});

const detail = (id: string, data = goals) =>
  text(
    renderToStaticMarkup(
      createElement(GoalDetail, {
        goal: data.goals.find((g) => g.id === id)!,
        data,
        actions: {} as never,
        onClose: noop,
        onDeleted: noop,
      }),
    ),
  );
const section = (data: GoalsResponse) =>
  text(
    renderToStaticMarkup(
      createElement(GoalsSection, {
        data,
        fresh: '',
        note: null,
        onOpen: noop,
        onCreate: noop,
        onOpenPrepared: noop,
        onResume: noop,
      }),
    ),
  );
test('goals print the server state and texts; one account has no create path', () => {
  const list = section(goals);
  assert.deepEqual(
    [...list.matchAll(/data-testid="goal-card" data-state="([a-z_]+)"/g)].map((m) => m[1]),
    goals.goals.map((g) => g.state),
  );
  assert.ok(list.includes('data-testid="goal-new"'));
  // No total across goals: the strip holds a count, the next payment and the room, no sum.
  const strip = /goals-summary.*?<\/dl>/s.exec(list)![0];
  const sum = goals.goals.reduce((n, g) => n + g.savedCents, 0);
  assert.ok(!strip.includes(money(sum)) && !strip.includes(money(sum).replace('.00', '')));
  for (const g of goals.goals) {
    const html = detail(g.id);
    assert.ok(html.includes(`data-testid="goal-detail" data-state="${g.state}"`));
    assert.ok(html.includes(`data-testid="goal-headline">${g.headline}</p>`), g.id);
    assert.ok(html.includes(`data-testid="goal-basis">${g.basis}</p>`), g.id);
    assert.doesNotMatch(words(html), /automatic|scheduled|should/i, g.id);
  }
  const single = section(oneAccount);
  assert.ok(single.includes(`<p>${oneAccount.canSaveReason}</p>`));
  assert.ok(!single.includes('goal-new') && !single.includes('<button'));
  const drawer = renderToStaticMarkup(
    createElement(CreateDrawer, {
      open: false,
      data: goals,
      template: null,
      actions: {} as never,
      onClose: noop,
      onCreated: noop,
    }),
  );
  assert.ok(drawer.includes('data-testid="goal-plan-preview"'));
  // GL1 lists the savings account first: the money leaves the main account by default.
  assert.equal(goals.accounts[0].id, 'acc-lucia-savings');
  assert.deepEqual(
    [...drawer.matchAll(/<option value="([^"]+)" selected/g)].map((m) => m[1]),
    ['acc-lucia', 'acc-lucia-savings'],
  );
  // The To select never offers the From account (the server: 400 for the same account twice).
  const selects = [...drawer.matchAll(/<select.*?<\/select>/gs)].map((m) => m[0]);
  assert.ok(selects[0].includes('Personal savings') && selects[0].includes('Aurora account'));
  assert.ok(selects[1].includes('Personal savings') && !selects[1].includes('Aurora account'));
});

test('GL1 as built: the transfer of a closed goal, a paused one, a waiting payment, dates', () => {
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?([^<]*)</g)].map((m) => m[1].trim());
  const adjustments = (html: string) => html.split('data-testid="goal-adjustment"').length - 1;
  // 1. date_passed and reached keep their monthly transfer while it exists: the plan card shows
  // it with its real state and action; "has ended" only once it is deleted (prepared null).
  for (const id of ['date_passed', 'reached']) {
    const g = goal(id);
    assert.ok(g.prepared && g.monthlyCents);
    const html = detail(g.id);
    assert.ok(html.includes(`<div class="prepared-card" data-state="${g.prepared!.state}">`), id);
    assert.ok(html.includes('data-testid="goal-send"'), id);
    assert.ok(!html.includes('has ended'), id);
    const ended = detail(`${g.id}-ended`);
    assert.ok(ended.includes('The monthly prepared transfer has ended.'), id);
    assert.ok(!ended.includes('prepared-card') && !ended.includes('goal-send'), id);
  }
  assert.equal(adjustments(detail('goal-date_passed')), 1); // its `extend`
  // 2. A paused transfer is `no_plan` with `prepared`: "Resume", never "Prepare it again".
  const paused = detail('goal-paused');
  assert.ok(goal('paused').suggestion?.kind === 'prepare_again');
  assert.ok(paused.includes('data-testid="goal-resume"') && buttons(paused).includes('Resume'));
  assert.ok(!buttons(paused).includes('Prepare it again') && adjustments(paused) === 0);
  const none = detail('goal-no_plan');
  assert.ok(buttons(none).includes('Prepare it again') && !none.includes('goal-resume'));
  const cards = section(goals);
  const card = (id: string) => new RegExp(`id="goal-goal-${id}".*?</article>`, 's').exec(cards)![0];
  assert.ok(buttons(card('paused')).includes('Resume'));
  assert.ok(buttons(card('no_plan')).includes('Prepare it again'));
  // A payment that waits: headline, basis and "Review and send"; no slider, no adjustment.
  const waiting = detail('goal-behind-payment-waiting');
  assert.ok(waiting.includes('>A payment is waiting</p>'));
  assert.ok(buttons(waiting).includes('Review and send'));
  assert.ok(!waiting.includes('goal-whatif') && adjustments(waiting) === 0);
  // GL1's review: a suggestion is rendered only when it came. `behind` with a gap and none at
  // all keeps the slider (its own snap is the current amount); `date_passed` with none shows
  // headline, basis and the transfer's action.
  const one = detail('goal-behind-raise-only');
  assert.ok(adjustments(one) === 1 && one.includes('goal-whatif'));
  const zero = detail('goal-behind-no-suggestion');
  assert.ok(adjustments(zero) === 0 && zero.includes('goal-whatif'));
  assert.equal(zero.split('aria-pressed=').length - 1, 1); // one snap point: the current amount
  const late = detail('goal-date_passed-no-suggestion');
  assert.ok(adjustments(late) === 0 && late.includes('goal-send') && !late.includes('goal-whatif'));
  // The reached basis is one or two sentences, as sent; no "has ended" beside a live transfer.
  assert.match(
    goal('reached').basis,
    /confirmed\. Its monthly transfer of €300\.00 is still in Transfers/,
  );
  assert.ok(
    detail('goal-reached').includes(`data-testid="goal-basis">${goal('reached').basis}</p>`),
  );
  // The name is the customer's text: text only, wherever it shows.
  const named = structuredClone(goals);
  named.goals = [{ ...named.goals[0], name: '<img src=x onerror=alert(1)>' }];
  const raw = [
    renderToStaticMarkup(
      createElement(GoalDetail, {
        goal: named.goals[0],
        data: named,
        actions: {} as never,
        onClose: noop,
        onDeleted: noop,
      }),
    ),
    renderToStaticMarkup(
      createElement(GoalsSection, {
        data: named,
        fresh: '',
        note: null,
        onOpen: noop,
        onCreate: noop,
        onOpenPrepared: noop,
        onResume: noop,
      }),
    ),
  ];
  for (const html of raw) assert.ok(!html.includes('<img') && html.includes('&lt;img'));
  assert.ok(
    !renderToStaticMarkup(
      createElement(PlanCard, { forecast: undefined, goals: named, onOpen: noop }),
    ).includes('<img'),
  );
  // The slider where a monthly amount can be changed: behind with a gap, on plan.
  for (const id of ['behind', 'on_track-new', 'on_track-one-payment'])
    assert.ok(detail(`goal-${id}`).includes('data-testid="goal-whatif"'), id);
  for (const id of ['no_plan', 'paused', 'date_passed', 'reached'])
    assert.ok(!detail(`goal-${id}`).includes('data-testid="goal-whatif"'), id);
  assert.equal(adjustments(detail('goal-behind')), 2); // raise and extend
  // 5. A day carries its year only when that is not the year of `today`, as the server's texts.
  assert.equal(dayYear('2027-03-07', '2026-10-07'), '7 Mar 2027');
  assert.equal(dayYear('2026-11-07', '2026-10-07'), '7 Nov');
  assert.equal(dayYear('2027-09-07', '2027-04-02'), '7 Sep');
  assert.ok(detail('goal-behind').includes('Move the date to 7 May 2027'));
  assert.ok(card('behind').includes('by 31 Mar 2027'));
  assert.ok(card('reached').includes('Reached on 7 Oct<'));
  // 3. No room → the comparison is not made.
  assert.match(fitsLine(null, null), /^Not enough history yet to compare/);
  assert.match(fitsLine(false, goals.room), /^More than you usually have left/);
});

test('the brief prints the server headline and findings; the Overview card never a bare headline', () => {
  for (const b of briefs) {
    const html = text(renderToStaticMarkup(createElement(PlanBrief, { brief: b, onGo: noop })));
    assert.ok(html.includes('data-testid="plan-brief"'));
    assert.ok(html.includes(`<h2 aria-label="${b.headline}">`));
    assert.equal(html.split('class="brief-text"').length - 1, b.findings.length);
    for (const f of b.findings)
      assert.ok(html.includes(`<span class="brief-text">${f.text}</span>`));
  }
  for (const f of Object.values(forecasts)) {
    const html = text(
      renderToStaticMarkup(createElement(PlanCard, { forecast: f, goals, onOpen: noop })),
    );
    const a = f.accounts.find((x) => x.shortfall) ?? f.accounts[0];
    assert.ok(html.includes(`${a.headline}</strong><small>${a.explanation}</small>`));
    assert.ok(html.includes('Trip to Lisbon')); // the goal that needs attention first
  }
  assert.equal(
    renderToStaticMarkup(
      createElement(PlanCard, { forecast: undefined, goals: undefined, onOpen: noop }),
    ),
    '',
  );
});

// What the page gets from the hook, on a dashboard with or without the round's fields.
function probe(dashboard: Record<string, unknown> | null, over = {}) {
  let got = {} as ReturnType<typeof usePlan>;
  function Host() {
    got = usePlan({
      api: async () => ({}),
      customerId: 'lucia',
      dashboard,
      refresh: async () => {},
      active: true,
      goPlan: noop,
      goOverview: noop,
      openPrepared: noop,
      ...over,
    });
    return createElement('main', null, got.page, got.overview);
  }
  return { html: text(renderToStaticMarkup(createElement(Host))), got: () => got };
}
const person = { id: 'lucia', name: 'Lucía Martín', role: 'customer' } as Person;
const shell = (plan?: boolean) =>
  renderToStaticMarkup(
    createElement(Shell, {
      operator: false,
      tab: 'overview',
      onTab: noop,
      collapsed: false,
      onToggleSidebar: noop,
      people: [person],
      current: person,
      personId: 'lucia',
      onPerson: noop,
      conversations: [],
      conversationId: null,
      onOpenConversation: noop,
      onNewConversation: noop,
      plan,
      children: null,
    }),
  );
test('a server without the forecast and the goals: no nav entry, nothing rendered, nothing asked', () => {
  const old = {
    accounts: [{ id: 'acc-lucia', label: 'Aurora account', balanceCents: 1 }],
    prepared: [],
  };
  assert.equal(asksGoals(old), false);
  assert.equal(planAvailable(old, undefined), false);
  assert.equal(planAvailable(old, null), false); // goals answered 404
  const none = probe(old);
  assert.equal(none.html, '<main></main>');
  assert.deepEqual([none.got().available, none.got().attention], [false, []]);
  assert.equal(none.got().known, true);
  const labels = (html: string) =>
    [...html.matchAll(/class="nav-label">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels(shell()), ['Overview', 'Assistant', 'Transfers', 'Documents']);
  assert.deepEqual(labels(shell(true)), [
    'Overview',
    'Assistant',
    'Transfers',
    'Plan',
    'Documents',
  ]);
  // Either part alone is enough; a forecast that could not be worked out (null) still is the tab.
  assert.equal(planAvailable({ ...old, forecast: null }, null), true);
  assert.equal(planAvailable(old, goals), true);
  assert.equal(asksGoals({ ...old, forecast: null }), true);
  assert.equal(parseTab('?tab=goals', 'customer'), 'goals');
  assert.equal(parseTab('?tab=goals', 'operator'), 'cases');
});

test('with the forecast and the brief: the tab, the Overview pieces and the row of "For you to do"', () => {
  const dashboard = {
    accounts: [],
    prepared: [],
    forecast: forecasts['short-estimated'],
    brief: briefs[1],
  };
  const on = probe(dashboard);
  assert.equal(on.got().available, true);
  for (const id of ['plan-brief', 'plan-forecast', 'forecast-verdict', 'plan-card'])
    assert.ok(on.html.includes(`data-testid="${id}"`), id);
  // The row is worded by the brief's finding, which carries "An estimate."
  assert.deepEqual(
    on.got().attention.map((a) => a.title),
    [briefs[1].findings[0].text],
  );
  // No brief on the dashboard (PL1 not merged): no row and no brief block, even with a short
  // forecast: the row is never made from `forecast`. The tab and the card still work from it.
  const bare = probe({ ...dashboard, brief: undefined });
  assert.deepEqual(bare.got().attention, []);
  assert.ok(!bare.html.includes('data-testid="plan-brief"'));
  assert.ok(
    bare.html.includes('data-testid="plan-forecast"') &&
      bare.html.includes('data-testid="plan-card"'),
  );
  // A brief without the finding (the server drops it when observations are off): no row.
  assert.deepEqual(probe({ ...dashboard, brief: briefs[0] }).got().attention, []);
  // `brief: null` (it could not be worked out) is the same as no brief.
  const none = probe({ ...dashboard, brief: null });
  assert.ok(none.got().attention.length === 0 && !none.html.includes('plan-brief'));
  // Observations off: the server sends no shortfall finding, so there is no row; the goal's stays
  // in the brief. One row per shortfall finding, never one made up; no "+N more" either.
  const off = probe({ ...dashboard, brief: briefs[3] });
  assert.deepEqual(off.got().attention, []);
  assert.ok(off.html.includes(briefs[3].findings[0].text));
  const two = structuredClone(briefs[2]);
  two.findings.push({
    ...two.findings[0],
    accountId: 'acc-lucia-savings',
    text: 'Personal savings: €5.00 short on 30 Oct.',
  });
  two.headline = '9 things to look at.';
  const many = probe({ ...dashboard, brief: two });
  assert.deepEqual(
    many.got().attention.map((a) => [a.id, a.title, a.actionLabel]),
    [
      ['plan-shortfall-acc-lucia', briefs[2].findings[0].text, 'See the month ahead →'],
      [
        'plan-shortfall-acc-lucia-savings',
        'Personal savings: €5.00 short on 30 Oct.',
        'See the month ahead →',
      ],
    ],
  );
  assert.ok(many.html.includes('9 things to look at.') && !/\bmore\b/.test(words(many.html)));
  // The Overview without the slot is the Overview as before.
  const overview = (plan?: React.ReactNode) =>
    renderToStaticMarkup(
      createElement(Overview, {
        current: person,
        people: [],
        dashboard: { accounts: [{ id: 'a', label: 'Aurora account', balanceCents: 100 }] },
        allActivity: false,
        onToggleAll: noop,
        onTab: noop,
        onOpenAccount: noop,
        onStartTransfer: noop,
        plan,
      }),
    );
  assert.equal(overview(undefined), overview(false));
  assert.ok(
    overview(createElement('i', { id: 'slot' })).includes(
      '</section><i id="slot"></i></div></section>',
    ),
  );
});

test("certainty is the server's; the view is the first account of the array; the operator has no Plan", () => {
  // The verdict carries `shortfall.certainty` as it came, whatever the events say (FC1: a usual
  // charge on the shortfall day makes it estimated; the page works nothing out).
  const certainty = (f: MonthForecast) => /data-certainty="(\w+)"/.exec(month(f))?.[1];
  assert.equal(certainty(forecasts['short-estimated']), 'estimated');
  assert.equal(certainty(forecasts['short-certain']), 'certain');
  assert.equal(certainty(forecasts['carla']), undefined);
  const forged = structuredClone(forecasts['short-certain']);
  forged.accounts[0].shortfall!.certainty = 'estimated';
  for (const e of forged.accounts[0].events) e.certainty = 'certain';
  assert.equal(certainty(forged), 'estimated');
  // Each row and dot follows its own event.
  const html = month(forecasts['short-estimated']);
  for (const e of forecasts['short-estimated'].accounts[0].events)
    assert.ok(html.includes(`${e.label} (${e.certainty})`), e.label);
  // Equal accounts come in the bank's order: the savings account can be first. The page shows
  // the first of the array and names the switch buttons in the array's order.
  const turned = structuredClone(forecasts['carla']);
  turned.accounts.reverse();
  const first = probe({ accounts: [], prepared: [], forecast: turned }).html;
  assert.deepEqual(
    [...first.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]),
    turned.accounts.map((a, i) => [a.label, String(i === 0)]),
  );
  assert.ok(first.includes(`<p class="verdict-sub">${turned.accounts[0].explanation}</p>`));
  // The operator's dashboard has no `forecast` key at all: nothing asked, no Plan.
  const operator = probe({ cases: [], handoffs: [] });
  assert.equal(asksGoals({ cases: [] }), false);
  assert.deepEqual([operator.got().available, operator.html], [false, '<main></main>']);
});

// ── Forecast adjustments (FC2, #182): the fixtures are the real forecasts of its scene. Lucía
// adds a one-off "Car insurance" of €2,900.00 on 25 Oct, covers it, leaves Spotify out. ──
import {
  addAdjustment,
  isRefusedLabel,
  removeAdjustment,
} from '../app/_components/plan/adjustments';
import {
  adjustmentWords,
  expectErrors,
  expectOf,
  hiddenAdjustments,
  isAdjustable,
  LABEL_HINT,
  withoutEvent,
} from '../app/_components/plan/logic';
const before = read<MonthForecast>('forecast-adjust-before'),
  expected = read<MonthForecast>('forecast-adjust-expected'),
  covered = read<MonthForecast>('forecast-adjust-expected-covered'),
  excluded = read<MonthForecast>('forecast-adjust-excluded'),
  hidden = read<MonthForecast>('forecast-adjust-hidden');
const adjust = {
  pending: null,
  busy: false,
  status: null,
  error: '',
  labelError: '',
  onExclude: noop,
  onExpect: async () => true,
  onRemove: noop,
};
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;
test('adjustments show only when the server says `adjustable`; the row actions and the server texts', () => {
  // FC1 alone sends `merchantKey` on every usual item and has no route to exclude one. The one
  // key is `forecast.adjustable === true`: no other field turns the actions on.
  const fc1 = forecasts['short-estimated'];
  assert.ok(fc1.accounts[0].events.some((e) => e.merchantKey));
  // (The five captures of the FC1 server; the three made by dev's function now carry the flag.)
  for (const n of ['lucia-before', 'short-estimated', 'short-covered-by-option', 'bruno', 'carla'])
    assert.equal(isAdjustable(forecasts[n]), false, n);
  assert.doesNotMatch(
    probe({ accounts: [], prepared: [], forecast: fc1 }).html,
    /forecast-exclude|forecast-expect|forecast-adjustment|Not regular|Count it again/,
  );
  assert.equal(isAdjustable({ ...excluded, adjustable: undefined }), false);
  for (const f of [before, expected, covered, excluded, hidden])
    assert.equal(isAdjustable(f), true);
  assert.match(
    probe({ accounts: [], prepared: [], forecast: before }).html,
    /data-testid="forecast-expect-open"/,
  );
  const html = month(before, undefined, { adjust });
  // One "Not regular" per usual item, named for a screen reader; none on a prepared transfer.
  const usual = before.accounts[0].events.filter((e) => e.source !== 'prepared');
  assert.deepEqual(
    [...html.matchAll(/data-testid="forecast-exclude" aria-label="Do not count ([^"]+)"/g)].map(
      (m) => m[1],
    ),
    usual.map((e) => e.label),
  );
  // After the expect: the customer's row with Remove, the server's verdict naming it, the
  // second form of the source line, and the cover option of the new shortfall.
  const added = month(expected, undefined, { adjust });
  const [a] = expected.accounts;
  assert.ok(
    added.includes(
      `<p class="verdict-headline" tabindex="-1">${a.headline}</p><p class="verdict-sub">${a.explanation}</p>`,
    ),
  );
  assert.equal(a.headline, '€13.28 short on 25 Oct');
  assert.match(
    a.explanation,
    /and Car insurance \(€2,900\.00, on the 25th, added by you\) comes, on 25 Oct you would be €13\.28 short for Car insurance, added by you\. An estimate\.$/,
  );
  assert.ok(added.includes('Added by you · estimated'));
  assert.equal(count(added, 'forecast-adjustment-remove'), 1);
  assert.equal(count(added, 'forecast-exclude'), usual.length); // none on the customer's own row
  assert.ok(added.includes('data-testid="forecast-prepare"'));
  assert.match(expected.sourceLine, /your prepared transfers and what you added or left out\./);
  assert.ok(added.includes(`<p class="plan-source">${expected.sourceLine}</p>`));
  assert.ok(
    month(covered, undefined, { adjust }).includes(
      'An estimate: it counts 4 usual payments and 1 added by you.',
    ),
  );
  // After the exclude: the server's text in "Not counted" with "Count it again"; the status line.
  const after = month(excluded, undefined, {
    adjust: { ...adjust, status: { text: 'Spotify is no longer counted.', undoId: 'x' } },
  });
  assert.ok(after.includes('Spotify: left out by you, not counted.<button'));
  assert.ok(after.includes('Count it again') && count(after, 'forecast-exclude-undo') === 1);
  assert.equal(count(after, 'forecast-adjustment-remove'), 2); // the charge's row, Spotify's row
  // Every adjustment of the scene is on a row already: no second list.
  for (const f of [expected, covered, excluded]) assert.deepEqual(hiddenAdjustments(f), []);
  assert.equal(count(after, 'forecast-adjustments'), 0);
  // The other reasons FC2 sends: the server's text, and "Remove" for the customer's charge.
  const twice = structuredClone(covered);
  twice.notCounted.push({
    label: 'Car insurance',
    reason: 'already_prepared',
    adjustmentId: 'adj-9',
    text: 'Car insurance (€2,900.00, added by you): a prepared transfer like it is already counted, not counted twice.',
  });
  assert.match(
    month(twice, undefined, { adjust }),
    /already counted, not counted twice\.<button[^>]*data-testid="forecast-adjustment-remove"[^>]*>Remove</,
  );
  // A label is the customer's text: printed as text.
  const odd = structuredClone(expected);
  odd.accounts[0].events.find((e) => e.adjustmentId)!.label = '<img src=x onerror=alert(1)>';
  assert.ok(
    !renderToStaticMarkup(createElement(MonthAhead, { ...monthProps(odd), adjust })).includes(
      '<img',
    ),
  );
});

test('a cover prepared earlier does not hide the option of a shortfall that came after it', () => {
  // Step 2 of the take left a done cover; step 3 added a charge: the server offers a new option.
  const [account] = expected.accounts;
  const old = {
    ...account.options[0],
    id: 'old',
    title: 'Move €30.00 from Personal savings on 19 Oct',
  };
  const done = {
    accountId: account.id,
    options: [old],
    option: old,
    // The prepared transfer the covered forecast counts (follow-up: the line is tied to it).
    preparedId: covered.accounts[0].events.find((e) => e.preparedId)!.preparedId!,
    phase: 'done' as const,
  };
  const html = text(
    renderToStaticMarkup(
      createElement(MonthAhead, { ...monthProps(expected), cover: done, adjust }),
    ),
  );
  assert.ok(html.includes(account.options[0].title) && !html.includes(old.title));
  assert.ok(html.includes('data-testid="forecast-prepare"') && !html.includes('forecast-undo'));
  // While the account is covered (no option offered) the done cover keeps its Undo.
  const still = text(
    renderToStaticMarkup(
      createElement(MonthAhead, { ...monthProps(covered), cover: done, adjust }),
    ),
  );
  assert.ok(still.includes('data-testid="forecast-undo"'));
});

test('FC2: an adjustment that is in no row of this month can still be seen and removed', () => {
  // A one-off dated next month and a monthly charge whose day has passed: only in `adjustments`.
  assert.deepEqual(
    hiddenAdjustments(hidden).map((a) => a.id),
    ['adj-next-month', 'adj-day-passed'],
  );
  assert.deepEqual(
    hidden.adjustments!.map((a) => adjustmentWords(a, hidden.today)),
    ['Expected once: Dentist, €180.00 on 12 Nov', 'Expected: Gym, €39.90 on the 3rd of each month'],
  );
  assert.equal(
    adjustmentWords({ ...hidden.adjustments![0], date: '2027-01-05' }, hidden.today),
    'Expected once: Dentist, €180.00 on 5 Jan 2027',
  );
  assert.equal(
    adjustmentWords(
      { ...excluded.adjustments!.find((a) => a.kind === 'exclude')! },
      excluded.today,
    ),
    'Left out: Spotify',
  );
  const html = month(hidden, undefined, { adjust });
  assert.match(
    html,
    /data-testid="forecast-adjustments"><summary>Your adjustments not in this month · 2</,
  );
  assert.equal(count(html, 'forecast-adjustment-remove'), 2);
  // Without the marker nothing of it shows.
  assert.equal(count(month({ ...hidden, adjustable: undefined }), 'forecast-adjustments'), 0);
});

test('the previews of an exclude and of an expected charge are the sums the server makes', () => {
  // Expect: "Car insurance €2,900 on the 25th" on the forecast before it is the server's
  // forecast after it, to the cent; its cover option previews the covered one's lowest point.
  const form = {
    label: ' Car insurance ',
    amount: '2900',
    repeats: 'once' as const,
    date: '2026-10-25',
    day: '',
  };
  const made = expectOf(form, before, 'acc-lucia')!;
  assert.deepEqual(made.body, {
    kind: 'expect',
    accountId: 'acc-lucia',
    label: 'Car insurance',
    amountCents: 290000,
    repeats: 'once',
    date: '2026-10-25',
  });
  const ghost = frameOf(before.accounts[0], before.today, made.change);
  assert.deepEqual(ghost.lowest, expected.accounts[0].lowest);
  assert.deepEqual(ghost.lowest, { date: '2026-10-25', balanceCents: -1328 });
  assert.equal(ghost.endCents, expected.accounts[0].endCents);
  const [option] = expected.accounts[0].options;
  assert.equal(option.title, 'Move €20.00 from Personal savings on 24 Oct');
  const cover = frameOf(expected.accounts[0], expected.today, option.change);
  assert.deepEqual(cover.lowest, covered.accounts[0].lowest);
  assert.equal(cover.lowest.balanceCents, 672);
  // Exclude: the covered line without Spotify is the server's forecast after it.
  const spotify = covered.accounts[0].events.find((e) => e.label === 'Spotify')!;
  const gone = frameOf(withoutEvent(covered.accounts[0], spotify), covered.today);
  assert.deepEqual(gone.lowest, excluded.accounts[0].lowest);
  assert.equal(gone.endCents, excluded.accounts[0].endCents);
  // Every month on the 25th: the same item this month; a day already past is not in this month.
  const monthly = expectOf({ ...form, repeats: 'monthly', day: '25' }, before, 'acc-lucia')!;
  assert.deepEqual(monthly.body, {
    kind: 'expect',
    accountId: 'acc-lucia',
    label: 'Car insurance',
    amountCents: 290000,
    repeats: 'monthly',
    day: 25,
  });
  assert.deepEqual(monthly.change, made.change);
  assert.equal(
    expectOf({ ...form, repeats: 'monthly', day: '3' }, before, 'acc-lucia')!.change,
    null,
  );
  assert.equal(expectOf({ ...form, date: '2026-11-02' }, before, 'acc-lucia')!.change, null);
});

test('the expected-charge form checks what the amount field of Transfers checks', () => {
  const ok = {
    label: 'Car insurance',
    amount: '420,50',
    repeats: 'once' as const,
    date: '2026-10-25',
    day: '',
  };
  const bad = (patch: object) =>
    Object.entries(expectErrors({ ...ok, ...patch }, '2026-10-06'))
      .filter(([, v]) => v)
      .map(([k]) => k);
  assert.deepEqual(bad({}), []);
  assert.deepEqual(bad({ label: '  ' }), ['label']);
  // A control or bidirectional-override character is the server's to refuse (400), in its words.
  assert.deepEqual(bad({ label: 'Car\u202Einsurance' }), []);
  assert.ok(LABEL_HINT);
  for (const amount of ['', '0', '-5', '1e3', '12.345', 'abc'])
    assert.deepEqual(bad({ amount }), ['amount'], amount);
  for (const date of ['', '2026-10-05', '2027-10-08'])
    assert.deepEqual(bad({ date }), ['date'], date);
  assert.deepEqual(bad({ date: '2027-10-07' }), []); // today + 366 days
  for (const day of ['', '0', '32', '1.5', 'x'])
    assert.deepEqual(bad({ repeats: 'monthly', day }), ['day'], day);
  assert.deepEqual(bad({ repeats: 'monthly', day: '31', date: '' }), []);
  assert.equal(expectOf({ ...ok, amount: '0' }, before, 'acc-lucia'), null);
});

test("the two calls of FC2: paths, bodies, answers; each refusal in the server's words", async () => {
  const seen: unknown[] = [];
  const api = async (path: string, body?: unknown, method?: string) => {
    seen.push([path, body, method]);
    // 201 and the 200 of a repeated exclusion carry the same body: both are a success here.
    return method === 'DELETE' ? { removed: true } : { adjustment: { id: 'adj-1' } };
  };
  const body = { kind: 'exclude' as const, accountId: 'acc-lucia', merchantKey: 'SPOTIFY' };
  assert.equal((await addAdjustment(api, body)).id, 'adj-1');
  assert.equal(await removeAdjustment(api, 'adj 1'), true);
  assert.deepEqual(seen, [
    ['forecast/adjustments', body, undefined],
    ['forecast/adjustments/adj%201', undefined, 'DELETE'],
  ]);
  const cap = 'You already have 20 changes to your month ahead. Remove one before adding another.';
  assert.equal(
    isRefusedLabel(Object.assign(new Error('Invalid request data.'), { status: 400 })),
    true,
  );
  for (const status of [404, 409])
    assert.equal(isRefusedLabel(Object.assign(new Error(cap), { status })), false);
  // The cap and a 404 print the server's sentence and keep the actions (no "not available").
  const full = month(before, undefined, { adjust: { ...adjust, error: cap } });
  assert.ok(full.includes(`role="alert">${cap}</p>`));
  assert.match(full, /forecast-exclude/);
  assert.match(full, /forecast-expect-open/);
});
