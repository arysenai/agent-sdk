# agent-sdk

TypeScript SDK for Arysen agents. Wraps the [`keymod`](../keymod) WASM modules into a single `ArysenKeymod` class providing cryptographic signing, credential management, policy enforcement, and on-chain transaction execution.

## Install

```bash
pnpm install
```

Requires the WASM packages to be built first:

```bash
cd ../keymod/wallet && wasm-pack build --target nodejs
cd ../keymod/mandate && wasm-pack build --target nodejs
cd ../../agent-sdk && pnpm install
```

## Quick Start

```ts
import { ArysenKeymod } from 'agent-sdk/keymod';

// Initialize WASM modules
const keymod = await ArysenKeymod.init();

// Generate keys
const workerKey = keymod.generateWorkerKey();
const sessionKey = keymod.generateSessionKey();

// Sign and verify
const message = new TextEncoder().encode('hello');
const signature = keymod.signWorker(message, workerKey.key_id);
const pubBytes = hexToBytes(workerKey.pub_key);
keymod.verifyWorker(message, signature, pubBytes); // true
```

## API

### Key Generation

```ts
keymod.generateWorkerKey(): KeyPairResult        // Ed25519
keymod.generateSessionKey(): KeyPairResult       // secp256k1
keymod.generateWorkerKeyWithSecret(): KeyPairWithSecret
keymod.generateSessionKeyWithSecret(): KeyPairWithSecret
```

### Signing & Verification

```ts
keymod.signWorker(message: Uint8Array, keyId: string): Uint8Array   // 64-byte Ed25519
keymod.signSession(message: Uint8Array, keyId: string): Uint8Array  // 65-byte secp256k1
keymod.verifyWorker(message, signature, pubKey): boolean
keymod.verifySession(message, signature, pubKey): boolean
```

### Secret Management

Secrets are encrypted with AES-256-GCM and stored persistently in:
- **macOS**: Keychain Services
- **Windows**: DPAPI
- **Linux**: libsecret or encrypted files at `~/.arysen/keys/`

Secrets survive application restarts.

```ts
keymod.depositSecret(name: string, value: string): boolean
keymod.removeSecret(name: string): boolean
keymod.listSecrets(): string[]  // names only, values never exposed
```

### Credential-Injected Requests

```ts
keymod.executeRequest({
  method: 'GET',
  url: 'https://api.example.com/data',
  headers: { Authorization: 'Bearer {API_KEY}' },
}): HttpResponse
// {API_KEY} is replaced with the deposited secret value.
// Response is scrubbed of injected values before return.
```

### Policy Enforcement

```ts
keymod.setPolicy(policy: Policy): boolean
keymod.checkPolicy(action: string, params: Record<string, unknown>): PolicyResult
keymod.getSpendingSummary(): SpendingSummary
```

### Backend Integration

Requires initialization with backend credentials:

```ts
const workerKey = keymod.generateWorkerKeyWithSecret();
const sessionKey = keymod.generateSessionKeyWithSecret();

const mandate = keymod.initMandate({
  base_url: 'https://api.arysen.ai',
  agent_id: 'your-agent-uuid',
  worker_key_id: workerKey.key_id,
  session_key_id: sessionKey.key_id,
  worker_private_key_hex: workerKey.private_key,
  session_private_key_hex: sessionKey.private_key,
});

// mandate: { mandate_id, max_per_tx, max_daily, wallet_address, ... }
```

### Transactions

```ts
// USDC transfer (5-step flow: preflight → check → prepare → sign → submit)
const result = keymod.transferUsdc('0xRecipient', '10.00');
// result: { tx_hash: '0x...' }

// Escrowed deal order
const deal = keymod.createDealOrder({
  executor_agent_id: 'agent-uuid',
  bounty_amount: '5.00',
  task_cid: 'QmTaskCID',
  delivery_deadline: 1735689600,
});
```

## Types

| Type | Description |
|------|-------------|
| `KeyPairResult` | `{ pub_key: string, key_id: string }` |
| `KeyPairWithSecret` | Extends with `private_key: string` |
| `Policy` | `{ spending: SpendingPolicy, secrets: Record<string, SecretPolicy> }` |
| `SpendingPolicy` | `{ max_per_tx, max_daily, expires_at? }` |
| `SecretPolicy` | `{ rate_limit, daily_limit, allowed_domains }` |
| `InitConfig` | Backend config + worker/session private keys |
| `MandateInfo` | On-chain mandate details from backend |
| `TransferResult` | `{ tx_hash: string }` |
| `DealOrderParams` | `{ executor_agent_id, bounty_amount, task_cid, delivery_deadline }` |

## Testing

```bash
pnpm test             # 38 unit/integration tests (vitest)
pnpm test:watch       # watch mode
pnpm test:keychain    # macOS keychain persistence integration test
```

### Keychain Integration Test (macOS only)

The `test:keychain` script verifies real keychain persistence:
- Deposits secrets and verifies they're written to macOS Keychain
- Destroys and recreates `ArysenKeymod` to simulate process restart
- Verifies secrets persist across restarts
- Tests multiple secrets and removal
- Cleans up test data automatically

This test uses the actual `security` CLI and reads/writes to your macOS Keychain under the service name `arysen`.

## Architecture

```
ArysenKeymod (TypeScript)
├── Wallet WASM ─── Ed25519 + secp256k1 signing
└── Mandate WASM ── Secrets + Policy + Backend + Transactions
    └── depends on Wallet (statically linked)
```

The SDK loads both WASM modules via `wasm-pack`'s Node.js CJS target, bridging to ESM with `createRequire`. Host imports (`get_time`, `http_execute`, etc.) are provided via an auto-generated env shim.
