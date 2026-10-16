#!/usr/bin/env bash
# DV4: builds the delivery ZIP (docs/challenge.md "Deliverables") at dist/banana-bank-submission.zip:
# every tracked file plus everything present under submission/ (the gitignored ai-sessions/,
# ai-sessions.zip, video, PDF), with the project at the ZIP root. Never packs local environment
# files, data, build output, dependencies, Git or Claude config, or cookie jars, and refuses to
# build when a file holds a secret-looking OpenAI key.
#
# IT3: `--scan [file…]` runs only that secret scan (over the tracked tree, or over the given files)
# and names file:line per hit; tests/it3-package-key-scan.test.ts runs it inside `npm test`.
#
# PK1: the collected transcript COPIES are redacted (scripts/package-prepare.ts redact: every
# key-shaped string becomes a fixed marker, counts and line numbers go to
# submission/ai-sessions/REDACTIONS.md), so the scan, unchanged and as strict as before for every
# other file, passes on them. The .scratch binaries no packed .md links to are left out of the ZIP
# and listed in submission/EXCLUDED.md (scripts/package-prepare.ts trim).
#
# PK2: after redaction the copies are slimmed (package-prepare.ts slim: screenshots become a marker,
# the Read file.content and Bash stdout a tool_result repeats and the hook-status/file-history
# records go; submission/ai-sessions/TRIMMED.md), then checked against the originals (check:
# messages, tool_use and tool_result ids per transcript; submission/ai-sessions/CHECK.md),
# and submission/BUILD.txt records the commit, the date, the file count and the ZIP size.
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/banana-bank-submission.zip
list=$(mktemp)
trap 'rm -f "$list"' EXIT

# Known fakes: the test fixture (tests/operator-view.test.ts checks that telemetry redacts it) and
# the sk-FAKE… keys used to exercise this scan, both of which appear in the collected transcripts.
allowed='sk-proj-abcdefghijklmnop|sk-FAKE[A-Za-z0-9_-]*'
refuse_on_keys() { # $1 = file with one path per line
  local hits
  hits=$(tr '\n' '\0' <"$1" | xargs -0 grep -HnoE 'sk-[A-Za-z0-9_-]{20,}' 2>/dev/null |
    grep -vE ":(${allowed})\$" | cut -d: -f1,2 | sort -u || true)
  [ -z "$hits" ] && return 0
  echo "Refusing to package: secret-looking key (sk-…) in:" >&2
  printf '  %s\n' $hits >&2
  exit 1
}

if [ "${1:-}" = --scan ]; then
  if [ $# -gt 1 ]; then printf '%s\n' "${@:2}"; else git ls-files; fi >"$list"
  refuse_on_keys "$list"
  exit 0
fi

# Collect Claude Code transcripts (*.jsonl + sibling session folders) from every BananaBank project
# folder and from EXTRA_SESSION_FILES into submission/ai-sessions/claude-code/. Originals are only
# read. COLLECT_SESSIONS=0 skips this step.
if [ "${COLLECT_SESSIONS:-1}" != 0 ]; then
  since=$(($(date +%s) * 1000))
  dest=submission/ai-sessions/claude-code
  rm -rf "$dest"
  copy_session() { # $1 = transcript, $2 = destination folder
    mkdir -p "$2" && cp -p "$1" "$2/"
    local sib="${1%.jsonl}"
    if [ -d "$sib" ]; then cp -Rp "$sib" "$2/"; fi
  }
  for dir in "$HOME"/.claude/projects/*BananaBank*/; do
    [ -d "$dir" ] || continue
    for f in "$dir"*.jsonl; do [ -f "$f" ] && copy_session "$f" "$dest/$(basename "$dir")"; done
  done
  for f in ${EXTRA_SESSION_FILES:-}; do
    [ -f "$f" ] || { echo "EXTRA_SESSION_FILES: $f not found" >&2; exit 1; }
    copy_session "$f" "$dest/extra"
  done
  if [ -d "$dest" ]; then
    echo "Collected $(find "$dest" -name '*.jsonl' -not -path '*/subagents/*' | wc -l | tr -d ' ') sessions," \
      "$(find "$dest" -path '*/subagents/*.jsonl' | wc -l | tr -d ' ') subagent transcripts," \
      "$(du -sh "$dest" | cut -f1) into $dest"
    node --import tsx scripts/package-prepare.ts redact "$dest" submission/ai-sessions/REDACTIONS.md
    node --import tsx scripts/package-prepare.ts slim "$dest" submission/ai-sessions/TRIMMED.md
    node --import tsx scripts/package-prepare.ts check "$HOME/.claude/projects" "$dest" "$since" \
      submission/ai-sessions/CHECK.md
  fi
fi

: >submission/BUILD.txt # PK2: listed now, written once the list is final
{ git ls-files; find submission -type f; } | sort -u |
  grep -vE '(^|/)\.env' | cat - <(git ls-files .env.example) |
  grep -vE '(^|/)(\.data[^/]*|\.next|node_modules|\.git|\.claude|jars|dist)/' |
  grep -vE '(^|/)\.DS_Store$' |
  while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done | sort -u >"$list"

node --import tsx scripts/package-prepare.ts trim "$list" submission/EXCLUDED.md

refuse_on_keys "$list"

[ -d submission/ai-sessions ] || [ -f submission/ai-sessions.zip ] ||
  echo "Warning: submission/ai-sessions/ (or ai-sessions.zip) is missing; the delivery needs it." >&2

dirty=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')
{
  echo "Commit: $(git rev-parse --short HEAD) ($([ "$dirty" = 0 ] && echo 'no uncommitted changes to tracked files' || echo "$dirty tracked files with uncommitted changes"))"
  echo "Built: $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "Files: $(wc -l <"$list" | tr -d ' ') ($(grep -c '^submission/ai-sessions/' "$list" || true) under submission/ai-sessions/)"
} >submission/BUILD.txt

mkdir -p dist
rm -f "$out"
zip -q -X "$out" -@ <"$list"
# The ZIP's own size can only be measured after it is built: added, then the entry refreshed.
echo "ZIP size: $(wc -c <"$out" | tr -d ' ') bytes before this line was added" >>submission/BUILD.txt
zip -q -X "$out" submission/BUILD.txt
echo "$out: $(wc -l <"$list" | tr -d ' ') files, $(du -h "$out" | cut -f1)"
