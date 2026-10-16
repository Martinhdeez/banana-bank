// PK1: the two packaging-time steps of scripts/package-submission.sh that need more than grep.
//   redact <dir> <manifest>  replaces every key-shaped string, and (PK2) the value of every
//                            assignment to a sensitive-looking name, in the collected transcript
//                            COPIES under <dir> and writes the manifest (counts, line numbers and
//                            variable names only).
//   slim <dir> <manifest>    (PK2) makes the transcript COPIES under <dir> smaller: drops the
//                            hook-status and file-history records, the two toolUseResult fields
//                            whose text is in the record's tool_result (Read file.content, Bash
//                            stdout), and replaces each embedded image's base64 with a marker;
//                            writes the counts.
//   check <orig> <copies> <since-ms> <manifest>
//                            (PK2) per transcript, compares the original under <orig> with its
//                            copy under <copies>: user/assistant records, tool_use ids,
//                            tool_result ids; exits 1 on a difference. An original changed after
//                            <since-ms> (a session open during the run) may only have more. A copy
//                            with no original (EXTRA_SESSION_FILES) is listed, not compared.
//   trim <list> <manifest>   drops from the package list the .scratch binaries no packed .md file
//                            links to, writes the manifest and prints the size tables.
// Neither step ever prints or stores a matched string.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Same shape as the packager's scan (refuse_on_keys). No allowlist here: inside a transcript copy
// every match goes, the known fakes included.
const KEY = /sk-[A-Za-z0-9_-]{20,}/g;
const MARKER = '[REDACTED: key-shaped string]';

// PK2: values that are not key-shaped but sit under a sensitive-looking name. The keyword comes
// first in the pattern (a leading [\w-]* would be quadratic on a base64 run); the start of the
// identifier is read back from the line. Forms: NAME=value, NAME="value", NAME: "value",
// "NAME": "value" (quotes escaped any number of times, as inside a JSON string), and
// Authorization: Bearer value. The value class holds no quote, backslash, space or control
// character, so a replacement never leaves the JSON string it is in and never cuts a UTF-8 sequence.
const NAMED_MARKER = '[REDACTED: secret-named value]';
const Q = String.raw`\\*["'\x60]`;
const VALUE = String.raw`([^\x00-\x20"'\x60\\()]{16,})`;
const ASSIGN = new RegExp(
  String.raw`(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTHORIZATION|BEARER)[\w-]*(?:(?:${Q})?[ \t]*[:=][ \t]*${Q}|=)${VALUE}`,
  'gi',
);
const BEARER = new RegExp(
  String.raw`(?:Authorization(?:${Q})?[ \t]*[:=][ \t]*(?:${Q})?(?:(?:Bearer|Basic|Token)[ \t]+)?|Bearer[ \t]+)${VALUE}`,
  'gi',
);
// Kept so the transcripts stay readable: references and placeholders, a call, and the local fake
// the repository documents (.env.example, src/config.ts). Words like none or changeme are under
// 16 characters and never match. PK2 review: a reference is `$NAME` or `${…}` and a placeholder is
// a closed `<…>`; a value that only starts with `$` or `<` goes.
const NOT_A_VALUE = /^(process\.env|import\.meta\.env|\$[{A-Za-z_]|<[^<>]*>|x+$|\*+$)/i;
const LOCAL_FAKE = 'banana-local-admin';

const BINARY = /^\.scratch\/.*\.(png|jpe?g|gif|webm|zip)$/i;

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    // Regular files only: a symbolic link in a copied session folder could point back at an
    // original, and writing through it would change that original (PK1 review).
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    })
    .sort();

const parses = (latin1Line: string) => {
  try {
    JSON.parse(Buffer.from(latin1Line, 'latin1').toString('utf8'));
    return true;
  } catch {
    return false;
  }
};

