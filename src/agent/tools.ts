import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { bankRequest, BankError } from '../banking/client';
import { cancelApproval, proposeTransfer, recentTransfers, verifyIntent } from '../banking/actions';
import { searchDocuments } from '../retrieval/search';
import { appDb } from '../db';
import { config } from '../config';
import { shortRef } from '../ui-helpers';
import { person } from '../people';
import { recordEvent } from '../telemetry';
import { text } from '../http';
import type { ToolContext } from '../types';
import { forecastToolDefinitions, forecastTools } from './forecast';
import { goalToolDefinitions, goalTools } from './goals';
import { insightsToolDefinitions, insightsTools, listMovements } from './insights';
import { observationToolDefinitions, observationTools } from './observations';
import { offerToolDefinitions, offerTools } from './offers';
import { preparedToolDefinitions, preparedTools } from './prepared';
// SI6b: the prompt lines of the insights tools, next to transferInstructions for run.ts.
export { insightsInstructions } from './insights';
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = { type: 'string' };
export const toolDefinitions: FunctionTool[] = [
  {
    type: 'function',
    name: 'list_accounts',
    description: "Get the current customer's accounts, balances, and available recipients.",
    parameters: object({}),
    strict: true,
  },
  {
    type: 'function',
    // G4: read-only, so "what were my last movements?" is answered with ledger data.
    // SI6b: each movement also has its spend category and a ref to cite it.
    name: 'list_movements',
    description:
      "Get the current customer's latest account movements (credits and debits, newest first) from the bank ledger, each with its spend category (an estimate unless its state is confirmed) and a ref. Read-only.",
    parameters: object({}),
    strict: true,
  },
  {
    type: 'function',
    name: 'search_documents',
    description:
      "Search the bank's documentation for policies and procedures. Returns only documents valid at the reference date, unless validAt names a past date for a question about that period.",
    // F4b: validAt selects the version valid at another date (never mixes versions).
    parameters: object({
      query: string,
      validAt: {
        type: ['string', 'null'],
        description: 'YYYY-MM-DD, only for questions about a past period; otherwise null.',
      },
    }),
    strict: true,
  },
  {
    type: 'function',
    name: 'transfer_money',
    // F2: the tool only proposes; money moves when the customer confirms the proposal.
    description:
      "Propose a transfer for the customer's explicit review. It does NOT send money: it creates a proposal (amount, source, destination) that the customer must confirm in the app. Amounts are integer cents.",
    parameters: object({
      // F7: null when the customer did not name the source account; never guess it.
      fromAccountId: {
        type: ['string', 'null'],
        description: 'Source account id, or null if the customer did not say which account.',
      },
      // R2: pay a person by name; the server picks their main (non-savings) account.
      recipient: {
        type: ['string', 'null'],
        description:
          "The person to pay, by name as in list_accounts contacts. The server sends to that person's main (non-savings) account. null only when toAccountId is given.",
      },
      toAccountId: {
        type: ['string', 'null'],
        description:
          "Exact destination account id, only when the customer asked for a specific account (one of their own accounts, or a recipient's other account such as savings); otherwise null.",
      },
      amountCents: { type: 'integer' },
      concept: string,
      // T5: set only after the customer confirmed an identical request is a new transfer.
      secondTransfer: {
        type: ['boolean', 'null'],
        description:
          'true only if the customer confirmed this is an additional transfer identical to one already proposed or sent; otherwise null.',
      },
      // AR1: a correction names the proposal it replaces, so the old one is closed.
      replacesApprovalId: {
        type: ['string', 'null'],
        description:
          'The approval id of the proposal still awaiting confirmation that this one corrects (the customer changed its amount, recipient, account or concept); null for a new, separate transfer.',
      },
    }),
    strict: true,
  },
  {
    type: 'function',
    name: 'cancel_transfer',
    // R5: cancelling moves no money; only a proposal still awaiting confirmation can be cancelled.
    description:
      'Cancel a transfer proposal that is still awaiting confirmation (approval id from transfer_money). A confirmed transfer cannot be cancelled.',
    parameters: object({ approvalId: string }),
    strict: true,
  },
  {
    type: 'function',
    name: 'operation_status',
    // F3: verified status for follow-ups; null reference = the customer's latest transfers.
    description:
      "Check with the bank whether a transfer went through. Pass the bank reference, or null to verify the customer's latest transfers.",
    parameters: object({ reference: { type: ['string', 'null'] } }),
    strict: true,
  },
  {
    type: 'function',
    name: 'request_human',
    description: 'Open a human support case for this conversation.',
    parameters: object({ summary: string }),
    strict: true,
  },
  // SI6b — contracts.md §4: the five spend-insights tools (chat only, not in POST /api/actions).
  ...insightsToolDefinitions,
  // XS3 — plan 24 §4: the three product-suggestion tools (chat only, not in POST /api/actions).
  ...offerToolDefinitions,
  // PT3 — plan 25 §5: the three prepared-transfer tools (chat only, not in POST /api/actions).
  ...preparedToolDefinitions,
  // OB3 — plan 26 §5: the two spending-observation tools (chat only, not in POST /api/actions).
  ...observationToolDefinitions,
  // GL3 — plan 28 §4.5: the three goal tools and the month forecast (chat only, not in POST
  // /api/actions).
  ...goalToolDefinitions,
  ...forecastToolDefinitions,
];
// F2: appended to the chat instructions (contract: explicit review before execution;
// an informational conversation alone does not authorize payment).
export const transferInstructions = `
Transfers: call transfer_money only when the customer explicitly asks to send money now; never for informational questions or examples. transfer_money creates a proposal and does not move money. After it returns requires_confirmation, show the amount, source and destination and ask the customer to review and confirm it in "Proposals awaiting confirmation". Never say money was sent unless a tool result has status completed.
If the customer holds more than one account and did not say which one to send from, pass fromAccountId null or ask; never choose one yourself. If the result is needs_source_account, ask which of the listed accounts to use.
To pay another person, pass their name as recipient and toAccountId null: the server uses their main account and the proposal shows the exact destination account. Never ask which of the recipient's accounts to use; pass toAccountId only when the customer names a specific account. If the result is ambiguous_recipient or invalid_destination, ask the customer to choose one of the listed recipients.
If a result has status possible_duplicate, an identical transfer is already awaiting confirmation or being verified: show it and ask whether this is a second, separate transfer; call transfer_money again with secondTransfer true only if the customer says yes, and never otherwise.
If the customer corrects a proposal that is awaiting confirmation (another amount, recipient, account or concept), call transfer_money with the corrected details and its approval id as replacesApprovalId; never leave both pending. If the result has replaced with status cancelled, say the earlier proposal was cancelled and only the new one awaits confirmation; if the result is failed, the earlier proposal is unchanged: say so. If the result is proposal_not_pending, nothing was proposed: correct the proposal listed in pending instead, or ask the customer if several are listed.
If the customer asks to cancel a proposal that is awaiting confirmation, call cancel_transfer with its approval id and report the result; if several are awaiting confirmation and it is unclear which one, ask.
If a result has status pending_verification, say the outcome is being verified with the bank and that the customer must not repeat the transfer; never suggest retrying while it is unknown. To answer whether a transfer went through, call operation_status (null reference checks the latest transfers) and report only its verified status.`;
// T5: the duplicate check applies to the agent; POST /api/actions passes checkDuplicates false
// because distinct intentIds there are explicit distinct intents (contract).
// T7: customers and the model get plain words, never a zod JSON dump.
// FX2-c: and the field in words ("source account") in the message people read; the argument
// names go beside it in `fields`, so the model (and an API client) can tell which one to fix.
const FIELD_LABELS: Record<string, string> = {
  fromAccountId: 'source account',
  toAccountId: 'destination account',
  concept: 'description',
  approvalId: 'proposal',
  replacesApprovalId: 'proposal to replace',
  reference: 'bank reference',
};
// Any other field: its name as words ("movementId" → "movement", "secondTransfer" → "second transfer").
const fieldLabel = (name: string) =>
  FIELD_LABELS[name] ??
  name.replace(/(Id|Key)$/, '').replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
