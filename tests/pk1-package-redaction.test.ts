// PK1: the packager redacts key-shaped strings in the transcript copies (scripts/package-prepare.ts
// redact) and still refuses one anywhere else. Keys are built at runtime: no key-shaped literal here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd: string, ...args: string[]) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
const key = (seed: string) => 'sk-' + seed.repeat(12);
const shape = /sk-[A-Za-z0-9_-]{20,}/;

test('PK1: redaction keeps JSONL valid, the manifest holds counts only, the scan stays strict', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk1-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const sessions = path.join(dir, 'ai-sessions', 'claude-code');
  fs.mkdirSync(path.join(sessions, 'sub'), { recursive: true });
  const jsonl = path.join(sessions, 'a.jsonl');
  const lines = [
    { text: 'clean line, sk-short' },
    { text: `quoted "${key('q7')}"\nnext\t${key('Zx')}\\`, n: 1 },
    { nested: { env: `OPENAI_API_KEY=${key('m_')}`, emoji: 'é 🍌' } },
  ];
  fs.writeFileSync(jsonl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const note = path.join(sessions, 'sub', 'tool-result.txt');
  fs.writeFileSync(note, `one\ntwo ${key('ab')}\n`);
  const manifest = path.join(dir, 'ai-sessions', 'REDACTIONS.md');

  const r = run(
    'node',
    '--import',
    'tsx',
    'scripts/package-prepare.ts',
    'redact',
    sessions,
    manifest,
  );
  assert.equal(r.status, 0, r.stderr);

  const out = fs.readFileSync(jsonl, 'utf8');
  assert.doesNotMatch(out + fs.readFileSync(note, 'utf8'), shape);
  const parsed = out
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], lines[0]);
  assert.equal(parsed[1].text.split('[REDACTED: key-shaped string]').length, 3);
  assert.ok(parsed[1].text.endsWith('\\'));
  assert.equal(parsed[2].nested.emoji, 'é 🍌');

  const md = fs.readFileSync(manifest, 'utf8');
  assert.match(md, /Total: 4 key-shaped strings and 0 secret-named values on 3 lines of 2 files/);
  assert.match(md, /a\.jsonl` \| 3 \| 0 \| 2, 3 \|/);
  assert.match(md, /tool-result\.txt` \| 1 \| 0 \| 2 \|/);
  for (const seed of ['q7', 'Zx', 'm_', 'ab'])
    assert.ok(!(md + r.stdout).includes('sk-' + seed[0]));

  if (process.platform === 'win32') return; // the scan is a bash script
  const outside = path.join(dir, 'notes.md');
  fs.writeFileSync(outside, `x\ny ${key('q7')}\n`);
  const scanner = 'scripts/package-submission.sh';
  const scan = run('bash', scanner, '--scan', jsonl, note, manifest, outside);
  assert.equal(scan.status, 1);
  assert.ok(scan.stderr.includes(`${outside}:2`), scan.stderr);
  assert.ok(!scan.stderr.includes('ai-sessions'), scan.stderr);
  assert.equal(run('bash', scanner, '--scan', jsonl, note, manifest).status, 0);
});

// PK1 review: found by the reviewer's probes 1 and 6.
test('PK1: a link among the copies is never written through; an image a document names by its bare name is kept', (t) => {
  if (process.platform === 'win32') return; // symbolic links need a privilege there
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk1-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const at = (...args: string[]) =>
    spawnSync(
      'node',
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(root, 'scripts/package-prepare.ts'),
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    );

  const original = path.join(dir, 'original.jsonl');
  fs.writeFileSync(original, JSON.stringify({ t: key('q7') }) + '\n');
  fs.mkdirSync(path.join(dir, 'copies'));
  fs.symlinkSync(original, path.join(dir, 'copies', 'link.jsonl'));
  const r = at('redact', 'copies', 'REDACTIONS.md');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(original, 'utf8'), shape);

  fs.mkdirSync(path.join(dir, '.scratch/a/shots'), { recursive: true });
  const shots = ['.scratch/a/shots/named.png', '.scratch/a/shots/unnamed.png'];
  for (const f of shots) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'note.md'), 'See `named.png`.\n');
  fs.writeFileSync(path.join(dir, 'list'), [...shots, 'note.md'].join('\n') + '\n');
  const s = at('trim', 'list', 'EXCLUDED.md');
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'list'), 'utf8').trim().split('\n'), [
    shots[0],
    'EXCLUDED.md',
    'note.md',
  ]);
});

