// INT1: tamper-evident audit log. Contract: "Operators need to understand the conversation,
// relevant steps, and effects. Historical evidence that was never recorded must not be invented."
// Every events row carries hash = sha256(prev_hash + '\n' + canonical row); the tip lives in meta
// 'audit-head'. verifyAuditChain() reports the first problem found and never repairs anything.
// ponytail: SHA-256 chain, detects edits/inserts/truncation not followed by a full rewrite. HMAC with AUDIT_KEY (outside the DB) if an attacker with write access matters.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appDb } from './db';
type EventRow = {
  id: string;
  run_id: string;
  user_id: string;
  conversation_id?: string | null;
  kind: string;
  data: string;
  created_at: string;
};
type ChainedRow = EventRow & { prev_hash: string | null; hash: string | null };
type AuditHead = { id: string; hash: string; count: number };
export type AuditStatus = {
  status: 'verified' | 'broken' | 'empty';
  checked: number;
  legacy: { through: string; count: number; at: string } | null;
  brokenAt: {
    eventId: string | null;
    kind: string | null;
    at: string | null;
    reason: 'hash_mismatch' | 'unlinked_rows' | 'head_mismatch' | 'fork';
  } | null;
};
// Fixed column order, values as stored (data is hashed as text, never re-serialised).
export function eventHash(row: EventRow, prevHash: string) {
  const canonical = JSON.stringify([
    row.id,
    row.run_id,
    row.user_id,
    row.conversation_id ?? null,
    row.kind,
    row.data,
    row.created_at,
  ]);
  return createHash('sha256').update(`${prevHash}\n${canonical}`).digest('hex');
}
const metaJson = <T>(db: Database.Database, key: string) => {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
    { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
};
export const writeHead = (db: Database.Database, head: AuditHead) =>
  db.prepare("INSERT OR REPLACE INTO meta VALUES('audit-head',?)").run(JSON.stringify(head));
// Links a new row to the current head. Call inside the IMMEDIATE transaction that inserts the row.
export function appendEventChain(db: Database.Database, row: EventRow) {
  const head = metaJson<AuditHead>(db, 'audit-head');
  const prev_hash = head?.hash ?? '';
  const hash = eventHash(row, prev_hash);
  return { prev_hash, hash, head: { id: row.id, hash, count: (head?.count ?? 0) + 1 } };
}
// ponytail: full walk per call; checkpoint (verified-through head) in meta if events exceed ~100k.
export function verifyAuditChain(db: Database.Database = appDb()): AuditStatus {
  const rows = db
    .prepare(
      'SELECT id,run_id,user_id,conversation_id,kind,data,created_at,prev_hash,hash FROM events ORDER BY rowid',
    )
    .all() as ChainedRow[];
  const head = metaJson<AuditHead>(db, 'audit-head');
  const legacy = metaJson<AuditStatus['legacy']>(db, 'audit-legacy');
  const result = (checked: number, brokenAt: AuditStatus['brokenAt']): AuditStatus => ({
    status: brokenAt ? 'broken' : 'verified',
    checked,
    legacy,
    brokenAt,
  });
  const at = (r: ChainedRow, reason: NonNullable<AuditStatus['brokenAt']>['reason']) => ({
    eventId: r.id,
    kind: r.kind,
    at: r.created_at,
    reason,
  });
  if (!rows.length && !head) return { status: 'empty', checked: 0, legacy, brokenAt: null };
  const byPrev = new Map<string, ChainedRow[]>();
  for (const r of rows)
    if (r.prev_hash != null) byPrev.set(r.prev_hash, [...(byPrev.get(r.prev_hash) ?? []), r]);
  for (const linked of byPrev.values())
    if (linked.length > 1) return result(0, at(linked[1], 'fork'));
  const reached = new Set<string>();
  let prev = '';
  let last: ChainedRow | undefined;
  for (
    let next = byPrev.get(prev)?.[0];
    next && !reached.has(next.id);
    next = byPrev.get(prev)?.[0]
  ) {
    if (eventHash(next, prev) !== next.hash) return result(reached.size, at(next, 'hash_mismatch'));
    reached.add(next.id);
    prev = next.hash;
    last = next;
  }
  const unlinked = rows
    .filter((r) => !reached.has(r.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (unlinked) return result(reached.size, at(unlinked, 'unlinked_rows'));
  if (!head || last?.hash !== head.hash || reached.size !== head.count)
    return result(reached.size, {
      eventId: head?.id ?? null,
      kind: null,
      at: null,
      reason: 'head_mismatch',
    });
  return result(reached.size, null);
}
