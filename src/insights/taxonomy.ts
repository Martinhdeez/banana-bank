// SI1: the closed list of spend categories and its sign rule (plan 23, contracts.md §1). Pure: the
// browser imports it.
export type CategoryId =
  | 'groceries'
  | 'eating_out_leisure'
  | 'transport'
  | 'home_utilities'
  | 'health'
  | 'shopping'
  | 'work'
  | 'transfer_person'
  | 'savings_internal'
  | 'income'
  | 'other';

export const CATEGORIES: readonly { id: CategoryId; en: string; es: string }[] = [
  { id: 'groceries', en: 'Groceries', es: 'Supermercado' },
  { id: 'eating_out_leisure', en: 'Eating out & leisure', es: 'Restaurantes y ocio' },
  { id: 'transport', en: 'Transport', es: 'Transporte' },
  { id: 'home_utilities', en: 'Home & utilities', es: 'Hogar y suministros' },
  { id: 'health', en: 'Health', es: 'Salud' },
  { id: 'shopping', en: 'Shopping', es: 'Compras' },
  // CAT1: spending on one's work or own projects; the label lives here only.
  { id: 'work', en: 'Work & projects', es: 'Trabajo y proyectos' },
  { id: 'transfer_person', en: 'Transfers to people', es: 'Transferencias a personas' },
  { id: 'savings_internal', en: 'Savings / own transfer', es: 'Ahorro / traspaso propio' },
  { id: 'income', en: 'Income', es: 'Ingresos' },
  { id: 'other', en: 'Other', es: 'Otros' },
];

export const CATEGORY_IDS: readonly CategoryId[] = CATEGORIES.map((c) => c.id);

export function isCategory(x: unknown): x is CategoryId {
  return CATEGORY_IDS.includes(x as CategoryId);
}

export function categoryLabel(id: CategoryId, lang: 'en' | 'es' = 'en'): string {
  return CATEGORIES.find((c) => c.id === id)![lang];
}

// What a decider may answer, in the order sent to it. `other` is never first. `savings_internal`
// and `income` are absent: they come from facts and rules, never from a model.
export const DECIDER_OPTIONS: readonly CategoryId[] = [
  'groceries',
  'eating_out_leisure',
  'transport',
  'home_utilities',
  'health',
  'shopping',
  'work',
  'transfer_person',
  'other',
];

// The description sent to a decider with each option. Each one says what separates it from its
// neighbours. The last two are never sent (not in DECIDER_OPTIONS).
export const OPTION_CRITERIA: Record<CategoryId, string> = {
  groceries:
    'Food and household basics bought to take home: supermercado, hipermercado, fruteria, panaderia, carniceria, grocery store. Not a bar, a restaurant or a food delivery.',
  eating_out_leisure:
    'Food or drink served or delivered, and free time: bar, restaurante, cafeteria, pub, delivery, cine, concierto, streaming, gimnasio, cinema, tickets. Not food bought in a shop.',
  transport:
    'Getting around: metro, bus, tren, taxi, VTC, gasolinera, parking, peaje, vuelo, car insurance, fuel, train or flight tickets.',
  home_utilities:
    'Running a home: alquiler, comunidad, luz, gas, agua, internet, telefono, seguro de hogar, rent, electricity, water or phone bill.',
  health:
    'Medical care: farmacia, clinica, dentista, optica, fisioterapia, psicologia, hospital, seguro de salud, pharmacy, doctor.',
  shopping:
    'Goods that are not food: ropa, electronica, muebles, bricolaje, libros, deporte, online marketplaces, clothes, department stores.',
  work: "Spending on the customer's own work or projects: cuota de autonomos (Seguridad Social, TGSS), professional software and tools, domains and hosting, coworking, professional courses and certifications. Not everyday streaming or music, general shopping or the home phone and internet.",
  transfer_person:
    'Money sent to a private person, not to a business: Bizum, transferencia a favor de a named person, a loan or a gift to a friend or relative.',
  other:
    'None of the above, or the text does not say what was bought: cash withdrawals, bank fees, taxes, fines, donations, a bare reference or terminal number.',
  savings_internal: "Money moved between the customer's own accounts.",
  income: 'Money received: salary, pension, interest.',
};

// Sign rule, checked on every write: a debit is never income, a credit never a transfer to a person.
export function allowedFor(direction: 'debit' | 'credit', id: CategoryId): boolean {
  return id !== (direction === 'debit' ? 'income' : 'transfer_person');
}

// Shared types of the pipeline (contracts.md §1 "Pipeline entry point"). They live here so the
// modules built before src/insights/classify.ts can import them; classify.ts re-exports them.
export type MovementInput = {
  id: string;
  accountId: string;
  amountCents: number;
  description: string;
  createdAt: string;
  operationId?: string | null;
  fromAccountId?: string;
  toAccountId?: string;
  concept?: string;
};
export type Candidate = { category: CategoryId; p: number | null }; // p null: suggested by a rule
export type RowCategory = {
  id: CategoryId;
  state: 'estimated' | 'confirmed' | 'needs_review' | 'pending';
  source: 'user' | 'user_rule' | 'rule' | 'model' | 'none';
  reason: string; // contracts.md §1 "Reasons"
  confidence: number | null; // 0..1, model decisions only
  threshold: number | null; // the bar in force for that decision
  candidates: Candidate[]; // at most 3, best first
  merchantKey: string;
  model: string | null; // e.g. 'systemone:jev-1.13.0'
};

// The text of a movement's chip. The state is in words, not only in colour.
export function chipText(category: Pick<RowCategory, 'id' | 'state'>): string {
  if (category.state === 'pending') return 'Classifying…';
  const label = categoryLabel(category.id);
  if (category.state === 'confirmed') return label;
  return `${label} · ${category.state === 'estimated' ? 'estimated' : 'to review'}`;
}
