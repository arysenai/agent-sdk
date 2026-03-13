/**
 * ArysenKeymod — typed API wrapping the wallet and mandate WASM modules.
 *
 * Usage:
 * ```ts
 * import { ArysenKeymod } from 'agent-sdk/keymod';
 *
 * const keymod = await ArysenKeymod.init();
 * const keys = keymod.generateKeys();
 * keymod.initMandate({ base_url, agent_id, worker_key_id: keys.worker_key_id, session_key_id: keys.session_key_id });
 * keymod.transferUsdc('0xRecipient', '5.00');
 * keymod.destroy(); // clean up worker thread
 * ```
 */

export { FileSystemStorage } from './storage-fs.js';
export { HttpHost } from './http-host.js';
export type {
  KeyPairResult,
  KeyPairWithSecret,
  GeneratedKeys,
  RequestTemplate,
  HttpResponse,
  Policy,
  SpendingPolicy,
  SecretPolicy,
  PolicyResult,
  SpendingSummary,
  BackendConfig,
  InitConfig,
  MandateInfo,
  TransferResult,
  DealOrderParams,
  KeymodOptions,
} from './types.js';

import type {
  KeyPairResult,
  KeyPairWithSecret,
  GeneratedKeys,
  RequestTemplate,
  HttpResponse,
  Policy,
  PolicyResult,
  SpendingSummary,
  InitConfig,
  MandateInfo,
  TransferResult,
  DealOrderParams,
  KeymodOptions,
} from './types.js';

import { loadWalletModule, loadMandateModule, destroyBridge } from './loader.js';
import type { WalletExports, MandateExports } from './loader.js';

// -------------------------------------------------------------------------
// serde-wasm-bindgen returns JS Map objects for Rust structs/hashmaps.
// We convert them to plain objects recursively for ergonomic TypeScript use.
// -------------------------------------------------------------------------

function mapToObject(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) {
      obj[String(k)] = mapToObject(v);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(mapToObject);
  }
  return value;
}

// Internal bridge type (avoid exposing loader internals)
interface Bridge {
  worker: import('node:worker_threads').Worker;
  signal: Int32Array;
  data: Uint8Array;
  wasmMemory: WebAssembly.Memory | null;
}

export class ArysenKeymod {
  private readonly wallet: WalletExports;
  private readonly mandate: MandateExports;
  private readonly walletHash: string;
  private readonly mandateHash: string;
  private bridge: Bridge | null;

  private constructor(
    wallet: WalletExports,
    mandate: MandateExports,
    bridge: Bridge,
    walletHash: string,
    mandateHash: string,
  ) {
    this.wallet = wallet;
    this.mandate = mandate;
    this.bridge = bridge;
    this.walletHash = walletHash;
    this.mandateHash = mandateHash;
  }

  /**
   * Initialize both WASM modules and return a ready-to-use instance.
   *
   * Spawns a Worker thread for HTTP bridging — call `destroy()` when done
   * to clean up. The worker is unref'd so it won't keep the process alive
   * if you forget.
   */
  static async init(options?: KeymodOptions): Promise<ArysenKeymod> {
    const { wallet, hash: wHash } = loadWalletModule(options?.walletWasmPath);
    const { mandate, bridge, hash: mHash } = loadMandateModule(
      options?.mandateWasmPath,
      options?.httpTimeout,
    );
    return new ArysenKeymod(wallet, mandate, bridge, wHash, mHash);
  }

  /**
   * Terminate the HTTP Worker thread. Call when the keymod instance
   * is no longer needed. Safe to call multiple times.
   */
  destroy(): void {
    if (this.bridge) {
      destroyBridge(this.bridge);
      this.bridge = null;
    }
  }

  // ------------------------------------------------------------------
  // Wallet operations
  // ------------------------------------------------------------------

  /** Generate an Ed25519 worker keypair. */
  generateWorkerKey(): KeyPairResult {
    return mapToObject(this.wallet.generate_worker_keypair()) as KeyPairResult;
  }

  /** Generate an Ed25519 worker keypair and return the private key. */
  generateWorkerKeyWithSecret(): KeyPairWithSecret {
    return mapToObject(this.wallet.generate_worker_keypair_with_secret()) as KeyPairWithSecret;
  }

  /** Generate a secp256k1 session keypair. */
  generateSessionKey(): KeyPairResult {
    return mapToObject(this.wallet.generate_session_keypair()) as KeyPairResult;
  }

  /** Generate a secp256k1 session keypair and return the private key. */
  generateSessionKeyWithSecret(): KeyPairWithSecret {
    return mapToObject(this.wallet.generate_session_keypair_with_secret()) as KeyPairWithSecret;
  }

  /** Sign a message with the worker (Ed25519) key. */
  signWorker(message: Uint8Array, keyId: string): Uint8Array {
    return this.wallet.sign_worker(message, keyId);
  }

