import { randomUUID } from 'node:crypto';
import { insert } from './db';
import type { ToolContext } from './types';
// F5a: "Operators need to understand the conversation, relevant steps, and effects." Events keep
// the caller's arguments, outputs and errors (not only {tool,status}), with secret-like values
// redacted and the stored size bounded.
const SECRET_KEY =
  /secret|token|password|passwd|api[_-]?key|authorization|signature|cookie|credential/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/;
const MAX_EVENT_CHARS = 8000;
export function sanitize(value: unknown, maxString = 500, maxItems = 20, depth = 0): unknown {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return '[redacted]';
    return value.length > maxString
      ? `${value.slice(0, maxString)}…[+${value.length - maxString} chars]`
      : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sanitize(v, maxString, maxItems, depth + 1));
    return value.length > maxItems ? [...items, `[+${value.length - maxItems} items]`] : items;
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, maxString, maxItems, depth + 1),
    ]),
  );
}
function serialize(data: Record<string, unknown>) {
  for (const [maxString, maxItems] of [
    [500, 20],
    [120, 5],
  ]) {
    const json = JSON.stringify(sanitize(data, maxString, maxItems));
    if (json.length <= MAX_EVENT_CHARS) return json;
  }
  return JSON.stringify({
    tool: data.tool,
    status: data.status,
    truncated: true,
    preview: JSON.stringify(sanitize(data, 120, 5)).slice(0, 2000),
  });
}
export function recordEvent(ctx: ToolContext, kind: string, data: Record<string, unknown>) {
  insert('events', {
    id: randomUUID(),
    run_id: ctx.runId,
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    kind,
    data: serialize(data),
    created_at: new Date().toISOString(),
  });
}
