import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });
export const defaults = { bankUrl: 'http://127.0.0.1:4001', bankPort: 4001 };
// K7: a numeric setting that is not a positive integer stops the app at startup with its name,
// instead of becoming NaN (BANK_TIMEOUT_MS=abc made every bank call "No response").
function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    throw new Error(`${name} must be a positive whole number, got "${raw}".`);
  return Number(raw);
}
// SEC1: same style for a setting where 0 is meaningful (RATE_LIMIT_SCALE=0 disables limits).
function nonNegativeInteger(name: string, fallback: number, zero = '0 disables rate limits') {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a whole number (${zero}), got "${raw}".`);
  return Number(raw);
}
// SI3: a setting with a closed list of values.
function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!values.includes(raw as T))
    throw new Error(`${name} must be one of ${values.join(', ')}, got "${raw}".`);
  return raw as T;
}
// SI3: a threshold given as a whole percentage.
function percent(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)
    throw new Error(`${name} must be a whole number from 1 to 100, got "${raw}".`);
  return Number(raw);
}
// SI3: where the decider key is sent. https only, so the key never travels in clear; http is
// accepted for this machine alone (test stubs). The value is not echoed: it could hold credentials.
function deciderBaseUrl() {
  const raw = process.env.DECIDER_BASE_URL?.trim() || 'https://api.typesafe.ai';
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url?.hostname ?? '');
  if (
    !url ||
    url.username ||
    url.password ||
    url.search || // "/v1/systemone" is appended: a query or a fragment would swallow it
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local))
  )
    throw new Error(
      'DECIDER_BASE_URL must be an https URL without credentials, query or fragment (http only for localhost).',
    );
  return raw.replace(/\/+$/, '');
}
// TR1 (plan 27 §4): AI_PRICES overrides the price of a model: `model=input/cached/output;…` in
// US$ per million tokens with at most three decimals, `-` for no cached rate. Stored as whole
// nano-dollars per token (US$ per million × 1000), so a cost is integer arithmetic.
export type ModelPrice = { input: number; cached: number | null; output: number };
function aiPrices(): Record<string, ModelPrice> {
  const raw = process.env.AI_PRICES?.trim();
  const prices: Record<string, ModelPrice> = {};
  for (const entry of raw ? raw.split(';') : []) {
    const m = /^([\w.:\/-]+)=(\d+(?:\.\d{1,3})?)\/(-|\d+(?:\.\d{1,3})?)\/(\d+(?:\.\d{1,3})?)$/.exec(
      entry.trim(),
    );
    if (!m)
      throw new Error(
        'AI_PRICES must be `model=input/cached/output` entries separated by `;`, in US$ per million tokens with at most three decimals (`-` for no cached rate).',
      );
    const nano = (usdPerMillion: string) => Math.round(Number(usdPerMillion) * 1000);
    prices[m[1]] = {
      input: nano(m[2]),
      cached: m[3] === '-' ? null : nano(m[3]),
      output: nano(m[4]),
    };
  }
  return prices;
}
// SC1: AI_DAILY_CAP_USD, what one customer's own model requests may cost in a day, in US$ with at
// most nine decimals (0.25). Kept as whole nano-dollars, the unit of `ai_usage.cost_nano_usd`.
// Unset: no cap, and nothing reads the usage table for one.
function aiDailyCapNanoUsd(): number | null {
  const raw = process.env.AI_DAILY_CAP_USD?.trim();
  if (!raw) return null;
  const nano = /^\d{1,6}(\.\d{1,9})?$/.test(raw) ? Math.round(Number(raw) * 1e9) : 0;
  if (nano < 1)
    throw new Error(
      `AI_DAILY_CAP_USD must be an amount in US$ above 0 with at most nine decimals (for example 0.25), got "${raw}".`,
    );
  return nano;
}
export const config = {
  dataDir: path.resolve(process.env.DATA_DIR || '.data'),
  bankDataDir: path.resolve(process.env.BANK_DATA_DIR || process.env.DATA_DIR || '.data'),
  bankUrl: process.env.BANK_URL || defaults.bankUrl,
  bankPort: positiveInteger('BANK_PORT', defaults.bankPort),
  appPort: positiveInteger('APP_PORT', 3000),
  serviceSecret: process.env.BANK_SERVICE_SECRET || 'banana-local-service',
  adminSecret: process.env.BANK_ADMIN_SECRET || 'banana-local-admin',
  sessionSecret: process.env.SESSION_SECRET || 'banana-local-session',
  chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-6-luna',
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  bankTimeoutMs: positiveInteger('BANK_TIMEOUT_MS', 1400),
  // OPX2: an open case is "warn" from this age and "breach" from the next one.
  caseWaitWarnMinutes: positiveInteger('CASE_WAIT_WARN_MINUTES', 60),
  caseWaitBreachMinutes: positiveInteger('CASE_WAIT_BREACH_MINUTES', 240),
  // FX7: open support cases one customer may hold at a time through request_human; past it a
  // request opens nothing and returns their most recent open case. 5: the seeded customers
  // already hold up to 2, a person rarely has more matters open, and a flood needs far more.
  handoffOpenCases: positiveInteger('HANDOFF_OPEN_CASES', 5),
  // SEC4: largest accepted JSON request body (preview-answer, the biggest legit one, is ~130 KB).
  maxBodyBytes: positiveInteger('MAX_BODY_BYTES', 262144),
  // SEC1: multiplies every rate limit in src/http.ts; 0 disables them (tests).
  rateLimitScale: nonNegativeInteger('RATE_LIMIT_SCALE', 1),
  // SEC3: session cookie lifetime (seconds, default 12 h); Secure also when forced by COOKIE_SECURE=1.
  sessionMaxAgeS: positiveInteger('SESSION_MAX_AGE_S', 43200),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  // SI3: which decider classifies what the rules cannot (plan 23, contracts.md §5). The key is
  // read here and used by src/insights/deciders/systemone.ts only; it is never logged or returned.
  decider: oneOf('DECIDER', ['auto', 'systemone', 'openai', 'none'], 'auto'),
  deciderBaseUrl: deciderBaseUrl(),
  deciderApiKey: process.env.DECIDER_API_KEY?.trim() || '',
  deciderModel: process.env.DECIDER_MODEL?.trim() || 'jev-1.13.0',
  deciderThreshold: percent('DECIDER_THRESHOLD_PCT', 80) / 100,
  deciderOpenaiThreshold: percent('DECIDER_OPENAI_THRESHOLD_PCT', 85) / 100,
  deciderTimeoutMs: positiveInteger('DECIDER_TIMEOUT_MS', 10000),
  // IT4 (A1): merchants one customer may send to a decider per rolling 24 hours. 200 = two full
  // bank windows (100 movements) of unknown merchants; a demo persona's first load sends 3-4.
  deciderDailyItems: positiveInteger('DECIDER_DAILY_ITEMS', 200),
  // XS2: product suggestions in the chat (plan 24 §5). `off` keeps the starter behaviour; the
  // cool-down is the least number of days between two suggestions to one customer.
  offers: oneOf('OFFERS', ['on', 'off'], 'on'),
  offersCooldownDays: nonNegativeInteger('OFFERS_COOLDOWN_DAYS', 0, '0 means no cool-down'),
  // OB1: spending observations, "Worth a look" (plan 26 §3). `off` is the app without them.
  observations: oneOf('OBSERVATIONS', ['on', 'off'], 'on'),
  // TR1 (plan 27 D12): one row per model request in `ai_usage`. `off` records nothing.
  aiUsage: oneOf('AI_USAGE', ['on', 'off'], 'on'),
  aiPrices: aiPrices(),
  aiDailyCapNanoUsd: aiDailyCapNanoUsd(),
  // VC1: voice input for the chat, transcribed by OPENAI_API_KEY's provider. `off` hides it.
  voice: oneOf('VOICE', ['on', 'off'], 'on'),
  voiceModel: process.env.VOICE_MODEL?.trim() || 'gpt-4o-mini-transcribe',
};
// SC1: the cap is read from what AI_USAGE records; with nothing recorded it would never apply.
if (config.aiDailyCapNanoUsd !== null && config.aiUsage === 'off')
  throw new Error('AI_DAILY_CAP_USD needs AI_USAGE=on: the cap is read from the recorded usage.');
if (config.decider === 'systemone' && !config.deciderApiKey)
  throw new Error('DECIDER=systemone needs DECIDER_API_KEY.');
if (config.caseWaitWarnMinutes >= config.caseWaitBreachMinutes)
  throw new Error(
    `CASE_WAIT_WARN_MINUTES (${config.caseWaitWarnMinutes}) must be lower than CASE_WAIT_BREACH_MINUTES (${config.caseWaitBreachMinutes}).`,
  );
// K7: session cookies signed with the public development secret can be forged.
if (process.env.NODE_ENV === 'production' && config.sessionSecret === 'banana-local-session')
  console.warn('SESSION_SECRET is the development default: set your own for production.');
// The document reference date lives with the UI helpers so the browser can label it too.
export { referenceDate } from './ui-helpers';
