// PK2: the packaged transcript COPIES lose what the challenge does not ask for (embedded screenshots,
// the toolUseResult text a tool_result repeats, hook-status and file-history records) and keep every
// message, tool call and tool result (scripts/package-prepare.ts slim, check).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const png = Buffer.alloc(3000, 7).toString('base64');
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };

const prepare = (...args: string[]) =>
  spawnSync('node', ['--import', 'tsx', 'scripts/package-prepare.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk2-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
};

test('PK2 review: a record holding U+2028 or U+2029 inside a string stays one valid line', (t) => {
  const dir = tmp(t);
  const records = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      message: { role: 'user', content: 'Car\u2028insurance for 2026\u2029ok' },
    },
    { type: 'system', subtype: 'turn_duration', uuid: 's1', parentUuid: 'u1' },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 's1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'line\u2028sep' }] },
    },
  ];
  const lines = records.map((r) => JSON.stringify(r));
  assert.ok(lines[0].includes('\u2028'), 'the fixture holds the raw character');
  const jsonl = path.join(dir, 'a.jsonl');
  fs.writeFileSync(jsonl, lines.join('\n') + '\n');
  const r = prepare('slim', dir, path.join(dir, 'TRIMMED.md'));
  assert.equal(r.status, 0, r.stderr);
  const out = fs.readFileSync(jsonl, 'utf8').trimEnd().split('\n');
  assert.equal(out.length, 2);
  assert.equal(out[0], lines[0], 'untouched byte for byte');
  assert.equal(JSON.parse(out[1]).message.content[0].text, 'line\u2028sep');
  assert.equal(JSON.parse(out[1]).parentUuid, 'u1');
});

test('PK2 review: only the toolUseResult text the tool_result repeats goes', (t) => {
  const dir = tmp(t);
  const result = (id: string, content: unknown) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  });
  const diff = { 'src/a.ts': [{ oldStart: 1, lines: ['-a', '+b'] }] };
  const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-x', '+y'] }];
  const records = [
    {
      type: 'user',
      uuid: 'bash',
      message: result('t1', 'hello\nworld'),
      toolUseResult: {
        stdout: 'hello\nworld',
        stderr: 'warn',
        interrupted: false,
        bashEditDiff: diff,
      },
    },
    {
      type: 'user',
      uuid: 'read',
      message: result('t2', [{ type: 'text', text: '     1\tline one\n     2\tline two\n' }]),
      toolUseResult: {
        type: 'text',
        file: { filePath: '/x.ts', content: 'line one\nline two', numLines: 2 },
      },
    },
    {
      type: 'user',
      uuid: 'edit',
      message: result('t3', 'The file /x.ts has been updated.'),
      toolUseResult: {
        filePath: '/x.ts',
        structuredPatch: patch,
        originalFile: 'x\n',
        oldString: 'x',
        newString: 'y',
      },
    },
    {
      type: 'user',
      uuid: 'persisted',
      message: result('t4', '<persisted-output>\nOutput too large. Preview: abc'),
      toolUseResult: { stdout: 'abc and much more that the tool_result does not hold', stderr: '' },
    },
  ];
  const jsonl = path.join(dir, 'a.jsonl');
  fs.writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const manifest = path.join(dir, 'TRIMMED.md');
  const r = prepare('slim', dir, manifest);
  assert.equal(r.status, 0, r.stderr);
  const [bash, read, edit, persisted] = fs
    .readFileSync(jsonl, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(bash.toolUseResult, { stderr: 'warn', interrupted: false, bashEditDiff: diff });
  assert.deepEqual(read.toolUseResult, { type: 'text', file: { filePath: '/x.ts', numLines: 2 } });
  assert.deepEqual(
    edit.toolUseResult,
    records[2].toolUseResult,
    'structuredPatch and originalFile stay',
  );
  assert.deepEqual(
    persisted.toolUseResult,
    records[3].toolUseResult,
    'a stdout not in the tool_result stays',
  );
  assert.equal(bash.message.content[0].content, 'hello\nworld', 'the tool_result stays');
  const md = fs.readFileSync(manifest, 'utf8');
  assert.match(md, /\| toolUseResult\.stdout \|[^\n]*\| 1 \|/);
  assert.match(md, /\| toolUseResult\.file\.content \|[^\n]*\| 1 \|/);
});

