# Uncertainties Log

Live dump of things I'm uncertain about. Highest-priority items at top.

## OPEN — most important first

### U-200 — RESOLVED ✓ — Full publish→consume pipeline live (the #1 from earlier)
End-to-end on live chain:
- SDK encrypts 9999 → `mint(deployer, encryptedHandle, proof)` → emits ConfidentialTransfer log
- Envio handler picks event, runs `pickSignerForTransfer` SQL, inserts `app.transfers (status='ready', assigned_signer=deployer)`, publishes to NATS `decrypt.<deployer>`
- Worker (long-lived per-signer loop) consumes msg, calls `sdk.decryption.decryptValues([{encryptedValue: handle, contractAddress: TOKEN}])`, writes `cleartext_amount=9999, cleartext_source='user_decrypt', status='done'`
- API `GET /balance/<deployer>` returns `{amount:"9999", source:"decrypted"}`

### U-201 — RESOLVED ✓ — Live multi-signer escalation (the #2 from earlier)
Two signers in `app.signers`: cheap (cost_rank=1) and expensive (cost_rank=100). Cheap signer has its `MOCK_FAILING_SIGNERS` flag set → worker throws "relayer 503 (injected)" → `msg.nak()` → max_deliver=2 exhausted → NATS emits `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES` → escalator subscriber re-runs `pickSignerForTransfer` with `excluded=[cheap]` → picks expensive → republishes to `decrypt.<expensive>` → worker for expensive consumes → SDK decryptValues → row goes `status='done', assigned_signer=<expensive>, tried_signers=[<cheap>]`. Audit trail preserved.

**Bugs found+fixed during this**:
- escalator's `failedSigner` was lowercase (consumer durable names are lowercase), didn't match checksummed `app.signers.addr` in exclusion → escalator looped 3300+ times re-electing the same signer. Fixed via `normAddr()`.
- escalator now also dedupes via `Array.from(new Set([...row.tried_signers, failedSigner]))` and short-circuits stale advisories (`row.assigned_signer !== failedSigner` → skip).

### U-202 — RESOLVED ✓ — `docker compose up` end-to-end (the #3 from earlier)
Stack: 7 containerized services (envio-postgres + graphql-engine + envio-indexer + nats + api + worker + escalator + balance-refresh) following the official envio self-host docker-compose pattern from `enviodev/local-docker-example`. Anvil + ConfidentialToken run on host (preconditions documented in compose YAML).

End-to-end verified inside docker: mint → envio-indexer container handler runs → app.transfers row → NATS publish → worker container consumes → real SDK userDecrypt → cleartext written. API container responds with cleartext via GET /balance.

**Bugs found+fixed during this**:
- `nats:alpine` lacks `wget` for healthcheck; switched to `pgrep nats-server`.
- envio codegen needs TOKEN_ADDRESS env vars at build time; moved codegen to container startup (CMD wraps `pnpm envio codegen && pnpm envio start`).
- SDK's `anvil` FheChain preset has hardcoded `network: 127.0.0.1:8545` which is unreachable from inside docker. Override at runtime: `fheChain = { ...sdkMod.anvil, network: process.env.RPC_URL }`. Lets the SDK reach Anvil at `host.docker.internal:8545` from a containerized worker.
- Fastify + pino logger type incompatibility surfaces under docker's tsc (different lib resolution). Cast `loggerInstance: log as any`.

### U-100 — RESOLVED ✓ — real userDecrypt E2E works
Found the right shapes: `cleartext()` factory from `@zama-fhe/sdk` (top-level), `createConfig` from `@zama-fhe/sdk/viem`, `sdk.decryption.decryptValues([{encryptedValue, contractAddress}])`. The 3 E2E tests (`test/e2e/full_pipeline.test.ts`) now drive the **full real-SDK path**:
  1. `sdk.relayer.encrypt({value: 4242n, type: "euint64", ...})` → external handle + input proof
  2. `ConfidentialToken.mint(holder, encrypted, proof)` → emits `ConfidentialTransfer` log
  3. Our `ZamaDecryptor.decrypt(onChainHandle)` → calls `sdk.decryption.decryptValues(...)` → returns **4242n** cleartext  ✓
