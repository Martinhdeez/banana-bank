// SI6b — contracts.md §4 "Quick replies and their target". Pure. The buttons under an assistant
// message and what the customer's next answer is about (`awaiting`) are derived from the tool
// results of the run and the attached movement: server data only, never model text.
import { categoryLabel, type Candidate, type CategoryId } from '../insights/taxonomy';
import type { MessageExtras } from './extras';

export type ToolRun = { name: string; args: unknown; result: unknown };
// What suggest_category_choices returns about a movement (the fields used here).
export type Choices = {
  movementId: string;
  merchant: string;
  state: string;
  candidates: Candidate[];
};
// PA1 review: the cover a shortfall answer offered, stored with that answer (as `goalPlan` is):
// prepare_cover prepares exactly `prepare` after the customer's yes. The model never copies it.
export type CoverOffer = { title: string; prepare: Record<string, unknown> };
type Out = Pick<MessageExtras, 'quickReplies' | 'awaiting'> & { coverOffer?: CoverOffer };
type Done = { args: Record<string, any>; result: Record<string, any> };

const reply = (label: string, value = label) => ({ label, value });

// XS6: the value a click on "Review them" sends; reviewNudged (insights.ts) finds the nudge by it.
export const REVIEW_VALUE = 'Review the movements to classify';
// PA1: the value a click on "Yes, prepare it" sends; prepare_cover counts it as a yes.
export const COVER_VALUE = 'Yes, prepare the transfer that covers it';

// `nudge` false: the review offer (4) is not attached (XS6: once per conversation, and never on
// a turn that carries a product suggestion).
export function quickRepliesFor(runs: ToolRun[], attached: Choices | null, nudge = true): Out {
  const done = (name: string) =>
    runs.filter(
      (r) => r.name === name && (r.result as { status?: string } | null)?.status === 'ok',
    ) as Done[];
  const sets = done('set_movement_category');
  // 1. A category was set and other movements share the merchant: the one-time offer.
  const offered = sets.filter((r) => r.result.similar && !r.result.ruleCreated).at(-1);
  if (offered) {
    const { merchant, count } = offered.result.similar as { merchant: string; count: number };
    return {
      quickReplies: [
        reply(`Yes, apply to the other ${count}`, 'Yes, apply it to all of them'),
        reply('No, only this one'),
      ],
      awaiting: {
        movementIds: [offered.args.movementId],
        merchantKey: merchant,
        offer: { category: offered.result.category as CategoryId },
      },
    };
  }
  // 2. The last movement the run asked about, unless the run settled it. 3. Else the attached
  // movement when it is in review and nothing was set.
  const settled = new Set(sets.map((r) => r.args.movementId));
  const suggested = done('suggest_category_choices').at(-1)?.result as Choices | undefined;
  const asked =
    suggested && !settled.has(suggested.movementId)
      ? suggested
      : !sets.length && attached?.state === 'needs_review'
        ? attached
        : null;
  if (asked)
    return {
      quickReplies: [
        // `other` is the "Other" button: the customer then says which category in their words.
        ...asked.candidates
          .filter((c) => c.category !== 'other')
          .map((c) => reply(categoryLabel(c.category))),
        reply('Other', 'Another category'),
        reply('Skip'),
      ],
      awaiting: { movementIds: [asked.movementId], merchantKey: asked.merchant },
    };
  // 4. A spending answer with movements still to review: the offer to go through them.
  const summary = done('get_spending_summary').at(-1)?.result;
  if (nudge && summary?.unresolved?.count > 0)
    return {
      quickReplies: [reply('Review them', REVIEW_VALUE), reply('Not now')],
    };
  // 5. PA1: a prepare that left its account short, with a way to cover it: one reply asking for it.
  const saved = runs.filter((r) => /^(prepare_transfer|prepare_cover|create_goal)$/.test(r.name));
  const cover = (saved.at(-1)?.result as { afterThis?: { cover?: any } } | null)?.afterThis?.cover;
  if (cover)
    return {
      quickReplies: [reply('Yes, prepare it', COVER_VALUE)],
      coverOffer: { title: cover.title, prepare: cover.prepareWith },
    };
  return {};
}
