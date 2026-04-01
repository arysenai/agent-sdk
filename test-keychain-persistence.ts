#!/usr/bin/env tsx
/**
 * Integration test for macOS Keychain persistence.
 *
 * Tests that secrets:
 * 1. Are written to the actual macOS Keychain
 * 2. Persist across ArysenKeymod instance restarts
 * 3. Can be retrieved after process restart
 *
 * Run: pnpm tsx test-keychain-persistence.ts
 */

import { execSync } from 'node:child_process';
import { ArysenKeymod } from './dist/keymod/index.js';

const TEST_SECRET_NAME = 'KEYCHAIN_TEST_SECRET';
const TEST_SECRET_VALUE = 'test_value_123';

function log(emoji: string, message: string) {
  console.log(`${emoji} ${message}`);
}

function checkKeychainEntry(keyId: string): boolean {
  try {
    execSync(`security find-generic-password -s arysen -a "${keyId}" -w`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function readKeychainEntry(keyId: string): string | null {
  try {
    const output = execSync(`security find-generic-password -s arysen -a "${keyId}" -w`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return Buffer.from(output.trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function deleteKeychainEntry(keyId: string) {
  try {
    execSync(`security delete-generic-password -s arysen -a "${keyId}"`, {
      stdio: 'pipe',
    });
  } catch {
    // Ignore if not found
  }
}

async function main() {
  log('🧪', 'Starting macOS Keychain persistence test...\n');

  // Cleanup any existing test data
  log('🧹', 'Cleaning up any existing test data...');
  deleteKeychainEntry('arysen_secrets_master');
  deleteKeychainEntry('arysen_secrets_index');
  deleteKeychainEntry(`arysen_secrets:${TEST_SECRET_NAME}`);

  // Test 1: Deposit secret and verify it's in keychain
  log('\n📝', 'Test 1: Deposit secret and verify keychain write');
  const keymod1 = await ArysenKeymod.init();

  const deposited = keymod1.depositSecret(TEST_SECRET_NAME, TEST_SECRET_VALUE);
  if (!deposited) {
    throw new Error('❌ Failed to deposit secret');
  }
  log('✅', 'Secret deposited successfully');

  // Verify master key was created
  if (!checkKeychainEntry('arysen_secrets_master')) {
    throw new Error('❌ Master key not found in keychain');
  }
  log('✅', 'Master key exists in keychain');

  // Verify secret exists in keychain
  if (!checkKeychainEntry(`arysen_secrets:${TEST_SECRET_NAME}`)) {
    throw new Error('❌ Secret not found in keychain');
  }
  log('✅', 'Secret exists in keychain');

  // Verify index exists
  if (!checkKeychainEntry('arysen_secrets_index')) {
    throw new Error('❌ Index not found in keychain');
  }
  log('✅', 'Index exists in keychain');

  // Verify index contains our secret name
  const indexData = readKeychainEntry('arysen_secrets_index');
  if (!indexData) {
    throw new Error('❌ Could not read index from keychain');
  }
  const index = JSON.parse(indexData);
  if (!index.includes(TEST_SECRET_NAME)) {
    throw new Error(`❌ Secret name not in index. Index: ${JSON.stringify(index)}`);
  }
  log('✅', `Index contains secret name: ${JSON.stringify(index)}`);

  // List secrets via SDK
  const secrets1 = keymod1.listSecrets();
  if (!secrets1.includes(TEST_SECRET_NAME)) {
    throw new Error(`❌ Secret not in list. Got: ${JSON.stringify(secrets1)}`);
  }
  log('✅', `SDK lists secret: ${JSON.stringify(secrets1)}`);

  // Destroy first instance
  keymod1.destroy();
  log('🔄', 'Destroyed first ArysenKeymod instance\n');

  // Test 2: Create new instance and verify secret persists
  log('📝', 'Test 2: Restart and verify persistence');
  const keymod2 = await ArysenKeymod.init();

  const secrets2 = keymod2.listSecrets();
  if (!secrets2.includes(TEST_SECRET_NAME)) {
    throw new Error(`❌ Secret not found after restart. Got: ${JSON.stringify(secrets2)}`);
  }
  log('✅', `Secret persisted across restart: ${JSON.stringify(secrets2)}`);

  // Test 3: Remove secret and verify cleanup
  log('\n📝', 'Test 3: Remove secret and verify index update');
  const removed = keymod2.removeSecret(TEST_SECRET_NAME);
  if (!removed) {
    throw new Error('❌ Failed to remove secret');
  }
  log('✅', 'Secret removed successfully');

  const secrets3 = keymod2.listSecrets();
  if (secrets3.includes(TEST_SECRET_NAME)) {
    throw new Error(`❌ Secret still in list after removal. Got: ${JSON.stringify(secrets3)}`);
  }
  log('✅', `Secret no longer listed: ${JSON.stringify(secrets3)}`);

  // Verify index was updated
  const indexDataAfter = readKeychainEntry('arysen_secrets_index');
  if (!indexDataAfter) {
    throw new Error('❌ Could not read index after removal');
  }
  const indexAfter = JSON.parse(indexDataAfter);
  if (indexAfter.includes(TEST_SECRET_NAME)) {
    throw new Error(`❌ Secret name still in index. Index: ${JSON.stringify(indexAfter)}`);
  }
  log('✅', `Index updated correctly: ${JSON.stringify(indexAfter)}`);

  keymod2.destroy();

  // Test 4: Deposit multiple secrets
  log('\n📝', 'Test 4: Multiple secrets persistence');
  const keymod3 = await ArysenKeymod.init();

  keymod3.depositSecret('SECRET_A', 'value_a');
  keymod3.depositSecret('SECRET_B', 'value_b');
  keymod3.depositSecret('SECRET_C', 'value_c');

  const multiSecrets1 = keymod3.listSecrets();
  log('✅', `Deposited 3 secrets: ${JSON.stringify(multiSecrets1)}`);

  keymod3.destroy();

  // Restart and verify all three persist
  const keymod4 = await ArysenKeymod.init();
  const multiSecrets2 = keymod4.listSecrets();

  if (multiSecrets2.length !== 3) {
    throw new Error(`❌ Expected 3 secrets, got ${multiSecrets2.length}`);
  }
  if (!multiSecrets2.includes('SECRET_A') || !multiSecrets2.includes('SECRET_B') || !multiSecrets2.includes('SECRET_C')) {
    throw new Error(`❌ Missing secrets after restart. Got: ${JSON.stringify(multiSecrets2)}`);
  }
  log('✅', `All 3 secrets persisted: ${JSON.stringify(multiSecrets2)}`);

  // Cleanup
  log('\n🧹', 'Cleaning up test data...');
  keymod4.removeSecret('SECRET_A');
  keymod4.removeSecret('SECRET_B');
  keymod4.removeSecret('SECRET_C');
  keymod4.destroy();

  deleteKeychainEntry('arysen_secrets_master');
  deleteKeychainEntry('arysen_secrets_index');
  deleteKeychainEntry(`arysen_secrets:${TEST_SECRET_NAME}`);
  deleteKeychainEntry('arysen_secrets:SECRET_A');
  deleteKeychainEntry('arysen_secrets:SECRET_B');
  deleteKeychainEntry('arysen_secrets:SECRET_C');

  log('\n✨', 'All tests passed! Keychain persistence working correctly.');
  log('🔒', 'Verified that secrets survive ArysenKeymod restarts on macOS.');
}

main().catch((error) => {
  console.error('\n❌ Test failed:', error.message);
  process.exit(1);
});
