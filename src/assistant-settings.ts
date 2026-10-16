// AC1 (plan 28 §4.1): "What the assistant may do". The customer's two switches, their category
// rules and what the bank recorded about suggestions and observations. App database only (no bank
// read, no model). State stays as events (plan 24 D8, plan 26 D6): nothing is stored here, and
// the recorded list is read-only (it is the audit log).
import { config } from './config';
import { appDb } from './db';
import { genericKey } from './insights/normalize';
import { listRules } from './insights/store';
import { categoryLabel, isCategory } from './insights/taxonomy';
import { offers } from './offers/catalogue';
import { MONTH_SHORTFALL_TITLE } from './observations/detect';

const RECORDED = {
  'offer.shown': 'suggestion_shown',
  'offer.declined': 'suggestion_declined',
  'offer.interest': 'interest_noted',
  'observation.told': 'observation_told',
  'observation.dismissed': 'observation_dismissed',
} as const;
// The title of an observation from its key alone (a dismissal stores only the key, and a key is
// not checked against the bank: nothing of a made-up one is repeated). The titles of
// src/observations/detect.ts.
function observationTitle(key: string): string {
  const [kind, id] = key.split(':');
  if (kind === 'prepared_uncovered') return 'A prepared transfer is not covered';
  if (kind === 'month_shortfall') return MONTH_SHORTFALL_TITLE; // FC1
  return isCategory(id) ? `${categoryLabel(id)} is up` : 'Spending in a category is up';
}
export function assistantSettingsOf(userId: string) {
  // ponytail: scans the customer's events of these kinds, as the two history reads do.
  const rows = appDb()
    .prepare(
      `SELECT kind,data,created_at at FROM events WHERE user_id=? AND kind IN ('offers.disabled','offers.enabled','observations.disabled','observations.enabled',${Object.keys(
        RECORDED,
      )
        .map((k) => `'${k}'`)
        .join(',')}) ORDER BY created_at DESC,rowid DESC`,
    )
    .all(userId) as { kind: string; data: string; at: string }[];
  const switchOf = (name: 'offers' | 'observations') => {
    const last = rows.find((r) => r.kind.startsWith(`${name}.`));
    // `available`: false when the deployment has the feature off (OFFERS=off / OBSERVATIONS=off);
    // the customer's switch is then kept but has no effect.
    return {
      enabled: last?.kind !== `${name}.disabled`,
      changedAt: last?.at ?? null,
      available: config[name] === 'on',
    };
  };
  return {
    suggestions: switchOf('offers'),
    observations: switchOf('observations'),
    rules: listRules(userId).map((r) => ({
      merchantKey: r.merchantKey,
      name: genericKey(r.merchantKey) ? 'Payments with no merchant name' : r.merchantKey,
      category: r.category,
      categoryLabel: categoryLabel(r.category),
      createdAt: r.createdAt,
    })),
    // `text` is server text (plan 28 §6.1): the catalogue name of the product, the basis the
    // server wrote when it told the observation, or the title rebuilt from a dismissed key.
    // Nothing the customer typed.
    recorded: rows
      .filter((r) => r.kind in RECORDED)
      .slice(0, 50)
      .map((r) => {
        const data = JSON.parse(r.data) as Record<string, string | undefined>;
        const product = offers().find((o) => o.id === data.offerId)?.name ?? 'a product';
        const title = observationTitle(String(data.key));
        return {
          at: r.at,
          kind: RECORDED[r.kind as keyof typeof RECORDED],
          text: {
            'offer.shown': `Suggested: ${product}`,
            'offer.declined': `You declined: ${product}`,
            'offer.interest': `Interest noted: ${product}. A support case was opened.`,
            'observation.told': `Told in the chat: ${data.basis ?? title}`,
            'observation.dismissed': `You dismissed: ${title}`,
          }[r.kind as keyof typeof RECORDED],
          ...(data.incidentId && { incidentId: data.incidentId }),
        };
      }),
  };
}
