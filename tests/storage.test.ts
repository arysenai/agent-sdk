/**
 * Secure Storage integration tests.
 *
 * Group 1: WASM pipeline tests — pure crypto, no network.
 * Group 2: Backend integration — requires local backend on port 4000.
 *
 * To run only WASM tests:  pnpm vitest run tests/storage.test.ts -t "WASM"
 * To run all:              pnpm vitest run tests/storage.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';

import { ArysenKeymod } from '../src/keymod/index.js';
import { loadStorageModule } from '../src/keymod/loader.js';
import { getStorageRate, uploadFile } from '../src/keymod/storage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = 'http://localhost:4000/api/v1';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Build Ed25519 auth headers for agent API calls.
 *
 * The backend builds the signed message as: JSON.stringify(req.body) + nonce + timestamp.
 * For POST with JSON body, pass the raw JSON string.
 * For GET requests (no body), Express parses body as {} → JSON.stringify({}) = "{}".
 * So callers should pass '' for GET, which we map to '{}' to match the backend.
 */
function makeAgentAuthHeaders(
  keymod: ArysenKeymod,
  agentId: string,
  workerKeyId: string,
) {
  return (body: string): Record<string, string> => {
    // For GET requests or empty body, Express sees req.body = undefined.
    // buildMessage calls JSON.stringify(undefined) which returns JS undefined,
    // then template literal produces the string "undefined".
    const effectiveBody = body === '' ? 'undefined' : body;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const message = effectiveBody + nonce + timestamp;
    const msgBytes = new TextEncoder().encode(message);
    const sig = keymod.signWorker(msgBytes, workerKeyId);
    return {
      'X-ARYSEN-Agent-ID': agentId,
      'X-ARYSEN-Signature': bytesToHex(sig),
      'X-ARYSEN-Nonce': nonce,
      'X-ARYSEN-Timestamp': timestamp,
    };
  };
}

// ---------------------------------------------------------------------------
// Group 1: WASM Pipeline Tests (no backend)
// ---------------------------------------------------------------------------

