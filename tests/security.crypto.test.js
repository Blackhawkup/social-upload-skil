import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MasterKeyStore } from '../src/security/masterKeyStore.js';
import { CredentialStore } from '../src/security/credentialStore.js';
import { decryptPayload, encryptPayload } from '../src/security/cryptoVault.js';
import { openDatabase } from '../src/db/database.js';
import { AccountsRepository } from '../src/db/repositories/accountsRepo.js';
import {
  clearRegisteredSensitiveValues,
  maskSecret,
  redactString,
  redactValue,
  registerSensitiveValue,
  sanitizeErrorMessage,
} from '../src/security/redact.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('AES-256-GCM encryption/decryption roundtrip and per-account AAD isolation', () => {
  const dir = makeTempDir('smp-crypto-');
  try {
    const keyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'file' });
    const credStore = new CredentialStore({ credentialsDir: path.join(dir, 'creds'), masterKeyStore: keyStore });

    const refA = credStore.createCredentialRef('yt');
    const refB = credStore.createCredentialRef('yt');

    credStore.saveAccountTokens({
      accountId: 'acc_alpha',
      platform: 'youtube',
      credentialRef: refA,
      tokens: { accessToken: 'ya29.alpha-secret-token', refreshToken: '1//alpha-refresh' },
    });

    credStore.saveAccountTokens({
      accountId: 'acc_beta',
      platform: 'youtube',
      credentialRef: refB,
      tokens: { accessToken: 'ya29.beta-secret-token', refreshToken: '1//beta-refresh' },
    });

    const loadedA = credStore.loadAccountTokens({ accountId: 'acc_alpha', platform: 'youtube', credentialRef: refA });
    assert.equal(loadedA.accessToken, 'ya29.alpha-secret-token');
    assert.equal(loadedA.refreshToken, '1//alpha-refresh');

    // Verify encrypted file does not contain plaintext tokens
    const rawFileA = fs.readFileSync(path.join(dir, 'creds', `${refA}.enc`), 'utf8');
    assert.equal(rawFileA.includes('alpha-secret-token'), false);

    // Account isolation: Account A ciphertext cannot be decrypted under Account B context/AAD
    assert.throws(() => {
      credStore.loadAccountTokens({ accountId: 'acc_beta', platform: 'youtube', credentialRef: refA });
    }, /mismatch|unable to authenticate/i);

    // Direct tamper detection on AES-256-GCM tag
    const masterKey = keyStore.getMasterKey();
    const env = encryptPayload(masterKey, 'ctx:1', { secret: 'hello' }, 'aad:1');
    env.ct = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptPayload(masterKey, 'ctx:1', env, 'aad:1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Master encryption key is stored separately from SQLite database and credentials wipe on delete', () => {
  const dir = makeTempDir('smp-dbiso-');
  try {
    const dbPath = path.join(dir, 'data', 'publisher.db');
    const secretsDir = path.join(dir, 'secrets');
    const credsDir = path.join(dir, 'creds');

    const keyStore = new MasterKeyStore({ secretsDir, mode: 'file' });
    const masterKeyHex = keyStore.getMasterKey().toString('hex');
    const credStore = new CredentialStore({ credentialsDir: credsDir, masterKeyStore: keyStore });
    const db = openDatabase(dbPath);
    const repo = new AccountsRepository(db);

    const ref = credStore.createCredentialRef('ig');
    credStore.saveAccountTokens({
      accountId: 'acc_ig_1',
      platform: 'instagram',
      credentialRef: ref,
      tokens: { accessToken: 'EAA_VERY_SECRET_IG_TOKEN', refreshToken: 'EAA_REFRESH' },
    });

    repo.upsertAccount({
      id: 'acc_ig_1',
      platform: 'instagram',
      displayName: 'AI News IG',
      username: '@ainews',
      platformAccountId: '17841400001',
      connectionStatus: 'connected',
      credentialRef: ref,
    });

    // Ensure SQLite file contains neither master key nor raw access token
    db.close();
    const dbBytes = fs.readFileSync(dbPath, 'utf8');
    assert.equal(dbBytes.includes(masterKeyHex), false);
    assert.equal(dbBytes.includes('EAA_VERY_SECRET_IG_TOKEN'), false);

    // Ensure public projection hides credentialRef
    const db2 = openDatabase(dbPath);
    const repo2 = new AccountsRepository(db2);
    const pub = repo2.findPublicById('acc_ig_1');
    assert.equal(pub.credentialRef, undefined);

    // Deleting credential file wipes it from disk
    assert.equal(credStore.deleteAccountTokens(ref), true);
    assert.equal(fs.existsSync(path.join(credsDir, `${ref}.enc`)), false);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.platform === 'win32') {
  test('Windows Credential Manager stores and retrieves master key cleanly outside workspace/SQLite', () => {
    const testNs = `AntigravitySocialPublisherTest_${crypto.randomBytes(4).toString('hex')}`;
    const dir = makeTempDir('smp-wincred-');
    // Omit DPAPI secretsDir first to prove genuine WinCred storage (no silent fallback)
    const keyStore = new MasterKeyStore({ namespace: testNs, mode: 'wincred' });
    try {
      const k1 = keyStore.getMasterKey();
      assert.equal(k1.length, 32);

      // Fresh instance with cleared memoryCache reads same key back from Windows Credential Manager
      const keyStore2 = new MasterKeyStore({ secretsDir: dir, namespace: testNs, mode: 'wincred' });
      const k2 = keyStore2.getMasterKey();
      assert.equal(k1.toString('hex'), k2.toString('hex'));
      assert.equal(fs.existsSync(path.join(dir, 'MasterKey.dpapi')), false);
    } finally {
      keyStore.deleteSecret('MasterKey');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Secret redaction scrubs tokens, headers, presigned signatures, and registered runtime secrets', () => {
  clearRegisteredSensitiveValues();
  registerSensitiveValue('my-super-custom-secret-987654');

  const rawMsg =
    'Failed calling https://example.r2.dev/vid.mp4?X-Amz-Signature=deadbeef1234&access_token=ya29.AbCdEfGhIjKlMnOpQrStUvWxYz with Authorization: Bearer topSecretJwt12345 and my-super-custom-secret-987654';
  const clean = sanitizeErrorMessage(new Error(rawMsg));

  assert.equal(clean.includes('deadbeef1234'), false);
  assert.equal(clean.includes('ya29.AbCdEfGhIjKlMnOpQrStUvWxYz'), false);
  assert.equal(clean.includes('topSecretJwt12345'), false);
  assert.equal(clean.includes('my-super-custom-secret-987654'), false);
  assert.equal(redactString('OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz123456').includes('abcdef'), false);

  const redactedObj = redactValue({
    clientSecret: 'super-secret-value',
    nested: { refresh_token: '1//secret', displayName: 'AI News' },
  });
  assert.equal(redactedObj.clientSecret, '[REDACTED]');
  assert.equal(redactedObj.nested.refresh_token, '[REDACTED]');
  assert.equal(redactedObj.nested.displayName, 'AI News');
  assert.equal(maskSecret('1234567890abcd'), '**********abcd');

  clearRegisteredSensitiveValues();
});
