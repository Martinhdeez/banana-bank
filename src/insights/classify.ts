// SI4: the one entry point of the spend classifier (plan 23, contracts.md §1 "Pipeline entry
// point"). Stored rows and rules answer inside the call; what is left goes to the decider chain in
// the background, one run per customer. Server only.
import { config } from '../config';
import { log } from '../http';
import { usageScopeFor } from '../usage/record';
import { capState } from '../usage/cap';
import { DECIDER_OPTIONS, allowedFor } from './taxonomy';
import type { Candidate, CategoryId, MovementInput, RowCategory } from './taxonomy';
import {
  amountBucket,
  cleanDescription,
  dayBucket,
  genericKey,
  merchantKey,
  timeBucket,
} from './normalize';
import { applyRules, ruleCandidates } from './rules';
import {
  answers,
  askCount,
  fingerprint,
  saveAnswer,
  saveCategories,
  storedCategories,
  takeAsks,
  userRules,
} from './store';
import type { StoredCategory } from './store';
import { deciderChain, limiter } from './decider';
import { namedCategories } from './guard';
import type { Decider, Decision, DecisionItem, MerchantProfile } from './decider';

export type { MovementInput, RowCategory };

type Direction = 'debit' | 'credit';
type Verdict = Omit<RowCategory, 'merchantKey'>;
const direction = (m: MovementInput): Direction => (m.amountCents < 0 ? 'debit' : 'credit');
const verdict = (
  id: CategoryId,
  rest: Partial<Verdict> & Pick<Verdict, 'state' | 'source' | 'reason'>,
): Verdict => ({
  id,
  confidence: null,
  threshold: null,
  candidates: [],
  model: null,
  ...rest,
});
const review = (reason: string): Verdict =>
  verdict('other', { state: 'needs_review', source: 'none', reason });
const PENDING = verdict('other', { state: 'pending', source: 'none', reason: 'pending' });

// A model answer against the bar of its decider. Shown as a category only when the provider's
// choice (candidates[0], whatever the other probabilities say) is one a model may give, the sign
// allows it, it is not `other` and the confidence reaches the bar. Anything else goes to review
// with the candidates the sign allows. The tables do not constrain these values, so this does.
export function resolveDecision(
  decision: Decision,
  threshold: number,
  sign: Direction,
): Pick<Verdict, 'id' | 'state' | 'source' | 'reason' | 'confidence' | 'threshold' | 'candidates'> {
  const usable = (c: Candidate) =>
    DECIDER_OPTIONS.includes(c.category) && allowedFor(sign, c.category);
  const top = decision.candidates[0];
  const confidence = decision.confidence >= 0 && decision.confidence <= 1 ? decision.confidence : 0;
  const shown = !!top && usable(top) && top.category !== 'other' && confidence >= threshold;
  return {
    id: shown ? top.category : 'other',
    state: shown ? 'estimated' : 'needs_review',
    source: 'model',
    reason: shown ? 'model' : 'below_threshold',
    confidence,
    threshold,
    candidates: decision.candidates.filter(usable).slice(0, 3),
  };
}

// IT8: exported (with `safe`), so the summary's periods use the same month as the profile.
export const MADRID_MONTH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
});
// A bank may send a date that does not parse: that movement has no time, day or month label.
export const safe = <T>(label: () => T): T | null => {
  try {
    return label();
  } catch {
    return null;
  }
};
// The bucket holding at least two thirds of the movements, else `mixed`.
function typical<T extends string>(labels: (T | null)[]): T | 'mixed' {
  const counts = new Map<T, number>();
  for (const l of labels) if (l !== null) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const [label, n] of counts) if (n * 3 >= labels.length * 2) return label;
  return 'mixed';
}
// What a decider is told about a merchant (contracts.md §1 "Merchant profile"): labels over all
// its movements of one sign in the bank answer, never a raw amount, time or date.
export function merchantProfile(movements: MovementInput[]): MerchantProfile {
  const months = movements.map((m) => safe(() => MADRID_MONTH.format(new Date(m.createdAt))));
  const n = movements.length;
  const monthly = n >= 2 && !months.includes(null) && new Set(months).size === n;
  return {
    typical_time: typical(movements.map((m) => safe(() => timeBucket(m.createdAt)))),
    typical_day: typical(movements.map((m) => safe(() => dayBucket(m.createdAt)))),
    typical_amount: typical(movements.map((m) => amountBucket(m.amountCents))),
    occurrences: n <= 1 ? 'once' : monthly ? 'recurring_monthly' : n >= 4 ? 'frequent' : 'few',
  };
}
const NEUTRAL: MerchantProfile = {
  typical_time: 'mixed',
  typical_day: 'mixed',
  typical_amount: 'mixed',
  occurrences: 'once',
};

