#!/usr/bin/env bash
# Full end-to-end orchestration:
#   1. Anvil + fhEVM host + ConfidentialToken (skipped if already running)
#   2. docker compose up -d --build (envio-postgres, hasura, envio-indexer,
#      nats, api, worker, escalator, balance-refresh)
#   3. Wait for API /health
#   4. pnpm test test/e2e
#
# Usage:
#   ./scripts/e2e.sh              # bring up stack, run tests, leave stack up
#   ./scripts/e2e.sh --teardown   # bring up, run, tear everything down

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TEARDOWN=0
for arg in "$@"; do
  case "$arg" in
    --teardown) TEARDOWN=1 ;;
  esac
done

cleanup() {
  if [ "$TEARDOWN" = "1" ]; then
    echo ""
    echo "→ Tearing down docker compose stack"
    docker compose down -v --remove-orphans || true
    if [ -n "${ANVIL_PID:-}" ]; then
      echo "→ Killing Anvil (pid $ANVIL_PID)"
      kill "$ANVIL_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

# ── 1. Anvil + contracts ─────────────────────────────────────────────────────
if curl -fsS -o /dev/null -X POST http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'; then
  echo "✓ Anvil already running on :8545"
else
  echo "→ Starting Anvil + deploying fhEVM host + ConfidentialToken"
  ./scripts/start-anvil.sh
  ANVIL_PID=$(pgrep -f 'anvil.*--port 8545' | head -1 || true)
fi

if [ ! -f .env.local ]; then
  echo "FATAL: .env.local missing (start-anvil.sh should have created it)"
  exit 1
fi

# Compose reads `.env` by default. Mirror .env.local so the two stay in sync.
cp .env.local .env

# Source for the test process below.
set -a
# shellcheck disable=SC1091
source .env.local
set +a

# ── 2. docker compose ────────────────────────────────────────────────────────
echo "→ docker compose up -d --build"
docker compose up -d --build

# ── 3. Wait for API /health ──────────────────────────────────────────────────
echo -n "→ Waiting for API /health "
DEADLINE=$(( $(date +%s) + 180 ))
until curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo ""
    echo "FATAL: API never came up. Logs:"
    docker compose logs --tail=30 api migrate envio-postgres
    exit 1
  fi
  echo -n "."
  sleep 2
done
echo " ✓"

# ── 4. Run e2e ───────────────────────────────────────────────────────────────
echo ""
echo "→ pnpm test test/e2e"
pnpm test test/e2e

echo ""
echo "✓ e2e suite passed"
if [ "$TEARDOWN" != "1" ]; then
  echo ""
  echo "Stack still running. Tear down with:"
  echo "  docker compose down -v"
  echo "  pkill -f 'anvil.*--port 8545'"
fi
