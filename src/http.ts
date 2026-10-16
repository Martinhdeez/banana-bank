// SEC5: request-level concerns shared by the API route and the bank client.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sanitize } from './telemetry';
import { config } from './config';
import { HttpError } from './auth';
import { z } from 'zod';
import { stripBidi } from './ui-helpers';
// FX3: every free-text input that is stored and shown later goes through this. The bidi controls
// are removed before the schema runs, so trim, "required" and the length limit see the clean text.
export const text = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? stripBidi(v) : v), schema);
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const requestId = () => requestContext.getStore()?.requestId;
// A client id is echoed only if it is short and header-safe (no spaces, CR/LF); else a new UUID.
export function newRequestId(request: Request) {
  const id = request.headers.get('x-request-id');
  return id && /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : randomUUID();
}
// One JSON line per event. Callers pass diagnostics only: never cookies, headers, bodies or chat
// text; sanitize() still redacts secret-like keys/values and bounds sizes.
export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
) {
  const safe = sanitize(fields, 4000) as Record<string, unknown>;
  console[level](
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      requestId: requestId(),
      ...safe,
    }),
  );
}
// Access-log label: the second segment is an id (conversation, approval, document), except in
// the fixed routes recipients/favourites (CF4), notifications/read (CF5) and movements/export.csv (CF2).
// SI5: insights/… segments are fixed too, and the merchant key of insights/rules/:key is never
// spelled in a log line.
// FC2: forecast/adjustments is fixed, and the id after it is not spelled.
const fixedSecond = new Set([
  'recipients',
  'notifications',
  'movements',
  'insights',
  'usage',
  'forecast',
]);
export const routeLabel = (path: string[]) =>
  path
    .map((part, i) =>
      i === 1 && !fixedSecond.has(path[0])
        ? ':id'
        : i >= 2 && path[0] === 'insights'
          ? ':key'
          : i >= 2 && path[0] === 'forecast'
            ? ':id'
            : part,
    )
    .join('/');
