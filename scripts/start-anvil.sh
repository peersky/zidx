#!/usr/bin/env bash
# Start a local Anvil + deploy fhEVM host contracts + ConfidentialToken.
# Exports TOKEN_ADDRESS and ACL_CONTRACT_ADDRESS to .env.local.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL_PORT="${ANVIL_PORT:-8545}"
DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPLOYER_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

cd "$REPO_ROOT/contracts/forge-fhevm-vendor"
[ -d dependencies ] || forge soldeer install

# Start Anvil in background
echo "→ Starting Anvil on :$ANVIL_PORT"
anvil --host 0.0.0.0 --chain-id 31337 --port "$ANVIL_PORT" >/tmp/anvil.log 2>&1 &
ANVIL_PID=$!
trap "kill $ANVIL_PID 2>/dev/null || true" EXIT
sleep 2

# Deploy host contracts (cleartext fhEVM)
echo "→ Deploying fhEVM host contracts"
./deploy-local.sh --anvil-port "$ANVIL_PORT"

# Deploy ConfidentialToken
cd "$REPO_ROOT/contracts"
[ -d dependencies/@openzeppelin ] || ln -sf "$REPO_ROOT/node_modules/@openzeppelin/confidential-contracts" dependencies/@openzeppelin/confidential-contracts 2>/dev/null || true
echo "→ Building + deploying ConfidentialToken"
forge build --silent
TOKEN_ADDRESS=$(forge script script/Deploy.s.sol:Deploy \
  --rpc-url "http://127.0.0.1:$ANVIL_PORT" \
  --private-key "$DEPLOYER_PK" \
  --broadcast 2>&1 \
  | grep "ConfidentialToken deployed at:" | awk '{print $NF}')

if [ -z "$TOKEN_ADDRESS" ]; then
  echo "FATAL: could not parse TOKEN_ADDRESS from forge output"
  exit 1
fi

# ACL contract is at canonical address from forge-fhevm
ACL_CONTRACT_ADDRESS=$(grep -oE '0x[a-fA-F0-9]{40}' "$REPO_ROOT/contracts/forge-fhevm-vendor/src/fhevm-host/contracts/FHEVMHostAddresses.sol" \
  | head -2 | tail -1 || echo "0x687408aB54661ba0b4aeF3a44156c616c6955E07")

echo "TOKEN_ADDRESS=$TOKEN_ADDRESS" > "$REPO_ROOT/.env.local"
echo "ACL_CONTRACT_ADDRESS=$ACL_CONTRACT_ADDRESS" >> "$REPO_ROOT/.env.local"
echo "DEPLOYER_PK=$DEPLOYER_PK" >> "$REPO_ROOT/.env.local"
echo "DEPLOYER_ADDR=$DEPLOYER_ADDR" >> "$REPO_ROOT/.env.local"

echo ""
echo "✓ Local fhEVM stack ready"
echo "  Anvil:                http://127.0.0.1:$ANVIL_PORT (pid $ANVIL_PID)"
echo "  TOKEN_ADDRESS:        $TOKEN_ADDRESS"
echo "  ACL_CONTRACT_ADDRESS: $ACL_CONTRACT_ADDRESS"
echo ""
echo "Anvil running in background. Kill with: kill $ANVIL_PID"
echo "Logs: /tmp/anvil.log"
# Detach Anvil from this script (remove trap so it survives exit)
trap - EXIT
disown $ANVIL_PID
