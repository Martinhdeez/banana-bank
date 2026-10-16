// UI1, forecast adjustments: the two calls of FC2 (#182), in one place. After either, the page
// reads GET /api/dashboard again: neither answer holds a forecast.
//   POST   /api/forecast/adjustments      {kind:'exclude', accountId, merchantKey}
//                                         {kind:'expect', accountId, label, amountCents, repeats:'monthly', day}
//                                         (RG1: plus direction:'income'|'charge' from "Regular money")
//                                         {kind:'expect', accountId, label, amountCents, repeats:'once', date}
//          → 201 {adjustment}; 200 {adjustment} with the existing one for a repeated exclusion
//          (the same success here); 400 (also a label with a control or bidirectional character);
//          404 an account that is not the customer's; 409 {error, code:'too_many'} at 20
//   DELETE /api/forecast/adjustments/:id  → 200 {removed: boolean}
import type { AnyRecord } from '../../../src/ui-helpers';
import type { ForecastAdjustment } from './types';

type Api = (path: string, body?: unknown, method?: string) => Promise<AnyRecord>;
export type AdjustmentBody =
  | { kind: 'exclude'; accountId: string; merchantKey: string }
  | {
      kind: 'expect';
      accountId: string;
      label: string;
      amountCents: number;
      repeats: 'monthly';
      day: number;
      // RG1: a regular item of "Regular money" says which list it joins.
      direction?: 'income' | 'charge';
    }
  | {
      kind: 'expect';
      accountId: string;
      label: string;
      amountCents: number;
      repeats: 'once';
      date: string;
    };
const PATH = 'forecast/adjustments';
export const addAdjustment = async (api: Api, body: AdjustmentBody) =>
  (await api(PATH, body)).adjustment as ForecastAdjustment;
export const removeAdjustment = async (api: Api, id: string) =>
  (await api(`${PATH}/${encodeURIComponent(id)}`, undefined, 'DELETE')).removed as boolean;
// A 400 after the form's own checks passed is the label the server refuses.
export const isRefusedLabel = (e: unknown) => (e as { status?: number }).status === 400;