// IT2: every API route and the methods it defines (`:x` is one path segment). The dispatcher
// answers nothing else: another method on one of these paths is a 405, any other path a 404.
export const apiRoutes: Record<string, string[]> = {
  health: ['GET'],
  people: ['GET'],
  session: ['GET', 'POST'],
  dashboard: ['GET'],
  movements: ['GET'],
  'movements/export.csv': ['GET'],
  conversations: ['GET', 'POST'],
  'conversations/:id': ['GET'],
  'conversations/:id/messages': ['POST'],
  actions: ['POST'],
  'approvals/:id/confirm': ['POST'],
  'approvals/:id/cancel': ['POST'],
  'transfers/:id/receipt': ['GET'],
  // PT1: prepared transfers (plan 25 §3).
  prepared: ['POST'],
  'prepared/:id': ['DELETE'],
  'prepared/:id/send': ['POST'],
  'prepared/:id/skip': ['POST'],
  'prepared/:id/pause': ['POST'],
  'prepared/:id/resume': ['POST'],
  // GL1: savings goals (plan 28 §4.3). `goals/plan` is the dry run and stays before `goals/:id`.
  goals: ['GET', 'POST'],
  'goals/plan': ['POST'],
  'goals/:id': ['DELETE'],
  'goals/:id/adjust': ['POST'],
  // OB1: dismiss a spending observation, or turn them off or on (plan 26 §4).
  observations: ['POST'],
  // FC2: the customer's adjustments to the month forecast (plan 28 §13).
  'forecast/adjustments': ['POST'],
  'forecast/adjustments/:id': ['DELETE'],
  // TL1: one account's balance day by day over a calendar period (the Plan chart).
  'forecast/timeline': ['GET'],
  // AC1: the customer's switches over the assistant, their rules and what was recorded.
  'assistant-settings': ['GET', 'POST'],
  'recipients/favourites': ['POST'],
  notifications: ['GET'],
  'notifications/read': ['POST'],
  'insights/spending': ['GET'],
  'insights/categories': ['POST'],
  'insights/rules': ['GET'],
  'insights/rules/:key': ['DELETE'],
  'insights/reclassify': ['POST'],
  incidents: ['GET'],
  'incidents/:id': ['GET'],
  'incidents/:id/resolve': ['POST'],
  'incidents/:id/export': ['GET'],
  documents: ['GET'],
  'documents/:id': ['GET'],
  'documents/:id/chunks': ['GET'],
  'preview-answer': ['POST'],
  search: ['POST'],
  ingestion: ['POST'],
  // VC1: a recording from the chat's microphone, as text. Customer only.
  transcribe: ['POST'],
  // TR1: what the app spent on models, per customer and per consumer (plan 27 §6). Operator only.
  usage: ['GET'],
  'usage/export.csv': ['GET'],
};
// The methods of the route a path names, or undefined when it names none.
export function routeMethods(path: string[]) {
  for (const [pattern, methods] of Object.entries(apiRoutes)) {
    const parts = pattern.split('/');
    if (parts.length === path.length && parts.every((p, i) => p[0] === ':' || p === path[i]))
      return methods;
  }
}
// SEC4: one reader for every body. Over maxBytes is a 413, by Content-Length before reading or by
// counting the stream (chunked or lying Content-Length).
export async function readBody(
  request: Request,
  maxBytes: number,
  message = 'The request is too large.',
) {
  const tooLarge = () => {
    log('warn', 'request_too_large', { path: new URL(request.url).pathname });
    return new HttpError(413, message);
  };
  if (Number(request.headers.get('content-length')) > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    size += r.value.byteLength;
    if (size > maxBytes) {
      await reader!.cancel();
      throw tooLarge();
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}
// K6: malformed or empty JSON is a 400.
export async function readJsonBody(request: Request, maxBytes = config.maxBodyBytes) {
  const raw = await readBody(request, maxBytes);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid request data.');
  }
}
// SEC1: requests per minute per key (session: client IP; others: session actor), token bucket
// refilled continuously; RATE_LIMIT_SCALE multiplies every limit, 0 disables them.
// session is 120, not 30 (plan): e2e runs posted up to 78/min from one IP, since every page load
// re-selects the remembered person (D6) and all local browsers share 127.0.0.1.
const limits = {
  session: 120,
  transfer: 20,
  actions: 120,
  approvals: 30,
  chat: 20,
  search: 60,
  preview: 30,
  // IT4 (A1): every non-GET /api/insights/* request (set category, delete rule, reclassify): the
  // last two can send merchants to a paid decider. A person clicks a few times a minute.
  insights: 30,
} as const;
export type Bucket = keyof typeof limits;
// ponytail: per-process buckets; use a shared store if the app runs as more than one instance.
const buckets = new Map<string, { tokens: number; at: number }>();
// Returns 0 when the request may proceed, else the whole seconds to wait for the next token.
function takeToken(bucket: Bucket, key: string) {
  const capacity = limits[bucket] * config.rateLimitScale;
  if (!capacity) return 0;
  const perMs = capacity / 60_000,
    now = Date.now(),
    id = `${bucket}:${key}`;
  // An entry idle for a minute is full again, so dropping it changes nothing.
  if (buckets.size > 10_000)
    for (const [k, v] of buckets) if (now - v.at >= 60_000) buckets.delete(k);
  const state = buckets.get(id) ?? { tokens: capacity, at: now };
  state.tokens = Math.min(capacity, state.tokens + (now - state.at) * perMs);
  state.at = now;
  buckets.set(id, state);
  if (state.tokens < 1) return Math.max(1, Math.ceil((1 - state.tokens) / perMs / 1000));
  state.tokens -= 1;
  return 0;
}
export function rateLimit(bucket: Bucket, key: string) {
  const wait = takeToken(bucket, key);
  if (!wait) return;
  log('warn', 'rate_limited', { bucket, retryAfter: wait }); // no key: it may be an IP
  throw new HttpError(429, 'Too many requests. Wait a moment and try again.', {
    'Retry-After': String(wait),
  });
}
// Next fills x-forwarded-for from the socket when absent. A client can spoof it: acceptable, the
// session bucket only guards persona selection (a local simulator session, not authentication).
export const clientIp = (request: Request) =>
  request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