  /** Sign a message with the session (secp256k1) key. */
  signSession(message: Uint8Array, keyId: string): Uint8Array {
    return this.wallet.sign_session(message, keyId);
  }

  /** Verify an Ed25519 worker signature. */
  verifyWorker(message: Uint8Array, signature: Uint8Array, pubKey: Uint8Array): boolean {
    return this.wallet.verify_worker(message, signature, pubKey);
  }

  /** Verify a secp256k1 session signature. */
  verifySession(message: Uint8Array, signature: Uint8Array, pubKey: Uint8Array): boolean {
    return this.wallet.verify_session(message, signature, pubKey);
  }

  /** Get the SHA-256 hash of the wallet WASM binary (hex string). */
  getWalletHash(): string {
    return this.walletHash;
  }

  // ------------------------------------------------------------------
  // Mandate operations — secrets
  // ------------------------------------------------------------------

  /**
   * Deposit a secret by name. The value is stored in the WASM module's
   * internal vault (encrypted internally by the Rust code).
   */
  depositSecret(name: string, value: string): boolean {
    const encoder = new TextEncoder();
    return this.mandate.deposit_secret(name, encoder.encode(value));
  }

  /** Remove a secret by name. Returns true if the secret existed. */
  removeSecret(name: string): boolean {
    return this.mandate.remove_secret(name);
  }

  /** List all stored secret names (values are never exposed). */
  listSecrets(): string[] {
    const raw = this.mandate.list_secret_names();
    return raw as string[];
  }

  // ------------------------------------------------------------------
  // Mandate operations — request execution
  // ------------------------------------------------------------------

  /**
   * Execute a request template with credential injection.
   *
   * Placeholders like `{SECRET_NAME}` in the template's URL, headers,
   * or body are replaced with the corresponding secret values. The
   * response is scrubbed of any injected secret values before being
   * returned.
   */
  executeRequest(template: RequestTemplate): HttpResponse {
    const result = this.mandate.execute_request(JSON.stringify(template));
    return mapToObject(result) as HttpResponse;
  }

  // ------------------------------------------------------------------
  // Mandate operations — policy
  // ------------------------------------------------------------------

  /** Set the spending/rate-limit policy. */
  setPolicy(policy: Policy): boolean {
    return this.mandate.set_policy(JSON.stringify(policy));
  }

  /** Check whether an action is permitted under the current policy. */
  checkPolicy(action: string, params: Record<string, unknown>): PolicyResult {
    const result = this.mandate.check_policy(action, JSON.stringify(params));
    return mapToObject(result) as PolicyResult;
  }

  /** Get spending usage statistics. */
  getSpendingSummary(): SpendingSummary {
    return mapToObject(this.mandate.get_spending_summary()) as SpendingSummary;
  }

  /** Get the SHA-256 hash of the mandate WASM binary (hex string). */
  getMandateHash(): string {
    return this.mandateHash;
  }

  // ------------------------------------------------------------------
  // Mandate operations — backend communication
  // ------------------------------------------------------------------

  /**
   * Generate both keypairs (Ed25519 worker + secp256k1 session) inside WASM.
   *
   * Private keys stay inside the WASM module and never cross the JS boundary.
   * Returns only public keys and key IDs. Call this before initMandate() —
   * the generated keys will be used automatically for signing.
   */
  generateKeys(): GeneratedKeys {
    return mapToObject(this.mandate.mandate_generate_keys()) as GeneratedKeys;
  }

  /**
   * Initialize the mandate module with backend configuration.
   *
   * Fetches the active mandate from the backend, hydrates the policy
   * engine with on-chain limits, and stores the worker private key
   * for signing subsequent backend requests.
   */
  initMandate(config: InitConfig): MandateInfo {
    const result = this.mandate.mandate_init(JSON.stringify(config));
    return mapToObject(result) as MandateInfo;
  }

  /** Fetch current mandate info from the backend. */
  getMandateInfo(): MandateInfo {
    const result = this.mandate.get_mandate_info();
    return mapToObject(result) as MandateInfo;
  }

  // ------------------------------------------------------------------
  // Mandate operations — transactions
  // ------------------------------------------------------------------

  /**
   * Transfer USDC to an address.
   *
   * Executes the full 5-step flow: local pre-flight → backend check →
   * prepare tx → sign with session key → submit → record spending.
   * Requires prior call to `initMandate()`.
   */
  transferUsdc(to: string, amount: string): TransferResult {
    const result = this.mandate.transfer_usdc(to, amount);
    return mapToObject(result) as TransferResult;
  }

  /**
   * Create a DealOrder with escrowed USDC.
   *
   * Same flow as transferUsdc but with type "escrow" and deal-specific params.
   * Requires prior call to `initMandate()`.
   */
  createDealOrder(params: DealOrderParams): TransferResult {
    const result = this.mandate.create_deal_order(JSON.stringify(params));
    return mapToObject(result) as TransferResult;
  }
}
