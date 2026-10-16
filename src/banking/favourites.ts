// CF4-api: favourite recipients (contact account ids the customer pinned) and recent recipients
// (destinations of the customer's completed app transfers). Recent is recorded app data only:
// transfers made outside the app carry no counterparty, and none is invented (R4).
import { HttpError } from '../auth';
import { appDb, insert } from '../db';
import { bankRequest } from './client';
import type { RecentRecipient } from './recipients';
const MAX_FAVOURITES = 20;
export const favouriteIds = (userId: string) =>
  (
    appDb()
      .prepare('SELECT account_id FROM favourite_recipients WHERE user_id=? ORDER BY created_at')
      .all(userId) as { account_id: string }[]
  ).map((r) => r.account_id);
// Pinning checks the id against the bank's contacts (and not an own account); unpinning needs no
// bank read, so it works while the bank is down. Idempotent both ways.
export async function setFavourite(userId: string, accountId: string, favourite: boolean) {
  if (!favourite) {
    appDb()
      .prepare('DELETE FROM favourite_recipients WHERE user_id=? AND account_id=?')
      .run(userId, accountId);
    return favouriteIds(userId);
  }
  const [contacts, accounts] = await Promise.all([
    bankRequest<{ id: string }[]>(userId, '/v1/contacts'),
    bankRequest<{ id: string }[]>(userId, '/v1/accounts'),
  ]);
  if (!contacts.some((c) => c.id === accountId) || accounts.some((a) => a.id === accountId))
    throw new HttpError(400, 'This person is not in your contacts.');
  const current = favouriteIds(userId);
  if (!current.includes(accountId) && current.length >= MAX_FAVOURITES)
    throw new HttpError(409, `You can pin up to ${MAX_FAVOURITES} favourites.`);
  insert(
    'favourite_recipients',
    { user_id: userId, account_id: accountId, created_at: new Date().toISOString() },
    { orIgnore: true },
  );
  return favouriteIds(userId);
}
// Up to 5 destinations of completed intents, newest first, one per account, keeping only current
// contacts (own accounts and people no longer listed are dropped before the cut of 5).
// SQLite's bare-column rule with MAX() takes the amount from the newest row.
export function recentRecipients(userId: string, contactIds: Set<string>): RecentRecipient[] {
  return (
    appDb()
      .prepare(
        `SELECT json_extract(payload,'$.toAccountId') AS accountId, MAX(created_at) AS lastAt,
                json_extract(payload,'$.amountCents') AS lastAmountCents
         FROM intents WHERE user_id=? AND status='completed'
         GROUP BY accountId ORDER BY lastAt DESC`,
      )
      .all(userId) as RecentRecipient[]
  )
    .filter((r) => contactIds.has(r.accountId))
    .slice(0, 5);
}
