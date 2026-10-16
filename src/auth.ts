import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { person } from './people';
export function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('hex');
}
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
// SEC3: token v2 `<userId>.<issuedAt>.<hmac>`; issuedAt in Unix seconds, signed with the id.
export function sessionToken(userId: string, issuedAt = Math.floor(Date.now() / 1000)) {
  const value = `${userId}.${issuedAt}`;
  return `${value}.${sign(value, config.sessionSecret)}`;
}
// SEC3: a fresh issuedAt on every selection. ponytail: stateless, so an old token stays valid until
// it expires; revocation needs a server-side session table (add if real accounts ever exist).
export function sessionCookie(userId: string, request: Request) {
  // x-forwarded-proto is trusted as sent (by Next or a proxy). A client can spoof it over plain http:
  // acceptable, it only adds Secure to that client's own cookie; it never removes Secure over HTTPS.
  const https =
    config.cookieSecure ||
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https' ||
    request.url.startsWith('https:');
  return `banana_actor=${sessionToken(userId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionMaxAgeS}${https ? '; Secure' : ''}`;
}
const expired = 'Your session expired. Select a person again.';
export function actor(request: Request) {
  const token = (request.headers.get('cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('banana_actor='))
    ?.slice('banana_actor='.length);
  if (!token) throw new HttpError(401, 'Select a person to continue.');
  const parts = token.split('.');
  // SEC3: a pre-SEC3 cookie (`<userId>.<hmac>`) has no issued-at: ask to select again, not a 500.
  if (parts.length === 2) throw new HttpError(401, expired);
  const [id, issuedAt, signature] = parts;
  const p = person(id);
  // Signature before age, so an unsigned timestamp tells nothing.
  if (
    parts.length !== 3 ||
    !p ||
    !/^\d+$/.test(issuedAt) ||
    !equal(signature, sign(`${id}.${issuedAt}`, config.sessionSecret))
  )
    throw new HttpError(401, 'Invalid session.');
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (age > config.sessionMaxAgeS || age < -60) throw new HttpError(401, expired);
  return p;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    // K7: an unparseable Origin (browsers send "null" from sandboxed or file pages) is a 403.
    const parsed = URL.parse(origin);
    if (
      !parsed ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.host !== request.headers.get('host')
    )
      throw new HttpError(403, 'Origin not allowed.');
  }
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
    public code?: string,
  ) {
    super(message);
  }
}