function redact(dir: string, manifest: string) {
  const rows: { file: string; count: number; named: number; lines: number[]; names: string[] }[] =
    [];
  const fakeNames = new Set<string>();
  for (const file of fs.existsSync(dir) ? walk(dir) : []) {
    // latin1 keeps every byte as it is, so a non-text file is never damaged.
    // ponytail: whole file in memory; stream by line if a transcript ever passes ~500 MB.
    const lines = fs.readFileSync(file, 'latin1').split('\n');
    const hit: number[] = [];
    let count = 0;
    let named = 0;
    const names = new Set<string>();
    lines.forEach((line, i) => {
      const n = line.match(KEY)?.length ?? 0;
      let m = 0;
      const value = (text: string, re: RegExp, nameOf: (hit: string, at: number) => string) =>
        text.replace(re, (hit: string, v: string, at: number) => {
          if (NOT_A_VALUE.test(v) || text[at + hit.length] === '(') return hit;
          const name = nameOf(hit, at);
          if (v.replace(/[,;.]+$/, '') === LOCAL_FAKE) return (fakeNames.add(name), hit);
          m++;
          names.add(name);
          return hit.slice(0, -v.length) + NAMED_MARKER;
        });
      const keyed = n ? line.replace(KEY, MARKER) : line;
      const bearer = value(keyed, BEARER, () => 'Authorization');
      // The identifier around the keyword, without the letter of a JSON escape (\n, \t) or the
      // line number of a grep output in front of it.
      const out = value(bearer, ASSIGN, (hit, at) => {
        let pre = bearer.slice(Math.max(0, at - 40), at).match(/[\w-]*$/)![0];
        if (bearer[at - pre.length - 1] === '\\') pre = pre.slice(1);
        return (pre + hit.match(/^[\w-]+/)![0]).replace(/^[\d-]+/, '');
      });
      if (!n && !m) return;
      // The patterns and the markers hold no quote or backslash, so a JSON string stays a JSON
      // string; checked anyway on every line that was valid before.
      if (file.endsWith('.jsonl') && parses(line) && !parses(out))
        throw new Error(`redaction broke the JSON of ${file}:${i + 1}`);
      lines[i] = out;
      count += n;
      named += m;
      hit.push(i + 1);
    });
    if (hit.length) {
      fs.writeFileSync(file, lines.join('\n'), 'latin1');
      rows.push({
        file: path.relative(path.dirname(manifest), file),
        count,
        named,
        lines: hit,
        names: [...names].sort(),
      });
    }
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  const namedTotal = rows.reduce((s, r) => s + r.named, 0);
  const code = (list: string[]) => list.map((n) => `\`${n}\``).join(', ');
  const lineCount = rows.reduce((s, r) => s + r.lines.length, 0);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(
    manifest,
    [
      '# Redactions in the AI session transcripts',
      '',
      `The packager (\`scripts/package-submission.sh\`) replaced every key-shaped string (\`sk-\` plus 20 or more key characters) in the packaged copies of the transcripts with \`${MARKER}\`. The original transcripts are untouched. Nobody judged whether a string was a real key; the strings, their prefixes and their hashes are not recorded anywhere.`,
      '',
      `It also replaced with \`${NAMED_MARKER}\` the value (16 or more characters) assigned to a name that looks sensitive (API key, secret, token, password, private key, authorization, bearer); the name stays. References and placeholders (\`process.env.X\`, \`$X\`, \`<…>\`, \`xxx…\`) are kept, and so is the local fake admin secret the repository documents in \`.env.example\`, found here under: ${code([...fakeNames].sort()) || 'no name'}.`,
      '',
      `Total: ${total} key-shaped strings and ${namedTotal} secret-named values on ${lineCount} lines of ${rows.length} files.`,
      '',
      '| File | Key-shaped | Secret-named values | Lines | Names |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| \`${r.file}\` | ${r.count} | ${r.named} | ${r.lines.join(', ')} | ${code(r.names)} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log(
    `Redacted ${total} key-shaped strings and ${namedTotal} secret-named values on ${lineCount} lines of ${rows.length} files`,
  );
}

// PK2: what the challenge does not ask for in the transcripts ("conversations, intermediate steps,
// tool calls and recorded results"). Records with no message: hook runs and their summaries, turn
// timings, editor file-history snapshots.
const DROP_RECORD = (r: Record<string, any>): string | null => {
  if (r.type === 'file-history-snapshot' || r.type === 'file-history-delta') return r.type;
  if (r.type === 'system' && ['stop_hook_summary', 'turn_duration'].includes(r.subtype))
    return `system:${r.subtype}`;
  if (r.type === 'attachment' && r.attachment?.type === 'hook_success')
    return 'attachment:hook_success';
  return null;
};
const DATA_URI = /(data:image\/[\w.+-]+;base64,)[A-Za-z0-9+/=]{100,}/g;
const imageMarker = (b64: string) => {
  const raw = Buffer.from(b64, 'base64');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `[screenshot removed for size: ${Math.round(raw.length / 1024)} KB, sha256 ${hash}]`;
};

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
      : '';

function slim(dir: string, manifest: string) {
  const dropped = new Map<string, [number, number]>();
  const add = (k: string, bytes: number) => {
    const g = dropped.get(k) ?? [0, 0];
    dropped.set(k, [g[0] + 1, g[1] + bytes]);
  };
  const stringBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  // Every image's base64 goes, wherever it sits: an image block ({type:image, source:{data}}) at
  // any depth, a Read result ({type:image, file:{base64}}), and a data:image URI in any string.
  const images = (o: any): any => {
    if (typeof o === 'string')
      return o.replace(DATA_URI, (m, head: string) => {
        add('image', m.length - head.length);
        return head + imageMarker(m.slice(head.length));
      });
    if (Array.isArray(o)) return o.map(images);
    if (!o || typeof o !== 'object') return o;
    if (o.type === 'image' && typeof o.source?.data === 'string' && o.source.type === 'base64') {
      add('image', o.source.data.length);
      return { ...o, source: { ...o.source, data: imageMarker(o.source.data) } };
    }
    if (o.type === 'image' && typeof o.file?.base64 === 'string') {
      add('image', o.file.base64.length);
      return { ...o, file: { ...o.file, base64: imageMarker(o.file.base64) } };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, images(v)]));
  };
  let files = 0;
  let before = 0;
  let after = 0;
  let relinked = 0;
  for (const file of fs.existsSync(dir) ? walk(dir).filter((f) => f.endsWith('.jsonl')) : []) {
    files++;
    // A dropped record's children point at its parent instead, so the thread stays whole.
    const parentOf = new Map<string, string | null>();
    const out: string[] = [];
    // PK2 review: split on \n only. readline also splits on U+2028/U+2029, which JSON.stringify
    // leaves raw inside strings, and so cut valid records in two.
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      before += Buffer.byteLength(line) + 1;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        out.push(line); // an unfinished last line stays as it is
        continue;
      }
      if (!r || typeof r !== 'object') {
        out.push(line);
        continue;
      }
      const kind = DROP_RECORD(r);
      if (kind) {
        add(kind, Buffer.byteLength(line) + 1);
        if (typeof r.uuid === 'string') parentOf.set(r.uuid, r.parentUuid ?? null);
        continue;
      }
      let changed = false;
      if (typeof r.parentUuid === 'string' && parentOf.has(r.parentUuid)) {
        let p: string | null = r.parentUuid;
        while (p !== null && parentOf.has(p)) p = parentOf.get(p)!;
        r.parentUuid = p;
        relinked++;
        changed = true;
      }
      // PK2 review: only the toolUseResult fields whose text the tool_result already holds go;
      // everything else in it (bashEditDiff, structuredPatch, originalFile, gitOperation, stderr,
      // paths, a stdout kept in a <persisted-output> file) stays.
      const u = r.toolUseResult;
      const results = Array.isArray(r.message?.content)
        ? r.message.content.filter((b: any) => b?.type === 'tool_result')
        : [];
      if (results.length && u && typeof u === 'object') {
        const shown = results.map((b: any) => textOf(b.content)).join('\n');
        // A Read result shows each line behind its number and a tab.
        const unnumbered = shown.replace(/^ *\d+\t/gm, '');
        if (
          typeof u.file?.content === 'string' &&
          u.file.content &&
          unnumbered.includes(u.file.content)
        ) {
          add('toolUseResult.file.content', stringBytes(u.file.content));
          delete u.file.content;
          changed = true;
        }
        if (typeof u.stdout === 'string' && u.stdout && shown.includes(u.stdout)) {
          add('toolUseResult.stdout', stringBytes(u.stdout));
          delete u.stdout;
          changed = true;
        }
      }
      const n = dropped.get('image')?.[0] ?? 0;
      if (line.includes('base64')) r = images(r);
      if (changed || (dropped.get('image')?.[0] ?? 0) !== n) out.push(JSON.stringify(r));
      else out.push(line);
    }
    const text = out.join('\n') + '\n';
    after += Buffer.byteLength(text);
    fs.writeFileSync(file, text);
  }
  const row = (k: string, why: string) => {
    const [n, b] = dropped.get(k) ?? [0, 0];
    return `| ${k} | ${why} | ${n} | ${mb(b)} |`;
  };
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(
    manifest,
    [
      '# Trimmed from the AI session transcripts',
      '',
      'The packager (`scripts/package-prepare.ts slim`, run by `scripts/package-submission.sh`) made the packaged COPIES of the Claude Code transcripts smaller. The original transcripts under `~/.claude/projects/` are untouched. Every user message, assistant message, tool call (`tool_use`) and tool result (`tool_result`) is kept, which `check` verifies per transcript against the original (`submission/ai-sessions/CHECK.md`).',
      '',
      '| What | Why it goes | Count | MB (of the JSON text) |',
      '| --- | --- | --- | --- |',
      row(
        'image',
        'the base64 of an embedded screenshot (image blocks at any depth, a Read result of an image, a `data:image/…;base64,` string); replaced by `[screenshot removed for size: <KB> KB, sha256 <first 12 hex of the image bytes>]`, type and media type kept',
      ),
      row(
        'toolUseResult.file.content',
        "a Read result's file text in the top-level `toolUseResult`, removed only when the same record's `tool_result` holds that text (behind its line numbers); the rest of `toolUseResult` stays",
      ),
      row(
        'toolUseResult.stdout',
        "a Bash command's output in the top-level `toolUseResult`, removed only when the same record's `tool_result` holds it; `stderr`, `bashEditDiff`, `gitOperation` and the rest stay, and so does an output the `tool_result` only points at",
      ),
      row(
        'attachment:hook_success',
        'a whole record: a hook command run and its exit status and output',
      ),
      row(
        'system:stop_hook_summary',
        'a whole record: the summary of the hooks run at the end of a turn',
      ),
      row('system:turn_duration', 'a whole record: how long a turn took'),
      row(
        'file-history-snapshot',
        'a whole record: the editor file-history snapshot used for undo',
      ),
      row('file-history-delta', 'a whole record: a change to that snapshot'),
      '',
      `Files: ${files} transcripts; ${mb(before)} MB before, ${mb(after)} MB after. Children of a dropped record were re-pointed at its parent (\`parentUuid\`) ${relinked} times, so each thread stays connected.`,
      '',
    ].join('\n'),
  );
  console.log(`Slimmed ${files} transcripts: ${mb(before)} MB -> ${mb(after)} MB (${manifest})`);
}

