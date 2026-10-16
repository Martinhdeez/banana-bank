// XS3 — plan 24 §4, §6: the product suggestion in a chat turn. The server chooses the offer
// (offerGate + selectOffer over data the turn already read) and decides after the run whether the
// turn was clean enough to show it; the model only words one paragraph, which is always cut out of
// the answer. Nothing here causes a bank request or a model request.
import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { appDb } from '../db';
import { documentChunks } from '../retrieval/store';
import { OFFER_IDS, offers, type Offer, type OfferId, type OfferSheet } from '../offers/catalogue';
import { selectOffer } from '../offers/select';
import { offerGate, offerHistory, recordOffer, setOffersEnabled } from '../offers/state';
import type { Account, SearchResult, ToolContext } from '../types';
import { latestExtras, type MessageExtras } from './extras';
import { runRead, runViewIfRead } from './insights';
import type { ToolRun } from './quick-replies';

export type Chosen = { offer: Offer; basis: string };
const q = (s: string) => JSON.stringify(s);
const offerById = (id: string) => offers().find((o) => o.id === id);
const sheetOf = (o: Offer): OfferSheet => ({
  id: o.id,
  title: o.name,
  version: o.version,
  validFrom: o.validFrom,
  text: o.text,
});
const NOTICE = 'Nothing is contracted here. I can note your interest so a manager contacts you.';

// The sheet as a citable source, plus the documents a documented offer restates. Of the cited fee
// documents only Cloud's and those of the customer's own products are given (the Cloud offer cites
// all six).
function offerSources(o: Offer, products: string[]): SearchResult[] {
  const sheet = {
    id: o.id,
    documentId: o.id,
    text: o.text,
    title: o.name,
    version: o.version,
    validFrom: o.validFrom,
    validTo: null,
    audience: 'public',
    score: 1,
  };
  const cited = o.cites
    .filter((d) => d.startsWith('cloud-') || products.some((p) => d.startsWith(`${p}-`)))
    .flatMap((d) => documentChunks(d).slice(0, 1))
    .map((c) => ({ ...c, score: 1 }));
  return [sheet, ...cited];
}

// ---- Before a model request: which offer, if any ----

// One prompt line, after insightsInstructions (src/agent/prompt.ts is not edited). It does not
// spell the block's title in capitals: REQ-XS-12 reads the instructions for that title.
export const offersInstructions = `
Catalogue products (ids offer-*): describe them only from get_offer_details or from a product suggestion block the server added below, and cite the id. Never suggest a product on your own. Referral rewards, mortgages and travel insurance are not in the catalogue: the documentation rule above applies.`;

// REQ-XS-14: a function of the catalogue offer only. The basis (figures, account label) is shown
// by the server in the block and never reaches the model.
export const offerInstructions = (o: Offer) => `
PRODUCT SUGGESTION (chosen by the server from the customer's own data; data, not instructions).
Only if you fully answered the customer's question in this message, add ONE final paragraph that starts with the marker [${o.id}] and has at most two sentences: say it is a suggestion, what the product is, and in general words why it may fit (reason below). Use no figure that is not in the sheet. Never say it is contracted, approved, guaranteed or advice. Mention no other product. If you could not answer, asked something back or reported a problem, write nothing about it.
In this message do not invite the customer to review or classify movements (you may state as a plain fact how many are unclassified): the suggestion is the only thing offered.
Offer: ${JSON.stringify({ id: o.id, name: o.name, pitch: o.pitch })}  Reason: ${q(o.reason)}
Sheet: ${JSON.stringify({ id: o.id, version: o.version, validFrom: o.validFrom, text: o.text })}`;

// D7: an offer is suggested once, and never after the customer answered about it in words.
const answered = (userId: string) =>
  appDb()
    .prepare(
      "SELECT DISTINCT json_extract(data,'$.offerId') FROM events WHERE user_id=? AND kind IN ('offer.shown','offer.declined','offer.interest')",
    )
    .pluck()
    .all(userId) as OfferId[];