// PK2: the value of an assignment to a sensitive-looking name goes too, whatever its shape; the
// name stays. Values are built at runtime.
test('PK2: secret-named values are redacted in the copies only; obvious non-values and other files stay', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk2-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const at = (...args: string[]) =>
    spawnSync(
      'node',
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(root, 'scripts/package-prepare.ts'),
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
  const v = 'Qz7' + 'pL0é'.repeat(6); // no key shape, non-ASCII inside
  const fake = ['banana', 'local', 'admin'].join('-');
  const gone = [
    `cd app\n12-SESSION_SECRET=${v} npm run dev`,
    `OPENAI_API_KEY="${v}"`,
    `apiKey: "${v}",`,
    JSON.stringify({ auth_token: v, n: 1 }),
    `export DB_PASSWORD=${v}\nnext`,
    `Authorization: Bearer ${v}`,
    `curl -H 'Authorization: Bearer ${v}' -d token="${v}" http://localhost`,
  ];
  // PK2 review: a value that only starts like a reference or a placeholder goes too.
  const odd = ['DB_TOKEN=$' + '7' + v, 'DB_TOKEN=<' + v];
  const kept = [
    'TOKEN= and SECRET=changeme and PASSWORD=undefined',
    'API_KEY=process.env.OPENAI_API_KEY',
    'SECRET=${SESSION_SECRET_VALUE} PASSWORD=$ADMIN_PASSWORD_VALUE',
    'TOKEN=<your-token-goes-here>',
    'API_KEY=' + 'x'.repeat(20),
    `BANK_ADMIN_SECRET=${fake}`,
    `-H 'Authorization: Bearer ${fake}'`,
    `MESSAGE=${v}`,
    'const token = readSessionTokenFromCookie(request)',
  ];
  fs.mkdirSync(path.join(dir, 'copies'));
  const jsonl = path.join(dir, 'copies', 'a.jsonl');
  fs.writeFileSync(
    jsonl,
    [...gone, ...odd, ...kept].map((text) => JSON.stringify({ text })).join('\n'),
  );
  const outside = path.join(dir, 'notes.md');
  fs.writeFileSync(outside, gone.join('\n'));

  const r = at('redact', 'copies', 'REDACTIONS.md');
  assert.equal(r.status, 0, r.stderr);
  const texts = fs
    .readFileSync(jsonl, 'utf8')
    .split('\n')
    .map((l) => JSON.parse(l).text);
  const marker = '[REDACTED: secret-named value]';
  assert.deepEqual(texts, [
    ...gone.map((g) => g.replaceAll(v, marker)),
    ...odd.map(() => 'DB_TOKEN=' + marker),
    ...kept,
  ]);
  assert.equal(fs.readFileSync(outside, 'utf8'), gone.join('\n'));

  const md = fs.readFileSync(path.join(dir, 'REDACTIONS.md'), 'utf8');
  assert.match(md, /Total: 0 key-shaped strings and 10 secret-named values on 9 lines of 1 files/);
  assert.match(
    md,
    /a\.jsonl` \| 0 \| 10 \| 1, 2, 3, 4, 5, 6, 7, 8, 9 \| `Authorization`, `DB_PASSWORD`, `DB_TOKEN`, `OPENAI_API_KEY`, `SESSION_SECRET`, `apiKey`, `auth_token`, `token` \|/,
  );
  assert.match(md, /`Authorization`, `BANK_ADMIN_SECRET`/);
  assert.ok(!(md + r.stdout).includes(v.slice(0, 4)) && !(md + r.stdout).includes(fake));

  if (process.platform === 'win32') return; // the scan is a bash script
  const scan = run('bash', 'scripts/package-submission.sh', '--scan', outside);
  assert.equal(scan.status, 0, scan.stderr);
});

// PK2: a folder a document links keeps the images directly inside it.
test('PK2: a .scratch folder a packed document links keeps its own images, not the ones below', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk2-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const files = ['.scratch/a/shots/1.png', '.scratch/a/shots/deep/2.png', '.scratch/b/3.png'];
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  fs.mkdirSync(path.join(dir, 'submission'));
  fs.writeFileSync(path.join(dir, 'submission/README.md'), '[shots](../.scratch/a/shots/).\n');
  fs.writeFileSync(path.join(dir, 'list'), [...files, 'submission/README.md'].join('\n') + '\n');
  const s = spawnSync(
    'node',
    [
      '--import',
      import.meta.resolve('tsx'),
      path.join(root, 'scripts/package-prepare.ts'),
      'trim',
      'list',
      'EXCLUDED.md',
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'list'), 'utf8').trim().split('\n'), [
    files[0],
    'EXCLUDED.md',
    'submission/README.md',
  ]);
});