test('PK2 review: check fails when a copy lost a tool result, and passes on an equal copy', (t) => {
  const dir = tmp(t);
  const rec = [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const write = (f: string, rs: unknown[]) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  write(path.join(dir, 'orig', 'p', 'a.jsonl'), rec);
  write(path.join(dir, 'copy', 'p', 'a.jsonl'), rec.slice(0, 3));
  const check = () =>
    prepare(
      'check',
      path.join(dir, 'orig'),
      path.join(dir, 'copy'),
      String(Date.now() + 60000),
      path.join(dir, 'CHECK.md'),
    );
  let r = check();
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    fs.readFileSync(path.join(dir, 'CHECK.md'), 'utf8'),
    /Transcripts: 1 equal, [^\n]*, 0 different/,
  );
  write(path.join(dir, 'copy', 'p', 'a.jsonl'), rec.slice(0, 2));
  r = check();
  assert.equal(r.status, 1, 'a lost tool result fails the package');
  assert.match(
    fs.readFileSync(path.join(dir, 'CHECK.md'), 'utf8'),
    /\| `p\/a\.jsonl` \| DIFFERENT \| 3 \/ 2 \| 1 \/ 1 \| 1 \/ 0 \|/,
  );
});

test('PK2: screenshots become a marker, duplicates and status records go, the conversation stays', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk2-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const sessions = path.join(dir, 'ai-sessions', 'claude-code');
  fs.mkdirSync(sessions, { recursive: true });
  const toolResult = {
    type: 'tool_result',
    tool_use_id: 't1',
    content: [{ type: 'text', text: 'shot' }, image],
  };
  const records = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hola' } },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Shot', input: { url: 'x' } }],
      },
    },
    {
      type: 'attachment',
      uuid: 'h1',
      parentUuid: 'a1',
      attachment: { type: 'hook_success', stdout: '{}' },
    },
    { type: 'system', subtype: 'stop_hook_summary', uuid: 'h2', parentUuid: 'h1' },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'h2',
      message: { role: 'user', content: [toolResult] },
      toolUseResult: { type: 'image', file: { base64: png, type: 'image/png' } },
    },
    { type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [image] } },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
    { type: 'system', subtype: 'turn_duration', durationMs: 5 },
    {
      type: 'user',
      uuid: 'u4',
      parentUuid: 'u3',
      toolUseResult: { stdout: 'kept: no tool_result here' },
      message: { role: 'user', content: `see data:image/png;base64,${png}` },
    },
  ];
  const jsonl = path.join(sessions, 'a.jsonl');
  const lines = records.map((r) => JSON.stringify(r));
  fs.writeFileSync(jsonl, lines.join('\n') + '\n{"type":"user","unfinished');
  const manifest = path.join(dir, 'ai-sessions', 'TRIMMED.md');

  const r = spawnSync(
    'node',
    ['--import', 'tsx', 'scripts/package-prepare.ts', 'slim', sessions, manifest],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0, r.stderr);

  const out = fs.readFileSync(jsonl, 'utf8').trimEnd().split('\n');
  assert.equal(out.at(-1), '{"type":"user","unfinished', 'a line that is not JSON stays');
  const kept = out.slice(0, -1).map((l) => JSON.parse(l));
  assert.deepEqual(
    kept.map((k) => k.uuid),
    ['u1', 'a1', 'u2', 'u3', 'u4'],
  );
  assert.equal(out[0], lines[0], 'a line with nothing to remove is unchanged byte for byte');
  assert.equal(out[1], lines[1], 'the tool call is unchanged');
  assert.equal(kept[2].parentUuid, 'a1', 'the thread skips the dropped hook records');
  assert.ok(!out.join('\n').includes(png.slice(0, 200)), 'no image base64 left');
  const marker = /^\[screenshot removed for size: 3 KB, sha256 [0-9a-f]{12}\]$/;
  const block = kept[2].message.content[0].content[1];
  assert.equal(block.type, 'image');
  assert.equal(block.source.media_type, 'image/png');
  assert.match(block.source.data, marker);
  assert.equal(kept[2].message.content[0].content[0].text, 'shot', 'tool_result content stays');
  assert.equal(kept[2].toolUseResult.type, 'image', 'a toolUseResult with no repeated text stays');
  assert.match(kept[2].toolUseResult.file.base64, marker);
  assert.match(kept[3].message.content[0].source.data, marker);
  assert.deepEqual(kept[4].toolUseResult, records[8].toolUseResult, 'kept without a tool_result');
  assert.match(
    kept[4].message.content,
    /^see data:image\/png;base64,\[screenshot removed for size: 3 KB/,
  );

  const md = fs.readFileSync(manifest, 'utf8');
  assert.match(md, /originals?[^\n]*untouched/i);
  assert.match(md, /\| image \|[^\n]*\| 4 \|/);
  for (const k of [
    'attachment:hook_success',
    'system:stop_hook_summary',
    'system:turn_duration',
    'file-history-snapshot',
  ])
    assert.match(md, new RegExp(`\\| ${k} \\|[^\\n]*\\| 1 \\|`));
});