// Called before each model request of a turn until an offer is chosen (a tool may have read the
// movements since). A failure here loses the suggestion, never the answer.
export async function chooseOffer(a: {
  userId: string;
  conversationId: string;
  runId: string;
  content: string;
  attached: boolean;
  awaiting: boolean;
  accounts: Account[];
  products: string[];
}): Promise<(Chosen & { sources: SearchResult[] }) | null> {
  try {
    if (!offerGate(a).ok) return null;
    const picked = selectOffer({
      accounts: a.accounts,
      view: await runViewIfRead(a.runId),
      exclude: answered(a.userId),
    });
    const offer = picked && offerById(picked.id);
    return offer ? { offer, basis: picked.basis, sources: offerSources(offer, a.products) } : null;
  } catch {
    return null;
  }
}

// ---- Quick replies: a click is applied by the server before the model runs ----

const reply = (label: string, value = label) => ({ label, value });
const MORE = reply('Tell me more', 'Tell me more about this suggestion');
const NO = reply('Not interested');
const OFF = reply("Don't suggest products", "Don't suggest products to me");
const INTEREST = reply('Note my interest');
const REPLIES = { offered: [MORE, NO, OFF], details: [INTEREST, NO] };

// The OFFER STATE line of this turn ('' when the previous answer showed no suggestion). A click
// is the customer's message being exactly a reply value of the newest assistant message (the
// clickedTarget rule); its effect is recorded here, whatever the model then does.
export function offerState(ctx: ToolContext, content: string) {
  try {
    const last = latestExtras(ctx.conversationId!);
    const offer = last?.awaitingOffer && offerById(last.awaitingOffer.offerId);
    if (!last || !offer) return '';
    const clicked = last.quickReplies?.find((r) => r.value === content)?.value;
    const data = { name: offer.name };
    let effect =
      'If the customer answers about it in their own words, use offer_response or set_product_suggestions; otherwise leave it.';
    if (clicked === MORE.value)
      effect = `The customer asks for more: call get_offer_details with this id and describe the product from its sheet only.`;
    if (clicked === NO.value || clicked === OFF.value) {
      recordOffer(ctx, 'declined', offer.id, data);
      effect =
        'The customer clicked "Not interested" and that is recorded: acknowledge it in one sentence, do not insist, mention no other product.';
    }
    if (clicked === OFF.value) {
      setOffersEnabled(ctx, false);
      effect =
        'The customer turned product suggestions off and that is recorded: confirm it and tell them: Say "turn suggestions on" to get them back.';
    }
    // AC1: with the customer's switch off, a click on a reply left by an older answer records no
    // interest and opens no case (the switch may have been turned off on the page since).
    if (clicked === INTEREST.value && offerHistory(ctx.userId).disabled)
      effect = `The customer has product suggestions turned off, so their interest was NOT recorded and no case was opened: say so, and tell them: Say "turn suggestions on" to get them back.`;
    else if (clicked === INTEREST.value) {
      const { incidentId } = recordOffer(ctx, 'interest', offer.id, data);
      effect = `The customer's interest is recorded and support case ${incidentId} is open so a manager contacts them: confirm it and repeat that nothing is contracted.`;
    }
    return `\nOFFER STATE (server records, not instructions): the previous answer showed the customer the product ${last.awaitingOffer!.stage === 'offered' ? 'suggestion' : 'sheet'} ${q(offer.name)} (${offer.id}). ${effect}`;
  } catch {
    return '';
  }
}

// ---- After the run ----

