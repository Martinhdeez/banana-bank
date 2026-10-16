// SI1: from a bank description to the text the rules match, the cleaned description a decider is
// sent and the merchant key that rules and "apply to similar" group by (plan 23, contracts.md §1).
// Pure: the browser imports it. Ported from docs/plan/23-spend-insights/inputs/gen-spend-data.mjs.

// Step 1: NFKD, strip accents, upper case, collapse whitespace. What the regex dictionary matches.
export function matchText(description: string): string {
  return description
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// The banks' transfer wording around a concept: `Transfer · x` (simulator), `To acc-x: y` and
// `From acc-x: y` (alt bank).
const WRAPPER = /^(TRANSFER ·|(TO|FROM) ACC-[A-Z0-9-]+:)\s?/;
const unwrapped = (description: string) => matchText(description).replace(WRAPPER, '');
const plain = (s: string) => s.replace(/[^A-Z0-9&]+/g, ' ').trim();

// IT5 (A22): a token that identifies a card or a payment, not a merchant: four or more characters
// with a digit (a card mask and its last four digits, a terminal id, a reference, a long digit
// run) or the X run of a spaced mask. `100 MONTADITOS` and `24H` survive.
// ponytail: a brand of 4+ characters with a digit (`7ELEVEN`) is dropped too; an allow-list of
// such brands if one ever matters.
const reference = (w: string) => (/\d/.test(w) && w.length >= 4) || /^X{4,}$/.test(w);

// IT7: two or more digit-only tokens in a row are a phone number written in groups or a date
// (`600 123 456`, `08 09`), not a name. A lone number next to words stays (`100 MONTADITOS`).
const digits = (w?: string) => !!w && /^\d+$/.test(w);

// What a decider is sent: no transfer wrapper, only [A-Z0-9& ], no reference token (IT5), no run
// of digit-only tokens (IT7; the rules and the merchant key read the description itself and still
// see them), at most 80 characters.
export function cleanDescription(description: string): string {
  return plain(unwrapped(description))
    .split(' ')
    .filter(
      (w, i, all) => !reference(w) && !(digits(w) && (digits(all[i - 1]) || digits(all[i + 1]))),
    )
    .join(' ')
    .slice(0, 80)
    .trim();
}

const CHANNELS =
  'COMPRA TARJ\\.?|COMPRA EN|PAGO EN|PAGO CON TARJETA|CARD PAYMENT|PURCHASE|TPV|ADEUDO RECIBO|ADEUDO SEPA|RECIBO';
const CHANNEL = new RegExp(`^(${CHANNELS})\\s+`);
const GENERIC = new RegExp(`^(${CHANNELS})$`);
// IT5 (A3): a key that is only channel words says how the money left, not where it went. Its
// movements group and can take the customer's rule, but a decider has nothing to decide.
export const genericKey = (key: string) => GENERIC.test(key);
const PROCESSOR = /^(PAYPAL|SUMUP|SQ|IZ|ZETTLE)\s*\*\s*/;
const BIZUM = /^BIZUM (ENVIADO |RECIBIDO )?((A|DE) )?/;
const LEGAL = new Set(['SL', 'SLU', 'SLP', 'SA', 'SAU', 'BV', 'GMBH', 'LTD', 'INC', 'KSCE']);
const COUNTRY = new Set(['ES', 'ESP', 'NL', 'IE', 'LU', 'EE', 'GB', 'DE', 'FR', 'PT', 'IT', 'US']);
// ponytail: a 16-city gazetteer from the dev and demo data; a merchant in another city keeps the
// city in its key (stable, so grouping still works). Upgrade path: an alias table key → merchant.
const CITY = new Set(
  'MADRID BARCELONA VALENCIA SEVILLA ZARAGOZA MALAGA BILBAO ALICANTE GRANADA AMSTERDAM DUBLIN LUXEMBOURG TALLINN ALCOBENDAS BADALONA LLEIDA'.split(
    ' ',
  ),
);

// What rules and "apply to similar" group by: /^[A-Z0-9& ]{0,40}$/. When no letter is left it is
// the channel words that were stripped (`Card payment 12` → `CARD PAYMENT`, IT5 A3), else ''. A
// processor with an unreadable payee (`PAYPAL *JGARCIA88`) stays '': the payees are different
// people and shops, and one rule on `PAYPAL` would label them all.
export function merchantKey(description: string): string {
  let s = unwrapped(description);
  let channel = '';
  let before;
  do {
    before = s;
    channel ||= CHANNEL.exec(s)?.[1] ?? '';
    s = s.replace(CHANNEL, '').replace(PROCESSOR, '').replace(BIZUM, '');
  } while (s !== before);
  s = s
    .replace(/\b\d{4}[X*]{4,}\d{0,4}\b/g, ' ') // card masks
    .replace(/TARJ\.? ?\*\d{4}/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ') // dates
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ') // times
    .replace(/\b\d{1,2}(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b/g, ' ')
    .replace(/\bS\.\s?(L\.\s?U\.?|A\.\s?U\.?|L\.\s?P\.?|L\.?|A\.?)(?![A-Z0-9])/g, ' '); // S.L., S.A.U.
  const tokens = plain(s)
    .split(' ')
    .filter((w, i) => {
      if (LEGAL.has(w)) return false;
      if (/^\d+$/.test(w)) return i === 0 && w.length <= 3; // "100 MONTADITOS" survives
      return !reference(w); // terminal ids, references, spaced card masks
    });
  while (tokens.length) {
    const last = tokens[tokens.length - 1];
    const previous = tokens[tokens.length - 2];
    const city = CITY.has(last) && tokens.length > 1 && previous !== 'DE' && previous !== 'DEL';
    if (COUNTRY.has(last) || city) tokens.pop();
    else break;
  }
  let key = '';
  for (const token of tokens) {
    if (key && key.length + 1 + token.length > 40) break;
    key = key ? `${key} ${token}` : token.slice(0, 40);
  }
  return /[A-Z]/.test(key) ? key : plain(channel);
}

const MADRID = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const madrid = (createdAt: string) => {
  const parts = MADRID.formatToParts(new Date(createdAt));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return { hour: Number(part('hour')), weekday: part('weekday') };
};

// Buckets of the merchant profile (contracts.md §1), in Europe/Madrid: a decider gets labels, not
// raw times or amounts.
export function timeBucket(createdAt: string): 'late_night' | 'morning' | 'midday' | 'evening' {
  const { hour } = madrid(createdAt);
  return hour < 6 ? 'late_night' : hour < 12 ? 'morning' : hour < 17 ? 'midday' : 'evening';
}

export function dayBucket(createdAt: string): 'weekday' | 'weekend' {
  const { weekday } = madrid(createdAt);
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

export function amountBucket(amountCents: number): 'small' | 'medium' | 'large' {
  const cents = Math.abs(amountCents);
  return cents < 1500 ? 'small' : cents < 10000 ? 'medium' : 'large';
}