// The chain for one item: the first decider that answers decides; one that throws (its adapter
// has spent its attempt budget) passes the item on; when all failed the item goes to review.
// `text` is the bank description the item was made from: the one text the decider read.
async function decide(item: DecisionItem, deciders: Decider[], text: string): Promise<Verdict> {
  for (const decider of deciders) {
    try {
      const decision = await decider.classify(item);
      let resolved = resolveDecision(decision, decider.threshold, item.direction);
      // IG1: this is the one place a model's answer enters the pipeline, whatever the decider. An
      // answer that would be shown is not when it is the category the text itself names: a third
      // party writes that text, and it must never choose. Review, with the candidates kept.
      if (resolved.state === 'estimated' && namedCategories(text).includes(resolved.id))
        resolved = { ...resolved, id: 'other', state: 'needs_review', reason: 'named_in_text' };
      const cited = [item.profile.typical_time, item.profile.typical_day].filter(
        (l) => l !== 'mixed',
      );
      return {
        ...resolved,
        reason:
          resolved.reason === 'model' && cited.length
            ? `model:${cited.join(',')}`
            : resolved.reason,
        model: `${decider.id}:${decision.model}`,
      };
    } catch (error) {
      // IT7 (A11): an adapter logs its failed requests (decider_failed), but not an item it
      // refused before any request. The next decider gets the item.
      log('warn', 'decider_passed', { decider: decider.id, error: (error as Error).name });
    }
  }
  return review('decider_unavailable');
}

// movements[0] is the movement the item's description was cleaned from.
type Group = { item: DecisionItem; movements: MovementInput[] };
type Clock = () => Date;
const DAY_MS = 24 * 3600_000;
// contracts.md §6: at most 8 requests in flight, whatever the chain is made of.
const inFlight = limiter(8);
// One background run per customer at a time (in process: the app is one long-lived Node process).
const runs = new Map<string, Promise<void>>();
// The chain from the environment, built once: the configuration is read at import.
let envChain: Decider[] | undefined;
const chain = () => (envChain ??= deciderChain());
// Which decider answers first, for the summary: 'none' when the rules work alone.
export const activeDecider = (): Decider['id'] | 'none' => chain()[0]?.id ?? 'none';

// A row for the store. A movement going to review with no candidate of its own (no decider, a
// failed one, a model answer with nothing usable) gets what the rules can suggest, so the customer
// has quick choices; a decider's own candidates are kept.
const stored = (m: MovementInput, key: string, v: Verdict, now: Clock): StoredCategory => ({
  ...v,
  candidates: v.state === 'needs_review' && !v.candidates.length ? ruleCandidates(m) : v.candidates,
  merchantKey: key,
  movementId: m.id,
  fingerprint: fingerprint(m),
  updatedAt: now().toISOString(),
});
// Keys in the order of RowCategory, so a row classified in this call and one read back from the
// store serialize to the same bytes (IT8b).
const row = (c: StoredCategory): RowCategory => ({
  id: c.id,
  state: c.state,
  source: c.source,
  reason: c.reason,
  confidence: c.confidence,
  threshold: c.threshold,
  candidates: c.candidates,
  merchantKey: c.merchantKey,
  model: c.model,
});

