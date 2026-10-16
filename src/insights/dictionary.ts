// SI2a: the regex dictionary of the spend classifier, as data (plan 23, contracts.md §1 "Labelling
// rules"). No logic here: src/insights/rules.ts compiles and applies it. The names come from
// docs/plan/23-spend-insights/inputs/gen-spend-data.mjs.
//
// Every source is matched against matchText(description): upper case, no accents, single spaces.
// The engine anchors each source on both sides (no letter or digit before or after), so a source
// is written without \b and never matches inside a longer word. Write endings out
// (`FISIO(TERAPIA)?`); never use an open-ended stem, and never nest an unbounded quantifier.
//
// Two strengths:
// - RULES and PRIORITY are STRONG: a brand or an institution. They may decide wherever they stand
//   in the merchant part of the description (the leading words, before any free text).
// - VOCABULARY is WEAK: a generic word anyone can write. It may decide only as the first word of
//   the merchant name (`FARMACIA LOPEZ`); anywhere else it is a candidate, never a decision.
import type { CategoryId } from './taxonomy';

export type Entry = readonly [category: CategoryId, source: string, note: string];

// Strong overrides: a specific phrase that beats a general entry. The first match wins.
export const PRIORITY: readonly Entry[] = [
  ['eating_out_leisure', 'UBER\\s*\\*?\\s*EATS', 'before UBER (transport)'],
  ['home_utilities', 'REPSOL (LUZ|ELECTRICIDAD)', 'before REPSOL (fuel)'],
  ['groceries', 'SUPERCOR|HIPERCOR', 'El Corte Ingles group, but a supermarket'],
];