function plainValidation(e: z.ZodError) {
  const fields = [...new Set(e.issues.map((i) => fieldLabel(String(i.path[0] ?? 'request'))))];
  return e.issues.some((i) => i.path[0] === 'amountCents')
    ? 'The amount must be a whole number of cents between €0.01 and €100,000.00. No money moved.'
    : `Some details are missing or invalid: ${fields.join(', ')}.`;
}
// FX7: the one place a customer-initiated support case is opened (the model's request_human and
// the customer's own through POST /api/actions). A conversation has one open case (a repeat
// returns it). A customer holds at most `config.handoffOpenCases` open ones at a time: past that
// no case is opened and the result names the most recent one, so one customer cannot fill the
// operator's inbox. Not counted and never refused: a conversation whose transfer may have moved
// money with no verified outcome (the operator must see it), and the cases the app opens for
// product interest (src/offers/state.ts). Count and insert are one write transaction.
const MONEY_UNVERIFIED = (conversation: string) =>
  `SELECT 1 FROM intents t WHERE t.conversation_id=${conversation} AND (t.status IN ('processing','pending_verification') OR (t.status='failed' AND t.bank_reference IS NOT NULL))`;
function openHandoffCase(userId: string, conversationId: string, summary: string) {
  const db = appDb();
  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT id FROM incidents WHERE conversation_id=? AND status=?')
        .pluck()
        .get(conversationId, 'open') as string | undefined;
      if (existing) return { status: 'open', incidentId: existing };
      if (!db.prepare(MONEY_UNVERIFIED('?')).get(conversationId)) {
        const counted = db
          .prepare(
            `SELECT i.id FROM incidents i WHERE i.user_id=? AND i.status='open'
               AND NOT EXISTS (SELECT 1 FROM events e WHERE json_extract(e.data,'$.incidentId')=i.id AND e.kind='offer.interest')
               AND NOT EXISTS (${MONEY_UNVERIFIED('i.conversation_id')})
             ORDER BY i.created_at DESC,i.rowid DESC`,
          )
          .pluck()
          .all(userId) as string[];
        if (counted.length >= config.handoffOpenCases)
          return {
            status: 'open',
            incidentId: counted[0],
            limitReached: true,
            message: `No new support case was opened: the customer already has ${counted.length} open support requests, the most recent with reference ${shortRef(counted[0])}. A person from the bank will review them. Tell the customer exactly that; do not say a case was opened for this conversation.`,
          };
      }
      const id = randomUUID();
      db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(
        id,
        userId,
        conversationId,
        summary,
        'open',
        new Date().toISOString(),
      );
      return { status: 'open', incidentId: id };
    })
    .immediate();
}
export async function runTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
  { checkDuplicates = true } = {},
): Promise<unknown> {
  const started = Date.now();
  recordEvent(ctx, 'tool.started', { tool: name, status: 'started', arguments: args });
  let result: unknown;
  try {
    switch (name) {
      // G7 — contract: "Results contain `status` …"; existing fields unchanged.
      case 'list_accounts':
        result = {
          status: 'ok',
          accounts: await bankRequest(ctx.userId, '/v1/accounts'),
          contacts: await bankRequest(ctx.userId, '/v1/contacts'),
        };
        break;
      // G4 — contract: GET /v1/movements, "up to 100 recent movements belonging to the actor";
      // the actor is the session user. Sorted here (any bank order) and cut to the latest 20.
      // SI6b: read through the run's bank view (sorted there), with `category` and `ref`.
      case 'list_movements':
        result = await listMovements(ctx);
        break;
      case 'search_documents': {
        const { query, validAt } = z
          .object({
            query: z.string().max(2000),
            validAt: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullish(),
          })
          .parse(args);
        // F4f: the audience comes from the server-side identity, never from model arguments;
        // operators also see internal procedures, customers only public documents.
        const role = person(ctx.userId)?.role ?? 'customer';
        result = {
          status: 'ok',
          sources: await searchDocuments(query, role, 5, validAt ?? undefined),
        };
        break;
      }
      case 'transfer_money': {
        // AR1 — contract: "A sensitive operation must present its amount, source, and destination
        // for explicit review before execution." A corrected proposal used to stay confirmable
        // next to its correction. The model names the proposal it replaces (only it knows a
        // correction from a second transfer: "Two distinct legitimate intentions…"). Order: owner
        // check, then the new proposal, and only once it exists the old one is cancelled, so a
        // refused correction leaves the customer's earlier proposal as it was.
        // proposeTransfer parses strictly: the field is removed before the call.
        const isObject = typeof args === 'object' && args !== null;
        const { replacesApprovalId: rawReplaces, ...transfer } = (isObject ? args : {}) as Record<
          string,
          unknown
        >;
        // AR1-a hardening: a string or null at the boundary (a boolean or object reached the
        // SQLite driver, an array was a bind list); "" is null.
        const replacesApprovalId =
          z
            .object({ replacesApprovalId: z.string().trim().max(100).nullish() })
            .parse({ replacesApprovalId: rawReplaces }).replacesApprovalId || null;
        const db = appDb();
        const oldProposal = () =>
          db
            .prepare(
              'SELECT a.consumed_at,a.expires_at,i.status FROM approvals a JOIN intents i ON i.id=a.intent_id WHERE a.id=? AND a.user_id=?',
            )
            .get(replacesApprovalId, ctx.userId) as
            { consumed_at: string | null; expires_at: string; status: string } | undefined;
        // AR1-a hardening — "explicit review before execution", "status should match verified
        // facts": only a proposal still pending can be replaced. A closed one (cancelled, or
        // replaced by an earlier correction, or confirmed) is refused and the answer lists what
        // is pending now; the server never guesses which live proposal the customer meant.
        const notPending = (status: string) => {
          const pending = (
            db
              .prepare(
                'SELECT id,payload FROM approvals WHERE user_id=? AND consumed_at IS NULL AND expires_at>? ORDER BY rowid',
              )
              .all(ctx.userId, new Date().toISOString()) as { id: string; payload: string }[]
          ).map((a) => ({ approvalId: a.id, ...JSON.parse(a.payload) }));
          return {
            status: 'failed',
            code: 'proposal_not_pending',
            error:
              status === 'cancelled'
                ? `That proposal was already cancelled or replaced, so it cannot be corrected. Nothing new was proposed. ${pending.length ? 'To correct a proposal listed in pending, call again with its approvalId as replacesApprovalId' : 'No proposal is awaiting confirmation: call again with replacesApprovalId null'}.`
                : 'That proposal was already confirmed, so it cannot be corrected. Nothing new was proposed: check its status with operation_status; another transfer would be an additional one.',
            pending,
            intentId: ctx.intentId,
          };
        };
        if (replacesApprovalId) {
          const old = oldProposal();
          if (!old) throw new Error('The proposal to replace was not found. Nothing was proposed.');
          // A retry of this same correction finds its own proposal and the old one closed by it.
          const retry = db.prepare('SELECT 1 FROM approvals WHERE intent_id=?').get(ctx.intentId);
          if (old.consumed_at && !retry) {
            result = notPending(old.status);
            break;
          }
        }
        result = await proposeTransfer(ctx, isObject ? transfer : args, {
          // A correction is by definition not a second transfer (same details, new concept).
          checkDuplicates: checkDuplicates && !replacesApprovalId,
        });
        const created = result as { status: string; approval?: { id: string } };
        if (
          replacesApprovalId &&
          created.status === 'requires_confirmation' &&
          created.approval &&
          created.approval.id !== replacesApprovalId
        ) {
          // Check and cancel in one transaction: cancelApproval runs synchronously up to its
          // closing note, so its UPDATE commits with the read that found the proposal pending.
          let closing: ReturnType<typeof cancelApproval> | undefined;
          const old = db.transaction(() => {
            const row = oldProposal()!;
            if (!row.consumed_at && row.expires_at > new Date().toISOString())
              closing = cancelApproval(ctx.userId, replacesApprovalId, 'replaced');
            return row;
          })();
          // Another correction or a confirm closed it while this one was being proposed: this
          // call's own proposal is withdrawn, so two corrections of one proposal leave one
          // pending. A retry did not create the proposal it returns and keeps it.
          const mine = db
            .prepare(
              "SELECT 1 FROM events WHERE kind='transfer.proposed' AND json_extract(data,'$.intentId')=? AND run_id=?",
            )
            .get(ctx.intentId, ctx.runId);
          if (!closing && old.consumed_at && mine) {
            await cancelApproval(ctx.userId, created.approval.id, 'withdrawn');
            result = notPending(old.status);
          } else
            result = {
              ...created,
              // An expired proposal (410) is already closed: nothing live is left beside the new one.
              replaced: await (
                closing ?? cancelApproval(ctx.userId, replacesApprovalId, 'replaced')
              ).catch((e: Error) => ({
                status: 'not_cancelled',
                approvalId: replacesApprovalId,
                error: e.message,
              })),
            };
        }
        break;
      }
      case 'cancel_transfer': {
        const { approvalId } = z.object({ approvalId: z.string().min(1) }).parse(args);
        result = await cancelApproval(ctx.userId, approvalId);
        break;
      }
      case 'operation_status': {
        const { reference } = z.object({ reference: z.string().min(1).nullable() }).parse(args);
        const intent = reference
          ? (appDb()
              .prepare('SELECT id FROM intents WHERE user_id=? AND bank_reference=?')
              .get(ctx.userId, reference) as { id: string } | undefined)
          : undefined;
        result = !reference
          ? await recentTransfers(ctx.userId)
          : intent
            ? await verifyIntent(ctx.userId, intent.id)
            : await bankRequest(
                ctx.userId,
                `/v1/operations/${encodeURIComponent(reference)}`,
              ).catch((e) => {
                // T7: an unknown reference is "not found", never a failed transfer.
                if (e instanceof BankError && e.status === 404)
                  return {
                    status: 'not_found',
                    reference,
                    message: 'No transfer with this reference was found for this customer.',
                  };
                throw e;
              });
        break;
      }
      case 'request_human': {
        if (!ctx.conversationId) throw new Error('A conversation is required to open a case.');
        const { summary } = z.object({ summary: text(z.string().min(1).max(2000)) }).parse(args); // FX3
        result = openHandoffCase(ctx.userId, ctx.conversationId, summary);
        break;
      }
      default:
        // SI6b: the spend-insights tools (src/agent/insights.ts), one function each.
        // XS3: the product-suggestion tools (src/agent/offers.ts), the same way.
        // PT3: the prepared-transfer tools (src/agent/prepared.ts), the same way.
        // OB3: the spending-observation tools (src/agent/observations.ts), the same way.
        // GL3: the goal tools (src/agent/goals.ts) and the forecast tool (src/agent/forecast.ts).
        if (Object.hasOwn(goalTools, name)) result = await goalTools[name](args, ctx);
        else if (Object.hasOwn(forecastTools, name)) result = await forecastTools[name](args, ctx);
        else if (Object.hasOwn(preparedTools, name)) result = await preparedTools[name](args, ctx);
        else if (Object.hasOwn(observationTools, name))
          result = await observationTools[name](args, ctx);
        else if (Object.hasOwn(offerTools, name)) result = await offerTools[name](args, ctx);
        else if (!Object.hasOwn(insightsTools, name)) throw new Error('Unknown tool.');
        else result = await insightsTools[name](args, ctx);
    }
    recordEvent(ctx, 'tool.completed', {
      tool: name,
      status: 'completed',
      arguments: args,
      output: result,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (e) {
    const error =
      e instanceof z.ZodError ? plainValidation(e) : e instanceof Error ? e.message : 'Tool error';
    recordEvent(ctx, 'tool.failed', {
      tool: name,
      status: 'failed',
      arguments: args,
      error,
      durationMs: Date.now() - started,
    });
    return e instanceof z.ZodError
      ? {
          status: 'failed',
          code: 'invalid_request',
          error,
          fields: [...new Set(e.issues.map((i) => String(i.path[0] ?? 'request')))],
        }
      : { status: 'failed', error };
  }
}