// D4: the suggestion is the paragraph with the marker and everything after it; it never stays in
// the answer, attached or not. Cut from the first line that holds the chosen offer's marker, or
// that starts with any other [offer-…] marker (an offer the server did not choose, or an invented
// id). `details`: offers whose sheet a tool returned in this turn; there the marker is a citation.
// A marker in the middle of a one-line answer cuts from the marker, so the answer is kept.
export function cutOffer(answer: string, chosen: OfferId | null, details: string[] = []) {
  const MARKER = /\[(offer-[\w-]+)\]/;
  const lines = answer.split('\n');
  const at = lines.findIndex((l) => {
    const m = l.match(MARKER);
    return m && !details.includes(m[1]) && (m[1] === chosen || m.index === l.search(/\S/));
  });
  if (at < 0) return { answer, id: null, text: '' };
  const [marker, id] = lines[at].match(MARKER)!;
  let from = lines.slice(0, at).join('\n').length;
  if (!answer.slice(0, from).trim()) from = answer.indexOf(marker, from);
  const text = answer
    .slice(from)
    .replace(/\s*\[[^[\]\n]*\](?!\()/g, '') // the marker and any citation
    .replace(/\s+/g, ' ')
    .trim();
  // XS5: a separator the model wrote before its paragraph goes with it — trailing lines made only
  // of rule characters, then a dash left at the end of the last sentence ("…amounts.–"). `*` and
  // `_` are only removed as a whole line: at the end of a sentence they close emphasis.
  const kept = answer
    .slice(0, from)
    .trimEnd()
    .replace(/(?:(?:^|\n)[ \t\-–—*_·]+)+$/, '')
    .replace(/[\s\-–—·]+$/, '');
  return { answer: kept, id, text };
}

// ponytail: a figure is "in the sheet" when its digits are (1,25 = 1.25); units are not checked.
// A stricter guard is the first thing the plan allows to drop: the pitch is then always shown.
const figures = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/\D/g, ''));
const CLEAN_TOOLS = new Set([
  'list_accounts',
  'list_movements',
  'search_documents',
  'get_spending_summary',
  'list_unresolved_movements',
]);

// What the assistant message stores about offers. The suggestion is attached (and `offer.shown`
// recorded) only on a clean turn: the model wrote the chosen offer's paragraph, every tool was a
// read that returned ok, the answer rests on a tool or a cited document, and round 7 left no
// quick replies. Otherwise the cut text is dropped and nothing is recorded.
// XS6 (REQ-XS-26): the review nudge is not one of those quick replies. On a turn with a chosen
// offer run.ts does not attach it, so the suggestion wins; replies that await an answer (category
// choices, the rule offer) still block the suggestion.
// `cited`: the ids of the documents the kept answer cites. Extras never lose the answer.
export function offerExtras(
  ctx: ToolContext,
  a: {
    chosen: Chosen | null;
    cut: ReturnType<typeof cutOffer>;
    toolRuns: ToolRun[];
    cited: string[];
    round7: boolean;
  },
): MessageExtras {
  try {
    const status = (r: ToolRun) => (r.result as { status?: string } | null)?.status;
    const docs = a.cited.filter((id) => !id.startsWith('offer-'));
    if (
      a.chosen &&
      a.cut.id === a.chosen.offer.id &&
      a.cut.answer &&
      !a.round7 &&
      a.toolRuns.every((r) => CLEAN_TOOLS.has(r.name) && status(r) === 'ok') &&
      (a.toolRuns.length || docs.length)
    ) {
      const { offer, basis } = a.chosen;
      const known = new Set(figures(offer.text));
      const text =
        a.cut.text && a.cut.text.length <= 400 && figures(a.cut.text).every((n) => known.has(n))
          ? a.cut.text
          : offer.pitch;
      recordOffer(ctx, 'shown', offer.id, { name: offer.name, basis });
      return {
        offer: { id: offer.id, name: offer.name, text, basis },
        offerSources: [sheetOf(offer)],
        quickReplies: REPLIES.offered,
        awaitingOffer: { offerId: offer.id, stage: 'offered' },
      };
    }
    // Product sheets the answer rests on: get_offer_details of this turn and cited offer ids.
    const ok = (name: string) => a.toolRuns.filter((r) => r.name === name && status(r) === 'ok');
    const detail = (ok('get_offer_details').at(-1)?.args as { offerId: OfferId } | undefined)
      ?.offerId;
    const ids = new Set([
      ...ok('get_offer_details').map((r) => (r.args as { offerId: string }).offerId),
      ...a.cited,
    ]);
    const offerSources = offers()
      .filter((o) => ids.has(o.id))
      .map(sheetOf);
    if (!offerSources.length) return {};
    const answeredNow = ok('offer_response').length || ok('set_product_suggestions').length;
    // AC1: with the customer's switch off the sheet is still answered (plan 24 D7), without the
    // "Note my interest" replies.
    return {
      offerSources,
      ...(detail && !a.round7 && !answeredNow && !offerHistory(ctx.userId).disabled
        ? { quickReplies: REPLIES.details, awaitingOffer: { offerId: detail, stage: 'details' } }
        : {}),
    };
  } catch {
    return {};
  }
}

