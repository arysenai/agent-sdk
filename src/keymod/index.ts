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
export {
  uploadFile,
  downloadFile,
  registerEncryptionKey,
  getStorageRate,
} from './storage.js';
export type {
  StorageAllocation,
  UploadResult,
  DownloadResult,
  StorageRateInfo,
  UploadOptions,
} from './storage.js';
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
  RegisterAgentParams,
  RegisterAgentResult,
  StoragePrepareResult,
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
  RegisterAgentParams,
  RegisterAgentResult,
  StoragePrepareResult,
} from './types.js';

import { loadStorageModule, loadWalletModule, loadMandateModule, destroyBridge } from './loader.js';
import type { StorageExports, WalletExports, MandateExports } from './loader.js';

// -------------------------------------------------------------------------
// serde-wasm-bindgen returns JS Map objects for Rust structs/hashmaps.
// We convert them to plain objects recursively for ergonomic TypeScript use.
// -------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Single-use nonce for agent auth headers (UUID when available; otherwise 32 hex chars). */
function newAgentAuthNonce(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (!c?.getRandomValues) {
    throw new Error('Web Crypto API is required for agent registration nonces');
  }
  const buf = new Uint8Array(16);
  c.getRandomValues(buf);
  return bytesToHex(buf);
}

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
  private readonly storageWasm: StorageExports;
  private readonly walletHash: string;
  private readonly mandateHash: string;
  private readonly storageHash: string;
  /** Storage module's session public key (hex). Used by wrapDecryptionKey. */
  private readonly storageSessionPubKey: string;
  private bridge: Bridge | null;

  private constructor(
    wallet: WalletExports,
    mandate: MandateExports,
    storageWasm: StorageExports,
    bridge: Bridge,
    walletHash: string,
    mandateHash: string,
    storageHash: string,
    storageSessionPubKey: string,
  ) {
    this.wallet = wallet;
    this.mandate = mandate;
    this.storageWasm = storageWasm;
    this.bridge = bridge;
    this.walletHash = walletHash;
    this.mandateHash = mandateHash;
    this.storageHash = storageHash;
    this.storageSessionPubKey = storageSessionPubKey;
  }

  /**
   * Initialize all three WASM modules and return a ready-to-use instance.
   *
   * Spawns a Worker thread for HTTP bridging — call `destroy()` when done
   * to clean up. The worker is unref'd so it won't keep the process alive
   * if you forget.
   */
  static async init(options?: KeymodOptions): Promise<ArysenKeymod> {
    const { storage, hash: sHash } = loadStorageModule(options?.storageWasmPath);
    const { wallet, hash: wHash } = loadWalletModule(options?.walletWasmPath);
    const { mandate, bridge, hash: mHash } = loadMandateModule(
      options?.mandateWasmPath,
      options?.httpTimeout,
    );
    // Initialize storage session — generates X25519 keypair inside WASM,
    // returns the public key so wallet can encrypt private keys for it.
    const sessionPubKey = storage.storage_init_session();
    return new ArysenKeymod(wallet, mandate, storage, bridge, wHash, mHash, sHash, sessionPubKey);
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
  // Agent registration
  // ------------------------------------------------------------------

  /**
   * Register the agent with the Arysen backend.
   *
   * Signs the request with the mandate-held worker key (`mandate_sign_worker_registration`) per backend `requireRegisterAuth`:
   * message = exact JSON body string + nonce + timestamp; headers `X-ARYSEN-Signature`,
   * `X-ARYSEN-Nonce`, `X-ARYSEN-Timestamp` (no `X-ARYSEN-Agent-ID`).
   *
   * Sends the worker/session public keys along with load-time WASM hashes
   * so the backend can verify the agent runs audited binaries.
   */
  async registerAgent(params: RegisterAgentParams): Promise<RegisterAgentResult> {
    const url = `${params.base_url.replace(/\/+$/, '')}/agents/register`;
    const bodyObj: Record<string, string> = {
      worker_pub_key: params.worker_pub_key,
      session_pub_key: params.session_pub_key,
      name: params.name,
    };
    if (params.description !== undefined) {
      bodyObj.description = params.description;
    }
    bodyObj.wasm_wallet_hash = this.walletHash;
    bodyObj.wasm_mandate_hash = this.mandateHash;
    const body = JSON.stringify(bodyObj);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = newAgentAuthNonce();
    const message = body + nonce + timestamp;
    const msgBytes = new TextEncoder().encode(message);
    const sig = this.mandate.mandate_sign_worker_registration(msgBytes);
    if (sig.length !== 64 || sig.every((b) => b === 0)) {
      throw new Error(
        'Registration signing failed: no worker key in mandate memory. Call generateKeys() (or mandate_init with keys) in this process before registerAgent.',
      );
    }
    const signatureHex = bytesToHex(sig);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ARYSEN-Signature': signatureHex,
        'X-ARYSEN-Nonce': nonce,
        'X-ARYSEN-Timestamp': timestamp,
      },
      body,
    });

    const json = await response.json() as { success: boolean; data?: RegisterAgentResult; message?: string };
    if (!response.ok || !json.success) {
      throw new Error(json.message ?? `Registration failed (${response.status})`);
    }

    return json.data!;
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
  // Wallet operations — functionality key (BIP-32 + X25519)
  // ------------------------------------------------------------------

  /**
   * Generate a BIP-32 functionality keypair for encryption.
   * The seed is stored in-memory. Returns the X25519 public key (rotation index 0).
   */
  generateFunctionalityKey(): KeyPairResult {
    return mapToObject(this.wallet.generate_functionality_keypair()) as KeyPairResult;
  }

  /**
   * Derive the X25519 encryption public key at a given rotation index.
   * Requires a prior generateFunctionalityKey() call.
   * @param keyId - Key ID from generateFunctionalityKey()
   * @param rotationIndex - Derivation index (0 = current, increment for rotation)
   */
  deriveEncryptionPubkey(keyId: string, rotationIndex: number = 0): string {
    return this.wallet.derive_encryption_pubkey(keyId, rotationIndex);
  }

  /**
   * Get the current (rotation 0) encryption public key.
   * @param keyId - Key ID from generateFunctionalityKey()
   */
  getEncryptionPubkey(keyId: string): string {
    return this.wallet.get_encryption_pubkey(keyId);
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

  /** Get the SHA-256 hash of the storage WASM binary (hex string). */
  getStorageHash(): string {
    return this.storageHash;
  }

  // ------------------------------------------------------------------
  // Storage operations — encrypted file pipeline
  // ------------------------------------------------------------------

  /** Get the default chunk size in bytes (512KB). */
  getDefaultChunkSize(): number {
    return this.storageWasm.storage_default_chunk_size();
  }

  /**
   * Prepare a file for encrypted upload via WASM pipeline.
   *
   * Chunks the file, encrypts each chunk with a sealed-box key derived
   * from the recipient's X25519 public key, computes CIDs, and builds
   * a manifest. Returns everything needed for S3 upload.
   *
   * @param data - Raw file bytes
   * @param recipientPubKeyHex - Recipient's X25519 public key (64-char hex)
   * @param chunkSize - Bytes per chunk (default: 512KB)
   * @param mimeType - MIME type (default: "application/octet-stream")
   */
  storagePrepareUpload(
    data: Uint8Array,
    recipientPubKeyHex: string,
    chunkSize?: number,
    mimeType?: string,
  ): StoragePrepareResult {
    const result = this.storageWasm.storage_prepare_upload(
      data,
      recipientPubKeyHex,
      chunkSize ?? this.storageWasm.storage_default_chunk_size(),
      mimeType ?? 'application/octet-stream',
    );
    const obj = mapToObject(result) as Record<string, unknown>;
    if (obj.error) throw new Error(obj.error as string);
    return obj as unknown as StoragePrepareResult;
  }

  /**
   * Wrap an X25519 decryption key for secure transfer to the storage WASM module.
   *
   * The wallet derives the private key from the BIP-32 seed, encrypts it
   * using the storage module's session public key (sealed-box), and returns
   * the opaque ciphertext. The raw private key never enters JavaScript.
   *
   * @param funcKeyId - Key ID from generateFunctionalityKey()
   * @param rotationIndex - BIP-32 rotation index (0 = current)
   */
  wrapDecryptionKey(funcKeyId: string, rotationIndex: number = 0): string {
    const wrapped = this.wallet.wrap_decryption_key(
      funcKeyId,
      rotationIndex,
      this.storageSessionPubKey,
    );
    if (!wrapped) {
      throw new Error('Failed to wrap decryption key — check funcKeyId and rotation index');
    }
    return wrapped;
  }

  /**
   * Process a downloaded file via WASM pipeline.
   *
   * Verifies chunk CIDs, decrypts, and reassembles the original file.
   * The wrapped key is unwrapped inside the storage WASM module using
   * its session secret — the raw private key never enters JavaScript.
   *
   * @param manifestBytes - Encoded manifest
   * @param chunks - Array of [cid_string, encrypted_bytes] pairs
   * @param wrappedKeyHex - Wrapped decryption key (from wrapDecryptionKey)
   */
  storageProcessDownload(
    manifestBytes: Uint8Array,
    chunks: Array<[string, number[]]>,
    wrappedKeyHex: string,
  ): Uint8Array {
    const chunksJson = JSON.stringify(chunks);
    const result = this.storageWasm.storage_process_download(
      manifestBytes,
      chunksJson,
      wrappedKeyHex,
    );
    const obj = mapToObject(result) as Record<string, unknown>;
    if (obj.error) throw new Error(obj.error as string);
    return new Uint8Array(obj.data as number[]);
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
