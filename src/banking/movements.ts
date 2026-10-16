// CF3-api: movement search and filters. Pure (no DB, bank or server imports), so the client can
// reuse it. The rows are the overview's own (activityRows); this only parses and filters.
import { z } from 'zod';
import { centsFromEuros, type ActivityRow } from '../ui-helpers';
import { fold } from './recipients';

// A plain date is a UTC day (inclusive bounds); an instant must carry its offset.
// SI5: exported for the range of GET /api/insights/spending.
export const when = (end: boolean) =>
  z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .transform((s) =>
      Date.parse(s.length === 10 ? `${s}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : s),
    );
// The transfer amount format (S1): €0.01 upwards, at most two decimals, "." or ",".
const euros = z
  .string()
  .transform((s) => centsFromEuros(s))
  .refine((c): c is number => !!c);
// Round-5 query-parameter rule: an unknown key or a bad value is a 400 (repeats: below).
const movementFilters = z
  .object({
    q: z.string().trim().max(100).optional(),
    from: when(false).optional(),
    to: when(true).optional(),
    min: euros.optional(),
    max: euros.optional(),
    direction: z.enum(['sent', 'received', 'internal']).optional(),
    account: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MovementFilters = {
  q?: string;
  fromAt?: number;
  toAt?: number;
  minCents?: number;
  maxCents?: number;
  direction?: 'sent' | 'received' | 'internal';
  account?: string;
};
export function parseMovementFilters(
  search: URLSearchParams,
): { filters: MovementFilters } | { error: string } {
  const keys = [...search.keys()];
  const parsed = movementFilters.safeParse(Object.fromEntries(search));
  if (new Set(keys).size !== keys.length || !parsed.success)
    return { error: 'Invalid request data.' };
  const { q, from, to, min, max, direction, account } = parsed.data;
  if (from !== undefined && to !== undefined && from > to)
    return { error: 'The start date is after the end date.' };
  if (min !== undefined && max !== undefined && min > max)
    return { error: 'The minimum amount is above the maximum.' };
  return {
    filters: { q, fromAt: from, toAt: to, minCents: min, maxCents: max, direction, account },
  };
}
// The account filter is applied by accountActivity (both sides of an internal move), not here.
export function filterRows<T extends ActivityRow>(rows: T[], f: MovementFilters): T[] {
  const needle = f.q ? fold(f.q) : '';
  return rows.filter((r) => {
    const at = Date.parse(r.createdAt),
      cents = Math.abs(r.amountCents);
    return (
      (!needle || fold(`${r.title}\n${r.detail}\n${r.account}`).includes(needle)) &&
      (f.fromAt === undefined || at >= f.fromAt) &&
      (f.toAt === undefined || at <= f.toAt) &&
      (f.minCents === undefined || cents >= f.minCents) &&
      (f.maxCents === undefined || cents <= f.maxCents) &&
      (!f.direction || r.direction === f.direction)
    );
  });
}
// The contract's "up to 100 recent movements": search never sees older ones, and says so.
export type MovementWindow = {
  limit: 100;
  returned: number;
  oldestAt: string | null;
  mayBeTruncated: boolean;
};
export function movementWindow(raw: { createdAt: string }[]): MovementWindow {
  const oldestAt = raw.reduce<string | null>(
    (min, m) => (min === null || m.createdAt < min ? m.createdAt : min),
    null,
  );
  return { limit: 100, returned: raw.length, oldestAt, mayBeTruncated: raw.length >= 100 };
}

// CF2: the rows as a CSV file (RFC 4180): a UTF-8 BOM so spreadsheets read "Ríos", CRLF endings,
// a field quoted when it holds `"`, `,`, CR or LF (inner `"` doubled). Formula-injection guard: a
// text cell starting with = + - @ tab or CR gets a leading `'`; amounts are never prefixed.
export function csvField(value: string | number, text: boolean) {
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
const CSV_HEADER = 'date,account,description,details,direction,amount,currency,reference';
// Amounts: signed, dot decimal, 2 places, from integer cents; the currency is its own column.
export function movementsCsv(rows: (ActivityRow & { reference?: string })[]) {
  const lines = rows.map((r) =>
    [
      csvField(r.createdAt, false),
      csvField(r.account, true),
      csvField(r.title, true),
      csvField(r.detail, true),
      r.direction,
      (r.amountCents / 100).toFixed(2),
      'EUR',
      csvField(r.reference ?? r.id, true),
    ].join(','),
  );
  return `\uFEFF${[CSV_HEADER, ...lines].map((l) => `${l}\r\n`).join('')}`;
}
