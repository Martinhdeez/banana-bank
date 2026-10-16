import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import type { IntentStatus } from './types';
import { eventHash, appendEventChain, writeHead } from './audit';
let instance: Database.Database | undefined;
// INT2: append-only. Never edit an applied migration; add a new one. The version is the list
// position. Add columns only to tables whose writes name their columns (events, intents,
// approvals): runs, messages, incidents, conversations, chunks, embedding_cache and meta still have
// positional inserts.
export const migrations: { name: string; up: (db: Database.Database) => void }[] = [
  {
    // Rounds 1–4 DDL verbatim: every statement is idempotent, so starter and round-4 databases
    // reach the same schema as a fresh one.
    name: 'baseline',
    up: (db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,started_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,run_id TEXT,payload TEXT NOT NULL,status TEXT NOT NULL,bank_reference TEXT,operation_id TEXT,error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,user_id TEXT NOT NULL,conversation_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,text TEXT NOT NULL,title TEXT,version INTEGER,valid_from TEXT,valid_to TEXT,audience TEXT NOT NULL,vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS message_sources(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embedding_cache(key TEXT PRIMARY KEY,vector BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,created_at);
      -- K1: hot lookups (dashboard timelines, operator inbox and case, chat state) were full scans.
      -- The events expression must match the queries' text: json_extract(data,'$.intentId').
      CREATE INDEX IF NOT EXISTS approvals_intent ON approvals(intent_id);
      CREATE INDEX IF NOT EXISTS intents_user ON intents(user_id,created_at);
      CREATE INDEX IF NOT EXISTS intents_conversation ON intents(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS incidents_conversation ON incidents(conversation_id,status);
      CREATE INDEX IF NOT EXISTS events_intent ON events(json_extract(data,'$.intentId'));
      -- K3: the chunk vector cache is keyed by this; databases from before K3 get one here.
      INSERT OR IGNORE INTO meta VALUES('index-version',lower(hex(randomblob(16))));
      -- K1, K8: no query filters incidents by user_id.
      DROP INDEX IF EXISTS incidents_user;
    `),
  },
  {
    // INT1: hash-chain the events. Existing rows are backfilled in insertion order and recorded as
    // legacy: they are known unchanged only since this migration.
    name: 'events-audit-chain',
    up: (db) => {
      db.exec(
        'ALTER TABLE events ADD COLUMN prev_hash TEXT; ALTER TABLE events ADD COLUMN hash TEXT;',
      );
      const rows = db
        .prepare(
          'SELECT rowid,id,run_id,user_id,conversation_id,kind,data,created_at FROM events ORDER BY rowid',
        )
        .all() as (Rows['events'] & { rowid: number })[];
      const update = db.prepare('UPDATE events SET prev_hash=?,hash=? WHERE rowid=?');
      let prev = '';
      for (const row of rows) {
        const hash = eventHash(row, prev);
        update.run(prev, hash, row.rowid);
        prev = hash;
      }
      const last = rows.at(-1);
      if (!last) return;
      writeHead(db, { id: last.id, hash: prev, count: rows.length });
      db.prepare("INSERT OR REPLACE INTO meta VALUES('audit-legacy',?)").run(
        JSON.stringify({ through: last.id, count: rows.length, at: new Date().toISOString() }),
      );
    },
  },
  {
    // OPX4: case views and exports are recorded from here on; earlier ones never were.
    name: 'opx4-activity-since',
    up: (db) =>
      db
        .prepare("INSERT OR IGNORE INTO meta VALUES('case-activity-since',?)")
        .run(new Date().toISOString()),
  },
  {
    // OPX4: case activity and resolution lookups; must match the queries' json_extract text.
    name: 'opx4-events-incident-index',
    up: (db) =>
      db.exec("CREATE INDEX events_incident ON events(json_extract(data,'$.incidentId'))"),
  },
  {
    // CF4-api (M21-1): customer-pinned contact account ids. Version 5, after OPX4's 3–4.
    name: 'cf4-favourite-recipients',
    up: (db) =>
      db.exec(
        'CREATE TABLE favourite_recipients(user_id TEXT NOT NULL,account_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,account_id)) WITHOUT ROWID',
      ),
  },
  {
    // CF5-api (M21-2): read marks of derived notifications, the only notification state stored.
    // Version 6, right after CF4 (checklist-05 migration table).
    name: 'cf5-notification-reads',
    up: (db) =>
      db.exec(
        'CREATE TABLE notification_reads(user_id TEXT NOT NULL,notification_id TEXT NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(user_id,notification_id)) WITHOUT ROWID',
      ),
  },
  {
    // SI2b: the category of a bank movement, per customer. Version 7. `fingerprint` ties the row to
    // the movement's content (a reset bank reuses ids); `pending` is never stored. The CHECK lists
    // are literals on purpose: an applied migration does not follow later edits of the taxonomy.
    name: 'si2-movement-categories',
    up: (db) =>
      db.exec(`
      CREATE TABLE movement_categories(
        user_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','transfer_person','savings_internal','income','other')),
        state TEXT NOT NULL CHECK(state IN ('estimated','confirmed','needs_review')),
        source TEXT NOT NULL CHECK(source IN ('user','user_rule','rule','model','none')),
        reason TEXT NOT NULL,
        confidence REAL,
        threshold REAL,
        candidates TEXT NOT NULL,
        model TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, movement_id)
      ) WITHOUT ROWID;
      CREATE INDEX movement_categories_merchant ON movement_categories(user_id, merchant_key);
    `),
  },
  {
    // SI2b: the customer's own rule for a merchant key, the durable memory of corrections. Version 8.
    name: 'si2-category-rules',
    up: (db) =>
      db.exec(
        "CREATE TABLE category_rules(user_id TEXT NOT NULL,merchant_key TEXT NOT NULL CHECK(merchant_key<>''),category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','transfer_person','savings_internal','income','other')),created_at TEXT NOT NULL,PRIMARY KEY(user_id,merchant_key)) WITHOUT ROWID",
      ),
  },
  {
    // SI6a: extra data of a chat message (attached movement; SI6b: quick replies, their server-side
    // target, cited movements) as JSON, like message_sources: `messages` cannot gain a column.
    // Version 9. Rows go with their message (reset, cascade).
    name: 'si6-message-extras',
    up: (db) =>
      db.exec(
        'CREATE TABLE message_extras(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,data TEXT NOT NULL)',
      ),
  },
  {
    // IT4 (A1, A2): one row per merchant (key + sign) sent to a decider: the count is the
    // customer's daily budget; `answer` (JSON: the stored verdict and the fingerprints of the
    // movements it was given for; NULL while asked or failed) is what a later call reuses instead
    // of asking again. Version 10. `chain` names the deciders and their models.
    name: 'it4-decider-asks',
    up: (db) =>
      db.exec(`
      CREATE TABLE decider_asks(
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        chain TEXT NOT NULL,
        asked_at TEXT NOT NULL,
        answer TEXT
      );
      CREATE INDEX decider_asks_user ON decider_asks(user_id, asked_at);
    `),
  },
  {
    // PT1 (plan 25 §2): transfers the customer left prepared. The app never sends one: a row only
    // names what Send proposes. Version 11. `to_name` is the destination's name when it was
    // prepared (as DV7-B), for the views that make no bank call. `attempt` numbers the send
    // attempts of the open occurrence: the intent of one is `prepared:<id>:<key>:<attempt>`.
    name: 'pt1-prepared-transfers',
    up: (db) =>
      db.exec(`
      CREATE TABLE prepared_transfers(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL, to_name TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents>0), concept TEXT NOT NULL, note TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('manual','on_date','monthly')),
        day INTEGER CHECK(day BETWEEN 1 AND 31),
        next_due TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','sent','deleted')),
        last_sent_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX prepared_transfers_user ON prepared_transfers(user_id,status);
    `),
  },
  {
    // TR1 (plan 27 §4): one row per request the app makes to a model provider. Append-only: every
    // total is a SUM of these rows. No prompt, answer, tool argument or movement text: tool NAMES
    // and counts only; `host` is a hostname, never a key or a path. Money is whole nano-dollars;
    // the price used is copied into the row, so a later price change does not rewrite history.
    // Version 12. Not wiped by seedApp(): the money was spent whatever happened to the demo data.
    name: 'tr1-ai-usage',
    up: (db) =>
      db.exec(`
      CREATE TABLE ai_usage(
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('customer','operator','system')),
        user_id TEXT,
        conversation_id TEXT,
        run_id TEXT,
        consumer TEXT NOT NULL CHECK(consumer IN ('assistant','operator_preview','decider:systemone','decider:openai','embeddings')),
        seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed')),
        model TEXT NOT NULL,
        host TEXT NOT NULL,
        input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        tools TEXT NOT NULL,
        price_input INTEGER, price_cached INTEGER, price_output INTEGER,
        price_source TEXT,
        cost_nano_usd INTEGER,
        cost_basis TEXT NOT NULL CHECK(cost_basis IN ('estimated','provider','unpriced'))
      );
      CREATE INDEX ai_usage_user ON ai_usage(user_id, created_at);
      CREATE INDEX ai_usage_run ON ai_usage(run_id);
    `),
  },
  {
    // GL1 (plan 28 §4.3): savings goals. A goal is fed by one monthly prepared transfer between two
    // own accounts (`prepared_transfers.goal_id`; the rows it had before stay, deleted, and their
    // completed intents are what the goal has saved). Version 13. Every write of
    // prepared_transfers names its columns, so the new column is NULL for an ordinary one.
    name: 'gl1-goals',
    up: (db) =>
      db.exec(`
      CREATE TABLE goals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        target_cents INTEGER NOT NULL CHECK(target_cents>0), target_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')), created_at TEXT NOT NULL);
      ALTER TABLE prepared_transfers ADD COLUMN goal_id TEXT;
    `),
  },
  {
    // FC2 (plan 28 §13): what the customer changed in the month forecast by hand. `exclude`: the
    // usual item with `merchant_key` on that account is left out; `expect`: a charge the rule
    // cannot see, monthly on `day` or once on `date`. `label` of an `expect` is the customer's
    // own text. A removed row keeps `removed_at`. Cleared by a reseed, like prepared_transfers.
    name: 'fc2-forecast-adjustments',
    up: (db) =>
      db.exec(`
      CREATE TABLE forecast_adjustments(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('exclude','expect')),
        merchant_key TEXT, label TEXT NOT NULL,
        amount_cents INTEGER CHECK(amount_cents>0),
        repeats TEXT CHECK(repeats IN ('monthly','once')),
        day INTEGER CHECK(day BETWEEN 1 AND 31), date TEXT,
        created_at TEXT NOT NULL, removed_at TEXT);
      CREATE INDEX forecast_adjustments_user ON forecast_adjustments(user_id,removed_at);
    `),
  },
  {
    // CAT1 (plan 23, contracts.md 2.36): the category `work`. SQLite cannot change a CHECK, so the
    // two tables of versions 7 and 8 are rebuilt with the new literal list and their rows copied.
    name: 'cat1-work-category',
    up: (db) =>
      db.exec(`
      CREATE TABLE movement_categories_new(
        user_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','work','transfer_person','savings_internal','income','other')),
        state TEXT NOT NULL CHECK(state IN ('estimated','confirmed','needs_review')),
        source TEXT NOT NULL CHECK(source IN ('user','user_rule','rule','model','none')),
        reason TEXT NOT NULL,
        confidence REAL,
        threshold REAL,
        candidates TEXT NOT NULL,
        model TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, movement_id)
      ) WITHOUT ROWID;
      INSERT INTO movement_categories_new SELECT * FROM movement_categories;
      DROP TABLE movement_categories;
      ALTER TABLE movement_categories_new RENAME TO movement_categories;
      CREATE INDEX movement_categories_merchant ON movement_categories(user_id, merchant_key);
      CREATE TABLE category_rules_new(user_id TEXT NOT NULL,merchant_key TEXT NOT NULL CHECK(merchant_key<>''),category TEXT NOT NULL CHECK(category IN ('groceries','eating_out_leisure','transport','home_utilities','health','shopping','work','transfer_person','savings_internal','income','other')),created_at TEXT NOT NULL,PRIMARY KEY(user_id,merchant_key)) WITHOUT ROWID;
      INSERT INTO category_rules_new SELECT * FROM category_rules;
      DROP TABLE category_rules;
      ALTER TABLE category_rules_new RENAME TO category_rules;
    `),
  },
  {
    // VC1: the consumer `voice` (a chat recording transcribed). SQLite cannot change a CHECK, so
    // `ai_usage` of version 12 is rebuilt with the new literal list and its rows copied.
    name: 'vc1-voice-consumer',
    up: (db) =>
      db.exec(`
      CREATE TABLE ai_usage_new(
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('customer','operator','system')),
        user_id TEXT,
        conversation_id TEXT,
        run_id TEXT,
        consumer TEXT NOT NULL CHECK(consumer IN ('assistant','operator_preview','decider:systemone','decider:openai','embeddings','voice')),
        seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed')),
        model TEXT NOT NULL,
        host TEXT NOT NULL,
        input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        tools TEXT NOT NULL,
        price_input INTEGER, price_cached INTEGER, price_output INTEGER,
        price_source TEXT,
        cost_nano_usd INTEGER,
        cost_basis TEXT NOT NULL CHECK(cost_basis IN ('estimated','provider','unpriced'))
      );
      INSERT INTO ai_usage_new SELECT * FROM ai_usage;
      DROP TABLE ai_usage;
      ALTER TABLE ai_usage_new RENAME TO ai_usage;
      CREATE INDEX ai_usage_user ON ai_usage(user_id, created_at);
      CREATE INDEX ai_usage_run ON ai_usage(run_id);
    `),
  },
  {
    // RG1: an `expect` adjustment may be an income. NULL is a charge, as every row before it.
    name: 'rg1-expect-direction',
    up: (db) =>
      db.exec(
        "ALTER TABLE forecast_adjustments ADD COLUMN direction TEXT CHECK(direction IN ('income'))",
      ),
  },
];
export const SCHEMA_VERSION = migrations.length;
// INT2: one IMMEDIATE transaction reads the version and applies what is missing, so two processes
// opening an old database do not both migrate, and a failure leaves the previous version.
function migrate(db: Database.Database) {
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
    );
    const current =
      (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null })
        .v ?? 0;
    if (current > migrations.length)
      throw new Error(
        `app.sqlite is at schema version ${current}; this code knows ${migrations.length}. Update the code or run npm run reset.`,
      );
    for (const [i, m] of migrations.entries())
      if (i + 1 > current) {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(
          i + 1,
          m.name,
          new Date().toISOString(),
        );
      }
  }).immediate();
}
export function appDb() {
  if (!instance) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = new Database(path.join(config.dataDir, 'app.sqlite'));
    // INT2: busy_timeout first, so a second process opening the file at the same time waits for the
    // WAL switch and the migration lock instead of failing with "database is locked".
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // INT2: the handle is kept only once migrated; a failure closes it so the next call retries.
    try {
      migrate(db);
    } catch (e) {
      db.close();
      throw e;
    }
    instance = db;
  }
  return instance;
}
// K5: rows by column name, so an insert never depends on the table's column order. Nullable
// columns are optional (omitted = NULL); a missing required or unknown column is a type error.
type Rows = {
  conversations: { id: string; user_id: string; title: string; created_at: string };
  messages: {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    created_at: string;
    run_id?: string | null;
  };
  intents: {
    id: string;
    user_id: string;
    conversation_id?: string | null;
    run_id?: string | null;
    payload: string;
    status: IntentStatus;
    bank_reference?: string | null;
    operation_id?: string | null;
    error?: string | null;
    created_at: string;
  };
  approvals: {
    id: string;
    user_id: string;
    intent_id: string;
    payload: string;
    expires_at: string;
    consumed_at?: string | null;
  };
  incidents: {
    id: string;
    user_id: string;
    conversation_id: string;
    summary: string;
    status: string;
    created_at: string;
  };
  events: {
    id: string;
    run_id: string;
    user_id: string;
    conversation_id?: string | null;
    kind: string;
    data: string;
    created_at: string;
  };
  favourite_recipients: { user_id: string; account_id: string; created_at: string };
  notification_reads: { user_id: string; notification_id: string; read_at: string };
  prepared_transfers: {
    id: string;
    user_id: string;
    from_account_id: string;
    to_account_id: string;
    to_name: string;
    amount_cents: number;
    concept: string;
    note?: string | null;
    kind: 'manual' | 'on_date' | 'monthly';
    day?: number | null;
    next_due?: string | null;
    created_at: string;
    goal_id?: string | null;
  };
  goals: {
    id: string;
    user_id: string;
    name: string;
    target_cents: number;
    target_date: string;
    created_at: string;
  };
  forecast_adjustments: {
    id: string;
    user_id: string;
    account_id: string;
    kind: 'exclude' | 'expect';
    merchant_key?: string | null;
    label: string;
    amount_cents?: number | null;
    repeats?: 'monthly' | 'once' | null;
    day?: number | null;
    date?: string | null;
    direction?: 'income' | null; // RG1
    created_at: string;
  };
};
export function insert<T extends keyof Rows>(table: T, input: Rows[T], { orIgnore = false } = {}) {
  const db = appDb();
  const write = (row: Record<string, unknown>) => {
    const columns = Object.keys(row).filter((c) => row[c] !== undefined);
    // Identifiers are never taken on trust: only the table's own columns reach the SQL text.
    const known = new Set(
      (db.pragma(`table_info(${JSON.stringify(table)})`) as { name: string }[]).map((c) => c.name),
    );
    const unknown = columns.find((c) => !known.has(c));
    if (unknown) throw new Error(`insert: ${table} has no column ${unknown}`);
    return db
      .prepare(
        `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table}(${columns.join(',')}) VALUES(${columns.map((c) => `@${c}`).join(',')})`,
      )
      .run(Object.fromEntries(columns.map((c) => [c, row[c]])));
  };
  if (table !== 'events') return write(input);
  // INT1: every event write (recordEvent, and through it src/agent's tool events) is chained here.
  // IMMEDIATE takes the write lock before the head is read; nested in a caller's transaction it
  // becomes a savepoint, so a rollback also drops the head update. Caller-set hashes are ignored.
  return db
    .transaction(() => {
      const { head, prev_hash, hash } = appendEventChain(db, input as Rows['events']);
      const result = write({ ...input, prev_hash, hash });
      if (result.changes) writeHead(db, head);
      return result;
    })
    .immediate();
}
// TR1: the usage recorder never opens (and so never creates) a database on its own.
export const appDbOpen = () => !!instance;
export function closeAppDb() {
  instance?.close();
  instance = undefined;
}
