/**
 * Secure Storage — agent-to-agent encrypted file exchange.
 *
 * Orchestrates the WASM storage pipeline (chunking, encryption, CID) with
 * the backend storage service (allocation, pre-signed URLs, completion).
 *
 * IMPORTANT: When uploading for a deal, use the encryption key from the deal
 * record, NOT the recipient's current key on the agent model. If the recipient
 * rotated after deal creation, the deal-time key is still correct — the
 * recipient can re-derive old keys from their BIP-32 seed.
 */

export interface StorageAllocation {
  id: string;
  prefix: string;
  max_mb: number;
  upload_window_hours: number;
  fee_paid: string;
  status: string;
  upload_expires_at: string;
  expires_at: string;
}

export interface UploadResult {
  root_cid: string;
  content_hash: string;
  allocation_id: string;
  chunk_count: number;
  total_bytes: number;
}

export interface DownloadResult {
  data: Uint8Array;
  root_cid: string;
  file_size: number;
  mime_type: string;
}

export interface StorageRateInfo {
  rate_per_gb: string;
  min_allocation_mb: number;
  max_allocation_mb: number;
  default_upload_window_hours: number;
  max_upload_window_hours: number;
  download_window_days: number;
}

export interface UploadOptions {
  /** Size in MB to allocate. If omitted, calculated from data length. */
  size_mb?: number;
  /** Upload window in hours. Default: 24. */
  upload_window_hours?: number;
  /** MIME type of the file. Default: "application/octet-stream". */
  mime_type?: string;
}

/**
 * Upload a file to secure storage.
 *
 * 1. Validates recipient has an encryption public key
 * 2. Calls WASM to chunk, encrypt, compute CIDs, build manifest
 * 3. Allocates storage on backend
 * 4. Uploads encrypted chunks + manifest to S3 via pre-signed URLs
 * 5. Marks allocation complete
 *
 * @param data - Raw file bytes
 * @param recipientPubKeyHex - Recipient's X25519 public key (64-char hex).
 *   For deal deliveries, use the key from the deal record, not the agent's current key.
 * @param baseUrl - Backend API base URL
 * @param agentAuthHeaders - Function returning Ed25519 auth headers for backend calls
 * @param opts - Upload options
 */
export async function uploadFile(
  data: Uint8Array,
  recipientPubKeyHex: string,
  baseUrl: string,
  agentAuthHeaders: (body: string) => Record<string, string>,
  opts?: UploadOptions,
): Promise<UploadResult> {
  if (!recipientPubKeyHex || recipientPubKeyHex.length !== 64) {
    throw new Error(
      'Recipient encryption public key is required (64-char hex). ' +
      'If the recipient has not set up secure storage, they must call registerEncryptionKey() first.',
    );
  }

  // TODO: Once WASM storage crate is built and linked:
  // 1. Call WASM storage_prepare_upload(data, recipientPubKey) → UploadBundle
  // 2. POST /storage/allocate → allocation
  // 3. GET /storage/:id/upload-urls → pre-signed URLs
  // 4. PUT each chunk to S3
  // 5. POST /storage/:id/complete
  // 6. Return { root_cid, content_hash, allocation_id, chunk_count, total_bytes }

  throw new Error('Storage WASM module not yet linked. Run wasm-pack build in keymod/storage first.');
}

/**
 * Download and decrypt a file from secure storage.
 *
 * 1. Gets download URLs from backend
 * 2. Downloads manifest + chunks from S3
 * 3. Calls WASM to verify CIDs, decrypt, reassemble
 *
 * @param rootCid - Root CID of the file
 * @param recipientSecretHex - Recipient's X25519 private key (64-char hex, derived from BIP-32 seed)
 * @param baseUrl - Backend API base URL
 * @param agentAuthHeaders - Function returning Ed25519 auth headers for backend calls
 * @param allocationId - Optional allocation ID (faster lookup than CID)
 */
export async function downloadFile(
  rootCid: string,
  recipientSecretHex: string,
  baseUrl: string,
  agentAuthHeaders: (body: string) => Record<string, string>,
  allocationId?: string,
): Promise<DownloadResult> {
  // TODO: Once WASM storage crate is built and linked:
  // 1. POST /storage/access → download URLs
  // 2. GET manifest from S3
  // 3. GET each chunk from S3
  // 4. Call WASM storage_process_download(manifest, chunks, recipientSecret)
  // 5. Return { data, root_cid, file_size, mime_type }

  throw new Error('Storage WASM module not yet linked. Run wasm-pack build in keymod/storage first.');
}

/**
 * Register the agent's encryption public key with the backend.
 * This must be called before the agent can receive encrypted deliveries.
 *
 * @param encryptionPubKeyHex - X25519 public key (64-char hex)
 * @param baseUrl - Backend API base URL
 * @param agentAuthHeaders - Function returning Ed25519 auth headers
 */
export async function registerEncryptionKey(
  encryptionPubKeyHex: string,
  baseUrl: string,
  agentAuthHeaders: (body: string) => Record<string, string>,
): Promise<void> {
  if (!encryptionPubKeyHex || encryptionPubKeyHex.length !== 64) {
    throw new Error('Encryption public key must be 64-char hex');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/agents/me`;
  const body = JSON.stringify({ encryption_pub_key: encryptionPubKeyHex });
  const headers = agentAuthHeaders(body);

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

  if (!response.ok) {
    const json = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(json.message ?? `Failed to register encryption key (${response.status})`);
  }
}

/**
 * Get the current storage rate from the backend.
 */
export async function getStorageRate(baseUrl: string): Promise<StorageRateInfo> {
  const url = `${baseUrl.replace(/\/+$/, '')}/storage/rate`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get storage rate (${response.status})`);
  }
  const json = await response.json() as { success: boolean; data: StorageRateInfo };
  return json.data;
}
