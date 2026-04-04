/**
 * WASM module loader.
 *
 * Loads the wasm-pack generated CJS packages (`arysen-wallet`, `arysen-mandate`)
 * from an ESM context using `createRequire`. The mandate module requires host
 * imports via an `env` WASM import module — we intercept Node's module
 * resolution to provide an env shim with a real `http_execute` backed by
 * a Worker thread (SharedArrayBuffer + Atomics for sync↔async bridging).
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Module from 'node:module';
import { platformRead, platformWrite } from './keystore.js';

// -------------------------------------------------------------------------
// Wallet module types (mirrors arysen_wallet.d.ts)
// -------------------------------------------------------------------------

export interface WalletExports {
  generate_session_keypair(): unknown;
  generate_session_keypair_with_secret(): unknown;
  generate_worker_keypair(): unknown;
  generate_worker_keypair_with_secret(): unknown;
  sign_session(message: Uint8Array, key_id: string): Uint8Array;
  sign_worker(message: Uint8Array, key_id: string): Uint8Array;
  verify_session(message: Uint8Array, signature: Uint8Array, pub_key: Uint8Array): boolean;
  verify_worker(message: Uint8Array, signature: Uint8Array, pub_key: Uint8Array): boolean;
}

// -------------------------------------------------------------------------
// Mandate module types (mirrors arysen_mandate.d.ts)
// -------------------------------------------------------------------------

export interface MandateExports {
  check_policy(action: string, params_json: string): unknown;
  create_deal_order(params_json: string): unknown;
  deposit_secret(name: string, encrypted_value: Uint8Array): boolean;
  execute_request(template_json: string): unknown;
  get_mandate_info(): unknown;
  get_spending_summary(): unknown;
  list_secret_names(): unknown;
  mandate_generate_keys(): unknown;
  mandate_sign_worker_registration(message: Uint8Array): Uint8Array;
  mandate_init(config_json: string): unknown;
  remove_secret(name: string): boolean;
  set_policy(policy_json: string): boolean;
  transfer_usdc(to: string, amount: string): unknown;
}

// -------------------------------------------------------------------------
// Host imports for the mandate WASM module
// -------------------------------------------------------------------------

export interface HostImports {
  key_store_read: (keyId: string, buf: Uint8Array) => number;
  key_store_write: (keyId: string, data: Uint8Array) => number;
  get_time: () => bigint;
  http_execute: (reqPtr: number, reqLen: number, respPtr: number, respLen: number) => number;
}

// -------------------------------------------------------------------------
// HTTP bridge — SharedArrayBuffer + Worker for sync↔async HTTP
// -------------------------------------------------------------------------

const SIGNAL_BUF_SIZE = 16;  // 4 x Int32
const DATA_BUF_SIZE = 262144; // 256KB for request/response JSON
const DEFAULT_HTTP_TIMEOUT = 30_000;

interface HttpBridge {
  worker: Worker;
  signal: Int32Array;
  data: Uint8Array;
  wasmMemory: WebAssembly.Memory | null;
}

/** Global bridge + keystore — set before mandate module loads, used by env shim. */
declare global {
  // eslint-disable-next-line no-var
  var __arysenHttpBridge: HttpBridge | undefined;
  // eslint-disable-next-line no-var
  var __arysenKeystore: {
    read: (keyId: string) => Buffer | null;
    write: (keyId: string, data: Buffer) => void;
  } | undefined;
}

function createHttpBridge(httpTimeout?: number): HttpBridge {
  const signalBuf = new SharedArrayBuffer(SIGNAL_BUF_SIZE);
  const dataBuf = new SharedArrayBuffer(DATA_BUF_SIZE);

  // Resolve the worker path relative to this file's location.
  // In compiled output it's http-worker.js; in vitest/tsx it's http-worker.ts.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let workerPath = resolve(thisDir, 'http-worker.js');
  if (!existsSync(workerPath)) {
    workerPath = resolve(thisDir, 'http-worker.ts');
  }

  const worker = new Worker(workerPath, {
    workerData: {
      signalBuf,
      dataBuf,
      timeout: httpTimeout ?? DEFAULT_HTTP_TIMEOUT,
    },
    // When running .ts directly (vitest / node --experimental-strip-types),
    // the worker needs the same TypeScript support flags.
    ...(workerPath.endsWith('.ts') ? { execArgv: ['--experimental-strip-types'] } : {}),
  });

  // Don't let the worker keep the process alive
  worker.unref();

  return {
    worker,
    signal: new Int32Array(signalBuf),
    data: new Uint8Array(dataBuf),
    wasmMemory: null,
  };
}

