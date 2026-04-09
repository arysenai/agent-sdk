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

import type { ArysenKeymod } from './index.js';

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
 * @param keymod - ArysenKeymod instance (provides WASM storage pipeline)
 * @param data - Raw file bytes
 * @param recipientPubKeyHex - Recipient's X25519 public key (64-char hex).
 *   For deal deliveries, use the key from the deal record, not the agent's current key.
 * @param baseUrl - Backend API base URL
 * @param agentAuthHeaders - Function returning Ed25519 auth headers for backend calls
 * @param opts - Upload options
 */
export async function uploadFile(
  keymod: ArysenKeymod,
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

  const mimeType = opts?.mime_type ?? 'application/octet-stream';

  // 1. WASM: chunk, encrypt, compute CIDs, build manifest
  const bundle = keymod.storagePrepareUpload(data, recipientPubKeyHex, undefined, mimeType);

  // 2. Calculate total encrypted size (chunks + manifest)
  let totalBytes = bundle.manifest_bytes.length;
  for (const [, chunkBytes] of bundle.chunks) {
    totalBytes += chunkBytes.length;
  }
  const sizeMb = opts?.size_mb ?? Math.max(1, Math.ceil(totalBytes / (1024 * 1024)));

  // 3. Backend: allocate storage
  const apiBase = baseUrl.replace(/\/+$/, '');
  const allocBody = JSON.stringify({
    size_mb: sizeMb,
    upload_window_hours: opts?.upload_window_hours ?? 24,
    mime_type: mimeType,
  });
  const allocRes = await fetch(`${apiBase}/storage/allocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...agentAuthHeaders(allocBody) },
    body: allocBody,
  });
  const allocJson = await allocRes.json() as { success: boolean; data?: StorageAllocation; message?: string };
  if (!allocRes.ok || !allocJson.success) {
    throw new Error(allocJson.message ?? `Storage allocation failed (${allocRes.status})`);
  }
  const allocation = allocJson.data!;

  // 4. Backend: get pre-signed upload URLs
  const chunkKeys = bundle.chunks.map(([cid]) => cid);
  chunkKeys.push('_manifest.json'); // manifest key
  const keysParam = encodeURIComponent(chunkKeys.join(','));
  const urlsRes = await fetch(`${apiBase}/storage/${allocation.id}/upload-urls?keys=${keysParam}`, {
    headers: agentAuthHeaders(''),
  });
  const urlsJson = await urlsRes.json() as { success: boolean; data?: { prefix: string; keys: string[]; urls?: Record<string, string> }; message?: string };
  if (!urlsRes.ok || !urlsJson.success) {
    throw new Error(urlsJson.message ?? `Failed to get upload URLs (${urlsRes.status})`);
  }

  // 5. Upload chunks + manifest via pre-signed URLs (or direct if available)
  const uploadUrls = urlsJson.data?.urls;
  if (uploadUrls) {
    // Real S3 pre-signed URLs available
    for (const [cid, chunkBytes] of bundle.chunks) {
      const url = uploadUrls[cid];
      if (!url) throw new Error(`No upload URL for chunk ${cid}`);
      const res = await fetch(url, { method: 'PUT', body: new Uint8Array(chunkBytes) });
      if (!res.ok) throw new Error(`S3 upload failed for chunk ${cid} (${res.status})`);
    }
    // Upload manifest
    const manifestUrl = uploadUrls['_manifest.json'];
    if (!manifestUrl) throw new Error('No upload URL for manifest');
    const res = await fetch(manifestUrl, { method: 'PUT', body: new Uint8Array(bundle.manifest_bytes) });
    if (!res.ok) throw new Error(`S3 upload failed for manifest (${res.status})`);
  }
  // If no pre-signed URLs (dev mode), skip S3 upload — backend stores metadata only

  // 6. Backend: mark allocation complete
  const completeBody = JSON.stringify({
    used_bytes: totalBytes,
    root_cid: bundle.root_cid,
  });
  const completeRes = await fetch(`${apiBase}/storage/${allocation.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...agentAuthHeaders(completeBody) },
    body: completeBody,
  });
  const completeJson = await completeRes.json() as { success: boolean; message?: string };
  if (!completeRes.ok || !completeJson.success) {
    throw new Error(completeJson.message ?? `Storage completion failed (${completeRes.status})`);
  }

  return {
    root_cid: bundle.root_cid,
    content_hash: bundle.content_hash,
    allocation_id: allocation.id,
    chunk_count: bundle.chunks.length,
    total_bytes: totalBytes,
  };
}

