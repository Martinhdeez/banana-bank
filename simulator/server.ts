import http from 'node:http';
import { z } from 'zod';
import { config } from '../src/config';
import { sign, equal, HttpError } from '../src/auth';
import { people, person } from '../src/people';
import { bankDb } from './db';
import { seedBank } from './seed';
import {
  listAccounts,
  operationByReference,
  profiles,
  scenario,
  setScenario,
  transfer,
} from './bank';
const db = bankDb();
if (!(db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n) seedBank();
const transferSchema = z
  .object({
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amountCents: z.number().int().positive().max(10000000),
    concept: z.string().max(200),
    reference: z.string().min(1).max(120),
  })
  .strict();
const server = http.createServer(async (req, res) => {
  const reply = (status: number, data: unknown) => {
    if (!res.destroyed) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }
  };
  try {
    const url = new URL(req.url || '/', 'http://bank.local');
    if (url.pathname === '/health') {
      reply(200, { ok: true, service: 'banana-bank', version: 1 });
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 32768) throw new HttpError(413, 'Request too large.');
    }
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname.startsWith('/admin/')) {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!equal(token, config.adminSecret))
        throw new HttpError(403, 'Invalid administrator credential.');
      if (url.pathname === '/admin/reset' && req.method === 'POST') {
        seedBank();
        reply(200, { ok: true });
        return;
      }
      if (url.pathname === '/admin/scenario' && req.method === 'POST') {
        const input = z
          .object({ profile: z.enum(profiles), seed: z.number().int().optional() })
          .parse(body);
        setScenario(input.profile, input.seed);
        reply(200, scenario());
        return;
      }
      if (url.pathname === '/admin/snapshot' && req.method === 'GET') {
        reply(200, {
          accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
          operations: db.prepare('SELECT * FROM operations ORDER BY createdAt,id').all(),
          movements: db.prepare('SELECT * FROM movements ORDER BY createdAt,id').all(),
          scenario: scenario(),
        });
        return;
      }
      throw new HttpError(404, 'Route not found.');
    }
    const actor = String(req.headers['x-bank-actor'] || '');
    const timestamp = String(req.headers['x-bank-time'] || '');
    const signature = String(req.headers['x-bank-signature'] || '');
    const payload = [req.method, req.url, actor, timestamp, raw].join('\n');
    if (
      !person(actor) ||
      !Number.isFinite(Number(timestamp)) ||
      Math.abs(Date.now() - Number(timestamp)) > 60000 ||
      !equal(signature, sign(payload, config.serviceSecret))
    )
      throw new HttpError(401, 'Invalid actor context.');
    if (url.pathname === '/v1/accounts' && req.method === 'GET') {
      reply(200, listAccounts(actor));
      return;
    }
    if (url.pathname === '/v1/contacts' && req.method === 'GET') {
      reply(
        200,
        db
          .prepare('SELECT id,userId,label,iban FROM accounts WHERE userId!=? ORDER BY userId')
          .all(actor)
          .map((a: any) => ({ ...a, name: person(a.userId)?.name })),
      );
      return;
    }
    if (url.pathname === '/v1/movements' && req.method === 'GET') {
      reply(
        200,
        db
          .prepare(
            'SELECT m.* FROM movements m JOIN accounts a ON a.id=m.accountId WHERE a.userId=? ORDER BY m.createdAt DESC,m.id LIMIT 100',
          )
          .all(actor),
      );
      return;
    }
    if (url.pathname === '/v1/transfers' && req.method === 'POST') {
      const { reference, ...input } = transferSchema.parse(body);
      const result = transfer(actor, reference, input);
      if (result.fault === 'reject-before') {
        reply(503, {
          error: 'Service temporarily unavailable',
          code: 'temporarily_unavailable',
        });
        return;
      }
      if (result.fault === 'lost-response' || result.fault === 'read-unavailable') {
        reply(504, { error: 'Upstream request timed out', code: 'upstream_timeout' });
        return;
      }
      if (result.fault === 'slow-response')
        await new Promise((resolve) => setTimeout(resolve, 2600));
      reply(200, { ...result.operation, replay: result.replay });
      return;
    }
    if (url.pathname.startsWith('/v1/operations/') && req.method === 'GET') {
      const op = operationByReference(
        actor,
        decodeURIComponent(url.pathname.slice('/v1/operations/'.length)),
      );
      if (!op) throw new HttpError(404, 'Operation not found.');
      reply(200, op);
      return;
    }
    if (url.pathname === '/v1/operator/customer' && req.method === 'GET') {
      if (person(actor)?.role !== 'operator') throw new HttpError(403, 'Operator role required.');
      const customer = url.searchParams.get('id') || '';
      if (!people.some((p) => p.id === customer && p.role === 'customer'))
        throw new HttpError(404, 'Customer not found.');
      reply(200, {
        accounts: listAccounts(customer),
        operations: db
          .prepare('SELECT * FROM operations WHERE userId=? ORDER BY createdAt DESC')
          .all(customer),
      });
      return;
    }
    throw new HttpError(404, 'Route not found.');
  } catch (e) {
    if (e instanceof HttpError) reply(e.status, { error: e.message });
    else if (e instanceof z.ZodError || e instanceof SyntaxError)
      reply(400, { error: 'Invalid request data.' });
    else {
      console.error('bank_request_failed', e instanceof Error ? e.name : 'unknown');
      reply(500, { error: 'Internal simulator error.' });
    }
  }
});
server.listen(config.bankPort, '127.0.0.1', () =>
  console.log(`Simulated bank: http://127.0.0.1:${config.bankPort}`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
