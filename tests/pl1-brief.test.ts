// PL1 (plan 28 §4.5, §6.1, D14, D15; REQ-PL-33, REQ-PL-34): the brief. One check per real risk:
// a false figure or an estimate read as a fact, the observations switch, "€0.00 behind plan",
// and the route (operator, another customer's data, a write caused by reading). The sources are
// built by the forecast's and the goals' own functions, so a finding is compared with what the
// customer sees elsewhere. Simulator bank, DECIDER=none: no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
import type { ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-pl1-');
const { planBrief } = await import('../src/plan/brief');
const { monthForecast } = await import('../src/forecast/month');
const { goalFigures, occurrence } = await import('../src/goals/plan');
const { seedApp } = await import('../src/seed');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { appDb, closeAppDb } = await import('../src/db');
const { today } = await import('../src/banking/prepared');
seedApp();
seedBank();
const bank = await startSimulator();
after(() => {
  bank.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const cents = (text: string) =>
  [...text.matchAll(/€([\d,]+\.\d\d)/g)].map((m) =>
    Math.round(Number(m[1].replace(/,/g, '')) * 100),
  );

// FC1's own scene: Digi and Spotify come as in July–September, then €3,000.00 to Bruno on the
// 20th leaves the main account €28.28 short (an estimate). Savings is short for a prepared
// transfer alone on the 25th (certain).
const monthly = (day: string, amountCents: number, description: string) =>
  ['07', '08', '09'].map((m) => ({
    accountId: 'acc',
    amountCents,
    description,
    createdAt: `2026-${m}-${day}T10:00:00.000Z`,
  }));
const prepared = (over: Partial<PreparedView>) =>
  ({ to: 'Bruno', state: 'scheduled', ...over }) as PreparedView;
const forecast = monthForecast({
  accounts: [
    { id: 'sav', label: 'Savings', balanceCents: 500_00 },
    { id: 'acc', label: 'Main account', balanceCents: 3022_61 },
  ],
  movements: [
    {
      accountId: 'acc',
      amountCents: 1,
      description: 'Deposit',
      createdAt: '2026-07-01T10:00:00.000Z',
    },
    ...monthly('10', -39_90, 'DIGI SPAIN TELECOM'),
    ...monthly('14', -10_99, 'SPOTIFY'),
  ],
  prepared: [
    prepared({ id: 'p1', fromAccountId: 'acc', amountCents: 3000_00, nextDue: '2026-10-20' }),
    prepared({ id: 'p2', fromAccountId: 'sav', amountCents: 600_00, nextDue: '2026-10-25' }),
  ],
  today: '2026-10-06',
} as ForecastInput);
const [main, savings] = ['acc', 'sav'].map((id) => forecast.accounts.find((a) => a.id === id)!);
const only = (id: string) => ({ accounts: forecast.accounts.filter((a) => a.id === id) });

const figures = (monthlyCents: number, nextDue: string, state: string, day: string) =>
  goalFigures({
    targetCents: 120_000,
    targetDate: '2027-03-31',
    savedCents: 0,
    prepared: { amountCents: monthlyCents, nextDue, state: state as PreparedView['state'] },
    last: { amountCents: monthlyCents, day: 10 },
    today: day,
  });
const goal = (id: string, name: string, f: ReturnType<typeof figures>) => ({ id, name, ...f });
const trip = goal('g-trip', 'Trip', figures(15_000, '2026-10-10', 'scheduled', '2026-10-07'));
const bike = goal('g-bike', 'Bike', figures(10_000, '2026-10-10', 'scheduled', '2026-10-07'));
// `behind` only because the payment of the 10th is not sent yet: behindCents is 0.
const waiting = goal('g-wait', 'Car', figures(20_000, '2026-10-10', 'due', '2026-10-12'));
const UP = {
  key: 'category_up:groceries:2026-09',
  kind: 'category_up' as const,
  basis:
    'Groceries: €412.30 in September (9 movements), €301.10 in August (7). Only movements classified by a rule or confirmed by you are counted.',
};
const none = {
  forecast: null,
  goals: [],
  observations: [],
  dismissed: [],
  observationsOn: true,
  trouble: false,
};

test("PL1 the headline per count; each finding is its source's own text and figure; an estimate says so", () => {
  assert.equal(main.shortfall?.certainty, 'estimated');
  assert.equal(savings.shortfall?.certainty, 'certain');
  assert.deepEqual([trip.behindCents, bike.behindCents], [30_000, 60_000]);

  assert.deepEqual(planBrief(none), { headline: 'Nothing needs a look this month.', findings: [] });
  assert.deepEqual(planBrief({ ...none, forecast: only('acc') }), {
    headline: 'One thing to look at.',
    findings: [
      {
        kind: 'forecast_shortfall',
        text: 'Main account: €28.28 short on 20 Oct. An estimate.',
        accountId: 'acc',
      },
    ],
  });
  assert.deepEqual(planBrief({ ...none, forecast: only('acc'), goals: [trip] }), {
    headline: 'Two things to look at.',
    findings: [
      {
        kind: 'forecast_shortfall',
        text: 'Main account: €28.28 short on 20 Oct. An estimate.',
        accountId: 'acc',
      },
      { kind: 'goal_behind', text: 'Trip: €300.00 behind plan.', goalId: 'g-trip' },
    ],
  });

  // Everything at once: shortfalls by date, goals by the amount behind, then the category.
  const all = { ...none, forecast, goals: [trip, waiting, bike], observations: [UP] };
  const four = planBrief({ ...all, goals: [trip, waiting] });
  assert.equal(four.headline, '4 things to look at.');
  assert.deepEqual(
    four.findings.map((f) => [f.kind, f.accountId ?? f.goalId]),
    [
      ['forecast_shortfall', 'acc'],
      ['forecast_shortfall', 'sav'],
      ['goal_behind', 'g-trip'],
      ['category_up', undefined],
    ],
  );
  const certain = four.findings[1].text;
  assert.equal(certain, 'Savings: €100.00 short on 25 Oct.');
  assert.doesNotMatch(certain, /estimate|If |Digi|Spotify/i);
  assert.equal(four.findings[3].text, UP.basis);
  // No figure of its own: a finding's amounts are its source's.
  for (const f of four.findings) {
    const account = forecast.accounts.find((a) => a.id === f.accountId);
    const source = account
      ? [account.shortfall!.shortCents]
      : f.goalId
        ? [trip.behindCents]
        : cents(UP.basis);
    assert.deepEqual(cents(f.text), source, f.text);
    if (account) assert.ok(f.text.includes(account.headline), "the forecast's own headline");
    if (account?.shortfall!.certainty === 'estimated') assert.ok(f.text.endsWith(' An estimate.'));
  }

  // The headline counts everything; at most five are listed.
  const many = planBrief({
    ...all,
    goals: ['a', 'b', 'c', 'd'].map((id) => ({ ...trip, id })).concat(bike),
  });
  assert.equal(many.headline, '8 things to look at.');
  assert.equal(many.findings.length, 5);
  assert.equal(many.findings[2].goalId, 'g-bike', 'the goal furthest behind first');

  // D15: observations off (by the customer or by the bank). The goal stays.
  assert.deepEqual(planBrief({ ...all, goals: [trip, waiting], observationsOn: false }), {
    headline: 'One thing to look at.',
    findings: [{ kind: 'goal_behind', text: 'Trip: €300.00 behind plan.', goalId: 'g-trip' }],
  });
  // A dismissed observation is not listed.
  const dismissed = planBrief({ ...all, goals: [], dismissed: [UP.key] });
  assert.deepEqual(
    [dismissed.headline, dismissed.findings.map((f) => f.kind)],
    ['Two things to look at.', ['forecast_shortfall', 'forecast_shortfall']],
  );
  // Review of #185: during trouble the category goes, as the "Worth a look" card does; a
  // shortfall and a goal behind stay.
  assert.deepEqual(
    planBrief({ ...all, goals: [trip], trouble: true }).findings.map((f) => f.kind),
    ['forecast_shortfall', 'forecast_shortfall', 'goal_behind'],
  );
  // REQ-PL-34: never "€0.00 behind plan".
  assert.equal(waiting.state, 'behind');
  assert.deepEqual(planBrief({ ...none, goals: [waiting] }).findings, []);
});

test("PL1 route: no brief for an operator; a customer's brief is their own; the switch holds; reading writes nothing", async () => {
  assert.equal('brief' in (await callApi('marta', 'dashboard')).body, false);
  assert.deepEqual((await callApi('lucia', 'dashboard')).body.brief, {
    headline: 'Nothing needs a look this month.',
    findings: [],
  });

  // Lucía: a goal lowered below what it needs, and €100,000.00 prepared for today (a certain
  // shortfall on any day this runs).
  const T = today();
  const created = await callApi('lucia', 'goals', {
    name: 'Holiday',
    targetCents: 120_000,
    targetDate: occurrence(T, 28, 5),
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    day: Number(T.slice(8)),
  });
  const id = created.body.goal.id;
  const adjusted = await callApi('lucia', `goals/${id}/adjust`, { monthlyCents: 5_000 });
  const behind = adjusted.body.goal;
  assert.ok(behind.behindCents > 0, JSON.stringify(adjusted.body));
  const big = await callApi('lucia', 'prepared', {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    amountCents: 10_000_000,
    concept: 'PL1',
    when: 'on_date',
    date: T,
  });
  assert.equal(big.body.status, 'prepared', JSON.stringify(big.body));

  const rows = () =>
    ['events', 'intents', 'approvals', 'prepared_transfers', 'goals'].map(
      (t) => (appDb().prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n,
    );
  const before = rows();
  const reads = await Promise.all(
    Array.from({ length: 6 }, (_, i) => callApi(i % 2 ? 'bruno' : 'lucia', 'dashboard')),
  );
  assert.deepEqual(rows(), before, 'reading the brief records nothing');
  for (const [i, r] of reads.entries()) {
    const { brief, forecast: f } = r.body;
    if (i % 2) {
      assert.deepEqual(brief.findings, [], 'Bruno sees nothing of Lucía');
      continue;
    }
    const short = f.accounts.find((a: any) => a.id === 'acc-lucia');
    assert.equal(brief.headline, 'Two things to look at.');
    assert.deepEqual(brief.findings, [
      {
        kind: 'forecast_shortfall',
        text: `${short.label}: ${short.headline}.`,
        accountId: 'acc-lucia',
      },
      { kind: 'goal_behind', text: `Holiday: ${behind.headline}.`, goalId: id },
    ]);
    assert.deepEqual(cents(brief.findings[0].text), [short.shortfall.shortCents]);
    assert.deepEqual(cents(brief.findings[1].text), [behind.behindCents]);
  }

  // D15 on the server: the customer's switch drops the shortfall, keeps the goal.
  await callApi('lucia', 'assistant-settings', { observations: false });
  const off = (await callApi('lucia', 'dashboard')).body;
  assert.ok(
    off.forecast.accounts.some((a: any) => a.shortfall),
    'the Plan page still has it',
  );
  assert.deepEqual(
    [off.brief.headline, off.brief.findings.map((f: any) => f.kind)],
    ['One thing to look at.', ['goal_behind']],
  );
});