// IT4 (A1): the deciders and pinned models an answer came from. An answer is reused only by the
// same chain: another provider or model id asks again.
const chainId = (deciders: Decider[]) =>
  deciders
    .map((d) => `${d.id}:${d.id === 'systemone' ? config.deciderModel : config.chatModel}`)
    .join(',');
// IT4 (A1): the start of the rolling day of the per-customer budget (DECIDER_DAILY_ITEMS).
const dayAgo = (now: Clock) => new Date(now().getTime() - DAY_MS).toISOString();

async function run(userId: string, groups: Group[], deciders: Decider[], now: Clock) {
  const started = Date.now();
  const counts = { items: groups.length, decided: 0, review: 0, unavailable: 0, overBudget: 0 };
  // IT4 (A1): budget is taken for the whole run before any request; an item that gets none is
  // stored `decider_budget` and sent when the day has room again (settle below).
  // SC1: a customer at the daily AI limit gets no ask at all: every item is `decider_budget`.
  const asks = capState(userId, now())
    ? new Map<string, never>()
    : takeAsks(
        userId,
        groups.map((g) => g.item.key),
        chainId(deciders),
        now().toISOString(),
        dayAgo(now),
        config.deciderDailyItems,
      );
  await Promise.all(
    groups.map(({ item, movements }) =>
      inFlight(async () => {
        const ask = asks.get(item.key);
        const v =
          ask === undefined
            ? review('decider_budget')
            : await decide(item, deciders, movements[0].description);
        // IT4 (A1): a paid answer is kept, so these movements are never asked twice (settle below).
        if (ask !== undefined && v.source === 'model')
          saveAnswer(ask, v, movements.map(fingerprint));
        // A row the customer confirmed meanwhile is kept by the store.
        saveCategories(
          userId,
          movements.map((m) => stored(m, merchantKey(m.description), v, now)),
        );
        counts[
          v.state === 'estimated'
            ? 'decided'
            : v.source === 'model'
              ? 'review'
              : ask === undefined
                ? 'overBudget'
                : 'unavailable'
        ]++;
      }),
    ),
  );
  log('info', 'classification_run', { ...counts, ms: Date.now() - started });
}