The handle that travels through `ConfidentialTransfer.amount` topic in the log is the same handle our decryptor consumes — so the "event in → cleartext out" claim is proven.

### U-104 — RESOLVED ✓ — `ConfidentialTransfer.amount` handle decrypts to the transfer amount
Test case added: `mint(holder, 100n)` → `confidentialTransfer(holder, recipient, 42n)` (low-level contract call, no SDK high-level abstraction) → parse the `ConfidentialTransfer` log → decrypt the `amount` handle via our `ZamaDecryptor` → assert equals `42n`. Passes against live forge-fhevm chain.

Confirms OZ ERC7984's emission semantics: `ConfidentialTransfer.amount` is the *transfer amount*, not the post-transfer balance handle. Our indexer's behavior of writing `cleartext_amount = decrypt(event.amount)` is correct.

### U-101 — RESOLVED ✓ — Envio v3 handler runtime exercised end-to-end
- `envio@3.2.1` installed via pnpm global.
- Config rewritten to v3 schema (`chains`, separate `contracts`, `abi_file_path`).
- Event ABIs extracted from forge artifacts into `envio/abis/{ConfidentialToken,ACL}.json`.
- `envio codegen` materializes typed handler signatures in `.envio/types.d.ts`.
- Added `field_selection: { transaction_fields: [hash] }` (default omits txHash).
- `context.isPreload` guard at top of each handler prevents double-writes.
- `envio dev -r` boots its own Postgres (18.3) + Hasura (v2.43.0) in Docker — port 5433, db `envio-dev`, password `testing`.
- Apply `app.*` migrations to envio's PG; seed signer config.
- **Verified end-to-end**: minted a token via SDK → envio handler ran on the ConfidentialTransfer event → ran the picker SQL → inserted `app.transfers` row with `status='ready'`, `assigned_signer=0xf39F...`, populated handle → published to NATS subject `decrypt.<signer>`. Sub-second from chain → DB → bus.

Dual-write pattern (Envio entities + side-loaded postgres.js for `app.*`) works under v3 without needing `context.effect()`. README updated with `host.docker.internal` notes for the Anvil→Hasura bridge.

### U-102 — `INDEXER_PRIVATE_KEY` defaults to deployer key in dev — multi-signer demo missing
**Severity:** medium
**Issue:** for the full multi-signer / escalator-cycling story to work end-to-end, the indexer needs to hold ≥ 2 signers and the chain needs to emit a Transfer where one signer holds rights but another is the cheaper one. The SQL/negative tests prove this works at the DB layer (45 tests passing), but a live multi-signer demo would require minting tokens, granting decrypt rights via `ACL.allow`, and triggering the escalator with one signer's userDecrypt failing.
**What's wired:** schema supports it (`tried_signers`, `cost_rank`, the unified picker query), worker code reads it, escalator subscribes to advisory. Tests cover the logic.
**What's not:** a one-shot script that demonstrates the multi-signer escalation end-to-end on the live chain. The simulated test (`negative_retry.test.ts`) covers this at the DB layer.

### U-103 — Soldeer git submodule recursion failure caused a slip; OZ contracts pulled from npm instead
**Severity:** low (resolved with workaround)
**What happened:** soldeer's git transport for `openzeppelin-confidential-contracts@7ac7cee` fails with `fatal: Unable to read current working directory` because OZ uses recursive git submodules and soldeer's clone setup hits a tmp-file race. Workaround: `pnpm add @openzeppelin/confidential-contracts` then symlink `node_modules/@openzeppelin/confidential-contracts → contracts/dependencies/@openzeppelin/confidential-contracts` so Foundry's `libs = ["dependencies"]` discovers it.
**Why I'm flagging:** non-obvious, will trip up a reviewer running `forge build` cold. README must explain.

## Resolved

