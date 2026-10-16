import { bankRequest } from './client';
import { HttpError } from '../auth';
import type { Account, ToolContext, TransferInput } from '../types';
// K8: throws when the source account is not the customer's; there is no other outcome.
export async function authorizeTransfer(ctx: ToolContext, input: TransferInput): Promise<void> {
  const accounts = await bankRequest<Account[]>(ctx.userId, '/v1/accounts');
  if (!accounts.some((a) => a.id === input.fromAccountId))
    throw new HttpError(403, 'This account does not belong to this person.');
}