// PK2 review: what the brief asks to keep, counted per transcript. Its own reader, on raw bytes
// split at 0x0A, so a fault in slim's reading cannot hide here.
function census(file: string) {
  const c = {
    lines: 0,
    unparsed: 0,
    messages: 0,
    toolUse: [] as string[],
    toolResult: [] as string[],
  };
  const buf = fs.readFileSync(file);
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    const raw = buf.subarray(start, end).toString('utf8');
    start = end + 1;
    if (!raw) continue;
    c.lines++;
    let r: any;
    try {
      r = JSON.parse(raw);
    } catch {
      c.unparsed++;
      continue;
    }
    if (r?.type !== 'user' && r?.type !== 'assistant') continue;
    c.messages++;
    for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (b?.type === 'tool_use') c.toolUse.push(b.id);
      if (b?.type === 'tool_result') c.toolResult.push(b.tool_use_id);
    }
  }
  return c;
}

function check(origRoot: string, copies: string, since: number, manifest: string) {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.sort().join() === b.sort().join();
  const within = (a: string[], b: string[]) => {
    const left = new Map<string, number>();
    for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
    return a.every((x) => (left.set(x, (left.get(x) ?? 0) - 1).get(x) ?? 0) >= 0);
  };
  const rows: string[] = [];
  const tally = { equal: 0, grown: 0, missing: 0, differ: 0 };
  const sum = { messages: 0, toolUse: 0, toolResult: 0, unparsed: 0, origUnparsed: 0 };
  for (const copy of walk(copies).filter((f) => f.endsWith('.jsonl'))) {
    const rel = path.relative(copies, copy);
    const orig = path.join(origRoot, rel);
    if (!fs.existsSync(orig)) {
      tally.missing++;
      rows.push(`| \`${rel}\` | no original found | | | | |`);
      continue;
    }
    const o = census(orig);
    const k = census(copy);
    sum.messages += k.messages;
    sum.toolUse += k.toolUse.length;
    sum.toolResult += k.toolResult.length;
    sum.unparsed += k.unparsed;
    sum.origUnparsed += o.unparsed;
    const equal =
      o.messages === k.messages &&
      same(o.toolUse, k.toolUse) &&
      same(o.toolResult, k.toolResult) &&
      k.unparsed === o.unparsed;
    const grown =
      !equal &&
      fs.statSync(orig).mtimeMs > since &&
      k.messages <= o.messages &&
      within(k.toolUse, o.toolUse) &&
      within(k.toolResult, o.toolResult) &&
      k.unparsed <= o.unparsed + 1;
    const verdict = equal ? 'equal' : grown ? 'grown' : 'differ';
    tally[verdict]++;
    if (!equal)
      rows.push(
        `| \`${rel}\` | ${verdict === 'grown' ? 'original appended to during the run; the copy is a subset' : 'DIFFERENT'} | ${o.messages} / ${k.messages} | ${o.toolUse.length} / ${k.toolUse.length} | ${o.toolResult.length} / ${k.toolResult.length} | ${o.unparsed} / ${k.unparsed} |`,
      );
  }
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(
    manifest,
    [
      '# Transcript copies checked against the originals',
      '',
      'Written by `scripts/package-submission.sh` (`scripts/package-prepare.ts check`) after the redaction and the trimming. For each packaged copy it reads the original again and compares: user and assistant records, `tool_use` ids, `tool_result` ids, and lines that do not parse as JSON. "Equal" means the same count of each and the same ids.',
      '',
      `Transcripts: ${tally.equal} equal, ${tally.grown} whose original was appended to while the package was built (the copy holds a subset), ${tally.differ} different, ${tally.missing} without an original. In the copies: ${sum.messages} user and assistant records, ${sum.toolUse} tool calls, ${sum.toolResult} tool results; ${sum.unparsed} lines that do not parse (${sum.origUnparsed} in the originals).`,
      '',
      ...(rows.length
        ? [
            '| Transcript | Verdict | Messages (original / copy) | tool_use | tool_result | Lines not JSON |',
            '| --- | --- | --- | --- | --- | --- |',
            ...rows,
            '',
          ]
        : []),
    ].join('\n'),
  );
  console.log(
    `Checked ${tally.equal + tally.grown + tally.differ + tally.missing} transcript copies: ${tally.equal} equal, ${tally.grown} grown, ${tally.differ} different, ${tally.missing} without an original (${manifest})`,
  );
  if (tally.differ) process.exit(1);
}

