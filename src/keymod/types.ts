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
  max_monthly: number;
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
  this_month: number;
  total_all_time: number;
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
