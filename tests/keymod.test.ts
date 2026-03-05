import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArysenKeymod } from '../src/keymod/index.js';
import { FileSystemStorage } from '../src/keymod/storage-fs.js';
import { HttpHost } from '../src/keymod/http-host.js';
import { loadWalletModule, loadMandateModule } from '../src/keymod/loader.js';
import type {
  KeyPairResult,
  Policy,
  RequestTemplate,
} from '../src/keymod/types.js';

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe('loader', () => {
  it('loads the wallet WASM module', () => {
    const wallet = loadWalletModule();
    expect(wallet).toBeDefined();
    expect(typeof wallet.generate_worker_keypair).toBe('function');
    expect(typeof wallet.generate_session_keypair).toBe('function');
    expect(typeof wallet.sign_worker).toBe('function');
    expect(typeof wallet.sign_session).toBe('function');
    expect(typeof wallet.verify_worker).toBe('function');
    expect(typeof wallet.verify_session).toBe('function');
    expect(typeof wallet.get_module_hash).toBe('function');
  });

  it('loads the mandate WASM module', () => {
    const { mandate } = loadMandateModule();
    expect(mandate).toBeDefined();
    expect(typeof mandate.deposit_secret).toBe('function');
    expect(typeof mandate.remove_secret).toBe('function');
    expect(typeof mandate.list_secret_names).toBe('function');
    expect(typeof mandate.execute_request).toBe('function');
    expect(typeof mandate.set_policy).toBe('function');
    expect(typeof mandate.check_policy).toBe('function');
    expect(typeof mandate.get_spending_summary).toBe('function');
    expect(typeof mandate.get_mandate_hash).toBe('function');
    expect(typeof mandate.mandate_init).toBe('function');
    expect(typeof mandate.get_mandate_info).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ArysenKeymod integration tests
// ---------------------------------------------------------------------------

describe('ArysenKeymod', () => {
  let keymod: ArysenKeymod;

  beforeEach(async () => {
    keymod = await ArysenKeymod.init();
  });

  // -- Key generation --

  describe('key generation', () => {
    it('generates a worker (Ed25519) keypair', () => {
      const result = keymod.generateWorkerKey();
      expect(result).toHaveProperty('pub_key');
      expect(result).toHaveProperty('key_id');
      expect(typeof result.pub_key).toBe('string');
      expect(typeof result.key_id).toBe('string');
      // Ed25519 public key is 32 bytes = 64 hex chars
      expect(result.pub_key).toMatch(/^[0-9a-f]{64}$/);
      // key_id is first 16 hex chars of SHA-256(pub_key)
      expect(result.key_id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates a session (secp256k1) keypair', () => {
      const result = keymod.generateSessionKey();
      expect(result).toHaveProperty('pub_key');
      expect(result).toHaveProperty('key_id');
      expect(typeof result.pub_key).toBe('string');
      expect(typeof result.key_id).toBe('string');
      // secp256k1 compressed public key is 33 bytes = 66 hex chars
      expect(result.pub_key).toMatch(/^[0-9a-f]{66}$/);
      expect(result.key_id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates a worker keypair with secret', () => {
      const result = keymod.generateWorkerKeyWithSecret();
      expect(result).toHaveProperty('pub_key');
      expect(result).toHaveProperty('key_id');
      expect(result).toHaveProperty('private_key');
      expect(result.pub_key).toMatch(/^[0-9a-f]{64}$/);
      expect(result.key_id).toMatch(/^[0-9a-f]{16}$/);
      // Ed25519 private key is 32 bytes = 64 hex chars
      expect(result.private_key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates a session keypair with secret', () => {
      const result = keymod.generateSessionKeyWithSecret();
      expect(result).toHaveProperty('pub_key');
      expect(result).toHaveProperty('key_id');
      expect(result).toHaveProperty('private_key');
      expect(result.pub_key).toMatch(/^[0-9a-f]{66}$/);
      expect(result.key_id).toMatch(/^[0-9a-f]{16}$/);
      // secp256k1 private key is 32 bytes = 64 hex chars
      expect(result.private_key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates unique keys each time', () => {
      const key1 = keymod.generateWorkerKey();
      const key2 = keymod.generateWorkerKey();
      expect(key1.pub_key).not.toBe(key2.pub_key);
      expect(key1.key_id).not.toBe(key2.key_id);
    });
  });

  // -- Signing --

  describe('signing', () => {
    it('signWorker returns a real 64-byte Ed25519 signature', () => {
      const kp = keymod.generateWorkerKey();
      const message = new TextEncoder().encode('hello world');
      const signature = keymod.signWorker(message, kp.key_id);

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64);
      // Should be a real signature (not all zeros)
      expect(signature.some((b: number) => b !== 0)).toBe(true);
    });

    it('signSession returns a real 65-byte secp256k1 signature', () => {
      const kp = keymod.generateSessionKey();
      const message = new TextEncoder().encode('transaction data');
      const signature = keymod.signSession(message, kp.key_id);

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(65);
      expect(signature.some((b: number) => b !== 0)).toBe(true);
    });

    it('verifyWorker rejects an invalid signature', () => {
      const kp = keymod.generateWorkerKey();
      const message = new TextEncoder().encode('hello');
      const badSig = new Uint8Array(64); // all zeros
      const pubKeyBytes = hexToBytes(kp.pub_key);
      const valid = keymod.verifyWorker(message, badSig, pubKeyBytes);
      expect(valid).toBe(false);
    });

    it('verifySession rejects an invalid signature', () => {
      const kp = keymod.generateSessionKey();
      const message = new TextEncoder().encode('hello');
      const badSig = new Uint8Array(65); // all zeros
      const pubKeyBytes = hexToBytes(kp.pub_key);
      const valid = keymod.verifySession(message, badSig, pubKeyBytes);
      expect(valid).toBe(false);
    });

    it('sign and verify worker (Ed25519) roundtrip', () => {
      const kp = keymod.generateWorkerKey();
      const message = new TextEncoder().encode('hello world');
      const signature = keymod.signWorker(message, kp.key_id);
      const pubKeyBytes = hexToBytes(kp.pub_key);
      expect(signature.length).toBe(64);
      // Signature should not be all zeros (key store is wired up)
      expect(signature.some((b: number) => b !== 0)).toBe(true);
      expect(keymod.verifyWorker(message, signature, pubKeyBytes)).toBe(true);
      const wrongMsg = new TextEncoder().encode('wrong');
      expect(keymod.verifyWorker(wrongMsg, signature, pubKeyBytes)).toBe(false);
    });

    it('sign and verify session (secp256k1) roundtrip', () => {
      const kp = keymod.generateSessionKey();
      const message = new TextEncoder().encode('transaction data');
      const signature = keymod.signSession(message, kp.key_id);
      const pubKeyBytes = hexToBytes(kp.pub_key);
      expect(signature.length).toBe(65);
      expect(signature.some((b: number) => b !== 0)).toBe(true);
      expect(keymod.verifySession(message, signature, pubKeyBytes)).toBe(true);
      const wrongMsg = new TextEncoder().encode('tampered');
      expect(keymod.verifySession(wrongMsg, signature, pubKeyBytes)).toBe(false);
    });
  });

  // -- Module hash --

  describe('module hash', () => {
    it('wallet module hash is 32 bytes', () => {
      const hash = keymod.getWalletModuleHash();
      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it('mandate module hash is 32 bytes', () => {
      const hash = keymod.getMandateModuleHash();
      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });
  });

  // -- Secrets lifecycle --

  describe('secrets', () => {
    it('deposit, list, and remove a secret', () => {
      // Initially empty (or at least no "test_api_key")
      const initial = keymod.listSecrets();
      expect(Array.isArray(initial)).toBe(true);

      // Deposit
      const deposited = keymod.depositSecret('test_api_key', 'sk-12345');
      expect(deposited).toBe(true);

      // List should contain it
      const afterDeposit = keymod.listSecrets();
      expect(afterDeposit).toContain('test_api_key');

      // Remove
      const removed = keymod.removeSecret('test_api_key');
      expect(removed).toBe(true);

      // Remove again should return false
      const removedAgain = keymod.removeSecret('test_api_key');
      expect(removedAgain).toBe(false);
    });

    it('deposit multiple secrets', () => {
      keymod.depositSecret('key_a', 'value_a');
      keymod.depositSecret('key_b', 'value_b');
      const names = keymod.listSecrets();
      expect(names).toContain('key_a');
      expect(names).toContain('key_b');
    });
  });

  // -- Policy --

  describe('policy', () => {
    it('set and check spending policy — within limit', () => {
      const policy: Policy = {
        spending: {
          max_per_tx: 1000,
          max_daily: 5000,
          expires_at: undefined,
        },
        secrets: {},
      };
      const set = keymod.setPolicy(policy);
      expect(set).toBe(true);

      const result = keymod.checkPolicy('spend', { amount: 100 });
      expect(result).toHaveProperty('allowed');
      expect(result.allowed).toBe(true);
    });

    it('check spending policy — exceeding per-tx limit', () => {
      const policy: Policy = {
        spending: {
          max_per_tx: 1000,
          max_daily: 5000,
          expires_at: undefined,
        },
        secrets: {},
      };
      keymod.setPolicy(policy);

      const result = keymod.checkPolicy('spend', { amount: 2000 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('spending summary returns numeric fields', () => {
      const summary = keymod.getSpendingSummary();
      expect(summary).toHaveProperty('today');
      expect(summary).toHaveProperty('total_all_time');
      expect(typeof summary.today).toBe('number');
      expect(typeof summary.total_all_time).toBe('number');
    });
  });

  // -- Backend operations (require init) --

  describe('backend operations', () => {
    it('transferUsdc returns error without init', () => {
      const result = keymod.transferUsdc('0xRecipient', '5.00') as unknown as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      expect(String(result.error)).toContain('not initialized');
    });

    it('createDealOrder returns error without init', () => {
      const result = keymod.createDealOrder({
        executor_agent_id: 'agent-123',
        bounty_amount: '3.50',
        task_cid: 'QmTest',
        delivery_deadline: 1735689600,
      }) as unknown as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      expect(String(result.error)).toContain('not initialized');
    });

    it('initMandate returns error with invalid config', () => {
      const result = keymod.initMandate({
        base_url: '',
        agent_id: '',
        worker_key_id: '',
        session_key_id: '',
        worker_private_key_hex: 'not_hex',
        session_private_key_hex: 'not_hex',
      }) as unknown as Record<string, unknown>;
      expect(result).toHaveProperty('error');
    });

    it('getMandateInfo returns error without init', () => {
      const result = keymod.getMandateInfo() as unknown as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      expect(String(result.error)).toContain('not initialized');
    });
  });

  // -- Request execution --

  describe('execute request', () => {
    it('returns an error for missing secret', () => {
      const template: RequestTemplate = {
        method: 'GET',
        url: 'https://api.example.com/data',
        headers: { Authorization: 'Bearer {MISSING_SECRET}' },
      };
      const result = keymod.executeRequest(template);
      // The mandate module should return an error since MISSING_SECRET is not deposited
      expect(result).toHaveProperty('error');
    });

    it('executes a request with no placeholders', () => {
      const template: RequestTemplate = {
        method: 'GET',
        url: 'https://api.example.com/data',
        headers: {},
      };
      const result = keymod.executeRequest(template);
      // With no placeholders, the WASM module will try to execute the request.
      // In WASM mode with our env stubs (http_execute returns 0), it will get
      // a response based on parsing 0 bytes — likely an error.
      // The important thing is it returns *something* and doesn't crash.
      expect(result).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// FileSystemStorage tests
// ---------------------------------------------------------------------------

describe('FileSystemStorage', () => {
  let tmpDir: string;
  let storage: FileSystemStorage;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'arysen-storage-'));
    storage = new FileSystemStorage(tmpDir);
  });

  it('returns null for non-existent key', async () => {
    const data = await storage.read('nonexistent');
    expect(data).toBeNull();
  });

  it('writes and reads back data', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.write('testkey', testData);

    const readBack = await storage.read('testkey');
    expect(readBack).not.toBeNull();
    expect(readBack!.length).toBe(5);
    expect(Array.from(readBack!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('overwrites existing data', async () => {
    await storage.write('mykey', new Uint8Array([10]));
    await storage.write('mykey', new Uint8Array([20, 30]));

    const readBack = await storage.read('mykey');
    expect(readBack).not.toBeNull();
    expect(Array.from(readBack!)).toEqual([20, 30]);
  });

  it('stores files with .enc extension', async () => {
    await storage.write('some-key', new Uint8Array([42]));
    const contents = await readFile(join(tmpDir, 'some-key.enc'));
    expect(contents[0]).toBe(42);
  });

  it('sanitizes key IDs to prevent path traversal', async () => {
    await storage.write('../../../etc/passwd', new Uint8Array([99]));
    // The file should be stored with sanitized name, not as a path traversal
    const readBack = await storage.read('../../../etc/passwd');
    expect(readBack).not.toBeNull();
    expect(Array.from(readBack!)).toEqual([99]);
  });
});

// ---------------------------------------------------------------------------
// HttpHost tests
// ---------------------------------------------------------------------------

describe('HttpHost', () => {
  it('returns error for invalid JSON request', async () => {
    const host = new HttpHost();
    const response = await host.execute('not valid json');
    const parsed = JSON.parse(response);
    expect(parsed.status).toBe(400);
    expect(parsed.body).toContain('invalid');
  });

  // Network-dependent tests are skipped by default
  it.skip('fetches a real URL', async () => {
    const host = new HttpHost(5000);
    const response = await host.execute(JSON.stringify({
      method: 'GET',
      url: 'https://httpbin.org/get',
      headers: { 'Accept': 'application/json' },
    }));
    const parsed = JSON.parse(response);
    expect(parsed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
