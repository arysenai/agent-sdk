/**
 * WASM module loader.
 *
 * Loads the wasm-pack generated CJS packages (`arysen-wallet`, `arysen-mandate`)
 * from an ESM context using `createRequire`. The mandate module requires host
 * imports via an `env` WASM import module — we intercept Node's module
 * resolution to provide stub implementations.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Module from 'node:module';

// -------------------------------------------------------------------------
// Wallet module types (mirrors arysen_wallet.d.ts)
// -------------------------------------------------------------------------

export interface WalletExports {
  generate_session_keypair(): unknown;
  generate_session_keypair_with_secret(): unknown;
  generate_worker_keypair(): unknown;
  generate_worker_keypair_with_secret(): unknown;
  get_module_hash(): Uint8Array;
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
  get_mandate_hash(): Uint8Array;
  get_mandate_info(): unknown;
  get_spending_summary(): unknown;
  list_secret_names(): unknown;
  mandate_generate_keys(): unknown;
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
  get_random_bytes: (buf: Uint8Array) => number;
  get_time: () => bigint;
  http_execute: (reqPtr: number, reqLen: number, respPtr: number, respLen: number) => number;
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
export function loadWalletModule(walletPkgPath?: string): WalletExports {
  const pkgDir = walletPkgPath ?? resolveDefaultPkgPath('arysen-wallet');
  const requireFn = createRequire(resolve(pkgDir, 'package.json'));
  const mod = requireFn('./arysen_wallet.js') as WalletExports;
  return mod;
}

/**
 * Load the mandate WASM module.
 *
 * The mandate WASM binary imports `env.get_time` and `env.http_execute`.
 * The wasm-pack generated JS does `require("env")` to resolve these.
 * We need to make that resolve — the simplest approach is to create a
 * shim module and hook Node's resolution temporarily.
 */
export function loadMandateModule(mandatePkgPath?: string): MandateExports {
  const pkgDir = mandatePkgPath ?? resolveDefaultPkgPath('arysen-mandate');

  // Write a temporary "env.js" shim next to the mandate JS file so that
  // `require("env")` resolves via the NODE_PATH or we can redirect to it.
  // But actually, the most reliable approach: patch Module._resolveFilename.
  const ModuleInternal = Module as unknown as ModuleInternals;
  const origResolve = ModuleInternal._resolveFilename;

  // Create a shim file in the package directory
  const envShimPath = resolve(pkgDir, '_env_shim.js');
  if (!existsSync(envShimPath)) {
    writeFileSync(envShimPath, ENV_SHIM_SOURCE);
  }

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

  try {
    const requireFn = createRequire(resolve(pkgDir, 'package.json'));
    const mod = requireFn('./arysen_mandate.js') as MandateExports;
    return mod;
  } finally {
    // Restore original resolution
    ModuleInternal._resolveFilename = origResolve;
  }
}

/** Source code for the env shim module. */
const ENV_SHIM_SOURCE = `
// Auto-generated shim for mandate WASM "env" imports.
// These are C-ABI-level stubs; the WASM binary expects low-level functions
// but uses wasm-bindgen's JS glue as the actual import object.
// The generated JS uses these as the import object for the "env" section
// when instantiating the WASM module.
module.exports = {
  key_store_read: function() { return -1; },
  key_store_write: function() { return 0; },
  get_random_bytes: function() { return 0; },
  get_time: function() { return BigInt(Math.floor(Date.now() / 1000)); },
  http_execute: function() { return 0; },
};
`;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Resolve the default pkg directory for a linked package. */
function resolveDefaultPkgPath(packageName: string): string {
  const thisFile = new URL(import.meta.url).pathname;
  const sdkRoot = resolve(dirname(thisFile), '..', '..');
  const pkgDir = resolve(sdkRoot, 'node_modules', packageName);
  try {
    readFileSync(resolve(pkgDir, 'package.json'));
  } catch {
    throw new Error(
      `Cannot find ${packageName} package at ${pkgDir}. ` +
      `Make sure to run 'pnpm install' and that the WASM packages are built.`
    );
  }
  return pkgDir;
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
