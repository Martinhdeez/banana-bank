import { appDb, insert } from './db';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { restoreIndex } from './retrieval/store';
export function seedApp() {
  const db = appDb();
  db.transaction(() => {
    db.exec(
      'DELETE FROM messages; DELETE FROM conversations; DELETE FROM incidents; DELETE FROM intents; DELETE FROM approvals; DELETE FROM events; DELETE FROM runs; DELETE FROM chunks; DELETE FROM embedding_cache; DELETE FROM meta; DELETE FROM favourite_recipients; DELETE FROM notification_reads; DELETE FROM movement_categories; DELETE FROM category_rules; DELETE FROM decider_asks; DELETE FROM prepared_transfers; DELETE FROM goals; DELETE FROM forecast_adjustments;',
    );
    const histories: {
      id: string;
      userId: string;
      title: string;
      createdAt: string;
      messages: { role: string; content: string }[];
      case?: { id: string; status: string };
    }[] = JSON.parse(readFileSync(path.resolve('fixtures/conversations.json'), 'utf8'));
    for (const history of histories) {
      insert('conversations', {
        id: history.id,
        user_id: history.userId,
        title: history.title,
        created_at: history.createdAt,
      });
      history.messages.forEach((entry, index) =>
        insert('messages', {
          id: `${history.id}-message-${index}`,
          conversation_id: history.id,
          role: entry.role,
          content: entry.content,
          created_at: new Date(Date.parse(history.createdAt) + index * 10000).toISOString(),
        }),
      );
      if (history.case)
        insert('incidents', {
          id: history.case.id,
          user_id: history.userId,
          conversation_id: history.id,
          summary: history.messages.at(-1)!.content,
          status: history.case.status,
          created_at: history.createdAt,
        });
    }
    insert('intents', {
      id: 'intent-historic-lucia',
      user_id: 'lucia',
      conversation_id: 'conv-lucia-support',
      run_id: 'run-historic-lucia',
      payload: JSON.stringify({
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-bruno',
        amountCents: 8500,
        concept: 'Team dinner',
      }),
      status: 'failed',
      bank_reference: 'ref-historic-lucia',
      error: 'No response received from the bank.',
      created_at: '2026-09-23T16:41:12.000Z',
    });
    db.prepare('INSERT INTO meta VALUES(?,?)').run('seed', 'banana-v3-2026-09-25');
    // OPX4: the wipe above drops the meta row; seeded cases have no recorded views before now.
    db.prepare('INSERT INTO meta VALUES(?,?)').run('case-activity-since', new Date().toISOString());
  })();
  const index = path.resolve('fixtures/embeddings/index.json.gz');
  if (existsSync(index)) restoreIndex(JSON.parse(gunzipSync(readFileSync(index)).toString()));
  return {
    conversations: (db.prepare('SELECT COUNT(*) n FROM conversations').get() as { n: number }).n,
    incidents: (db.prepare('SELECT COUNT(*) n FROM incidents').get() as { n: number }).n,
    indexLoaded: existsSync(index),
  };
}