// Strong entries: brands and institutions.
export const RULES: readonly Entry[] = [
  ['groceries', 'MERCADONA', ''],
  ['groceries', 'CARREFOUR', ''],
  ['groceries', 'LIDL', ''],
  ['groceries', 'ALDI', ''],
  ['groceries', 'DIA\\s*%|SUPERMERCADOS? DIA|DIA S\\.?A', 'never bare DIA: "lo del otro dia"'],
  ['groceries', 'CONSUM', ''],
  ['groceries', 'EROSKI', ''],
  ['groceries', 'ALCAMPO', ''],
  ['groceries', 'AHORRAMAS', ''],
  ['groceries', 'BONPREU|ESCLAT', ''],
  ['groceries', 'CAPRABO', ''],
  ['groceries', 'CONDIS', ''],
  ['groceries', 'GADIS', ''],
  ['groceries', 'FROIZ', ''],
  ['groceries', 'MASYMAS', ''],
  ['groceries', 'BM SUPERMERCADOS', ''],
  ['groceries', 'HIPERDINO', ''],
  ['groceries', 'SPAR', ''],
  ['groceries', 'COVIRAN', ''],
  ['groceries', 'TESCO', ''],
  ['groceries', 'SAINSBURYS?', ''],
  ['groceries', 'AUCHAN', ''],
  ['groceries', 'INTERMARCHE', ''],
  ['groceries', 'REWE', ''],
  ['groceries', 'EDEKA', ''],
  ['groceries', 'ALBERT HEIJN', ''],
  ['groceries', 'PINGO DOCE', ''],

  ['eating_out_leisure', 'MCDONALDS?', ''],
  ['eating_out_leisure', 'KFC', ''],
  ['eating_out_leisure', 'TELEPIZZA', ''],
  ['eating_out_leisure', 'DOMINOS? PIZZA|DOMINOS', ''],
  ['eating_out_leisure', '100 MONTADITOS', ''],
  ['eating_out_leisure', 'VIPS', ''],
  ['eating_out_leisure', 'STARBUCKS', ''],
  ['eating_out_leisure', 'GLOVO', ''],
  ['eating_out_leisure', 'JUST ?EAT', ''],
  ['eating_out_leisure', 'DELIVEROO', ''],
  ['eating_out_leisure', 'SPOTIFY', ''],
  ['eating_out_leisure', 'NETFLIX', ''],
  ['eating_out_leisure', 'DISNEY ?(PLUS|\\+)', ''],
  ['eating_out_leisure', 'DAZN', ''],
  ['eating_out_leisure', 'FILMIN', ''],
  ['eating_out_leisure', 'CINESA|YELMO|KINEPOLIS', ''],
  ['eating_out_leisure', 'TICKETMASTER|ENTRADAS\\.COM', ''],
  ['eating_out_leisure', 'STEAM ?(GAMES|POWERED)', ''],
  ['eating_out_leisure', 'PLAYSTATION', ''],
  ['eating_out_leisure', 'NINTENDO', ''],

  ['transport', 'RENFE', ''],
  ['transport', 'OUIGO', ''],
  ['transport', 'IRYO', ''],
  ['transport', 'ALSA', ''],
  ['transport', 'FLIXBUS', ''],
  ['transport', 'UBER', 'UBER EATS is a priority rule'],
  ['transport', 'CABIFY', ''],
  ['transport', 'BOLT', ''],
  ['transport', 'FREE ?NOW', ''],
  ['transport', 'METRO (DE )?(MADRID|BILBAO|VALENCIA|SEVILLA)', ''],
  ['transport', 'TMB|EMT|CRTM', ''],
  ['transport', 'T-(USUAL|CASUAL)', ''],
  ['transport', 'BICIMAD|BICING|VALENBISI', ''],
  ['transport', 'REPSOL', 'REPSOL LUZ is a priority rule'],
  ['transport', 'CEPSA|MOEVE', ''],
  ['transport', 'BP', ''],
  ['transport', 'SHELL', ''],
  ['transport', 'GALP', ''],
  ['transport', 'PETRONOR', ''],
  ['transport', 'BALLENOIL|PLENOIL|PLENERGY', ''],
  ['transport', 'SABA|EMPARK|TELPARK', ''],
  ['transport', 'RYANAIR', ''],
  ['transport', 'VUELING', ''],
  [
    'transport',
    'IBERIA (LAE|EXPRESS|LINEAS)|IBERIA\\.COM',
    'never bare IBERIA: NATURGY IBERIA, IKEA IBERICA',
  ],
  ['transport', 'EASYJET', ''],
  ['transport', 'AIR EUROPA', ''],
  ['transport', 'BLABLACAR', ''],
  ['transport', 'ZITY|WIBLE', ''],

  ['home_utilities', 'IBERDROLA', ''],
  ['home_utilities', 'ENDESA', ''],
  ['home_utilities', 'NATURGY', ''],
  ['home_utilities', 'TOTALENERGIES', ''],
  ['home_utilities', 'HOLALUZ', ''],
  ['home_utilities', 'OCTOPUS ENERGY', ''],
  ['home_utilities', 'CURENERGIA|ENERGIA XXI', ''],
  ['home_utilities', 'CANAL DE ISABEL II', ''],
  ['home_utilities', 'EMASA|EMASESA', ''],
  ['home_utilities', 'MOVISTAR', ''],
  ['home_utilities', 'VODAFONE', ''],
  ['home_utilities', 'ORANGE', ''],
  ['home_utilities', 'YOIGO', ''],
  ['home_utilities', 'MASMOVIL', ''],
  ['home_utilities', 'JAZZTEL', ''],
  ['home_utilities', 'DIGI', ''],
  ['home_utilities', 'PEPEPHONE', ''],
  ['home_utilities', 'LOWI', ''],
  ['home_utilities', 'O2', ''],
  ['home_utilities', 'SIMYO', ''],
  ['home_utilities', 'SECURITAS DIRECT|PROSEGUR ALARMAS', ''],

  ['health', 'QUIRONSALUD', ''],
  ['health', 'SANITAS', ''],
  ['health', 'ADESLAS', ''],
  ['health', 'ASISA', ''],
  ['health', 'DKV', ''],
  ['health', 'VITHAS', ''],
  ['health', 'THERAPYCHAT', ''],
  ['health', 'BOOTS', ''],

  ['shopping', 'ZARA', ''],
  ['shopping', 'H&M|HENNES', ''],
  ['shopping', 'MANGO', ''],
  ['shopping', 'PULL ?& ?BEAR', ''],
  ['shopping', 'BERSHKA', ''],
  ['shopping', 'STRADIVARIUS', ''],
  ['shopping', 'MASSIMO DUTTI', ''],
  ['shopping', 'UNIQLO', ''],
  ['shopping', 'PRIMARK', ''],
  ['shopping', 'DECATHLON', ''],
  ['shopping', 'ZALANDO', ''],
  ['shopping', 'SHEIN', ''],
  ['shopping', 'ASOS', ''],
  ['shopping', 'ALIEXPRESS', ''],
  ['shopping', 'TEMU', ''],
  ['shopping', 'MEDIAMARKT', ''],
  ['shopping', 'PCCOMPONENTES', ''],
  ['shopping', 'FNAC', ''],
  ['shopping', 'IKEA', 'furniture is shopping; home_utilities is running costs'],
  ['shopping', 'LEROY MERLIN', 'same policy as IKEA'],
  ['shopping', 'BRICOMART|OBRAMAT|BRICO DEPOT', ''],
  ['shopping', 'CASA DEL LIBRO', ''],
  ['shopping', 'SEPHORA', ''],
  ['shopping', 'DRUNI|PRIMOR', ''],
  ['shopping', 'KIABI', ''],
  ['shopping', 'SPRINTER|JD SPORTS|FOOT LOCKER', ''],
  ['shopping', 'EBAY', ''],
  ['shopping', 'VINTED', ''],
  ['shopping', 'WALLAPOP', ''],
  ['shopping', 'ETSY', ''],

  // CAT1: only merchants that are work whoever pays them. Apple, Google, Amazon and a bare
  // Microsoft can be personal: they stay where they were.
  ['work', 'TGSS|TESORERIA GENERAL (DE LA )?SEGURIDAD SOCIAL', 'the cuota de autonomos'],
  ['work', 'CUOTA (DE )?AUTONOMOS?|SEGURIDAD SOCIAL (RETA|AUTONOMOS?)', ''],
  ['work', 'GITHUB|JETBRAINS|ATLASSIAN|FIGMA|ADOBE', 'professional software'],
  ['work', 'NOTION', ''],
  ['work', 'MICROSOFT ?\\*? ?(365 )?BUSINESS', 'only the business plans'],
  ['work', 'HETZNER|DIGITAL ?OCEAN|OVH(CLOUD)?|GODADDY|AWS|AMAZON WEB SERVICES', 'hosting'],
  ['work', 'WEWORK', 'coworking'],
  ['work', 'UDEMY|COURSERA|PLATZI', 'professional courses'],

  ['other', 'AEAT|AGENCIA TRIBUTARIA', 'tax paid; a tax refund is TAX and REFUND'],
];

