# CLAUDE.md — agent-sdk

TypeScript SDK wrapping the keymod WASM modules. Provides `ArysenKeymod` — a single class for agent key management, credential injection, policy enforcement, and transaction execution.

## Structure

```
agent-sdk/
├── package.json        # pnpm, ESM, vitest
├── tsconfig.json       # ES2023, Node16 module, strict
├── vitest.config.ts
├── src/
│   ├── wasm.d.ts       # Ambient WebAssembly types (Node has no built-in TS defs)
│   └── keymod/
│       ├── index.ts        # ArysenKeymod class (public API)
│       ├── types.ts        # TypeScript types mirroring Rust structs
│       ├── loader.ts       # WASM module loader + HTTP bridge setup
│       ├── http-worker.ts  # Worker thread — async fetch loop
│       ├── http-host.ts    # HttpHost — standalone fetch-based HTTP executor
│       └── storage-fs.ts   # FileSystemStorage — encrypted key files
└── tests/
    └── keymod.test.ts  # vitest integration tests
```

## Commands

```bash
pnpm install    # Install deps + link WASM packages
pnpm test       # vitest run
pnpm build      # tsc → dist/
```

## Dependencies

WASM packages are linked from `../keymod/` via `file:` dependencies:
- `arysen-wallet`: `file:../keymod/wallet/pkg`
- `arysen-mandate`: `file:../keymod/mandate/pkg`

After rebuilding WASM in keymod (`wasm-pack build --target nodejs`), run `pnpm install` here to refresh hard-links. Also delete any stale `_env_shim.js` in the mandate node_modules package dir.

## Key Architecture

- **loader.ts** patches `Module._resolveFilename` to intercept `require("env")` from the mandate WASM glue, providing an env shim with host imports (`get_time`, `key_store_read/write`, `http_execute`). Also hooks `WebAssembly.Instance` to capture WASM linear memory for the HTTP bridge.
- **http-worker.ts** runs in a Worker thread for sync↔async HTTP bridging. The env shim's `http_execute` uses SharedArrayBuffer + Atomics to block the main thread while the Worker does async `fetch()`. This allows WASM's synchronous host import calls to make real HTTP requests.
- **loader.ts** `loadMandateModule()` returns `{ mandate, bridge }` — the bridge must be passed to `ArysenKeymod` and cleaned up via `destroy()`.
- **mapToObject()** in index.ts recursively converts `Map` objects (from serde-wasm-bindgen) to plain JS objects.
- Methods are synchronous (WASM calls are blocking). `ArysenKeymod.init()` spawns the Worker thread — call `destroy()` when done.
- Error responses from WASM come as `{ error: string }` — callers should check for this.

## Architecture Constraints

- The 5-step transfer flow (check-spend → prepare → sign → submit → record) **must stay inside WASM**. Do not refactor to JS-side HTTP orchestration.
- Private keys never cross the WASM→JS boundary.
- The Worker thread HTTP bridge (SharedArrayBuffer + Atomics) is intentional — WASM has no native I/O.

## Testing

32 tests in `tests/keymod.test.ts`:
- Loader: verifies all WASM function exports exist (`loadMandateModule()` returns `{ mandate, bridge }`)
- Key generation: Ed25519 (64-char hex pubkey) and secp256k1 (66-char hex compressed pubkey)
- Sign/verify roundtrips for both schemes
- Secrets lifecycle (deposit, list, remove)
- Policy checks (within limits, over limits)
- Backend operations (error handling without init)
- HTTP + filesystem storage

The `HttpHost.execute` network test is skipped by default (`it.skip`).

## Conventions

- WASM exports are snake_case; TypeScript methods are camelCase
- Types use snake_case field names to match Rust (e.g., `pub_key`, `key_id`, `max_per_tx`)
- All signatures and keys use **hex** encoding (not base64)
- `file:` WASM deps require `pnpm install` after every WASM rebuild
- No runtime dependencies beyond the two WASM packages
