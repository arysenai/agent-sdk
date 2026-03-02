/**
 * Filesystem-based encrypted key storage.
 *
 * Stores each key as `{key_id}.enc` in a configurable base directory
 * (default: ~/.arysen/keys/). The directory is auto-created on first write.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_BASE_PATH = join(homedir(), '.arysen', 'keys');

export class FileSystemStorage {
  private readonly basePath: string;
  private dirEnsured = false;

  constructor(basePath?: string) {
    this.basePath = basePath ?? DEFAULT_BASE_PATH;
  }

  /**
   * Read encrypted key data by key ID.
   * Returns null if the key file does not exist.
   */
  async read(keyId: string): Promise<Uint8Array | null> {
    const filePath = this.keyPath(keyId);
    try {
      const data = await readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write encrypted key data by key ID.
   * Auto-creates the storage directory on first write.
   */
  async write(keyId: string, data: Uint8Array): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.keyPath(keyId);
    await writeFile(filePath, data);
  }

  /** Return the full file path for a given key ID. */
  private keyPath(keyId: string): string {
    // Sanitize key ID to prevent path traversal
    const safe = keyId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.basePath, `${safe}.enc`);
  }

  /** Ensure the base directory exists. */
  private async ensureDirectory(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.basePath, { recursive: true });
    this.dirEnsured = true;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
