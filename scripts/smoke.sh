#!/usr/bin/env bash
# コンパイル済みの ccx で、center → push → search の経路を 1 周する。
# `bun test` は `bun run` の経路しか通らず、単一バイナリ固有の部分 ($bunfs の asset →
# cache → dlopen → 埋め込んだ .node) は誰も見ない。CI の Build の後に走る。
set -euo pipefail

BIN=${1:-./ccx}
WORK=$(mktemp -d)
PORT=${CCX_SMOKE_PORT:-18791}
trap 'kill "$CENTER" 2>/dev/null || true; rm -rf "$WORK"' EXIT

CCX_ROOT="$WORK/root" CCX_CENTER_PORT=$PORT bun run apps/hub/src/index.ts serve >"$WORK/center.log" 2>&1 &
CENTER=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || { cat "$WORK/center.log"; exit 1; }

export CCX_HUB_URL="http://127.0.0.1:$PORT" CLAUDE_CONFIG_DIR="$WORK/claude" XDG_CACHE_HOME="$WORK/cache"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/-w"
printf '{"type":"user","cwd":"/w","timestamp":"2026-01-01T00:00:00Z","message":{"content":"SMOKE-NEEDLE here"}}\n' \
  >"$CLAUDE_CONFIG_DIR/projects/-w/0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b.jsonl"

"$BIN" tr push --ended | grep -q '^pushed' || { echo "push did not report pushed"; exit 1; }
"$BIN" tr search smoke-needle --json | grep -q 'SMOKE-NEEDLE' || { echo "search missed the present word"; exit 1; }
if "$BIN" tr search absent-word --json | grep -q 'session_id'; then echo "search matched an absent word"; exit 1; fi
"$BIN" tr search --sql 'SELECT count(*) AS n FROM history' --json | grep -q '"n": "1"' || { echo "history view wrong"; exit 1; }
test -s "$XDG_CACHE_HOME/ccx/duckdb/"*/httpfs.duckdb_extension || { echo "extension not materialised"; exit 1; }
echo "smoke ok ($BIN)"
