// PL1 (plan 28 §4.5, §6.1, D14, D15; REQ-PL-33, REQ-PL-34): the brief. What the rules already
// found for one customer, under a fixed headline. Pure: no bank request, no model, no clock, no
// write. Every figure is the text of the piece that computed it (the forecast's `headline`, the
// goal's `headline`, the observation's `basis`), so the brief cannot disagree with its source and
// does not care which sources the forecast counted (FC2's `expected_by_you` included).
import type { MonthForecast } from '../forecast/month';
import type { GoalView } from '../goals/store';
import type { Observation } from '../observations/detect';

export type BriefFinding = {
  kind: 'forecast_shortfall' | 'goal_behind' | 'category_up';
  text: string;
  accountId?: string;
  goalId?: string;
};
export type Brief = { headline: string; findings: BriefFinding[] };

const MAX_FINDINGS = 5; // listed; the headline counts all of them
const HEADLINES = [
  'Nothing needs a look this month.',
  'One thing to look at.',
  'Two things to look at.',
];

export function planBrief(i: {
  forecast: Pick<MonthForecast, 'accounts'> | null;
  goals: Pick<GoalView, 'id' | 'name' | 'behindCents' | 'headline'>[];
  observations: Pick<Observation, 'key' | 'kind' | 'basis'>[]; // what the rules found, in order
  dismissed: string[]; // observation keys the customer dismissed
  // D15: false when the customer turned observations off, or the bank has them off. The
  // shortfall and `category_up` come unasked, so they go; a goal is the customer's own plan.
  observationsOn: boolean;
  // Review of #185 (plan 26 D7): an open case, a transfer in trouble or a pending approval. The
  // bank does not point at a spending habit then, so `category_up` goes, as the card does. A
  // shortfall and a goal behind are about the customer's own money and plans: they stay.
  trouble: boolean;
}): Brief {
  const shortfalls = (i.forecast?.accounts ?? [])
    .filter((a) => a.shortfall)
    .sort((a, b) => a.shortfall!.date.localeCompare(b.shortfall!.date))
    .map((a): BriefFinding => ({
      kind: 'forecast_shortfall',
      // The forecast's own headline; an estimate is never stated as a fact (§5.4).
      text: `${a.label}: ${a.headline}.${a.shortfall!.certainty === 'estimated' ? ' An estimate.' : ''}`,
      accountId: a.id,
    }));
  // A goal that is `behind` for a waiting payment alone has behindCents 0: not a finding.
  const goals = i.goals
    .filter((g) => g.behindCents > 0)
    .sort((a, b) => b.behindCents - a.behindCents)
    .map((g): BriefFinding => ({
      kind: 'goal_behind',
      text: `${g.name}: ${g.headline}.`,
      goalId: g.id,
    }));
  const up = i.observations.find((o) => o.kind === 'category_up' && !i.dismissed.includes(o.key));
  const all = [
    ...(i.observationsOn ? shortfalls : []),
    ...goals,
    ...(i.observationsOn && !i.trouble && up
      ? [{ kind: 'category_up' as const, text: up.basis }]
      : []),
  ];
  return {
    headline: HEADLINES[all.length] ?? `${all.length} things to look at.`,
    findings: all.slice(0, MAX_FINDINGS),
  };
}
