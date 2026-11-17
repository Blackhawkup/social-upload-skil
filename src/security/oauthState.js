import crypto from 'node:crypto';
import { decryptPayload, encryptPayload } from './cryptoVault.js';

export function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function generatePkcePair() {
  // RFC 7636: 32 random bytes -> 43-char URL-safe verifier
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const challengeDigest = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  const codeChallenge = base64UrlEncode(challengeDigest);
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

export class OAuthStateManager {
  constructor({ oauthStatesRepo, masterKeyStore, ttlSeconds = 600 }) {
    this.oauthStatesRepo = oauthStatesRepo;
    this.masterKeyStore = masterKeyStore;
    this.ttlSeconds = ttlSeconds;
  }

  createState({ platform, mode = 'connect', accountId = null, displayName = null, igLoginMode = null, sessionBinding = 'ipc', redirectUri, usePkce = true }) {
    this.oauthStatesRepo.purgeExpired();

    const rawState = base64UrlEncode(crypto.randomBytes(32));
    const stateHash = sha256Hex(rawState);
    const sessionBindingHash = sha256Hex(sessionBinding);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();

    let pkce = null;
    let codeVerifierEnc = null;
    if (usePkce) {
      pkce = generatePkcePair();
      const masterKey = this.masterKeyStore.getMasterKey();
      const envelope = encryptPayload(
        masterKey,
        `oauth_pkce:${stateHash}`,
        { codeVerifier: pkce.codeVerifier },
        stateHash
      );
      codeVerifierEnc = JSON.stringify(envelope);
    }

    this.oauthStatesRepo.insert({
      stateHash,
      platform,
      mode,
      accountId,
      displayName,
      igLoginMode,
      codeVerifierEnc,
      sessionBindingHash,
      redirectUri,
      expiresAt,
      createdAt: new Date().toISOString(),
    });

    return {
      state: rawState,
      stateId: stateHash.slice(0, 16),
      codeChallenge: pkce?.codeChallenge || null,
      codeChallengeMethod: pkce?.codeChallengeMethod || null,
      expiresAt,
    };
  }

  consumeState({ rawState, expectedPlatform, expectedSessionBinding = null }) {
    if (!rawState || typeof rawState !== 'string' || rawState.length < 24) {
      throw new Error('Invalid or missing OAuth state parameter');
    }

    const stateHash = sha256Hex(rawState);
    const record = this.oauthStatesRepo.findByHash(stateHash);
    if (!record) {
      throw new Error('Unknown or expired OAuth state');
    }
    if (record.consumed_at) {
      throw new Error('OAuth state has already been consumed');
    }
    if (record.platform !== expectedPlatform) {
      throw new Error('OAuth state platform mismatch');
    }
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      throw new Error('OAuth state has expired');
    }

    if (expectedSessionBinding) {
      const ipcBuf = Buffer.from(sha256Hex('ipc'), 'hex');
      const actualBuf = Buffer.from(record.session_binding_hash, 'hex');
      const expectedBuf = Buffer.from(sha256Hex(expectedSessionBinding), 'hex');
      const isIpcOrigin = actualBuf.length === ipcBuf.length && crypto.timingSafeEqual(actualBuf, ipcBuf);
      const matchesSession = actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
      if (!isIpcOrigin && !matchesSession) {
        throw new Error('OAuth state session binding mismatch');
      }
    }

    const marked = this.oauthStatesRepo.markConsumed(stateHash);
    if (!marked) {
      throw new Error('OAuth state race condition detected');
    }

    let codeVerifier = null;
    if (record.code_verifier_enc) {
      const masterKey = this.masterKeyStore.getMasterKey();
      const envelope = JSON.parse(record.code_verifier_enc);
      const decrypted = decryptPayload(masterKey, `oauth_pkce:${stateHash}`, envelope, stateHash);
      codeVerifier = decrypted.codeVerifier;
    }

    return {
      platform: record.platform,
      mode: record.mode,
      accountId: record.account_id,
      displayName: record.display_name,
      igLoginMode: record.ig_login_mode,
      redirectUri: record.redirect_uri,
      codeVerifier,
    };
  }
}
