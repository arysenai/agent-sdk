/**
 * Platform-specific key storage backends.
 *
 * Routes key_store_read/write host imports to the appropriate
 * OS secure storage:
 * - macOS: Keychain Services via `security` CLI
 * - Windows: DPAPI via PowerShell
 * - Linux: Encrypted files at ~/.arysen/keys/
 *
 * All operations are synchronous (WASM C-ABI host imports require it).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platform as osPlatform } from 'node:process';

type Platform = 'darwin' | 'win32' | 'linux';

const KEYCHAIN_SERVICE = 'arysen';
const LINUX_KEYS_DIR = join(homedir(), '.arysen', 'keys');

/** Sanitize key ID to prevent path traversal / shell injection. */
function sanitize(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9_:.-]/g, '_');
}

// ---------------------------------------------------------------------------
// macOS Keychain Services
// ---------------------------------------------------------------------------

function darwinRead(keyId: string): Buffer | null {
  try {
    const stdout = execFileSync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', sanitize(keyId),
      '-w',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    // exit code 44 = item not found
    return null;
  }
}

function darwinWrite(keyId: string, data: Buffer): void {
  const safe = sanitize(keyId);
  const b64 = data.toString('base64');
  try {
    // Try to update existing entry first
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', safe,
      '-w', b64,
      '-U', // update if exists
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // If add fails (shouldn't with -U), try delete + add
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', safe,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { /* ignore delete failure */ }
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', safe,
      '-w', b64,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

// ---------------------------------------------------------------------------
// Windows DPAPI
// ---------------------------------------------------------------------------

function windowsKeysDir(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'arysen', 'keys');
}

function win32Read(keyId: string): Buffer | null {
  const filePath = join(windowsKeysDir(), `${sanitize(keyId)}.dpapi`);
  if (!existsSync(filePath)) return null;

  try {
    const b64Protected = readFileSync(filePath, 'utf8').trim();
    // Use PowerShell to DPAPI-unprotect
    const script = `
      Add-Type -AssemblyName System.Security
      $protected = [Convert]::FromBase64String('${b64Protected}')
      $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')
      [Convert]::ToBase64String($plain)
    `;
    const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    return null;
  }
}

function win32Write(keyId: string, data: Buffer): void {
  const dir = windowsKeysDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const b64Plain = data.toString('base64');
  // Use PowerShell to DPAPI-protect
  const script = `
    Add-Type -AssemblyName System.Security
    $plain = [Convert]::FromBase64String('${b64Plain}')
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
    [Convert]::ToBase64String($protected)
  `;
  const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const filePath = join(dir, `${sanitize(keyId)}.dpapi`);
  writeFileSync(filePath, stdout.trim(), 'utf8');
}

// ---------------------------------------------------------------------------
// Linux encrypted files (fallback)
// ---------------------------------------------------------------------------

function linuxRead(keyId: string): Buffer | null {
  const filePath = join(LINUX_KEYS_DIR, `${sanitize(keyId)}.enc`);
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function linuxWrite(keyId: string, data: Buffer): void {
  if (!existsSync(LINUX_KEYS_DIR)) mkdirSync(LINUX_KEYS_DIR, { recursive: true, mode: 0o700 });
  const filePath = join(LINUX_KEYS_DIR, `${sanitize(keyId)}.enc`);
  writeFileSync(filePath, data, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function platformRead(keyId: string): Buffer | null {
  const platform = osPlatform as Platform;
  switch (platform) {
    case 'darwin':
      return darwinRead(keyId);
    case 'win32':
      return win32Read(keyId);
    default:
      return linuxRead(keyId);
  }
}

export function platformWrite(keyId: string, data: Buffer): void {
  const platform = osPlatform as Platform;
  switch (platform) {
    case 'darwin':
      darwinWrite(keyId, data);
      break;
    case 'win32':
      win32Write(keyId, data);
      break;
    default:
      linuxWrite(keyId, data);
      break;
  }
}
