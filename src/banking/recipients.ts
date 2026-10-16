// R2: recipients are people, not account rows. Pure (no server imports): the server resolves a
// person to an account with it, and the transfer form groups its options with the same rule.
// The contract only promises "destination accounts and fictional names" from /v1/contacts, so a
// person is the rows sharing `userId`, or `name` when a bank does not expose the owner.
export type Contact = { id: string; name?: string; label?: string; userId?: string };
export type Recipient = { key: string; name: string; accounts: Contact[]; main: Contact };
// Main account rule: the first account, in bank order, whose label does not say "savings";
// if every account is a savings account, the first one. Bank order therefore never decides it.
const SAVINGS = /savings/i;
export const mainAccount = <T extends { label?: string }>(accounts: T[]) =>
  accounts.find((a) => !SAVINGS.test(a.label ?? '')) ?? accounts[0];
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
export function groupRecipients(contacts: Contact[]): Recipient[] {
  const groups = new Map<string, Contact[]>();
  for (const c of contacts) {
    const key = c.userId ?? c.name ?? c.id;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups].map(([key, accounts]) => ({
    key,
    name: accounts[0].name ?? key,
    accounts,
    main: mainAccount(accounts),
  }));
}
// People matching a reference: the person id or full name (case and accents ignored), else a
// first name. More than one match is ambiguous; the caller must ask, never pick.
export function findRecipients(contacts: Contact[], ref: string): Recipient[] {
  const wanted = fold(ref),
    people = groupRecipients(contacts);
  const exact = people.filter((p) => fold(p.key) === wanted || fold(p.name) === wanted);
  return exact.length ? exact : people.filter((p) => fold(p.name).split(/\s+/)[0] === wanted);
}
// CF4-api: favourites first (pin order), then recent (newest first), then the rest in bank order.
// A person is a favourite or recent if any of their accounts is; picking still uses `main` (R2).
export type RecentRecipient = { accountId: string; lastAt: string; lastAmountCents: number };
type RankedRecipient = Recipient & { favourite: boolean; lastAt: string | null };
export function rankRecipients(
  recipients: Recipient[],
  { favourites, recent }: { favourites: string[]; recent: RecentRecipient[] },
): RankedRecipient[] {
  const rank = (ids: string[], r: Recipient) => {
    const i = ids.findIndex((id) => r.accounts.some((a) => a.id === id));
    return i < 0 ? Infinity : i;
  };
  const recentIds = recent.map((x) => x.accountId);
  // Infinity − Infinity is NaN (falsy), so two unranked people fall through to the next key.
  return recipients
    .map((r, i) => ({ r, i, fav: rank(favourites, r), rec: rank(recentIds, r) }))
    .sort((a, b) => a.fav - b.fav || a.rec - b.rec || a.i - b.i)
    .map(({ r, fav, rec }) => ({
      ...r,
      favourite: fav < Infinity,
      lastAt: rec < Infinity ? recent[rec].lastAt : null,
    }));
}
