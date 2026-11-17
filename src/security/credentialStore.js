import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decryptPayload, encryptPayload } from './cryptoVault.js';
import { restrictWindowsFileAcl } from './masterKeyStore.js';
import { maskSecret, registerSensitiveValue } from './redact.js';

function sanitizeRef(ref) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(ref)) {
    throw new Error('Invalid credential reference identifier');
  }
  return ref;
}

export class CredentialStore {
  constructor({ credentialsDir, masterKeyStore }) {
    this.credentialsDir = credentialsDir;
    this.masterKeyStore = masterKeyStore;
    fs.mkdirSync(this.credentialsDir, { recursive: true });
  }

  createCredentialRef(prefix = 'cred') {
    const id = crypto.randomBytes(16).toString('hex');
    return `${prefix}_${id}`;
  }

  saveAccountTokens({ accountId, platform, credentialRef, tokens }) {
    const safeRef = sanitizeRef(credentialRef);
    const masterKey = this.masterKeyStore.getMasterKey();
    const context = `account:${accountId}:${platform}:${safeRef}`;
    const aad = `${accountId}|${platform}|${safeRef}`;

    const sanitizedPayload = {
      accountId,
      platform,
      credentialRef: safeRef,
      accessToken: tokens.accessToken || '',
      refreshToken: tokens.refreshToken || '',
      tokenType: tokens.tokenType || 'Bearer',
      scope: tokens.scope || '',
      expiresAt: tokens.expiresAt || null,
      refreshExpiresAt: tokens.refreshExpiresAt || null,
      updatedAt: new Date().toISOString(),
    };

    registerSensitiveValue(sanitizedPayload.accessToken);
    registerSensitiveValue(sanitizedPayload.refreshToken);

    const envelope = encryptPayload(masterKey, context, sanitizedPayload, aad);
    const filePath = path.join(this.credentialsDir, `${safeRef}.enc`);
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (this.masterKeyStore?.mode !== 'memory') {
      restrictWindowsFileAcl(filePath);
    }
    return { credentialRef: safeRef };
  }

