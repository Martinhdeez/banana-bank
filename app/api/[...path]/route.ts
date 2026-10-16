import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, sessionCookie, sameOrigin, HttpError } from '../../../src/auth';
import { people, person } from '../../../src/people';
import { appDb, insert } from '../../../src/db';
import { bankRequest, BankError } from '../../../src/banking/client';
import {
  cancelApproval,
  confirmApproval,
  recheckPending,
  transferTimelines,
} from '../../../src/banking/actions';
import {
  changePrepared,
  preparedList,
  prepareTransfer,
  sendPrepared,
  today,
} from '../../../src/banking/prepared';
import {
  currentObservation,
  dismissObservation,
  observationGate,
  observationHistory,
  setObservationsEnabled,
} from '../../../src/observations/state';
import { explainObservations, type ObservationInput } from '../../../src/observations/detect';
import { planBrief, type Brief } from '../../../src/plan/brief';
import { monthForecast, type MonthForecast } from '../../../src/forecast/month';
import { balanceTimeline, TIMELINE_RANGES } from '../../../src/forecast/timeline';
import {
  addAdjustment,
  adjustmentBody,
  adjustmentsOf,
  preparedGoals,
  preparedOperationIds,
  removeAdjustment,
} from '../../../src/forecast/adjustments';
import { setOffersEnabled } from '../../../src/offers/state';
import { assistantSettingsOf } from '../../../src/assistant-settings';
import { adjustGoal, createGoal, deleteGoal, goalsOf, planGoal } from '../../../src/goals/store';
import { bankView } from '../../../src/banking/view';
import { activeDecider } from '../../../src/insights/classify';
import {
  parsePeriod,
  parseRange,
  periodSummary,
  reclassify,
  removeRule,
  setCategory,
  uiAudit,
  withCategories,
} from '../../../src/insights/summary';
import { listRules } from '../../../src/insights/store';
import { CATEGORY_IDS } from '../../../src/insights/taxonomy';
import {
  filterRows,
  movementsCsv,
  movementWindow,
  parseMovementFilters,
} from '../../../src/banking/movements';
import { accountActivity } from '../../../src/ui-helpers';
import { transferReceipt } from '../../../src/banking/receipt';
import { favouriteIds, recentRecipients, setFavourite } from '../../../src/banking/favourites';
import { markRead, notifications } from '../../../src/notifications';
import { sendMessage, answerWithEvidence } from '../../../src/agent/run';
import { extrasFor, storeHandoffMessage } from '../../../src/agent/extras';
import { runTool } from '../../../src/agent/tools';
import {
  filterInbox,
  inbox,
  INBOX_REASONS,
  resolveCase,
  viewCase,
} from '../../../src/operator/view';
import { exportCase } from '../../../src/operator/export';
import { documents, readDocument, ingest } from '../../../src/ingestion/pipeline';
import { appliesAt, searchDocuments } from '../../../src/retrieval/search';
import { MissingOpenAIKeyError } from '../../../src/retrieval/embeddings';
import { config, referenceDate } from '../../../src/config';
import { documentChunks } from '../../../src/retrieval/store';
import type { Person } from '../../../src/types';
import { usageScope } from '../../../src/usage/record';
import { capState, CAP_SENTENCE } from '../../../src/usage/cap';
import { AUDIO_TYPES, transcribe, voiceAvailable } from '../../../src/voice';
import {
  PERIODS,
  usageCsv,
  usageOfCustomer,
  usageOfRun,
  usageOverview,
  usageWindow,
  type Period,
} from '../../../src/usage/report';
import {
  clientIp,
  log,
  newRequestId,
  rateLimit,
  readBody,
  readJsonBody,
  requestContext,
  routeLabel,
  routeMethods,
  text,
  type Bucket,
} from '../../../src/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
type RouteContext = { params: Promise<{ path: string[] }> };
function conversationFor(id: string, userId: string) {
  const result = appDb()
    .prepare('SELECT * FROM conversations WHERE id=? AND user_id=?')
    .get(id, userId);
  if (!result) throw new HttpError(404, 'Conversation not found.');
  return result;
}
// IT8b: the period of the two summary routes comes in the `period` query parameter or in the
// `x-insights-period` request header (same values, same check), never in both. A header sent
// twice reads as "a, b", which is not a period.
const PERIOD_HEADER = 'x-insights-period';
function periodOf(request: Request, search: URLSearchParams) {
  const header = request.headers.get(PERIOD_HEADER);
  if (header === null) return parsePeriod(search);
  if (search.has('period')) throw new HttpError(400, 'Invalid request data.');
  return parsePeriod(new URLSearchParams({ period: header }));
}
async function dashboard({ request, route, current }: Route) {
  if (route === 'dashboard') {
    if (current.role === 'operator')
      // OP2: prioritised inbox with the reason of each case's priority.
      return json({ incidents: inbox() });
    // R7: unknown outcomes are re-checked with the bank (throttled) before they are shown.
    // K2: the recheck runs alongside the three reads; the timelines below are built after both.
    // IT8: `?period=` chooses the period of `insights`; checked before any bank read.
    const period = periodOf(request, new URL(request.url).searchParams);
    const [, view] = await Promise.all([recheckPending(current.id), bankView(current.id)]);
    const { accounts, contacts } = view;
    // SI4: each bank movement carries its category (`movementIds`: what to send to change it), and
    // `insights` is the summary of the same bank read. A movement still with a decider is
    // `pending`; the page reads again while any is.
    const movements = withCategories(view);
    const approvals = (
      appDb()
        .prepare('SELECT * FROM approvals WHERE user_id=? AND consumed_at IS NULL AND expires_at>?')
        .all(current.id, new Date().toISOString()) as any[]
    ).map((a) => ({ ...a, payload: JSON.parse(a.payload) }));
    // CF4-api: pinned and recently paid contacts, from app records; ids no longer among the
    // contacts (or own accounts) are left out, not deleted.
    const own = new Set(accounts.map((a) => a.id));
    const contactIds = new Set(contacts.map((c) => c.id).filter((id) => !own.has(id)));
    // PT1: read before the timelines, so an occurrence it closes is already in them; after the
    // recheck above, so an outcome verified in this load closes its occurrence in this load.
    const prepared = preparedList(current.id);
    // FC1 (plan 28 §4.4): the month ahead, from this load's own reads. An extra: a failure in it
    // must not take the dashboard with it.
    const day = today();
    let forecast: MonthForecast | null = null;
    try {
      forecast = monthForecast({
        accounts: accounts as ObservationInput['accounts'],
        movements: view.movements,
        prepared,
        adjustments: adjustmentsOf(current.id), // FC2
        preparedOperationIds: preparedOperationIds(current.id), // RG1
        goals: preparedGoals(current.id), // RG1b
        today: day,
      });
    } catch {}
    const observed: ObservationInput = {
      accounts: accounts as ObservationInput['accounts'],
      view,
      prepared,
      today: day,
      forecast,
    };
    // PL1 (plan 28 §4.5, D14, D15): the brief, from this load's own reads and the app's tables
    // (no bank request, no model, nothing recorded). An extra, like the forecast.
    let brief: Brief | null = null;
    try {
      const { dismissed, disabled } = observationHistory(current.id);
      const observationsOn = config.observations === 'on' && !disabled;
      brief = planBrief({
        forecast,
        goals: goalsOf(current.id, view).goals,
        observations: observationsOn ? explainObservations(observed).flatMap((k) => k.found) : [],
        dismissed,
        observationsOn,
        // Review of #185: the gate of the "Worth a look" card, so `category_up` is hidden when
        // the card is.
        trouble: !observationGate(current.id).ok,
      });
    } catch {}
    // R8: the customer's latest transfers with their recorded timeline.
    return json({
      accounts,
      movements,
      contacts,
      approvals,
      prepared,
      transfers: transferTimelines(current.id),
      recipients: {
        favourites: favouriteIds(current.id).filter((id) => contactIds.has(id)),
        recent: recentRecipients(current.id, contactIds),
      },
      insights: periodSummary(view, period, activeDecider()),
      // OB1 (plan 26 §4): one fact worth a look, or null; from this load's own reads (no bank
      // request is added) and never during trouble.
      observation: currentObservation(current.id, observed, 'page'),
      forecast,
      brief,
    });
  }
}
// CF3-api: search and filters over the bank's movement window (read-only: no recheck). Filters are
// checked before any bank read; the rows are the overview's (no approvals or transfers are passed,
// so there are no pending rows).
// CF2: GET /api/movements/export.csv runs the same pipeline and returns the rows as a CSV file.
async function movementsRoute({ request, route, current }: Route) {
  const csv = route === 'movements/export.csv';
  if ((route === 'movements' || csv) && request.method === 'GET') {
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    const parsed = parseMovementFilters(new URL(request.url).searchParams);
    if ('error' in parsed) throw new HttpError(400, parsed.error);
    const f = parsed.filters,
      view = await bankView(current.id);
    if (f.account && !view.accounts.some((a) => a.id === f.account))
      throw new HttpError(400, 'Unknown account.');
    // SI5: each row carries its category (a merged internal row: both legs' ids).
    const categorised = { ...view, movements: withCategories(view) };
    const rows = filterRows(accountActivity(categorised, f.account ?? null, Infinity), f),
      window = movementWindow(view.movements);
    if (!csv) return json({ rows, total: rows.length, window });
    // The reference is the bank operation when the movement has one (a merged row's id already is).
    const operation = new Map(view.movements.map((m) => [m.id, m.operationId]));
    // Filename days: the bounds are local-day instants (S4); ±12 h lands on that local calendar
    // day for any offset within ±12 h, and on the same day for a plain (UTC) date.
    // ponytail: UTC+13/+14 (e.g. NZ summer) name the previous day, UTC-12 the next; send the day if that matters.
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    const name = `banana-movements-${f.fromAt === undefined ? 'all' : day(f.fromAt + 43_200_000)}-${day(f.toAt === undefined ? Date.now() : f.toAt - 43_200_000)}.csv`;
    return new Response(
      movementsCsv(rows.map((r) => ({ ...r, reference: operation.get(r.id) ?? r.id }))),
      {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
          'X-Movements-Window': `returned=${window.returned}; limit=${window.limit}; truncated=${window.mayBeTruncated}; oldest=${window.oldestAt ?? 'none'}`,
        },
      },
    );
  }
}
// SI6a — contracts.md §3: the client sends only a movement id. The movement is read from the
// session customer's own bank view, so another customer's id and an unknown id are the same 404.
// `title` is the activity row's (a merged "Between your accounts" row is found by its operation).
async function attachedMovement(userId: string, movementId: string) {
  const view = await bankView(userId),
    movement = view.movements.find((m) => m.id === movementId);
  if (!movement) throw new HttpError(404, 'Movement not found.');
  const row = accountActivity(view, null, Infinity).find(
    (r) => r.id === movement.id || r.id === movement.operationId,
  );
  return {
    id: movement.id,
    title: row?.title ?? movement.description,
    amountCents: movement.amountCents,
    createdAt: movement.createdAt,
  };
}
async function conversations({ request, path, route, current }: Route) {
  if (route === 'conversations') {
    if (current.role !== 'customer') throw new HttpError(403, 'Select a customer to open a chat.');
    if (request.method === 'POST') {
      const id = randomUUID();
      insert('conversations', {
        id,
        user_id: current.id,
        title: 'New conversation',
        created_at: new Date().toISOString(),
      });
      return json({ id }, 201);
    }
    return json(
      appDb()
        .prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY created_at DESC')
        .all(current.id),
    );
  }
  if (path[0] === 'conversations' && path[1]) {
    const conversation = conversationFor(path[1], current.id);
    if (path[2] === 'messages' && request.method === 'POST') {
      const { content, movementId } = z
        .object({
          content: text(z.string().trim().min(1).max(8000)), // FX3
          movementId: z.string().min(1).max(120).optional(),
        })
        .strict()
        .parse(await readJsonBody(request));
      // SI6a: the attachment is loaded before anything is written or sent to the model.
      const attachment = movementId ? await attachedMovement(current.id, movementId) : undefined;
      if ((conversation as any).title === 'New conversation')
        appDb()
          .prepare('UPDATE conversations SET title=? WHERE id=?')
          .run(content.slice(0, 50), path[1]);
      return json(await sendMessage(current.id, path[1], content, { attachment }));
    }
    // SI6a: each message's extras (attached movement; SI6b: quick replies, cited movements).
    const extras = extrasFor(path[1]);
    return json({
      conversation,
      // F4d: each message comes with the sources its answer cited (stored at answer time).
      messages: (
        appDb()
          .prepare(
            'SELECT m.*, s.sources FROM messages m LEFT JOIN message_sources s ON s.message_id=m.id WHERE m.conversation_id=? ORDER BY m.created_at,m.rowid',
          )
          .all(path[1]) as { id: string; sources: string | null }[]
      ).map((m) => ({
        ...m,
        sources: m.sources ? JSON.parse(m.sources) : [],
        extras: extras.get(m.id) ?? null,
      })),
    });
  }
}
async function actions({ request, route, current }: Route) {
  if (route === 'actions' && request.method === 'POST') {
    const body = z
      .object({
        name: z.enum([
          'transfer_money',
          'cancel_transfer',
          'request_human',
          'operation_status',
          'list_accounts',
          'search_documents',
        ]),
        arguments: z.unknown(),
        conversationId: z.string().nullable().optional(),
        intentId: z.string().max(150).optional(),
      })
      .parse(await readJsonBody(request));
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    // SEC1: the tool name is only known after the parse; a 429 runs no tool and writes nothing.
    rateLimit(body.name === 'transfer_money' ? 'transfer' : 'actions', current.id);
    if (body.conversationId) conversationFor(body.conversationId, current.id);
    const ctx = {
      userId: current.id,
      conversationId: body.conversationId || null,
      runId: randomUUID(),
      // T7: a client intentId is scoped to the session user, so ids never collide across
      // customers and a 409 cannot reveal another customer's intent.
      intentId: body.intentId ? `${current.id}:${body.intentId}` : randomUUID(),
    };
    const result = (await runTool(body.name, body.arguments, ctx, {
      checkDuplicates: false,
    })) as { status?: string; incidentId?: string; limitReached?: boolean };
    // HS2: the customer asked for a person without the model: the confirmation is a stored
    // message. Inside a turn (src/agent/run.ts) the model's answer is that message.
    if (body.name === 'request_human' && ctx.conversationId && result.incidentId)
      storeHandoffMessage(ctx.conversationId, result.incidentId, result.limitReached);
    return json(result);
  }
}
async function approvals({ request, path, current }: Route) {
  if (path[0] === 'approvals' && path[1] && path[2] === 'confirm' && request.method === 'POST') {
    // F2: single-use, expiring, owner-checked confirmation; the only execution entry point.
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json(await confirmApproval(current.id, path[1]));
  }
  if (path[0] === 'approvals' && path[1] && path[2] === 'cancel' && request.method === 'POST') {
    // R5: owner-only, idempotent cancel of a proposal still awaiting confirmation.
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json(await cancelApproval(current.id, path[1]));
  }
}
// PT1 (plan 25 §3): prepared transfers. Customer-only, actor from the session; another customer's
// id is a 404. No route here executes: `send` returns a proposal for the usual confirmation.
// A refused request answers 200 with status 'failed' like POST /api/actions, except these states
// of the prepared transfer itself, which are conflicts.
const PREPARED_CONFLICTS = new Set([
  'too_many',
  'not_active',
  'not_monthly',
  'prepared_in_progress',
  'paused',
]);
async function prepared({ request, path, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  const [, id, action] = path,
    { method } = request;
  // SEC1: a send creates a proposal, so it shares the transfer bucket.
  rateLimit(action === 'send' ? 'transfer' : 'actions', current.id);
  const answer = (result: { status: string; code?: unknown }) =>
    json(result, PREPARED_CONFLICTS.has(String(result.code)) ? 409 : 200);
  const base = { userId: current.id, conversationId: null, runId: randomUUID(), intentId: '' };
  if (id && !action && method === 'DELETE') return answer(changePrepared(base, id, 'delete'));
  if (action === 'skip' || action === 'pause' || action === 'resume')
    return answer(changePrepared(base, id, action));
  // The page sends its open conversation, as the transfer form does: the steps join that case.
  // A send needs no body: an empty one is no conversation (SEC4: a huge one is still a 413).
  const body = await readJsonBody(request).catch((e) => {
    if (!id || (e instanceof HttpError && e.status === 413)) throw e;
    return {};
  });
  const { conversationId, ...args } = z
    .object({ conversationId: z.string().nullish() })
    .passthrough()
    .parse(body);
  if (conversationId) conversationFor(conversationId, current.id);
  const ctx = { ...base, conversationId: conversationId || null };
  if (!id) return answer(await prepareTransfer(ctx, args));
  if (action === 'send') return answer(await sendPrepared(ctx, id));
}
// OB1 (plan 26 §4): dismiss one observation, or turn observations off or on. Customer only, the
// actor from the session. Idempotent. A key is not checked against the bank (that would be a bank
// read on a write): a made-up key hides nothing.
const observationsBody = z.union([
  z
    .object({
      dismiss: z.string().regex(/^(prepared_uncovered|category_up|month_shortfall):[^\n]{1,160}$/),
    })
    .strict(),
  z.object({ enabled: z.boolean() }).strict(),
]);
async function observations({ request, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  rateLimit('actions', current.id);
  const body = observationsBody.parse(await readJsonBody(request));
  const ctx = { userId: current.id, conversationId: null, runId: randomUUID(), intentId: '' };
  if ('dismiss' in body) dismissObservation(ctx, body.dismiss);
  else setObservationsEnabled(ctx, body.enabled);
  return json({ status: 'ok' });
}
// FC2 (plan 28 §13): the customer's adjustments to the month forecast. Customer only, the actor
// from the session; another customer's account or id reads as not found. The page reads the
// dashboard again afterwards: no forecast is answered here. Nothing is sent or prepared.
async function forecastRoute({ request, path, current }: Route) {
  if (path[1] === 'timeline') return timelineRoute(request, current);
  if (path[1] !== 'adjustments') return;
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  rateLimit('actions', current.id);
  if (request.method === 'DELETE') return json({ removed: removeAdjustment(current.id, path[2]) });
  const body = adjustmentBody.parse(await readJsonBody(request));
  const accounts = await bankRequest<{ id: string }[]>(current.id, '/v1/accounts');
  const { adjustment, created } = addAdjustment(
    current.id,
    body,
    accounts.map((a) => a.id),
  );
  return json({ adjustment }, created ? 201 : 200);
}
// TL1: GET /api/forecast/timeline?accountId=&range= (range absent = this_month). Customer only;
// another customer's account is the same 404 as an unknown one; an unknown key or range is a 400.
// From the same reads as the dashboard's month ahead, so a change shows on the next read.
const timelineQuery = z
  .object({
    accountId: z.string().min(1).max(120),
    range: z.enum(TIMELINE_RANGES).default('this_month'),
  })
  .strict();
async function timelineRoute(request: Request, current: Person) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  const search = new URL(request.url).searchParams;
  if (new Set(search.keys()).size !== [...search.keys()].length)
    throw new HttpError(400, 'Invalid request data.');
  const { accountId, range } = timelineQuery.parse(Object.fromEntries(search));
  const view = await bankView(current.id, { classify: 'none' });
  if (!view.accounts.some((a) => a.id === accountId))
    throw new HttpError(404, 'Account not found.');
  return json(
    balanceTimeline({
      accountId,
      range,
      accounts: view.accounts as ObservationInput['accounts'],
      movements: view.movements,
      prepared: preparedList(current.id),
      adjustments: adjustmentsOf(current.id),
      preparedOperationIds: preparedOperationIds(current.id),
      goals: goalsOf(current.id, view).goals.flatMap((g) =>
        g.prepared
          ? [
              {
                preparedId: g.prepared.id,
                goalId: g.id,
                name: g.name,
                remainingCents: g.remainingCents,
              },
            ]
          : [],
      ),
      today: today(),
    }),
  );
}
// AC1: "What the assistant may do" (plan 28 §4.1). Customer only; the POST sets either switch and
// answers what the GET answers (src/assistant-settings.ts).
const assistantSettingsBody = z
  .object({ suggestions: z.boolean().optional(), observations: z.boolean().optional() })
  .strict()
  .refine((b) => b.suggestions !== undefined || b.observations !== undefined);
async function assistantSettings({ request, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  if (request.method === 'POST') {
    rateLimit('actions', current.id);
    const body = assistantSettingsBody.parse(await readJsonBody(request));
    const ctx = { userId: current.id, conversationId: null, runId: randomUUID(), intentId: '' };
    if (body.suggestions !== undefined) setOffersEnabled(ctx, body.suggestions);
    if (body.observations !== undefined) setObservationsEnabled(ctx, body.observations);
  }
  return json(assistantSettingsOf(current.id));
}
// GL1 (plan 28 §4.3): savings goals. Customer only, the actor from the session; another
// customer's goal id is the same 404 as an unknown one. No route here sends money, creates an
// intent or an approval: create and adjust prepare the goal's one monthly transfer, which the
// customer sends and confirms on the prepared-transfer path above.
async function goals({ request, path, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  const [, id, action] = path,
    { method } = request;
  if (method !== 'GET') rateLimit('actions', current.id);
  const ctx = { userId: current.id, conversationId: null, runId: randomUUID(), intentId: '' };
  if (id && !action && method === 'DELETE') return json(deleteGoal(ctx, id));
  const body = method === 'POST' ? await readJsonBody(request) : undefined;
  const view = await bankView(current.id);
  if (!id)
    return json(method === 'GET' ? goalsOf(current.id, view) : await createGoal(ctx, body, view));
  if (id === 'plan' && !action) return json(planGoal(current.id, body, view));
  if (action === 'adjust') return json(await adjustGoal(ctx, id, body, view));
}
async function transfers({ request, path, current }: Route) {
  if (path.length === 3 && path[2] === 'receipt' && request.method === 'GET') {
    // CF1-api: owner-only (another customer's id is a 404), verified status, 409 if never sent.
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json(await transferReceipt(current.id, path[1]));
  }
}
async function recipients({ request, route, current }: Route) {
  if (route === 'recipients/favourites' && request.method === 'POST') {
    // CF4-api: owner-only pin/unpin of a contact account; the session decides whose favourites.
    const { accountId, favourite } = z
      .object({ accountId: z.string().min(1).max(120), favourite: z.boolean() })
      .strict()
      .parse(await readJsonBody(request));
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json({ favourites: await setFavourite(current.id, accountId, favourite) });
  }
}
// SI5 — contracts.md §3: the customer's spend categories. Customer-only. Every write reads the
// bank first (bankView), so ids, signs and merchant keys are the bank's current answer, a bank
// error stores nothing, and another customer's movement or rule looks exactly like an unknown one.
const setCategoryBody = z
  .object({
    movementIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    category: z.enum(CATEGORY_IDS),
    applyToSimilar: z.boolean().optional(),
  })
  .strict();
// A merchant key arrives URL-encoded; one that does not decode cannot name a rule.
function decoded(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
async function insights({ request, path, route, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  const { method } = request;
  // IT4 (A1): one bucket per customer for every write, before any bank read, body or model work.
  if (method !== 'GET') rateLimit('insights', current.id);
  if (route === 'insights/spending' && method === 'GET') {
    // IT8: `period`, or `from` / `to` as before, never both.
    const search = new URL(request.url).searchParams;
    const period = periodOf(request, search);
    const given = search.has('period') || request.headers.has(PERIOD_HEADER);
    search.delete('period');
    if (given && search.size) throw new HttpError(400, 'Invalid request data.');
    const range = parseRange(search);
    const view = await bankView(current.id);
    return json(periodSummary(view, period, activeDecider(), new Date(), range));
  }
  if (route === 'insights/categories' && method === 'POST') {
    const input = setCategoryBody.parse(await readJsonBody(request));
    return json(setCategory(current.id, await bankView(current.id), input, uiAudit(current.id)));
  }
  if (route === 'insights/rules' && method === 'GET') return json({ rules: listRules(current.id) });
  if (path[1] === 'rules' && path.length === 3 && method === 'DELETE') {
    const view = await bankView(current.id);
    return json(await removeRule(current.id, view, decoded(path[2]), uiAudit(current.id)));
  }
  if (route === 'insights/reclassify' && method === 'POST') {
    z.object({})
      .strict()
      .parse(await readJsonBody(request));
    return json(await reclassify(current.id, await bankView(current.id)));
  }
}
async function notificationsRoute({ request, route, current }: Route) {
  // CF5-api: derived from recorded facts (no bank or model call); only read marks are stored.
  if (route === 'notifications' && request.method === 'GET') {
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json(notifications(current.id));
  }
  if (route === 'notifications/read' && request.method === 'POST') {
    const body = z
      .union([
        z.object({ ids: z.array(z.string().min(1).max(120)).min(1).max(50) }).strict(),
        z.object({ all: z.literal(true) }).strict(),
      ])
      .parse(await readJsonBody(request));
    if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
    return json(markRead(current.id, 'all' in body ? 'all' : body.ids));
  }
}
async function incidents({ request, path, current }: Route) {
  if (path[0] === 'incidents') {
    if (current.role !== 'operator') throw new HttpError(403, 'Operator role required.');
    // OPX3: optional filters; unknown key, repeated key or bad value → 400 (round-5 rule).
    if (!path[1]) {
      const query = [...new URL(request.url).searchParams];
      if (new Set(query.map(([k]) => k)).size !== query.length)
        throw new HttpError(400, 'Invalid request data.');
      const filters = z
        .object({
          q: z
            .string()
            .trim()
            .max(100)
            .transform((q) => q || undefined)
            .optional(),
          status: z.enum(['open', 'closed']).optional(),
          money: z
            .enum(['true', 'false'])
            .transform((m) => m === 'true')
            .optional(),
          reason: z.enum(INBOX_REASONS).optional(),
        })
        .strict()
        .parse(Object.fromEntries(query));
      return json(filterInbox(inbox(), filters));
    }
    // F5d: operator-only, audited resolution of a case. S6: needs {"confirm": true}; an empty
    // or non-JSON body is a missing confirmation, not a parse error. SEC4: a huge body is a 413.
    if (path[2] === 'resolve' && request.method === 'POST') {
      const body = await readJsonBody(request).catch((e) => {
        if (e instanceof HttpError && e.status === 413) throw e;
        return null;
      });
      return json(await resolveCase(current.id, path[1], body?.confirm));
    }
    // OPX1: evidence bundle download (GET link, session cookie is SameSite=Strict). Only `format`,
    // once, json|html: anything else is 400 (round-5 query-parameter rule).
    if (path[2] === 'export' && request.method === 'GET') {
      const query = [...new URL(request.url).searchParams];
      const { format } = z
        .object({ format: z.enum(['json', 'html']).default('json') })
        .strict()
        .parse(Object.fromEntries(query));
      if (query.length > 1) throw new HttpError(400, 'Invalid request data.');
      const file = await exportCase(current.id, path[1], format);
      return new Response(file.body, {
        headers: {
          'Content-Type': file.contentType,
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    // OPX4: reading a case is recorded (throttled) in its activity log.
    return json(await viewCase(current.id, path[1]));
  }
}
async function documentsRoute({ request, path, current }: Route) {
  if (path[0] === 'documents') {
    // DL1: each document carries its product (a product name in its id, from the fee schedules)
    // and its validity at the reference date, the same rule retrieval applies (appliesAt).
    // Contract: "Documents can contain historical versions and third-party content".
    const all = documents();
    const products = [
      ...new Set(all.filter((d) => d.family === 'fees').map((d) => d.id.split('-')[0])),
    ];
    const visible = all
      .filter((d) => current.role === 'operator' || d.audience === 'public')
      .map((d) => ({
        ...d,
        product: products.find((p) => d.id.split('-').includes(p)) ?? null,
        validity: appliesAt(d, referenceDate) ? 'current' : 'archived',
      }));
    if (path[1]) {
      const doc = visible.find((d) => d.id === path[1]);
      if (!doc) throw new HttpError(404, 'Document not found.');
      if (path[2] === 'chunks') return json(documentChunks(doc.id));
      return json({ ...doc, text: readDocument(doc) });
    }
    // SEC4: unknown or repeated keys, or a validity other than current|archived, are a 400 (a
    // typo must not look like "no documents"); an unknown product is still an empty list.
    const query = new URL(request.url).searchParams,
      keys = [...query.keys()];
    const product = query.get('product'),
      validity = query.get('validity');
    if (
      keys.some((k) => k !== 'product' && k !== 'validity') ||
      new Set(keys).size !== keys.length ||
      (validity !== null && validity !== 'current' && validity !== 'archived')
    )
      throw new HttpError(400, 'Invalid request data.');
    return json({
      documents: visible.filter(
        (d) => (!product || d.product === product) && (!validity || d.validity === validity),
      ),
      products,
      index: appDb().prepare('SELECT COUNT(*) AS chunks FROM chunks').get(),
    });
  }
}
async function previewAnswer({ request, route, current }: Route) {
  if (route === 'preview-answer' && request.method === 'POST') {
    if (current.role !== 'operator') throw new HttpError(403, 'Operator role required.');
    const body = z
      .object({
        question: z.string().min(1).max(8000),
        sources: z
          .array(
            z.object({
              id: z.string(),
              documentId: z.string(),
              text: z.string().max(12000),
              title: z.string().nullable(),
              version: z.number().nullable(),
              validFrom: z.string().nullable(),
              validTo: z.string().nullable(),
              audience: z.enum(['public', 'internal']),
              score: z.number(),
            }),
          )
          .max(10),
      })
      .parse(await readJsonBody(request));
    appDb(); // VC1 review: its usage row needs the DB open, as on the first request of a process
    return json(await as(current, () => answerWithEvidence(body.question, body.sources)));
  }
}
// TR1 (plan 27 §5): the model requests of these three routes are recorded for the signed-in
// person, as `customer` or `operator`.
const as = <T>(current: Person, fn: () => T) =>
  usageScope({ actor: current.role, userId: current.id }, fn);
async function search({ request, route, current }: Route) {
  if (route === 'search' && request.method === 'POST') {
    const { query } = z
      .object({ query: z.string().min(1).max(2000) })
      .parse(await readJsonBody(request));
    return json({ sources: await as(current, () => searchDocuments(query, current.role)) });
  }
}
async function ingestion({ request, route, current }: Route) {
  if (route === 'ingestion' && request.method === 'POST') {
    if (current.role !== 'operator') throw new HttpError(403, 'Operator role required.');
    return json(await as(current, () => ingest()));
  }
}
// VC1: a recording from the chat's microphone, as text. Customer only, the `actions` bucket. Every
// refusal comes before the body is read and before any model request.
const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
async function transcribeRoute({ request, current }: Route) {
  if (current.role !== 'customer') throw new HttpError(403, 'A customer is required.');
  rateLimit('actions', current.id);
  if (!voiceAvailable())
    throw new HttpError(503, 'Voice input is not available.', {}, 'voice_unavailable');
  // SC1: the same answer as a chat turn at the customer's daily AI limit.
  if (capState(current.id)) throw new HttpError(503, CAP_SENTENCE, {}, 'ai_daily_limit');
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!Object.hasOwn(AUDIO_TYPES, type)) throw new HttpError(400, 'Invalid request data.');
  const audio = await readBody(request, MAX_RECORDING_BYTES, 'Recording too long.');
  if (!audio.length) throw new HttpError(400, 'Invalid request data.');
  return json({ text: await as(current, () => transcribe(audio, type)) });
}
// TR1 (plan 27 §6): GET /api/usage and its CSV, operator only. Tokens, cost, counts, tool names,
// ids and times: no prompt, message or other customer text at any level (none is stored).
// `period` = today | 7d | 30d | all | range (default 7d; days of Europe/Madrid); UP1: `range` takes
// `from` and `to` (YYYY-MM-DD, to inclusive, not after today), no other period takes them; at most
// one of `customer`, `run`; an unknown or repeated key or a bad value is a 400.
async function usage({ request, route, current }: Route) {
  const csv = route === 'usage/export.csv';
  if (route !== 'usage' && !csv) return;
  if (current.role !== 'operator') throw new HttpError(403, 'Operator role required.');
  const query = [...new URL(request.url).searchParams];
  if (new Set(query.map(([k]) => k)).size !== query.length)
    throw new HttpError(400, 'Invalid request data.');
  const id = z.string().regex(/^[\w:.-]{1,80}$/);
  const { period, from, to, customer, run } = z
    .object({
      period: z.enum(PERIODS).default('7d'),
      from: z.string().optional(),
      to: z.string().optional(),
      ...(!csv && { customer: id.optional(), run: id.optional() }),
    })
    .strict()
    .parse(Object.fromEntries(query)) as {
    period: Period;
    from?: string;
    to?: string;
    customer?: string;
    run?: string;
  };
  const window = usageWindow({ period, from, to });
  if (!window || (customer && run)) throw new HttpError(400, 'Invalid request data.');
  if (csv)
    return new Response(usageCsv(window), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="banana-ai-usage-${period === 'range' ? `${from}_${to}` : period}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  return json(
    run ? usageOfRun(run) : customer ? usageOfCustomer(customer, window) : usageOverview(window),
  );
}
// K8: one function per resource, chosen by the first path segment. Each keeps its exact matching
// (method included) and returns undefined when the request is not one of its routes: a 404.
type Route = { request: Request; path: string[]; route: string; current: Person };
const routes = new Map<string, (r: Route) => Promise<Response | undefined>>(
  Object.entries({
    dashboard,
    movements: movementsRoute,
    conversations,
    actions,
    approvals,
    prepared,
    observations,
    forecast: forecastRoute,
    'assistant-settings': assistantSettings,
    goals,
    transfers,
    recipients,
    notifications: notificationsRoute,
    insights,
    incidents,
    documents: documentsRoute,
    'preview-answer': previewAnswer,
    search,
    ingestion,
    usage,
    transcribe: transcribeRoute,
  }),
);
// SEC1: POST routes throttled per session actor before their handler runs (actions: in actions()).
function postBucket(path: string[]): Bucket | undefined {
  if (path[0] === 'approvals' && (path[2] === 'confirm' || path[2] === 'cancel'))
    return 'approvals';
  if (path[0] === 'conversations' && path[2] === 'messages') return 'chat';
  if (path[0] === 'search') return 'search';
  if (path[0] === 'preview-answer') return 'preview';
}
async function handler(request: Request, context: RouteContext) {
  // T9: "Results contain status and applicable operation, approval, or error fields": errors
  // from the transfer endpoints (actions, approvals) carry status 'failed' too.
  let failed = {};
  try {
    const { path } = await context.params;
    if (path[0] === 'actions' || path[0] === 'approvals' || path[0] === 'prepared')
      failed = { status: 'failed' };
    // IT2: the one place every request passes. The route table (src/http.ts) says which methods a
    // path defines; the handlers below match loosely and used to answer other methods like a GET.
    const methods = routeMethods(path);
    const allow = [...(methods ?? []), ...(methods?.includes('GET') ? ['HEAD'] : []), 'OPTIONS'];
    const Allow = allow.join(', ');
    // As Next's own OPTIONS answer (it had no origin check), with this route's methods.
    if (methods && request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { Allow } });
    // SI5: every non-GET (POST, DELETE) must come from this origin.
    if (request.method !== 'GET') sameOrigin(request);
    if (methods && !allow.includes(request.method))
      throw new HttpError(405, 'Method not allowed.', { Allow });
    // HEAD is its route's GET; Next drops the body.
    if (request.method === 'HEAD') request = new Request(request, { method: 'GET' });
    const route = path.join('/');
    // PL1: public, so it says only that the app is up; `npm run doctor` reports models and key.
    if (route === 'health') return json({ ok: true });
    if (route === 'people') return json(people);
    if (route === 'session' && request.method === 'POST') {
      rateLimit('session', clientIp(request));
      const { userId } = z.object({ userId: z.string() }).parse(await readJsonBody(request));
      if (!person(userId)) throw new HttpError(400, 'Unknown person.');
      return json({ person: person(userId) }, 200, {
        'Set-Cookie': sessionCookie(userId, request),
      });
    }
    const current = actor(request);
    if (!methods) throw new HttpError(404, 'Route not found.');
    // VC1: `voice` tells the UI whether to offer the microphone.
    if (route === 'session')
      return json({ person: current, voice: current.role === 'customer' && voiceAvailable() });
    const bucket = request.method === 'POST' ? postBucket(path) : undefined;
    if (bucket) rateLimit(bucket, current.id);
    const response = await routes.get(path[0])?.({ request, path, route, current });
    if (response) return response;
    throw new HttpError(404, 'Route not found.');
  } catch (e) {
    if (e instanceof MissingOpenAIKeyError)
      return json({ error: e.message, code: 'missing_openai_api_key' }, 503);
    if (e instanceof HttpError)
      return json(
        { ...failed, error: e.message, ...(e.code && { code: e.code }) },
        e.status,
        e.headers,
      );
    // K6: the bank's own wording stays in the server log; the client gets plain words.
    if (e instanceof BankError) {
      log('warn', 'bank_request_failed', { status: e.status, error: e.message });
      return json(
        {
          ...failed,
          error:
            e.status >= 500
              ? 'The bank did not respond. Try again in a moment.'
              : 'The bank could not complete this request.',
        },
        e.status,
      );
    }
    if (e instanceof z.ZodError) return json({ ...failed, error: 'Invalid request data.' }, 400);
    // K6: enough to diagnose a 500 (the stack), never the request body, cookies or headers.
    log('error', 'app_request_failed', {
      method: request.method,
      path: new URL(request.url).pathname,
      ...(e instanceof Error
        ? { name: e.name, message: e.message, stack: e.stack }
        : { error: String(e) }),
    });
    return json(
      {
        ...failed,
        error: 'The request could not be completed. Check the service and configuration.',
      },
      500,
    );
  }
}
// SEC5: every API response carries x-request-id; the id reaches bank calls and log lines through
// AsyncLocalStorage; one access-log line per request with the route label (ids replaced).
async function handle(request: Request, context: RouteContext) {
  const requestId = newRequestId(request),
    started = performance.now();
  return requestContext.run({ requestId }, async () => {
    const response = await handler(request, context);
    response.headers.set('x-request-id', requestId);
    log('info', 'api_request', {
      method: request.method,
      route: routeLabel((await context.params).path),
      status: response.status,
      ms: Math.round(performance.now() - started),
    });
    return response;
  });
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle; // SI5: DELETE /api/insights/rules/:merchantKey
// IT2: exported so that these get the dispatcher's 405 (JSON, Allow), not Next's bare one. HEAD is
// not exported: Next runs GET for it.
export const PUT = handle;
export const PATCH = handle;
export const OPTIONS = handle;
