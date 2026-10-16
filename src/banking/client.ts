import { config } from '../config';
import { sign } from '../auth';
import { requestId } from '../http';
export class BankError extends Error {
  // T3: set when an earlier attempt for the same reference had an unknown outcome.
  uncertain = false;
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function bankRequest<T>(
  userId: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const raw = body === undefined ? '' : JSON.stringify(body),
    timestamp = String(Date.now());
  const signature = sign([method, path, userId, timestamp, raw].join('\n'), config.serviceSecret);
  let response: Response;
  try {
    response = await fetch(`${config.bankUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bank-actor': userId,
        'x-bank-time': timestamp,
        'x-bank-signature': signature,
        // SEC5: correlation only, outside the signed string; banks ignore unknown headers.
        ...(requestId() ? { 'x-request-id': requestId() } : {}),
      },
      body: raw || undefined,
      signal: AbortSignal.timeout(config.bankTimeoutMs),
      cache: 'no-store',
    });
  } catch {
    throw new BankError(504, 'No response received from the bank.');
  }
  // F8: a proxy or error page may not be JSON; keep the HTTP status instead of throwing a raw
  // SyntaxError. An unreadable 2xx is an unknown outcome (>=500, see F3), not a success.
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new BankError(response.status, data?.error || 'Bank service error.');
  if (data === null) throw new BankError(502, 'The bank returned an unreadable response.');
  return data as T;
}