  loadAccountTokens({ accountId, platform, credentialRef }) {
    const safeRef = sanitizeRef(credentialRef);
    const filePath = path.join(this.credentialsDir, `${safeRef}.enc`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const masterKey = this.masterKeyStore.getMasterKey();
    const context = `account:${accountId}:${platform}:${safeRef}`;
    const aad = `${accountId}|${platform}|${safeRef}`;
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const decrypted = decryptPayload(masterKey, context, envelope, aad);

    registerSensitiveValue(decrypted.accessToken);
    registerSensitiveValue(decrypted.refreshToken);
    return decrypted;
  }

  deleteAccountTokens(credentialRef) {
    const safeRef = sanitizeRef(credentialRef);
    const filePath = path.join(this.credentialsDir, `${safeRef}.enc`);
    if (fs.existsSync(filePath)) {
      // Overwrite with zeros before unlinking
      const size = fs.statSync(filePath).size;
      if (size > 0) {
        fs.writeFileSync(filePath, Buffer.alloc(size, 0));
      }
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  saveProviderConfig(providerName, configObj) {
    const safeProvider = sanitizeRef(`provider_${providerName}`);
    const masterKey = this.masterKeyStore.getMasterKey();
    const context = `provider:${providerName}`;
    const aad = `provider|${providerName}`;

    const existing = this.loadProviderConfig(providerName) || {};
    const merged = { ...existing };

    for (const [k, v] of Object.entries(configObj || {})) {
      if (v === undefined) continue;
      if (v === '') {
        delete merged[k];
      } else {
        merged[k] = v;
        if (typeof v === 'string' && /secret|key|token|passcode/i.test(k)) {
          registerSensitiveValue(v);
        }
      }
    }

    merged.updatedAt = new Date().toISOString();
    const envelope = encryptPayload(masterKey, context, merged, aad);
    const filePath = path.join(this.credentialsDir, `${safeProvider}.enc`);
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (this.masterKeyStore?.mode !== 'memory') {
      restrictWindowsFileAcl(filePath);
    }
  }

  loadProviderConfig(providerName) {
    const safeProvider = sanitizeRef(`provider_${providerName}`);
    const filePath = path.join(this.credentialsDir, `${safeProvider}.enc`);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const masterKey = this.masterKeyStore.getMasterKey();
    const context = `provider:${providerName}`;
    const aad = `provider|${providerName}`;
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const decrypted = decryptPayload(masterKey, context, envelope, aad);
    for (const [k, v] of Object.entries(decrypted)) {
      if (typeof v === 'string' && /secret|key|token|passcode/i.test(k)) {
        registerSensitiveValue(v);
      }
    }
    return decrypted;
  }

  getMaskedProviderStatus(envConfig) {
    const ytVault = this.loadProviderConfig('youtube');
    const igVault = this.loadProviderConfig('instagram');
    const r2Vault = this.loadProviderConfig('storage');
    const aiVault = this.loadProviderConfig('ai');
    const dashVault = this.loadProviderConfig('dashboard');

    const ytClientId = ytVault.clientId || envConfig.youtube.clientId;
    const ytClientSecret = ytVault.clientSecret || envConfig.youtube.clientSecret;

    const igAppId = igVault.appId || envConfig.instagram.appId;
    const igAppSecret = igVault.appSecret || envConfig.instagram.appSecret;
    const igLoginMode = igVault.loginMode || envConfig.instagram.loginMode || 'meta_unified_login';
    const igConfigId = igVault.configId || envConfig.instagram.configId || '';

    const r2AccountId = r2Vault.accountId || envConfig.storage.accountId;
    const r2Bucket = r2Vault.bucket || envConfig.storage.bucket;
    const r2AccessKeyId = r2Vault.accessKeyId || envConfig.storage.accessKeyId;
    const r2SecretAccessKey = r2Vault.secretAccessKey || envConfig.storage.secretAccessKey;

    const geminiKey = aiVault.geminiApiKey || envConfig.ai.geminiApiKey;
    const openaiKey = aiVault.openaiApiKey || envConfig.ai.openaiApiKey;
    const anthropicKey = aiVault.anthropicApiKey || envConfig.ai.anthropicApiKey;

    return {
      youtube: {
        configured: Boolean(ytClientId && ytClientSecret),
        clientIdMasked: maskSecret(ytClientId),
        hasClientSecret: Boolean(ytClientSecret),
        redirectUri: ytVault.redirectUri || envConfig.youtube.redirectUri,
      },
      instagram: {
        configured: Boolean(
          igAppId && igAppSecret && (igLoginMode !== 'meta_unified_login' || igConfigId)
        ),
        appIdMasked: maskSecret(igAppId),
        hasAppSecret: Boolean(igAppSecret),
        configId: igConfigId,
        hasConfigId: Boolean(igConfigId),
        loginMode: igLoginMode,
        redirectUri: igVault.redirectUri || envConfig.instagram.redirectUri,
      },
      storage: {
        provider: r2Vault.provider || envConfig.storage.provider,
        configured: Boolean(r2Bucket && r2AccessKeyId && r2SecretAccessKey && (r2AccountId || r2Vault.endpoint || envConfig.storage.endpoint)),
        bucket: r2Bucket || '',
        endpoint: r2Vault.endpoint || envConfig.storage.endpoint || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ''),
        accessKeyIdMasked: maskSecret(r2AccessKeyId),
        hasSecretAccessKey: Boolean(r2SecretAccessKey),
        urlTtlSeconds: Math.min(3600, Math.max(60, Number(r2Vault.urlTtlSeconds || envConfig.storage.urlTtlSeconds || 1800))),
        retentionMinutes: Math.min(1440, Math.max(5, Number(r2Vault.retentionMinutes || envConfig.storage.retentionMinutes || 60))),
        monthlyUploadLimitCount: Number(r2Vault.monthlyUploadLimitCount || envConfig.storage.monthlyUploadLimitCount || 200),
        monthlyUploadLimitBytes: Number(
          r2Vault.monthlyUploadLimitBytes ||
            (r2Vault.monthlyUploadLimitMb ? Number(r2Vault.monthlyUploadLimitMb) * 1024 * 1024 : null) ||
            envConfig.storage.monthlyUploadLimitBytes ||
            10 * 1024 * 1024 * 1024
        ),
        monthlyUploadLimitMb: Math.round(
          Number(
            r2Vault.monthlyUploadLimitMb ||
              (r2Vault.monthlyUploadLimitBytes ? Number(r2Vault.monthlyUploadLimitBytes) / (1024 * 1024) : null) ||
              (envConfig.storage.monthlyUploadLimitBytes ? envConfig.storage.monthlyUploadLimitBytes / (1024 * 1024) : 10240)
          )
        ),
      },
      ai: {
        provider: aiVault.provider || envConfig.ai.provider,
        geminiConfigured: Boolean(geminiKey),
        geminiKeyMasked: maskSecret(geminiKey),
        openaiConfigured: Boolean(openaiKey),
        openaiKeyMasked: maskSecret(openaiKey),
        anthropicConfigured: Boolean(anthropicKey),
        anthropicKeyMasked: maskSecret(anthropicKey),
        ollamaBaseUrl: aiVault.ollamaBaseUrl || envConfig.ai.ollamaBaseUrl,
        ollamaModel: aiVault.ollamaModel || envConfig.ai.ollamaModel,
      },
      dashboard: {
        passcodeConfigured: Boolean(dashVault.passcodeHash),
      },
    };
  }

  resolveEffectiveCredentials(envConfig) {
    const ytVault = this.loadProviderConfig('youtube');
    const igVault = this.loadProviderConfig('instagram');
    const r2Vault = this.loadProviderConfig('storage');
    const aiVault = this.loadProviderConfig('ai');

    const ytClientId = ytVault.clientId || envConfig.youtube.clientId;
    const ytClientSecret = ytVault.clientSecret || envConfig.youtube.clientSecret;
    const igAppId = igVault.appId || envConfig.instagram.appId;
    const igAppSecret = igVault.appSecret || envConfig.instagram.appSecret;
    const igLoginMode = igVault.loginMode || envConfig.instagram.loginMode || 'meta_unified_login';
    const igConfigId = igVault.configId || envConfig.instagram.configId || '';
    const r2AccessKeyId = r2Vault.accessKeyId || envConfig.storage.accessKeyId;
    const r2SecretAccessKey = r2Vault.secretAccessKey || envConfig.storage.secretAccessKey;
    const geminiApiKey = aiVault.geminiApiKey || envConfig.ai.geminiApiKey;
    const openaiApiKey = aiVault.openaiApiKey || envConfig.ai.openaiApiKey;
    const anthropicApiKey = aiVault.anthropicApiKey || envConfig.ai.anthropicApiKey;

    for (const s of [ytClientSecret, igAppSecret, r2SecretAccessKey, geminiApiKey, openaiApiKey, anthropicApiKey]) {
      registerSensitiveValue(s);
    }

    return {
      youtube: {
        clientId: ytClientId,
        clientSecret: ytClientSecret,
        redirectUri: ytVault.redirectUri || envConfig.youtube.redirectUri,
      },
      instagram: {
        appId: igAppId,
        appSecret: igAppSecret,
        configId: igVault.configId || envConfig.instagram.configId || '',
        graphApiVersion: igVault.graphApiVersion || envConfig.instagram.graphApiVersion,
        redirectUri: igVault.redirectUri || envConfig.instagram.redirectUri,
        loginMode: igVault.loginMode || envConfig.instagram.loginMode || 'meta_unified_login',
      },
      storage: {
        provider: r2Vault.provider || envConfig.storage.provider,
        accountId: r2Vault.accountId || envConfig.storage.accountId,
        bucket: r2Vault.bucket || envConfig.storage.bucket,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        endpoint: r2Vault.endpoint || envConfig.storage.endpoint,
        region: r2Vault.region || envConfig.storage.region,
        urlTtlSeconds: Math.min(3600, Math.max(60, Number(r2Vault.urlTtlSeconds || envConfig.storage.urlTtlSeconds || 1800))),
        retentionMinutes: Math.min(1440, Math.max(5, Number(r2Vault.retentionMinutes || envConfig.storage.retentionMinutes || 60))),
        maxTotalStoredBytes: Math.min(
          8 * 1024 * 1024 * 1024,
          Number(envConfig.storage.maxTotalStoredBytes || 8 * 1024 * 1024 * 1024)
        ),
        maxVideoSizeBytes: Math.min(
          500 * 1024 * 1024,
          Number(envConfig.storage.maxVideoSizeBytes || 500 * 1024 * 1024)
        ),
        maxConcurrentUploads: 1,
        maxQueuedJobs: Math.min(10, Number(envConfig.storage.maxQueuedJobs || 10)),
        abandonedUploadHours: Math.min(24, Number(envConfig.storage.abandonedUploadHours || 24)),
        monthlyUploadLimitCount: Number(
          r2Vault.monthlyUploadLimitCount || envConfig.storage.monthlyUploadLimitCount || 200
        ),
        monthlyUploadLimitBytes: Number(
          r2Vault.monthlyUploadLimitBytes ||
            (r2Vault.monthlyUploadLimitMb ? Number(r2Vault.monthlyUploadLimitMb) * 1024 * 1024 : null) ||
            envConfig.storage.monthlyUploadLimitBytes ||
            10 * 1024 * 1024 * 1024
        ),
        monthlyClassAOpsLimit: Number(
          r2Vault.monthlyClassAOpsLimit || envConfig.storage.monthlyClassAOpsLimit || 800000
        ),
        monthlyClassBOpsLimit: Number(
          r2Vault.monthlyClassBOpsLimit || envConfig.storage.monthlyClassBOpsLimit || 8000000
        ),
        ...(envConfig.storage.multipartThresholdBytes
          ? { multipartThresholdBytes: envConfig.storage.multipartThresholdBytes }
          : {}),
        ...(envConfig.storage.multipartPartSizeBytes
          ? { multipartPartSizeBytes: envConfig.storage.multipartPartSizeBytes }
          : {}),
      },
      ai: {
        provider: aiVault.provider || envConfig.ai.provider,
        geminiApiKey,
        geminiModel: aiVault.geminiModel || envConfig.ai.geminiModel,
        openaiApiKey,
        openaiModel: aiVault.openaiModel || envConfig.ai.openaiModel,
        anthropicApiKey,
        anthropicModel: aiVault.anthropicModel || envConfig.ai.anthropicModel,
        ollamaBaseUrl: aiVault.ollamaBaseUrl || envConfig.ai.ollamaBaseUrl,
        ollamaModel: aiVault.ollamaModel || envConfig.ai.ollamaModel,
      },
    };
  }

  setDashboardPasscode(passcode) {
    if (!passcode || passcode.length < 8) {
      throw new Error('Dashboard passcode must be at least 8 characters');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(passcode, salt, 64).toString('hex');
    this.saveProviderConfig('dashboard', { passcodeSalt: salt, passcodeHash: hash });
  }

  verifyDashboardPasscode(passcode) {
    const dash = this.loadProviderConfig('dashboard');
    if (!dash.passcodeHash || !dash.passcodeSalt) return false;
    const derived = crypto.scryptSync(String(passcode || ''), dash.passcodeSalt, 64);
    const expected = Buffer.from(dash.passcodeHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }
}