/**
 * Download and decrypt a file from secure storage.
 *
 * 1. Wraps the decryption key inside WASM (private key never enters JS)
 * 2. Gets download access from backend
 * 3. Downloads manifest + chunks from S3 via pre-signed URLs
 * 4. Passes wrapped key to storage WASM for decryption
 *
 * @param keymod - ArysenKeymod instance (provides WASM storage pipeline)
 * @param rootCid - Root CID of the file
 * @param funcKeyId - Functionality key ID (from generateFunctionalityKey)
 * @param rotationIndex - BIP-32 rotation index (0 = current key)
 * @param baseUrl - Backend API base URL
 * @param agentAuthHeaders - Function returning Ed25519 auth headers for backend calls
 * @param allocationId - Optional allocation ID (faster lookup than CID)
 */
export async function downloadFile(
  keymod: ArysenKeymod,
  rootCid: string,
  funcKeyId: string,
  rotationIndex: number,
  baseUrl: string,
  agentAuthHeaders: (body: string) => Record<string, string>,
  allocationId?: string,
): Promise<DownloadResult> {
  const apiBase = baseUrl.replace(/\/+$/, '');

  // 1. Backend: request download access
  const accessBody = JSON.stringify(
    allocationId ? { allocation_id: allocationId } : { root_cid: rootCid },
  );
  const accessRes = await fetch(`${apiBase}/storage/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...agentAuthHeaders(accessBody) },
    body: accessBody,
  });
  const accessJson = await accessRes.json() as {
    success: boolean;
    data?: { prefix: string; root_cid: string; urls?: Record<string, string> };
    message?: string;
  };
  if (!accessRes.ok || !accessJson.success) {
    throw new Error(accessJson.message ?? `Storage access failed (${accessRes.status})`);
  }
  const access = accessJson.data!;
  const downloadUrls = access.urls;

  if (!downloadUrls) {
    throw new Error(
      'Download URLs not available. S3 pre-signed URL generation is not yet configured on the backend.',
    );
  }

  // 2. Download manifest
  const manifestUrl = downloadUrls['_manifest.json'];
  if (!manifestUrl) throw new Error('No download URL for manifest');
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) throw new Error(`Failed to download manifest (${manifestRes.status})`);
  const manifestBytes = new Uint8Array(await manifestRes.arrayBuffer());

  // Parse manifest to get chunk CIDs
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    chunk_cids: string[];
    file_size: number;
    mime_type: string;
  };

  // 3. Download chunks in order
  const chunks: Array<[string, number[]]> = [];
  for (const cid of manifest.chunk_cids) {
    const chunkUrl = downloadUrls[cid];
    if (!chunkUrl) throw new Error(`No download URL for chunk ${cid}`);
    const chunkRes = await fetch(chunkUrl);
    if (!chunkRes.ok) throw new Error(`Failed to download chunk ${cid} (${chunkRes.status})`);
    const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());
    chunks.push([cid, Array.from(chunkBytes)]);
  }

  // 4. Wrap decryption key (wallet → storage, private key never enters JS)
  const wrappedKey = keymod.wrapDecryptionKey(funcKeyId, rotationIndex);

  // 5. WASM: verify CIDs, decrypt, reassemble (using wrapped key)
  const decrypted = keymod.storageProcessDownload(manifestBytes, chunks, wrappedKey);

  return {
    data: decrypted,
    root_cid: access.root_cid,
    file_size: manifest.file_size,
    mime_type: manifest.mime_type,
  };
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
