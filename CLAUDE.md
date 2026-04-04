# CLAUDE.md — agent-sdk

TypeScript SDK wrapping the keymod WASM modules. Provides `ArysenKeymod` — a single class for agent key management, credential injection, policy enforcement, and transaction execution.

**See also** (agent workflows and HTTP reference, not loaded by default in all tools): [`skill/SKILL.md`](skill/SKILL.md) for OpenClaw / product guidance; [`skill/REFERENCE.md`](skill/REFERENCE.md) for REST paths, WebSocket, and Ed25519 signing details.

## Structure

```
agent-sdk/
├── package.json        # pnpm, ESM, vitest; exports only ./keymod
├── tsconfig.json       # ES2023, Node16 module, strict
├── vitest.config.ts
├── skill/              # Agent skill docs (SKILL.md + guides)
├── src/
│   ├── wasm.d.ts       # Ambient WebAssembly types (Node has no built-in TS defs)
│   └── keymod/
│       ├── index.ts        # ArysenKeymod class (public API)
│       ├── types.ts        # TypeScript types mirroring Rust structs
│       ├── loader.ts       # WASM module loader + HTTP bridge setup
│       ├── http-worker.ts  # Worker thread — async fetch loop
│       ├── http-host.ts    # HttpHost — standalone fetch-based HTTP executor
│       ├── keystore.ts     # Platform keystore — macOS Keychain, Windows DPAPI, Linux libsecret/files
│       └── storage-fs.ts   # FileSystemStorage — encrypted key files
└── tests/
    └── keymod.test.ts  # vitest integration tests
```

## Commands

```bash
pnpm install       # Install dependencies
pnpm test          # vitest run
pnpm test:watch    # vitest watch mode
pnpm test:keychain # macOS keychain persistence (tsx script)
pnpm build         # tsc → dist/
```

## Dependencies

**Published package** (`@arysenai/agent-sdk` on npm) depends on:

- `@arysenai/arysen-wallet`
- `@arysenai/arysen-mandate`

No other runtime dependencies.

**Monorepo / local development**: To use freshly built WASM from the sibling `keymod` tree, point `package.json` at `file:../keymod/wallet/pkg` and `file:../keymod/mandate/pkg` (or equivalent), then run `wasm-pack build --target nodejs` in each crate and `pnpm install` in `agent-sdk`. After WASM rebuilds, refresh installs and remove any stale `_env_shim.js` under the mandate package in `node_modules` if loads fail.

**`@arysenai/arysen-mandate` ≥ 0.3.2** adds `mandate_sign_worker_registration` (used by **`registerAgent`**). Until that version is published to npm, this package uses **`pnpm.overrides`** → `file:../keymod/mandate/pkg`; after `wasm-pack`, set `pkg/package.json` **`name`** to `@arysenai/arysen-mandate` before `pnpm install` (wasm-pack emits an unscoped name by default).

## Public API (high level)

- **`ArysenKeymod.init(options?: KeymodOptions)`** — Loads wallet + mandate WASM, starts HTTP Worker bridge. Options: `httpTimeout` (ms, default 30_000), `storagePath`, `walletWasmPath`, `mandateWasmPath`.
- **`destroy()`** — Terminate the HTTP Worker.
- **`registerAgent(params)`** — Async `fetch` to `{base_url}/agents/register` with worker/session public keys and load-time **`wasm_wallet_hash` / `wasm_mandate_hash`**. Signs **body + nonce + timestamp** via mandate WASM **`mandate_sign_worker_registration`** (worker key must already be in mandate memory from **`generateKeys()`** or **`initMandate`**). Same headers as `requireRegisterAuth` — **no** `X-ARYSEN-Agent-ID`. Use a `base_url` that includes the API prefix (e.g. `https://api.arysen.ai/api/v1`).
- **`getWalletHash()` / `getMandateHash()`** — Same hashes as sent with registration.
- **Keys**: `generateKeys()`, per-keypair `generateWorkerKey` / `generateSessionKey` (+ `*WithSecret()`), `signWorker` / `signSession`, `verifyWorker` / `verifySession`.
- **Mandate**: `initMandate(config)` — `InitConfig` extends backend URL + agent id + key ids; `worker_private_key_hex` / `session_private_key_hex` optional if `generateKeys()` was used first. `getMandateInfo()`, `transferUsdc`, `createDealOrder`, policy/secrets/executeRequest as documented in README.

## Key Architecture

- **loader.ts** patches `Module._resolveFilename` to intercept `require("env")` from the mandate WASM glue, providing an env shim with host imports (`get_time`, `key_store_read/write`, `http_execute`). Also hooks `WebAssembly.Instance` to capture WASM linear memory for the HTTP bridge.
- **http-worker.ts** runs in a Worker thread for sync↔async HTTP bridging. The env shim's `http_execute` uses SharedArrayBuffer + Atomics to block the main thread while the Worker does async `fetch()`. This allows WASM's synchronous host import calls to make real HTTP requests.
- **loader.ts** `loadWalletModule()` returns `{ wallet, hash }` and `loadMandateModule(path?, httpTimeout?)` returns `{ mandate, bridge, hash }` — hash is SHA-256 hex of the `.wasm` binary, computed at load time. The bridge must be passed to `ArysenKeymod` and cleaned up via `destroy()`.
- **mapToObject()** in index.ts recursively converts `Map` objects (from serde-wasm-bindgen) to plain JS objects.
- Methods are synchronous (WASM calls are blocking) except **`registerAgent`**, which uses global `fetch`. `ArysenKeymod.init()` spawns the Worker thread — call `destroy()` when done.
- Error responses from WASM come as `{ error: string }` — callers should check for this.

## Architecture Constraints

- The 5-step transfer flow (check-spend → prepare → sign → submit → record) **must stay inside WASM**. Do not refactor to JS-side HTTP orchestration.
- Private keys never cross the WASM→JS boundary.
- The Worker thread HTTP bridge (SharedArrayBuffer + Atomics) is intentional — WASM has no native I/O.

## Testing

Run `pnpm test` for the full Vitest suite in `tests/keymod.test.ts` (38 tests as of last count), including:

- Loader: WASM exports + load-time hash (SHA-256 hex), stability, distinctness
- Key generation: Ed25519 (64-char hex pubkey) and secp256k1 (66-char hex compressed pubkey)
- Sign/verify roundtrips for both schemes
- Secrets lifecycle (deposit, list, remove)
- Policy checks (within limits, over limits)
- Backend operations (error handling without init)
- **`registerAgent`** (mocked `fetch`)
- HTTP + filesystem storage

The `HttpHost.execute` network test is skipped by default (`it.skip`). Use `pnpm test:keychain` on macOS for optional keychain persistence checks.

## Conventions

- WASM exports are snake_case; TypeScript methods are camelCase
- Types use snake_case field names to match Rust (e.g., `pub_key`, `key_id`, `max_per_tx`)
- All signatures and keys use **hex** encoding (not base64)
- Monorepo `file:` WASM deps require `pnpm install` after every WASM rebuild
- No runtime dependencies beyond the two WASM packages