describe('WASM storage pipeline', () => {
  let keymod: ArysenKeymod;

  beforeAll(async () => {
    keymod = await ArysenKeymod.init();
  });

  it('loader exports storage module with correct functions', () => {
    const { storage, hash } = loadStorageModule();
    expect(typeof storage.storage_prepare_upload).toBe('function');
    expect(typeof storage.storage_process_download).toBe('function');
    expect(typeof storage.storage_default_chunk_size).toBe('function');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('default chunk size is 512KB', () => {
    expect(keymod.getDefaultChunkSize()).toBe(512 * 1024);
  });

  it('prepares a small file for upload', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('hello secure storage!');

    const bundle = keymod.storagePrepareUpload(data, pubHex);

    expect(bundle.chunks.length).toBe(1);
    expect(bundle.root_cid).toMatch(/^baf/);
    expect(bundle.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.manifest_bytes.length).toBeGreaterThan(0);
  });

  it('multi-chunk file produces correct chunk count', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz0123456789'); // 36 bytes

    const bundle = keymod.storagePrepareUpload(data, pubHex, 10, 'text/plain');

    expect(bundle.chunks.length).toBe(4); // 36 / 10 = 4 chunks
    for (const [cid] of bundle.chunks) {
      expect(cid).toMatch(/^baf/);
    }
  });

  it('rejects invalid recipient public key', () => {
    const data = new TextEncoder().encode('test');
    expect(() => keymod.storagePrepareUpload(data, 'tooshort')).toThrow();
    expect(() => keymod.storagePrepareUpload(data, 'zz'.repeat(32))).toThrow();
  });

  it('each encryption produces unique output (ephemeral key)', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('ephemeral key test');

    const b1 = keymod.storagePrepareUpload(data, pubHex);
    const b2 = keymod.storagePrepareUpload(data, pubHex);

    // Different ephemeral keys → different encrypted chunks → different CIDs
    expect(b1.root_cid).not.toBe(b2.root_cid);
    expect(b1.content_hash).not.toBe(b2.content_hash);
  });

  it('content hash is 32 bytes (64 hex chars)', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const bundle = keymod.storagePrepareUpload(
      new TextEncoder().encode('hash test'),
      pubHex,
    );
    expect(bundle.content_hash.length).toBe(64);
  });

  it('full roundtrip: prepare → wrap key → process', () => {
    // With wrapped key flow, we can do a proper end-to-end roundtrip!
    // The wallet wraps the private key for the storage module — no raw
    // secret ever enters JavaScript.
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);

    const data = new TextEncoder().encode('full roundtrip via wrapped key!');
    const bundle = keymod.storagePrepareUpload(data, pubHex, undefined, 'text/plain');

    // Wrap the decryption key (wallet → storage, sealed-box)
    const wrappedKey = keymod.wrapDecryptionKey(funcKey.key_id, 0);
    expect(wrappedKey.length).toBe(184); // 92 bytes hex-encoded

    // Decrypt with wrapped key
    const decrypted = keymod.storageProcessDownload(
      new Uint8Array(bundle.manifest_bytes),
      bundle.chunks,
      wrappedKey,
    );

    expect(decrypted).toEqual(data);
  });

  it('process rejects wrong wrapped key', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('wrong key test');

    const bundle = keymod.storagePrepareUpload(data, pubHex, undefined, 'text/plain');

    // Wrap a DIFFERENT key (different func key)
    const otherFuncKey = keymod.generateFunctionalityKey();
    const wrongWrapped = keymod.wrapDecryptionKey(otherFuncKey.key_id, 0);

    expect(() => {
      keymod.storageProcessDownload(
        new Uint8Array(bundle.manifest_bytes),
        bundle.chunks,
        wrongWrapped,
      );
    }).toThrow();
  });

  it('process rejects tampered wrapped key', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('tamper detection');

    const bundle = keymod.storagePrepareUpload(data, pubHex, undefined, 'text/plain');
    const wrappedKey = keymod.wrapDecryptionKey(funcKey.key_id, 0);

    // Tamper with the wrapped key blob
    const tampered = wrappedKey.slice(0, -4) + 'ffff';

    expect(() => {
      keymod.storageProcessDownload(
        new Uint8Array(bundle.manifest_bytes),
        bundle.chunks,
        tampered,
      );
    }).toThrow();
  });

  it('process rejects garbage wrapped key', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('garbage key');

    const bundle = keymod.storagePrepareUpload(data, pubHex, undefined, 'text/plain');

    expect(() => {
      keymod.storageProcessDownload(
        new Uint8Array(bundle.manifest_bytes),
        bundle.chunks,
        'aa'.repeat(92), // random 92 bytes
      );
    }).toThrow();
  });

  it('key rotation: different indices produce different pubkeys', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pub0 = keymod.deriveEncryptionPubkey(funcKey.key_id, 0);
    const pub1 = keymod.deriveEncryptionPubkey(funcKey.key_id, 1);
    const pub2 = keymod.deriveEncryptionPubkey(funcKey.key_id, 2);

    expect(pub0.length).toBe(64);
    expect(pub1.length).toBe(64);
    expect(pub2.length).toBe(64);
    expect(pub0).not.toBe(pub1);
    expect(pub1).not.toBe(pub2);
    expect(pub0).not.toBe(pub2);
  });

  it('re-deriving same index gives same pubkey', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const pub0a = keymod.deriveEncryptionPubkey(funcKey.key_id, 0);
    const pub0b = keymod.deriveEncryptionPubkey(funcKey.key_id, 0);
    expect(pub0a).toBe(pub0b);
  });

  it('getEncryptionPubkey returns same as deriveEncryptionPubkey(id, 0)', () => {
    const funcKey = keymod.generateFunctionalityKey();
    const current = keymod.getEncryptionPubkey(funcKey.key_id);
    const derived = keymod.deriveEncryptionPubkey(funcKey.key_id, 0);
    expect(current).toBe(derived);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Backend Integration Tests (requires local backend)
// ---------------------------------------------------------------------------

describe('storage backend integration', () => {
  let keymod: ArysenKeymod;
  let agentId: string;
  let workerKeyId: string;
  let authHeaders: (body: string) => Record<string, string>;
  let backendAvailable = false;

  beforeAll(async () => {
    // Check if backend is running
    try {
      const res = await fetch(`${API_BASE}/storage/rate`);
      backendAvailable = res.ok;
    } catch {
      backendAvailable = false;
    }

    if (!backendAvailable) return;

    // Set up keymod with wallet-level keys (mandate_sign_worker_registration
    // is not yet implemented in the mandate crate, so we register the agent
    // directly via the DB using a signed POST to the register endpoint).
    keymod = await ArysenKeymod.init();
    const workerKey = keymod.generateWorkerKeyWithSecret();
    workerKeyId = workerKey.key_id;

    // Backend requireHexKey expects exactly 64 hex chars for both keys.
    // Ed25519 worker key is 64 chars. secp256k1 session key is 66 chars (compressed).
    // For storage tests we don't need a real session key, so use a dummy 64-char hex.
    const dummySessionBytes = new Uint8Array(32);
    crypto.getRandomValues(dummySessionBytes);
    const dummySessionPubKey = bytesToHex(dummySessionBytes);

    // Register agent by hitting the backend directly with Ed25519 signature.
    // This mirrors requireRegisterAuth: sign(body + nonce + timestamp) with worker key.
    const bodyObj = {
      worker_pub_key: workerKey.pub_key,
      session_pub_key: dummySessionPubKey,
      name: `storage-test-${Date.now()}`,
      description: 'Integration test agent for secure storage',
    };
    const body = JSON.stringify(bodyObj);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const message = body + nonce + timestamp;
    const sig = keymod.signWorker(new TextEncoder().encode(message), workerKeyId);

    const regRes = await fetch(`${API_BASE}/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ARYSEN-Signature': bytesToHex(sig),
        'X-ARYSEN-Nonce': nonce,
        'X-ARYSEN-Timestamp': timestamp,
      },
      body,
    });
    const regJson = await regRes.json() as { success: boolean; data?: { id: string }; message?: string };
    if (!regRes.ok || !regJson.success) {
      throw new Error(`Agent registration failed: ${regJson.message ?? regRes.status}`);
    }
    agentId = regJson.data!.id;

    authHeaders = makeAgentAuthHeaders(keymod, agentId, workerKeyId);
  });

  it('getStorageRate returns valid rate info', async () => {
    if (!backendAvailable) return;

    const rate = await getStorageRate(API_BASE);
    expect(rate.rate_per_gb).toBeDefined();
    expect(rate.min_allocation_mb).toBe(1);
    expect(rate.max_upload_window_hours).toBe(168);
    expect(rate.download_window_days).toBe(7);
  });

  it('allocate storage returns allocation with valid fields', async () => {
    if (!backendAvailable) return;

    const body = JSON.stringify({ size_mb: 1, upload_window_hours: 24 });
    const res = await fetch(`${API_BASE}/storage/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(body) },
      body,
    });

    expect(res.ok).toBe(true);
    const json = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data.id).toBeDefined();
    expect(json.data.prefix).toBeDefined();
    expect(json.data.status).toBe('active');
    expect(json.data.max_mb).toBe(1);
    expect(json.data.upload_expires_at).toBeDefined();
    expect(json.data.expires_at).toBeDefined();
  });

  it('get upload URLs returns keys for the allocation', async () => {
    if (!backendAvailable) return;

    // First allocate
    const allocBody = JSON.stringify({ size_mb: 1, upload_window_hours: 24 });
    const allocRes = await fetch(`${API_BASE}/storage/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(allocBody) },
      body: allocBody,
    });
    const allocJson = await allocRes.json() as { data: { id: string } };
    const allocationId = allocJson.data.id;

    // Get upload URLs
    const keys = 'chunk1.bin,chunk2.bin,_manifest.json';
    const urlsRes = await fetch(
      `${API_BASE}/storage/${allocationId}/upload-urls?keys=${encodeURIComponent(keys)}`,
      { headers: authHeaders('') },
    );

    expect(urlsRes.ok).toBe(true);
    const urlsJson = await urlsRes.json() as { success: boolean; data: { keys: string[] } };
    expect(urlsJson.success).toBe(true);
    expect(urlsJson.data.keys).toEqual(['chunk1.bin', 'chunk2.bin', '_manifest.json']);
  });

  it('complete allocation updates status', async () => {
    if (!backendAvailable) return;

    // Allocate
    const allocBody = JSON.stringify({ size_mb: 1, upload_window_hours: 24 });
    const allocRes = await fetch(`${API_BASE}/storage/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(allocBody) },
      body: allocBody,
    });
    const allocJson = await allocRes.json() as { data: { id: string } };
    const allocationId = allocJson.data.id;

    // Complete
    const completeBody = JSON.stringify({
      used_bytes: 1024,
      root_cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenera',
    });
    const completeRes = await fetch(`${API_BASE}/storage/${allocationId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(completeBody) },
      body: completeBody,
    });

    expect(completeRes.ok).toBe(true);
    const completeJson = await completeRes.json() as { success: boolean; data: { status: string; used_bytes: number } };
    expect(completeJson.success).toBe(true);
    expect(completeJson.data.status).toBe('completed');
  });

  it('uploadFile with null recipientPubKey throws clear error', async () => {
    if (!backendAvailable) return;

    const data = new TextEncoder().encode('test');
    await expect(
      uploadFile(keymod, data, '', API_BASE, authHeaders),
    ).rejects.toThrow('Recipient encryption public key is required');
  });

  it('full uploadFile flow: allocate → complete (S3 skipped in dev)', async () => {
    if (!backendAvailable) return;

    // Generate encryption key for recipient
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);

    const data = new TextEncoder().encode('Hello from secure storage integration test!');

    const result = await uploadFile(keymod, data, pubHex, API_BASE, authHeaders, {
      mime_type: 'text/plain',
    });

    expect(result.root_cid).toMatch(/^baf/);
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.allocation_id).toBeDefined();
    expect(result.chunk_count).toBe(1);
    expect(result.total_bytes).toBeGreaterThan(data.length); // encrypted > plaintext
  });

  it('access endpoint returns allocation info by root CID', async () => {
    if (!backendAvailable) return;

    // Upload first
    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('access test file');

    const upload = await uploadFile(keymod, data, pubHex, API_BASE, authHeaders);

    // Access by root CID
    const accessBody = JSON.stringify({ root_cid: upload.root_cid });
    const accessRes = await fetch(`${API_BASE}/storage/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessBody) },
      body: accessBody,
    });

    expect(accessRes.ok).toBe(true);
    const accessJson = await accessRes.json() as { success: boolean; data: { root_cid: string } };
    expect(accessJson.success).toBe(true);
    expect(accessJson.data.root_cid).toBe(upload.root_cid);
  });

  it('access endpoint returns allocation info by allocation ID', async () => {
    if (!backendAvailable) return;

    const funcKey = keymod.generateFunctionalityKey();
    const pubHex = keymod.getEncryptionPubkey(funcKey.key_id);
    const data = new TextEncoder().encode('access by id test');

    const upload = await uploadFile(keymod, data, pubHex, API_BASE, authHeaders);

    // Access by allocation ID
    const accessBody = JSON.stringify({ allocation_id: upload.allocation_id });
    const accessRes = await fetch(`${API_BASE}/storage/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(accessBody) },
      body: accessBody,
    });

    expect(accessRes.ok).toBe(true);
    const accessJson = await accessRes.json() as { success: boolean; data: { allocation_id: string } };
    expect(accessJson.success).toBe(true);
    expect(accessJson.data.allocation_id).toBe(upload.allocation_id);
  });
});