// The part that runs inside the call: stored rows, then rules, then what no decider can be asked.
// Returns the answer so far and the groups a decider must decide.
function settle(
  input: Parameters<typeof classifyMovements>[0],
  deciders: Decider[],
  now: Clock,
): { result: Map<string, RowCategory>; groups: Group[] } {
  const { userId, movements, ownAccountIds } = input;
  const known = storedCategories(userId, movements);
  let room: boolean | undefined;
  for (const [id, r] of known) {
    // A failed item is sent again after 24 hours; one stored with no decider, once there is one;
    // IT4: one left over the daily budget, once the rolling day has room.
    const stale =
      (r.reason === 'decider_unavailable' && now().getTime() - Date.parse(r.updatedAt) > DAY_MS) ||
      (r.reason === 'no_decider' && deciders.length > 0) ||
      (r.reason === 'decider_budget' &&
        // SC1: and the customer is not at the daily AI limit.
        (room ??=
          !capState(userId, now()) && askCount(userId, dayAgo(now)) < config.deciderDailyItems));
    if (stale) known.delete(id);
  }
  // Operations with two legs on own accounts in this answer: the same test as activityRows
  // (src/ui-helpers.ts) uses for "Between your accounts", so such a row is never income.
  const legs = new Map<string, number>();
  for (const m of movements)
    if (m.operationId && ownAccountIds.has(m.accountId))
      legs.set(m.operationId, (legs.get(m.operationId) ?? 0) + 1);
  const ctx = {
    ownAccountIds,
    ownPairOperationIds: new Set([...legs].filter(([, n]) => n === 2).map(([id]) => id)),
    userRules: userRules(userId),
  };

  const fresh: StoredCategory[] = [];
  const undecided: { m: MovementInput; key: string }[] = [];
  // IT4 (A1): what this chain already answered for this customer's movements, read at most once.
  let paid: Map<string, Verdict> | undefined;
  const keys = new Map(movements.map((m) => [m.id, merchantKey(m.description)]));
  for (const m of movements) {
    if (known.has(m.id)) continue;
    const key = keys.get(m.id)!;
    const hit = applyRules(m, ctx);
    if (hit && allowedFor(direction(m), hit.category)) {
      const { category, ...rest } = hit;
      fresh.push(stored(m, key, verdict(category, rest), now));
    } // IT5 (A3): channel words alone are no merchant either, so no decider is asked.
    else if (!key || genericKey(key)) fresh.push(stored(m, key, review('no_merchant'), now));
    else if (!deciders.length) fresh.push(stored(m, key, review('no_decider'), now));
    else {
      // IT4 (A1): a movement a decider already answered is not sent again when its row is gone
      // (a rule created and deleted): the stored answer is its decision, inside this call.
      const answer = (paid ??= answers<Verdict>(userId, chainId(deciders))).get(fingerprint(m));
      if (answer) fresh.push(stored(m, key, answer, now));
      else undecided.push({ m, key });
    }
  }
  if (fresh.length) saveCategories(userId, fresh);
  for (const r of fresh) known.set(r.movementId, r);

  const groupKey = (m: MovementInput) => `${keys.get(m.id)}|${direction(m)}`;
  const groups = new Map<string, Group>();
  for (const { m, key } of undecided) {
    const id = groupKey(m);
    const group = groups.get(id);
    if (group) group.movements.push(m);
    else {
      const all = movements.filter((x) => keys.get(x.id) === key && direction(x) === direction(m));
      groups.set(id, {
        item: {
          key: id,
          description: cleanDescription(m.description),
          direction: direction(m),
          profile: input.profile === false ? NEUTRAL : merchantProfile(all),
        },
        movements: [m],
      });
    }
  }
  const pending = new Set(undecided.map(({ m }) => m.id));
  const result = new Map<string, RowCategory>(
    movements.map((m) => {
      const r = pending.has(m.id) ? undefined : known.get(m.id);
      return [m.id, r ? row(r) : { ...PENDING, merchantKey: keys.get(m.id)! }];
    }),
  );
  return { result, groups: [...groups.values()] };
}

export async function classifyMovements(
  input: {
    userId: string;
    movements: MovementInput[]; // one bank answer
    ownAccountIds: ReadonlySet<string>;
    deciders?: Decider[]; // default: the chain from the environment
    wait?: boolean; // default false
    profile?: boolean; // default true
  },
  now: Clock = () => new Date(), // a seam for tests
): Promise<Map<string, RowCategory>> {
  const { userId, movements, wait = false } = input;
  const deciders = input.deciders ?? chain();
  let ranOwn = false;
  for (;;) {
    let settled;
    try {
      settled = settle(input, deciders, now);
    } catch (error) {
      // A store failure: nothing can be remembered, so nothing is sent to a decider either.
      log('error', 'classification_failed', { error: (error as Error).name });
      return new Map(
        movements.map((m) => [m.id, { ...PENDING, merchantKey: merchantKey(m.description) }]),
      );
    }
    const { result, groups } = settled;
    // After this call's own run nothing can be left, unless the store failed under it.
    if (!groups.length || ranOwn) return result;
    let current = runs.get(userId);
    if (!current) {
      ranOwn = true;
      // TR1 (plan 27 §5): the run's decider requests are recorded for this customer, whoever's
      // request is open around it; the conversation only when this customer's chat turn started it.
      current = usageScopeFor(userId, () => run(userId, groups, deciders, now))
        .catch((error) => log('error', 'classification_failed', { error: (error as Error).name }))
        .finally(() => runs.delete(userId));
      runs.set(userId, current);
    }
    if (!wait) return result;
    // A run already in flight may not know these movements: read again when it ends.
    await current;
  }
}
