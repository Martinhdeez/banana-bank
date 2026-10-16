// IG1: a model's answer is not shown when it is the category the bank's text itself names (plan
// 23, contracts.md 2.29). The payer or the merchant writes a movement's description, and a live
// run showed a model following an instruction written there, fully sure. Rules read the text, no
// model; used only on a model answer (src/insights/classify.ts `decide`): a movement the rules
// decide never comes here. Pure.
import { TRANSFER_WRAPPER } from './dictionary';
import { matchText } from './normalize';
import type { CategoryId } from './taxonomy';

const WRAPPER = new RegExp(TRANSFER_WRAPPER);
// Upper case, no accents, without the bank's own transfer wrapper; every sign but `&` and `:` is a
// space, so `[[SYSTEM: x]]`, `ignore_this` and `***IGNORE` read as words.
const words = (description: string) =>
  matchText(description)
    .replace(WRAPPER, '')
    .replace(/[^A-Z0-9&:]+/g, ' ')
    .trim();

// A verb that hands the reader a label, then `as` / `como` within a few words.
const AS = '(?: [A-Z0-9&]+){0,4} (?:AS|COMO)\\b';
// Text written to whoever classifies the movement, English and Spanish.
// NOT applied by the pipeline: the frozen REQ-CORE-18 (tests/acceptance/si4-core-systemone.test.ts
// :166) requires that such a text, answered with a category it does not name, is shown. Only the
// evaluation harness uses it, to count the model answers shown on such a text. Withholding them is
// one line in `decide` once that requirement is changed.
// ponytail: a short word list. Another language, a paraphrase with none of these words or letters
// spelt apart (`I G N O R E`) pass it. Upgrade path: a separate classifier call that sees the text
// and no category list.
const ADDRESSED: readonly RegExp[] = [
  // "drop what you were told"
  /\b(IGNORE|DISREGARD|FORGET|OVERRIDE|IGNORA|IGNORAR|IGNORE[NS]|OLVIDA|OLVIDAR|OLVIDE|OMITE)\b/,
  // "classify …", "label it as …", "marca esto como …"
  /\b(CLASSIFY|RECLASSIFY|CATEGORI[SZ]E|CLASIFICA|CLASIFICAR|CATEGORIZA|CATEGORIZAR)\b/,
  new RegExp(
    `\\b(LABEL|MARK|TREAT|SET|ASSIGN|TAG|COUNT|MARCA|MARCAR|TRATA|TRATAR|ETIQUETA|ETIQUETAR|ASIGNA|ASIGNAR|PON|CONSIDERA)${AS}`,
  ),
  // "this is income", "this payment is health", "esto es salud"
  /\b(THIS( [A-Z]+)? IS|ESTO ES|ESTE [A-Z]+ ES)\b/,
  // a role or a field: "system: …", "category: health", "categoría: salud"
  /\b(SYSTEM|ASSISTANT|USER|SISTEMA|ASISTENTE|LABEL|ETIQUETA|EXPECTED|ANSWER|RESPUESTA) ?:/,
  // talk about categories, rules and prompts
  /\b(CATEGORY|CATEGORIES|CATEGORIAS?|INSTRUCTIONS?|INSTRUCCION(ES)?|PROMPT)\b/,
  /\b((RULES|REGLAS|NORMAS) (ABOVE|ANTERIORES|PREVIAS)|(PREVIOUS|PRIOR|ABOVE) RULES)\b/,
];
export const addressedText = (description: string): boolean => {
  const text = words(description);
  return ADDRESSED.some((pattern) => pattern.test(text));
};

// The words that name a category: its id, its two labels (taxonomy.ts) and a few synonyms. A word
// starts at a boundary and may go on (`TRANSPORT` is also `TRANSPORTE`), except where `\b` ends it.
// `COMPRA` is not here: it is the banks' word for a card payment. A model answer that is one of
// these categories is not shown, however the text is phrased and whatever the model's confidence.
// ponytail: the category's own names in two languages. A text can still push a model to a wrong
// category it does not name ("this is not food"), or name one in words not listed (`FARMACIA` for
// health is a merchant type, and listing those would withhold most honest answers). Upgrade path:
// ask the decider twice, with and without the free text, and show only an answer both give.
const NAMED: readonly [CategoryId, RegExp][] = [
  ['groceries', /\b(GROCER|SUPERMERCADO|SUPERMARKET|ALIMENTACION)/],
  ['eating_out_leisure', /\b(EATING|LEISURE|RESTAURANT|OCIO\b)/],
  ['transport', /\bTRANSPORT/],
  ['home_utilities', /\b(HOME\b|UTILIT|HOGAR\b|SUMINISTRO)/],
  ['health', /\b(HEALTH|SALUD\b)/],
  ['shopping', /\b(SHOPPING|COMPRAS\b)/],
  ['work', /\b(WORK\b|TRABAJO\b|PROJECTS?\b|PROYECTOS?\b)/],
  ['transfer_person', /\bTRANSFER/],
  ['savings_internal', /\b(SAVING|AHORRO)/],
  ['income', /\b(INCOME|INGRESO|SALARY|NOMINA|SUELDO)/],
];
export const namedCategories = (description: string): CategoryId[] => {
  const text = words(description);
  return NAMED.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
};
