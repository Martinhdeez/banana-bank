// XS1: the offer catalogue (plan 24 §2, §3; REQ-XS-1, REQ-XS-2). A set of its own in
// fixtures/offers/ (D1): never embedded, never retrieved, never mixed with fixtures/documents/.
// Nothing here runs at import and there is no `node:` import, so browser code can import the
// types and OFFER_IDS; offers() and productFees() are server only.
import { z } from 'zod';

export const OFFER_IDS = [
  'offer-aurora-fee-waiver',
  'offer-cashback-card',
  'offer-salary-plan',
  'offer-savings-pot',
  'offer-home-insurance',
  'offer-bills-watch',
  'offer-round-ups',
  'offer-cloud-account',
] as const; // this order is the tie-break order of selectOffer
export type OfferId = (typeof OFFER_IDS)[number];
export type Offer = {
  id: OfferId;
  name: string;
  pitch: string;
  reason: string; // no figures, for the model
  cites: string[];
  version: number;
  validFrom: string;
  text: string;
};
export type OfferCard = { id: OfferId; name: string; text: string; basis: string };
export type OfferSheet = {
  id: OfferId;
  title: string;
  version: number;
  validFrom: string;
  text: string;
};
export type OfferExtras = { offer?: OfferCard; offerSources?: OfferSheet[] };

// The documented monthly fee of each product and the Aurora waiver's salary, each next to the
// document that states it (tests/xs1-offers.test.ts fails if the document says another number).
export type ProductFee = { product: string; euros: number; doc: string };

const docId = z.string().regex(/^[a-z0-9-]+$/);
const manifest = z.strictObject({
  fees: z.array(z.strictObject({ product: z.string().min(1), euros: z.int().min(0), doc: docId })),
  auroraWaiver: z.strictObject({
    doc: docId,
    salaryEuros: z.int().positive(),
    waivedEuros: z.int().min(0),
    cardPurchases: z.string().min(1),
  }),
  offers: z.array(
    z.strictObject({
      id: z.enum(OFFER_IDS),
      name: z.string().min(1),
      pitch: z.string().min(1),
      reason: z.string().min(1),
      cites: z.array(docId),
      version: z.int().positive(),
      validFrom: z.iso.date(),
    }),
  ),
});
type Catalogue = Omit<z.infer<typeof manifest>, 'offers'> & { offers: Offer[] };

const MAX_SHEET_CHARS = 900;
let loaded: Catalogue | undefined;
// Reads fixtures/offers once; throws on a bad manifest or sheet, so a broken catalogue never
// reaches a customer.
function catalogue(): Catalogue {
  if (loaded) return loaded;
  const fs = process.getBuiltinModule('node:fs');
  const read = (file: string) => fs.readFileSync(`fixtures/offers/${file}`, 'utf8');
  const parsed = manifest.parse(JSON.parse(read('manifest.json')));
  if (parsed.offers.map((o) => o.id).join() !== OFFER_IDS.join())
    throw new Error('fixtures/offers/manifest.json: the offers are not the eight ids, in order.');
  const offers = parsed.offers.map((o) => {
    const text = read(`${o.id}.md`).trim();
    const bad = (what: string) => new Error(`fixtures/offers/${o.id}.md: ${what}`);
    if (text.length > MAX_SHEET_CHARS) throw bad(`over ${MAX_SHEET_CHARS} characters.`);
    const sections = [`# ${o.name}`, '## What it is', '## Terms', '## What it is not'];
    if (sections.some((s, i) => text.indexOf(`${s}\n`) < text.indexOf(sections[i - 1] ?? '')))
      throw bad('needs its title, "What it is", "Terms" and "What it is not", in that order.');
    const footer = `Version ${o.version}. Valid from ${o.validFrom}. Demonstration content written by the project team.`;
    if (!text.endsWith(`\n${footer}`)) throw bad('does not end with its version line.');
    return { ...o, text };
  });
  return (loaded = { ...parsed, offers });
}

export const offers = (): Offer[] => catalogue().offers;
export const productFees = (): ProductFee[] => catalogue().fees;
export const auroraWaiver = () => catalogue().auroraWaiver;
