import { bankRequest } from './client';
import { withCounterparties } from './actions';
import { classifyMovements, type RowCategory } from '../insights/classify';

type BankMovement = {
  id: string;
  accountId: string;
  amountCents: number;
  description: string;
  createdAt: string;
  operationId?: string | null;
};
// CF3-api: the customer's three bank reads, shared by the dashboard and movement search.
// R4 (ALT-1): the contract does not fix the order of /v1/movements; newest first here, each with
// its counterparty when the app sent the operation.
// SI4: moved here from app/api/[...path]/route.ts so the insights routes and the agent tools can
// share it. Each movement also gets its category: stored rows and rules inside this call, the
// deciders in the background (never awaited), so a slow or failing model cannot hold a bank read.
// IT1: `read` lets a chat run pass its own reader, so the accounts and contacts the turn already
// fetched are not requested again; every other caller reads the bank directly, as before.
export async function bankView(
  userId: string,
  opts?: { classify?: 'background' | 'none'; read?: <T>(path: string) => Promise<T> },
) {
  const read = opts?.read ?? (<T>(path: string) => bankRequest<T>(userId, path));
  const [accounts, raw, contacts] = await Promise.all([
    read<{ id: string }[]>('/v1/accounts'),
    read<BankMovement[]>('/v1/movements'),
    read<{ id: string }[]>('/v1/contacts'),
  ]);
  raw.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const movements = withCounterparties(raw);
  const categories: Map<string, RowCategory> =
    opts?.classify === 'none'
      ? new Map()
      : await classifyMovements({
          userId,
          movements,
          ownAccountIds: new Set(accounts.map((a) => a.id)),
        });
  return { accounts, movements, contacts, categories };
}