// Weak entries: generic words. They decide only as the first word of the merchant name.
export const VOCABULARY: readonly Entry[] = [
  ['groceries', 'SUPERMERCADOS?|SUPERMARKETS?|HIPERMERCADOS?', ''],
  ['groceries', 'GROCERY|GROCERIES', ''],
  ['groceries', 'FRUTERIAS?', ''],
  ['groceries', 'CARNICERIAS?', ''],
  ['groceries', 'PESCADERIAS?', ''],
  ['groceries', 'PANADERIAS?', 'bakery counts as groceries, not eating out'],
  ['groceries', 'ULTRAMARINOS', ''],

  ['eating_out_leisure', 'RESTAURANTE?S?', ''],
  ['eating_out_leisure', 'BAR', ''],
  ['eating_out_leisure', 'PUB', ''],
  ['eating_out_leisure', 'CAFETERIA|CAFE|COFFEE', ''],
  ['eating_out_leisure', 'CERVECERIA', ''],
  ['eating_out_leisure', 'TABERNA|TASCA|TASQUITA', ''],
  ['eating_out_leisure', 'PIZZAS?|PIZZERIA', ''],
  ['eating_out_leisure', 'TRATTORIA', ''],
  ['eating_out_leisure', 'BURGERS?|HAMBURGUESAS?|HAMBURGUESERIA', ''],
  ['eating_out_leisure', 'KEBAB', ''],
  ['eating_out_leisure', 'SUSHI', ''],
  ['eating_out_leisure', 'DISCOTECA', ''],
  ['eating_out_leisure', 'CINES?', ''],
  ['eating_out_leisure', 'DINNER|LUNCH|BRUNCH', ''],
  ['eating_out_leisure', 'CENA|COMIDA|TAPAS|CANAS|COPAS', 'mostly transfer concepts: candidates'],
  ['eating_out_leisure', 'CONCIERTO', ''],
  ['eating_out_leisure', 'MUSEO', ''],

  ['transport', 'CERCANIAS', ''],
  ['transport', 'TAXIS?', ''],
  ['transport', 'ABONO TRANSPORTE|BONOBUS', ''],
  ['transport', 'ESTACION (DE )?SERV(ICIOS?)?|GASOLINERA|PETROL|FUEL', ''],
  ['transport', 'PARKING|APARCAMIENTO', ''],
  ['transport', 'PEAJES?|AUTOPISTAS?|TOLL', ''],
  ['transport', 'ITV', ''],
  ['transport', 'TRANSPORT(E|ES)?', ''],
  ['transport', '(SEGURO|POLIZA) (DE )?(AUTO|COCHE|MOTO)', 'insurance by object'],

  ['home_utilities', 'AGUAS DE|AIGUES DE', ''],
  ['home_utilities', 'INTERNET|FIBRA|BROADBAND', ''],
  ['home_utilities', 'ALQUILER|RENT', 'debits only; a rent credit is income'],
  ['home_utilities', 'HIPOTECA|HIPOTECARIO|MORTGAGE', ''],
  ['home_utilities', 'COMUNIDAD (DE )?PROPIETARIOS', ''],
  ['home_utilities', 'IBI', ''],
  ['home_utilities', 'TASA (DE )?BASURAS?', ''],
  ['home_utilities', 'FACTURA (DE )?(LUZ|GAS|AGUA)', ''],
  ['home_utilities', 'ELECTRICITY|ELECTRICIDAD', ''],
  ['home_utilities', 'SEGURO (DE )?HOGAR', 'insurance by object'],

  ['health', 'FARMACIAS?|PHARMACY|APOTHEKE', ''],
  ['health', 'CLINICAS?', ''],
  ['health', 'DENTAL|DENTISTA', ''],
  ['health', 'CENTRO MEDICO|MEDICAL', ''],
  ['health', 'HOSPITAL|HOSP', ''],
  ['health', 'OPTICA', ''],
  ['health', 'FISIO(TERAPIA|TERAPEUTA)?', ''],
  ['health', 'PSICOLOG(O|A|IA)', ''],
  ['health', 'LABORATORIO|ANALISIS CLINICOS', ''],
  ['health', 'PODOLOG(O|A|IA)', ''],
  ['health', 'SEGURO (DE )?(SALUD|MEDICO|DENTAL)', 'insurance by object'],

  ['work', 'COWORKING', 'CAT1'],

  ['other', 'REINTEGRO|CASH WITHDRAWAL|ATM', 'cash: resolved other'],
  ['other', 'COMISION(ES)?|FEES?', 'bank fees'],
  ['other', 'DONATIVO|DONACION', ''],
  ['other', 'MULTA', ''],
];

