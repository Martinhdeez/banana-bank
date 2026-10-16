// SI2a: the deterministic tiers of the spend classifier (plan 23, contracts.md §1 "Labelling
// rules"). Facts first, then the customer's rule, then the regex dictionary. First hit wins, and a
// rule that is not sure abstains (null) so the decider or the customer decides. Pure.
//
// Only the merchant part of a description can decide a category: its leading words, before any
// free text. What a third party writes (a concept, a reference, an instruction) gives candidates.
import {
  FREE_TEXT,
  INCOME,
  OPENING,
  OWN_MONEY,
  PRIORITY,
  REFUND,
  REFUND_WEAK,
  RULES,
  SENTINEL,
  TAX,
  TRANSFER_LIKE,
  TRANSFER_PERSON,
  TRANSFER_WRAPPER,
  VOCABULARY,
} from './dictionary';
import type { Entry } from './dictionary';
import { matchText, merchantKey } from './normalize';
import { allowedFor } from './taxonomy';
import type { CategoryId, MovementInput } from './taxonomy';

export type RuleHit = {
  category: CategoryId;
  source: 'user_rule' | 'rule';
  state: 'confirmed' | 'estimated';
  reason: string; // contracts.md §1 "Reasons"
  candidates: { category: CategoryId; p: null }[]; // tier 2 only
};
export type RuleContext = {
  ownAccountIds: ReadonlySet<string>;
  ownPairOperationIds: ReadonlySet<string>; // operations with two legs on own accounts in this bank answer
  userRules: ReadonlyMap<string, CategoryId>; // merchant key → category
};

// A source never matches inside a longer word.
const word = (source: string) => new RegExp(`(?<![A-Z0-9])(?:${source})(?![A-Z0-9])`);
// A weak source matches only as the first word of a merchant name, after an article.
const first = (source: string) => new RegExp(`^(?:(?:EL|LA|LOS|LAS|THE) )?(${source})(?![A-Z0-9])`);
const compile = (entries: readonly Entry[], re = word) =>
  entries.map(([category, source]) => ({ category, re: re(source) }));
const priority = compile(PRIORITY);
const strong = compile(RULES);
const weak = compile(VOCABULARY);
const weakFirst = compile(VOCABULARY, first);
const person = compile(TRANSFER_PERSON);
const income = compile(INCOME);
const [refund, refundWeak, tax, transferLike, ownMoney] = [
  REFUND,
  REFUND_WEAK,
  TAX,
  TRANSFER_LIKE,
  OWN_MONEY,
].map(word);
const [opening, sentinel, wrapper, freeText] = [
  OPENING[1],
  SENTINEL,
  TRANSFER_WRAPPER,
  FREE_TEXT,
].map((source) => new RegExp(source));

// No real description is longer. The dictionary is matched against at most this much text,
// whatever a third party writes in a description or a concept (the merchant key reads the whole
// text, in linear time).
const MAX_TEXT = 500;
const text = (s: string) => matchText(s).slice(0, MAX_TEXT);
const words = (s: string, n: number) => s.split(' ', n).join(' ');
// The merchant part: before the first free-text separator, and no more than six words (a channel
// prefix and a card mask, then about four words of name).
const merchantPart = (t: string) => words(t.slice(0, freeText.exec(t)?.index ?? t.length), 6);

type Match = { category: CategoryId; match: string };
// The first match of each category, in dictionary order.
function matches(
  rules: typeof strong,
  s: string,
  group = 0,
  found = new Map<CategoryId, string>(),
) {
  for (const { category, re } of rules) {
    const m = found.has(category) ? null : re.exec(s);
    if (m) found.set(category, m[group]);
  }
  return found;
}
const list = (found: Map<CategoryId, string>): Match[] =>
  [...found].map(([category, match]) => ({ category, match }));
const override = (s: string): Match | undefined => {
  for (const { category, re } of priority) {
    const m = re.exec(s);
    if (m) return { category, match: m[0] };
  }
};

// What may DECIDE: the brands in the merchant part and a generic word that starts the merchant
// name. Exactly one category is a decision; more is a tie, and the rules never guess.
function decisive(part: string): Match[] {
  return list(matches(weakFirst, merchantKey(part), 1, brands(part)));
}
function brands(s: string) {
  const o = override(s);
  return o ? new Map<CategoryId, string>([[o.category, o.match]]) : matches(strong, s);
}