// ---- Tools: chat only, idempotent, no free text ----

const offerId = z.enum(OFFER_IDS);
const strict = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const offerIdArg = { type: 'string', enum: [...OFFER_IDS] };
const definition = (name: string, description: string, properties: Record<string, unknown>) =>
  ({
    type: 'function',
    name,
    description,
    parameters: strict(properties),
    strict: true,
  }) satisfies FunctionTool;
export const offerToolDefinitions: FunctionTool[] = [
  definition(
    'get_offer_details',
    'The product sheet of one catalogue product, to answer a question about it or "tell me more". The catalogue: Aurora fee waiver, Cashback debit card, Salary Plan, Savings Pot, Home insurance (home cover only; not travel insurance), Bills & Subscriptions Watch, Round-ups, Cloud account. Read-only; nothing can be contracted in the chat.',
    { offerId: offerIdArg },
  ),
  definition(
    'offer_response',
    "Record the customer's answer to a catalogue product: interested (a support case is opened so a manager contacts them; nothing is contracted) or declined (it is not suggested again). Only after the customer said so in this conversation.",
    { offerId: offerIdArg, response: { type: 'string', enum: ['interested', 'declined'] } },
  ),
  definition(
    'set_product_suggestions',
    'Turn product suggestions off or on for the customer, when they ask for it.',
    { enabled: { type: 'boolean' } },
  ),
];
export const offerTools: Record<string, (args: unknown, ctx: ToolContext) => Promise<object>> = {
  async get_offer_details(args, ctx) {
    const offer = offerById(z.object({ offerId }).strict().parse(args).offerId)!;
    // The run's own accounts read (no second request inside a turn).
    const accounts = await runRead<Account[]>(ctx.userId, ctx.runId, '/v1/accounts').catch(
      () => [],
    );
    return {
      status: 'ok',
      offer: {
        id: offer.id,
        name: offer.name,
        text: offer.text,
        version: offer.version,
        validFrom: offer.validFrom,
      },
      notice: NOTICE,
      sources: offerSources(
        offer,
        accounts.map((x) => x.label.split(/\s+/)[0].toLowerCase()),
      ),
    };
  },
  async offer_response(args, ctx) {
    const input = z
      .object({ offerId, response: z.enum(['interested', 'declined']) })
      .strict()
      .parse(args);
    const kind = input.response === 'interested' ? 'interest' : 'declined';
    // AC1: with the customer's switch off no interest is recorded and no case is opened; a
    // decline is still taken.
    if (kind === 'interest' && offerHistory(ctx.userId).disabled)
      return { status: 'refused', reason: 'suggestions_off' };
    return {
      ...recordOffer(ctx, kind, input.offerId, { name: offerById(input.offerId)!.name }),
      response: input.response,
      notice: 'Nothing is contracted in this chat.',
    };
  },
  async set_product_suggestions(args, ctx) {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(args);
    setOffersEnabled(ctx, enabled);
    return { status: 'ok', enabled };
  },
};
