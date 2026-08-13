#!/bin/sh
# Build gate for the consumet library — the thing the Dockerfile's `npx tsc || true` used to skip.
#
# `|| true` hid EVERY compile error, including the TS2307 module-not-found class CLAUDE.md says must
# block: a renamed or broken import produced no build failure, and the image shipped a stale/absent
# dist/ that only crashed at runtime.
#
# tsc EMITS dist/ despite errors (tsconfig sets no noEmitOnError) and that is deliberate — there are
# 12 KNOWN pre-existing strictness errors (rabbit.ts x1 + anilist.ts x11) that must not block the
# build. So we let tsc run and then gate on the result. The build fails if:
#   1. any error is reported OUTSIDE the two known-baseline files      (the TS2307 / real-breakage case)
#   2. the total error count grows past 12                             (new errors INSIDE those files)
#   3. tsc exits non-zero without reporting a single "error TS" line   (crash, OOM, no compiler,
#      unreadable tsconfig — the old `| tee` pipeline threw this exit code away entirely)
#   4. dist/index.js was not (re)written by THIS run                   (i.e. a stale dist/ from the
#      build context would otherwise be what ships — the exact symptom H2 is about)
#
# Lives in a script rather than inline in the Dockerfile so it can be run — and its failure modes
# actually exercised — without a Docker daemon: `cd consumet && sh scripts/build-gate.sh`.
#
# Env: TSC_PROJECT (default tsconfig.json), TSC_LOG (default /tmp/tsc.log).
set -u

cd "$(dirname "$0")/.." || exit 1

PROJECT="${TSC_PROJECT:-tsconfig.json}"
LOG="${TSC_LOG:-/tmp/tsc.log}"
STAMP="${LOG}.stamp"
ENTRY="dist/index.js"
# Errors in these files are the documented pre-existing baseline; anything else is new.
BASELINE_FILES='src/extractors/rabbit\.ts|src/providers/meta/anilist\.ts'
BASELINE_MAX=12

fail() {
  echo "=== BUILD FAILED: $* ==="
  exit 1
}

: > "$STAMP" # freshness marker: dist/index.js must end up newer than this

npx tsc -p "$PROJECT" > "$LOG" 2>&1
TSC_EXIT=$?

UNEXPECTED="$(grep -E 'error TS' "$LOG" | grep -vE "$BASELINE_FILES" || true)"
TOTAL="$(grep -cE 'error TS' "$LOG" || true)"
TOTAL="${TOTAL:-0}"

if [ -n "$UNEXPECTED" ]; then
  echo "$UNEXPECTED"
  fail "TypeScript errors outside the known rabbit.ts/anilist.ts baseline"
fi

if [ "$TOTAL" -gt "$BASELINE_MAX" ]; then
  cat "$LOG"
  fail "$TOTAL tsc errors > $BASELINE_MAX known baseline (new errors inside rabbit.ts/anilist.ts)"
fi

if [ "$TSC_EXIT" -ne 0 ] && [ "$TOTAL" -eq 0 ]; then
  cat "$LOG"
  fail "tsc exited $TSC_EXIT without reporting a TypeScript error (crashed, or never ran)"
fi

if [ ! -s "$ENTRY" ] || [ -z "$(find "$ENTRY" -newer "$STAMP" 2>/dev/null)" ]; then
  fail "$ENTRY was not emitted by this build — refusing to ship a stale dist/"
fi

echo "tsc gate OK: $TOTAL error(s), all within the known rabbit.ts/anilist.ts baseline; $ENTRY emitted"