// What a text MENTIONS, wherever it stands: candidates only.
const mentioned = (s: string): CategoryId[] => [...matches(weak, s, 0, brands(s)).keys()];
const candidates = (categories: CategoryId[]): RuleHit['candidates'] =>
  [...new Set(categories)].slice(0, 3).map((category) => ({ category, p: null }));

const hit = (category: CategoryId, reason: string, suggested: CategoryId[] = []): RuleHit => ({
  category,
  source: 'rule',
  state: 'estimated',
  reason,
  candidates: candidates(suggested),
});

export function applyRules(m: MovementInput, ctx: RuleContext): RuleHit | null {
  const t = text(m.description);
  const part = merchantPart(t);
  const debit = m.amountCents < 0;
  // The guaranteed unknown matches no global rule: facts and the customer's rule still apply.
  const unknown = sentinel.test(t);
  const own = (id?: string) => id !== undefined && ctx.ownAccountIds.has(id);

  // 1. Own account: the app's record, an own pair in this bank answer, or an own id in the text.
  const wrapped = wrapper.exec(t);
  const named = wrapped?.[1];
  if (
    (own(m.fromAccountId) && own(m.toAccountId)) ||
    (!!m.operationId && ctx.ownPairOperationIds.has(m.operationId)) ||
    (!!named && [...ctx.ownAccountIds].some((id) => id.toUpperCase() === named))
  ) {
    return hit('savings_internal', 'own_account');
  }

  // 2. Transfer to a person. The purpose words of its concept are candidates, never the category.
  if (
    [m.fromAccountId, m.toAccountId].some((id) => id !== undefined && !own(id)) ||
    wrapped ||
    (!unknown && person.some((r) => r.re.test(part)))
  ) {
    if (!debit) return hit('income', 'credit');
    const concept =
      m.concept !== undefined ? text(m.concept) : wrapped ? t.slice(wrapped[0].length) : t;
    return hit(
      'transfer_person',
      'person_transfer',
      mentioned(concept).filter((c) => c !== 'other'),
    );
  }

  // 3. Opening rows.
  if (opening.test(t)) return hit('other', 'opening_balance');

  // 4. The customer's own rule for the merchant, when the sign allows its category.
  const key = ctx.userRules.size ? merchantKey(m.description) : '';
  const category = key ? ctx.userRules.get(key) : undefined;
  if (category && allowedFor(debit ? 'debit' : 'credit', category)) {
    return {
      category,
      source: 'user_rule',
      state: 'confirmed',
      reason: `user_rule:${key}`,
      candidates: [],
    };
  }

  if (unknown) return null;
  const lead = words(part, 3);
  const found = decisive(part);

  // 5. Credits. A refund takes the merchant's category; own-money wording is not income, and
  // without an account fact it is not savings either; any other credit is income.
  if (!debit) {
    const refunded = refund.exec(part);
    if (refunded && tax.test(part)) return hit('other', 'tax_refund');
    if (refunded) {
      return found.length === 1
        ? hit(found[0].category, `refund:${found[0].match}`)
        : hit('other', `refund:${refunded[0]}`);
    }
    if (refundWeak.test(part) && found.length === 1 && !income.some((r) => r.re.test(part))) {
      return hit(found[0].category, `refund:${found[0].match}`);
    }
    return ownMoney.test(lead) ? null : hit('income', 'credit');
  }

  // 6. Debits. What looks like an outgoing transfer or own money, with no account fact, is not
  // decided by the words of its concept. Otherwise exactly one category, or no decision.
  if (transferLike.test(lead) || ownMoney.test(lead)) return null;
  return found.length === 1 ? hit(found[0].category, `keyword:${found[0].match}`) : null;
}

// What to offer the customer when applyRules abstains: the categories the description and the
// concept mention, at most three. Never a decision.
export function ruleCandidates(m: MovementInput): RuleHit['candidates'] {
  const t = text(m.description);
  if (sentinel.test(t)) return [];
  const debit = m.amountCents < 0;
  const all = m.concept === undefined ? t : `${t} ${text(m.concept)}`;
  const lead = words(merchantPart(t), 3);
  const facts: CategoryId[] = ownMoney.test(lead)
    ? ['savings_internal']
    : debit && transferLike.test(lead)
      ? ['transfer_person']
      : [];
  return candidates(
    [...facts, ...mentioned(all)].filter(
      (c) => c !== 'other' && allowedFor(debit ? 'debit' : 'credit', c),
    ),
  );
}