// The wording of a transfer to a person. Decided before any purpose keyword.
export const TRANSFER_PERSON: readonly Entry[] = [
  ['transfer_person', 'BIZUM (ENVIADO|A)', ''],
  ['transfer_person', 'TRANSFERENCIA A FAVOR DE', ''],
  ['transfer_person', 'SEPA CREDIT TRANSFER TO', ''],
];

// Bank seed rows: credits that are not income. Anchored: the whole description.
export const OPENING: Entry = [
  'other',
  '^(OPENING BALANCE|INITIAL DEPOSIT|SAVINGS ACCOUNT OPENING)$',
  'bank seed rows, never income',
];

// Kinds of income. Credits only. Its one use: next to one of these, ABONO is not a refund.
export const INCOME: readonly Entry[] = [
  ['income', 'NOMINA|SALARY|PAYROLL|SUELDO', 'salary'],
  ['income', 'PENSION|PRESTACION|SEPE', ''],
  ['income', 'BIZUM RECIBIDO', ''],
  ['income', 'INTERESES|INTEREST', ''],
  ['income', 'TRANSFERENCIA( RECIBIDA)?|INGRESO', ''],
];

// Refund wording, credits only. These always mean a refund.
export const REFUND = 'DEVOLUCION(ES)?|REFUND(S|ED)?|REEMBOLSOS?';
// ABONO is a refund, and also the banks' word for any credit: it counts as a refund only next to
// exactly one recognised merchant and no INCOME word.
export const REFUND_WEAK = 'ABONO';
export const TAX = 'AEAT|AGENCIA TRIBUTARIA|HACIENDA';

// A description starting with it matches no global rule, now or later (frozen in contracts.md).
export const SENTINEL = '^ZZQXV ';

// The two known banks' wording around a transfer concept: `Transfer · x`, `To acc-x: y`,
// `From acc-x: y`. Group 1 is the account id named by the alt bank.
export const TRANSFER_WRAPPER = '^(?:TRANSFER ·|(?:TO|FROM) (ACC-[A-Z0-9-]+):)\\s?';

// Any bank's transfer wording, Spanish and English. Among the leading words of a debit it means
// "an outgoing transfer": without an account fact the rules abstain, whatever its concept says.
export const TRANSFER_LIKE =
  'TRANSFER(S|ENCIAS?)?|TRF|BIZUM|GIRO|ENVIO (A|DE DINERO)|ENVIADO A|SENT TO|(TO|FROM|PARA|A) (ACC-[A-Z0-9-]+|IBAN|CUENTA|CTA|[A-Z]{2}\\d{2,})';

// Wording of money moved between the customer's own accounts. It never decides: only an account
// fact makes a movement savings_internal. Among the leading words the rules abstain, on either sign.
export const OWN_MONEY =
  'TRASPASOS?|CUENTAS? PROPIAS?|CUENTA (DE )?AHORRO|AHORROS?|SAVINGS|PLAN (DE )?PENSIONES|ROUND-?UP|HUCHA';

// Where free text starts. What follows is written by a third party (a concept, a reference, an
// instruction) and never decides a category.
export const FREE_TEXT =
  '//| - |:(?!\\d)|["“”\'`\\[\\]<>{}|=;#]|\\*{2,}|\\b(?:REF|CONCEPTO?|NOTE|NOTA|MEMO|CATEGORY|CATEGORIA|CLASSIFY|CLASIFICAR?|LABEL|ETIQUETA|IGNORE|IGNORA|SYSTEM|ASSISTANT)\\b';