// -------------------------------------------------------------------------
// Loader functions
// -------------------------------------------------------------------------

/**
 * Load the wallet WASM module.
 *
 * The wallet package has no custom host imports — it only needs the standard
 * wasm-bindgen glue which is self-contained in the generated JS.
 */
export function loadWalletModule(walletPkgPath?: string): { wallet: WalletExports; hash: string } {
  const pkgDir = walletPkgPath ?? resolveDefaultPkgPath('@arysenai/arysen-wallet');
  const requireFn = createRequire(resolve(pkgDir, 'package.json'));
  const mod = requireFn('./arysen_wallet.js') as WalletExports;
  const hash = computeWasmHash(resolve(pkgDir, 'arysen_wallet_bg.wasm'));
  return { wallet: mod, hash };
}

/**
 * Load the mandate WASM module with a live HTTP bridge.
 *
 * Sets up a Worker thread for async HTTP, hooks WebAssembly.Instance to
 * capture WASM memory, and provides an env shim where http_execute
 * synchronously bridges to the Worker via SharedArrayBuffer + Atomics.
 */
export function loadMandateModule(
  mandatePkgPath?: string,
  httpTimeout?: number,
): { mandate: MandateExports; bridge: HttpBridge; hash: string } {
  const pkgDir = mandatePkgPath ?? resolveDefaultPkgPath('@arysenai/arysen-mandate');

  // 1. Create or reuse the HTTP bridge (Worker + SharedArrayBuffers)
  // If a bridge already exists with wasmMemory set, reuse it
  let bridge = globalThis.__arysenHttpBridge;
  if (!bridge || !bridge.wasmMemory) {
    bridge = createHttpBridge(httpTimeout);
  }

  // 2. Hook WebAssembly.Instance to capture WASM memory (only if not already hooked)
  if (!(WebAssembly.Instance as unknown as { __arysen_hooked?: boolean }).__arysen_hooked) {
    const OrigInstance = WebAssembly.Instance;
    (WebAssembly as unknown as Record<string, unknown>).Instance = function (
      module: WebAssembly.Module,
      imports: WebAssembly.Imports,
    ): WebAssembly.Instance {
      const instance = new OrigInstance(module, imports);
      if (instance.exports.memory && globalThis.__arysenHttpBridge) {
        globalThis.__arysenHttpBridge.wasmMemory = instance.exports.memory as WebAssembly.Memory;
      }
      return instance;
    };
    (WebAssembly.Instance as unknown as { __arysen_hooked?: boolean }).__arysen_hooked = true;
  }

  // 3. Write env shim that uses the global bridge + keystore
  globalThis.__arysenHttpBridge = bridge;
  globalThis.__arysenKeystore = { read: platformRead, write: platformWrite };
  const envShimPath = resolve(pkgDir, '_env_shim.js');
  writeFileSync(envShimPath, ENV_SHIM_SOURCE);

  // 4. Patch module resolution so require("env") resolves to our shim
  const ModuleInternal = Module as unknown as ModuleInternals;
  const origResolve = ModuleInternal._resolveFilename;
  ModuleInternal._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) {
    if (request === 'env') {
      return envShimPath;
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  // 5. Clear require cache for env shim (force reload with new source)
  const requireFn = createRequire(resolve(pkgDir, 'package.json'));
  delete requireFn.cache?.[envShimPath];

  try {
    const mandate = requireFn('./arysen_mandate.js') as MandateExports;
    const hash = computeWasmHash(resolve(pkgDir, 'arysen_mandate_bg.wasm'));
    return { mandate, bridge, hash };
  } finally {
    ModuleInternal._resolveFilename = origResolve;
  }
}

/** Terminate the HTTP bridge worker. */
export function destroyBridge(bridge: HttpBridge): void {
  // Signal shutdown
  Atomics.store(bridge.signal, 0, -1);
  Atomics.notify(bridge.signal, 0);
  bridge.worker.terminate();
}

/** Source code for the env shim module — uses globalThis.__arysenHttpBridge + __arysenKeystore. */
const ENV_SHIM_SOURCE = `
// Auto-generated shim for mandate WASM "env" imports.
// key_store_read/write route to platform keychain (macOS/Windows) or encrypted files (Linux).
// http_execute bridges synchronously to the HTTP Worker thread
// via SharedArrayBuffer + Atomics (set up by loader.ts).
module.exports = {
  key_store_read: function(keyIdPtr, keyIdLen, bufPtr, bufLen) {
    var bridge = globalThis.__arysenHttpBridge;
    var ks = globalThis.__arysenKeystore;
    if (!bridge || !bridge.wasmMemory || !ks) return -1;

    // Read key_id string from WASM memory
    var wasmBuf = new Uint8Array(bridge.wasmMemory.buffer);
    var keyIdBytes = wasmBuf.slice(keyIdPtr, keyIdPtr + keyIdLen);
    var keyId = new TextDecoder().decode(keyIdBytes);

    // Read from platform keystore
    try {
      var data = ks.read(keyId);
    } catch (e) { return -1; }
    if (!data) return -1;
    if (data.length > bufLen) return -2;

    // Write data to WASM buffer (re-read for potential memory.grow)
    var freshBuf = new Uint8Array(bridge.wasmMemory.buffer);
    freshBuf.set(data, bufPtr);
    return data.length;
  },
  key_store_write: function(keyIdPtr, keyIdLen, dataPtr, dataLen) {
    var bridge = globalThis.__arysenHttpBridge;
    var ks = globalThis.__arysenKeystore;
    if (!bridge || !bridge.wasmMemory || !ks) return -1;

    // Read key_id string from WASM memory
    var wasmBuf = new Uint8Array(bridge.wasmMemory.buffer);
    var keyIdBytes = wasmBuf.slice(keyIdPtr, keyIdPtr + keyIdLen);
    var keyId = new TextDecoder().decode(keyIdBytes);

    // Read data bytes from WASM memory
    var data = Buffer.from(wasmBuf.slice(dataPtr, dataPtr + dataLen));

    // Write to platform keystore
    try {
      ks.write(keyId, data);
      return 0;
    } catch (e) { return -1; }
  },
  get_time: function() { return BigInt(Math.floor(Date.now() / 1000)); },
  http_execute: function(reqPtr, reqLen, respPtr, respLen) {
    var bridge = globalThis.__arysenHttpBridge;
    if (!bridge || !bridge.wasmMemory) return -1;

    // Read request from WASM memory
    var wasmBuf = new Uint8Array(bridge.wasmMemory.buffer);
    var reqBytes = wasmBuf.slice(reqPtr, reqPtr + reqLen);

    // Copy to shared data buffer
    if (reqBytes.length > bridge.data.length) return -2;
    bridge.data.set(reqBytes, 0);
    Atomics.store(bridge.signal, 1, reqLen);

    // Signal request ready and block until response
    Atomics.store(bridge.signal, 0, 1);
    Atomics.notify(bridge.signal, 0);
    Atomics.wait(bridge.signal, 0, 1);

    var state = Atomics.load(bridge.signal, 0);
    if (state !== 2) return -3;

    // Read response length
    var respLength = Atomics.load(bridge.signal, 1);
    if (respLength > respLen) return -4;

    // Write response to WASM memory (re-read buffer for potential memory.grow)
    var freshBuf = new Uint8Array(bridge.wasmMemory.buffer);
    freshBuf.set(bridge.data.subarray(0, respLength), respPtr);

    // Reset to idle
    Atomics.store(bridge.signal, 0, 0);
    return respLength;
  },
};
`;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Compute SHA-256 hash of a WASM binary file, returned as a hex string. */
function computeWasmHash(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Resolve the default pkg directory for a linked package (supports scoped names). */
function resolveDefaultPkgPath(packageName: string): string {
  const thisFile = new URL(import.meta.url).pathname;
  const sdkRoot = resolve(dirname(thisFile), '..', '..');
  const requireFn = createRequire(resolve(sdkRoot, 'package.json'));
  try {
    const pkgJsonPath = requireFn.resolve(`${packageName}/package.json`);
    return dirname(pkgJsonPath);
  } catch {
    const fallbackDir = resolve(sdkRoot, 'node_modules', ...packageName.split('/'));
    throw new Error(
      `Cannot find ${packageName} package. ` +
      `Tried Node resolution and fallback path ${fallbackDir}. ` +
      `Make sure to run 'pnpm install' and that the WASM packages are built.`
    );
  }
}

// Node.js internal typing
interface ModuleInternals {
  _resolveFilename: (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) => string;
}