const mb = (n: number) => (n / 1048576).toFixed(1);
const size = (f: string) => fs.statSync(f).size;

function table(title: string, files: string[], key: (f: string) => string) {
  const groups = new Map<string, [number, number]>();
  for (const f of files) {
    const g = groups.get(key(f)) ?? [0, 0];
    groups.set(key(f), [g[0] + 1, g[1] + size(f)]);
  }
  const rows = [...groups].sort((a, b) => b[1][1] - a[1][1]).slice(0, 12);
  console.log(`\n${title}`);
  for (const [k, [n, bytes]] of rows)
    console.log(`  ${mb(bytes).padStart(8)} MB ${String(n).padStart(6)} files  ${k}`);
}

function sizes(label: string, files: string[]) {
  const total = files.reduce((s, f) => s + size(f), 0);
  console.log(`\n== ${label}: ${files.length} files, ${mb(total)} MB uncompressed ==`);
  table('By top-level folder', files, (f) => (f.includes('/') ? f.split('/')[0] + '/' : '(root)'));
  table('By file type', files, (f) => path.extname(f).toLowerCase() || '(none)');
}

function trim(listFile: string, manifest: string) {
  const all = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  // Every binary path a packed .md file (transcripts aside) names: as written, relative to the
  // document, or relative to a .scratch folder the same document names (change notes give the
  // evidence folder once and then bare file names).
  const linked = new Set<string>();
  const names = new Set<string>();
  // PK2: the .scratch folders a handoff document writes keep the images directly inside them.
  const linkedDirs = new Set<string>();
  for (const md of all.filter(
    (f) => f.endsWith('.md') && !f.startsWith('submission/ai-sessions/'),
  )) {
    const text = fs.readFileSync(md, 'utf8');
    const dirs = [...text.matchAll(/\.scratch\/[\w.@/-]*/g)].flatMap((m) => [
      m[0],
      path.dirname(m[0]),
    ]);
    // Only the folders the handoff documents write: with every .md (change notes name their whole
    // evidence folder) the ZIP grows by 73.5 MB, with these by 6.7 MB. Not recursive.
    if (/^(submission\/README|README|docs\/[^/]+)\.md$/.test(md))
      for (const [d] of text.matchAll(/\.scratch\/[\w.@/-]*/g))
        linkedDirs.add(path.normalize(d).replace(/[/.]+$/, ''));
    for (const [name] of text.matchAll(/[\w.@/-]+\.(png|jpe?g|gif|webm|zip)\b/gi)) {
      names.add(path.normalize(name).replace(/^(\.\.\/)+/, ''));
      for (const base of ['', path.dirname(md), ...dirs])
        linked.add(path.normalize(path.join(base, name)));
    }
  }
  // PK1 review: 16 images a change note names resolved against none of those bases and were left
  // out. A binary whose path ends with a name some document writes is kept too.
  const named = (f: string) => [...names].some((n) => f === n || f.endsWith('/' + n));
  const inLinked = (f: string) => linkedDirs.has(path.dirname(f));
  const cut = all.filter((f) => BINARY.test(f) && !linked.has(f) && !named(f) && !inLinked(f));
  const drop = new Set(cut);
  const kept = [...new Set([...all.filter((f) => !drop.has(f)), manifest])].sort();
  const bytes = cut.reduce((s, f) => s + size(f), 0);
  const folders = new Map<string, number>();
  for (const f of cut) folders.set(path.dirname(f), (folders.get(path.dirname(f)) ?? 0) + 1);
  fs.writeFileSync(
    manifest,
    [
      '# Left out of the delivery ZIP',
      '',
      'Written by `scripts/package-submission.sh` at packaging time. The repository keeps every file; only the ZIP is smaller.',
      '',
      '| Pattern | Why | Files | Bytes |',
      '| --- | --- | --- | --- |',
      `| \`.scratch/**/*.{png,jpg,jpeg,gif,webm,zip}\` that no packed \`.md\` file links to | screenshots and recordings of intermediate runs; every \`.txt\` evidence file and every image a document names is packed; a folder that \`submission/README.md\`, \`README.md\` or a \`docs/*.md\` file links to keeps the images directly inside it; any other linked folder keeps only the images named somewhere | ${cut.length} | ${bytes} (${mb(bytes)} MB) |`,
      '| `**/jars/**` | cookie jars of probe sessions | not counted | not counted |',
      '| `.env*` (except `.env.example`), `.data*/`, `.next/`, `node_modules/`, `.git/`, `.claude/`, `dist/`, `.DS_Store` | local environment, data, build output, dependencies | not counted | not counted |',
      '',
      'No AI session transcript is left out.',
      '',
      '## Folders of the unlinked binaries',
      '',
      '| Folder | Files |',
      '| --- | --- |',
      ...[...folders].sort().map(([d, n]) => `| \`${d}/\` | ${n} |`),
      '',
    ].join('\n'),
  );
  sizes('Before the cut', all);
  sizes('After the cut', kept);
  console.log(`\nLeft out ${cut.length} unlinked .scratch binaries, ${mb(bytes)} MB (${manifest})`);
  fs.writeFileSync(listFile, kept.join('\n') + '\n');
}

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === 'redact') redact(a, b);
if (cmd === 'trim') trim(a, b);
if (cmd === 'slim') slim(a, b);
if (cmd === 'check') check(a, b, Number(c), d);
