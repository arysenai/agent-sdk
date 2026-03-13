/**
 * TypeScript types mirroring the Rust types used by the keymod WASM modules.
 */

/** Result of keypair generation from the wallet module. */
export interface KeyPairResult {
  /** Hex-encoded public key. */
  pub_key: string;
  /** Hex-encoded first 16 chars of SHA-256 hash of the public key. */
  key_id: string;
}

/** Result of mandate_generate_keys — both keypairs, public keys only. */
export interface GeneratedKeys {
  /** Hex-encoded Ed25519 public key (32 bytes → 64 chars). */
  worker_pub_key: string;
  /** Key ID for the worker keypair. */
  worker_key_id: string;
  /** Hex-encoded secp256k1 compressed public key (33 bytes → 66 chars). */
  session_pub_key: string;
  /** Key ID for the session keypair. */
  session_key_id: string;
}

/** Keypair result with private key included (used internally for cross-module key sharing). */
export interface KeyPairWithSecret extends KeyPairResult {
  /** Hex-encoded private key. Only returned by *_with_secret() exports. */
  private_key: string;
}

/** HTTP request template — used for credential-injected requests. */
export interface RequestTemplate {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** HTTP response returned by the mandate module after request execution. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Top-level policy configuration. */
export interface Policy {
  spending: SpendingPolicy;
  secrets: Record<string, SecretPolicy>;
}

/** Spending limits (values in the smallest unit, e.g. micro-cents). */
export interface SpendingPolicy {
  max_per_tx: number;
  max_daily: number;
  /** Unix timestamp when this mandate expires. Omit for no expiry. */
  expires_at?: number;
}

/** Per-secret access policy. */
export interface SecretPolicy {
  rate_limit: number;
  daily_limit: number;
  allowed_domains: string[];
}

/** Result of a policy check. */
export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/** Spending usage summary. */
export interface SpendingSummary {
  today: number;
  total_all_time: number;
}

// ---------------------------------------------------------------------------
// Backend communication types (Phase 9+)
// ---------------------------------------------------------------------------

/** Configuration for initializing the keymod with backend connection. */
export interface BackendConfig {
  /** Base URL of the Arysen backend (e.g. "https://api.arysen.ai"). */
  base_url: string;
  /** Agent UUID. */
  agent_id: string;
  /** Key ID of the worker keypair for signing requests. */
  worker_key_id: string;
  /** Key ID of the session keypair for signing transactions. */
  session_key_id: string;
}

/** Extended config for mandate_init — includes worker + session private keys.
 *  Private key fields are optional when using generateKeys() first. */
export interface InitConfig extends BackendConfig {
  /** Hex-encoded Ed25519 private key (32 bytes). Optional if generateKeys() was called. */
  worker_private_key_hex?: string;
  /** Hex-encoded secp256k1 private key (32 bytes). Optional if generateKeys() was called. */
  session_private_key_hex?: string;
}

/** Mandate info returned by GET /mandates/mine. */
export interface MandateInfo {
  mandate_id: string;
  max_per_tx: string;
  max_daily: string;
  daily_spent: number;
  wallet_address: string;
  expires_at: string;
  serialized_permission: string;
}

/** Result of a USDC transfer or DealOrder escrow. */
export interface TransferResult {
  tx_hash: string;
}

/** Parameters for creating a DealOrder. */
export interface DealOrderParams {
  executor_agent_id: string;
  bounty_amount: string;
  task_cid: string;
  delivery_deadline: number;
}

/** Options for initializing the ArysenKeymod instance. */
export interface KeymodOptions {
  /** Directory for encrypted key storage. Default: ~/.arysen/keys/ */
  storagePath?: string;
  /** HTTP request timeout in milliseconds. Default: 30000 */
  httpTimeout?: number;
  /** Override path to the wallet WASM pkg directory. */
  walletWasmPath?: string;
  /** Override path to the mandate WASM pkg directory. */
  mandateWasmPath?: string;
}

/** Parameters for agent registration with the Arysen backend. */
export interface RegisterAgentParams {
  /** Base URL of the Arysen backend (e.g. "http://localhost:4000/api/v1"). */
  base_url: string;
  /** Hex-encoded Ed25519 worker public key. */
  worker_pub_key: string;
  /** Hex-encoded secp256k1 session public key. */
  session_pub_key: string;
  /** Agent display name. */
  name: string;
  /** Optional agent description. */
  description?: string;
}

/** Result of agent registration. */
export interface RegisterAgentResult {
  id: string;
  name: string;
  status: string;
  wasm_hash_verified: boolean;
}