### R-001 — ACL event names (was U-004)
Found in `forge-fhevm/src/fhevm-host/contracts/ACLEvents.sol`. Canonical names captured in `envio/config.yaml` + my schema/SQL design:
- `Allowed(address indexed caller, address indexed account, bytes32 handle)` — persistent grant
- `AllowedForDecryption(address indexed caller, bytes32[] handlesList)` — bulk grant for PUBLIC decrypt (we don't use)
- `DelegatedForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 delegationCounter, uint64 oldExpirationDate, uint64 newExpirationDate)`
- `RevokedDelegationForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 delegationCounter, uint64 oldExpirationDate)`

**Key surprises locked into design:**
- No `Disallowed` per-handle event. Once `Allowed`, persists forever (`$.persistedAllowedPairs[handle][account] = true`). So `handle_rights_current` is upsert-only, no `active` flag, no cycle tracking for per-handle.
- Delegation is per-(delegator, delegate, **single** contractAddress) with **expirationDate**. Schema: `expiration_ts BIGINT NOT NULL`, queries filter `WHERE expiration_ts > EXTRACT(EPOCH FROM now())`.

### R-002 — Zama SDK shape (was U-003)
Confirmed via `examples/node-viem/src/index.ts` on `@zama-fhe/sdk@3.1.0-alpha.15`:
```ts
import { ZamaSDK, MemoryStorage } from "@zama-fhe/sdk";
import { ViemSigner } from "@zama-fhe/sdk/viem";
import { RelayerNode } from "@zama-fhe/sdk/node";   // or node() factory in some alphas
using sdk = new ZamaSDK({ relayer, signer, storage: new MemoryStorage() });
const token = sdk.createToken(wrapperAddress);
await token.balanceOf();
await tokenB.decryptBalanceAs({ delegatorAddress: A });
```
- `using sdk = ...` — TC39 explicit resource management, calls `terminate()` on scope exit.
- Auth: `{ __type: "ApiKeyHeader", value: KEY }` or undefined for local cleartext mode.
- `DelegationNotPropagatedError` — thrown until ACL grant propagates to relayer.

### R-003 — forge-fhevm sample ERC-7984 (was U-002)
Settled on writing our own minimal `ConfidentialToken extends ERC7984, ZamaEthereumConfig` per the user's suggested template. Adds a public `mint(to, externalEuint64, bytes inputProof)` so we can stage tests. Verified on chain via `cast`:
```
$ forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
ConfidentialToken deployed at: 0x851356ae760d987e095750cceb3bc6014560891c
```

### R-004 — forge-fhevm deploy-local.sh
Confirmed running cleanly against Anvil 31337. Host contracts at canonical deterministic addresses:
- ACL:           `0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D`
- FHEVMExecutor: `0xe3a9105a3a932253A70F126eb1E3b589C643dD24`
- KMSVerifier:   `0x901F8942346f7AB3a01F6D7613119Bca447Bb030`
- InputVerifier: `0x36772142b74871f255CbD7A3e89B401d3e45825f`
- HCULimit:      `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154`
- PauserSet:     `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`

These addresses are stable across runs (deterministic, derived from deployer nonce). Our Envio config + tests can pin them.

### R-005 — Envio v3 handler context shape
Confirmed via docs.envio.dev:
- `indexer.onEvent({contract, event}, async ({event, context}) => {...})`
- `context.Entity.get/set/delete/...` for Envio-managed entities
- `context.isPreload`, `context.log`, `context.effect()`
- **No `context.sql`** — for raw SQL writes outside Envio's entities, use a side-loaded pg client. We do this in `envio/src/EventHandlers.ts` and document the dual-write pattern (Envio's entity store + our `app.*` schema) in DECISIONS.md.

### R-006 — NATS client (was U-007)
Picked `@nats-io/transport-node` + `@nats-io/jetstream` (the v3 modular client). Both `msg.working()` heartbeat and `js.consumers.get(...).consume()` for-await loop work as documented.

### R-007 — Postgres BIGINT serialization
postgres.js returns BIGINT columns as strings by default. We `Number(...)` them at the API boundary (`updatedAtBlock`, `setAtBlock`, `block`, `logIndex`, `id`). Caught by Fastify response-schema validation which 500'd on string-where-integer-expected — fixed and verified by `happy_api.test.ts`.
