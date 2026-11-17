import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../config/env.js';
import { ensureRuntimeDirectories } from '../config/paths.js';
import { MasterKeyStore } from '../security/masterKeyStore.js';
import { CredentialStore } from '../security/credentialStore.js';
import { BackendIpcClient } from '../mcp/server.js';

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$u = [Console]::In.ReadToEnd().Trim(); if ($u) { Start-Process -FilePath $u }',
      ],
      { input: url, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
    );
  }
}

async function promptSecret(rl, label, currentlyConfigured) {
  const hint = currentlyConfigured ? ' [already set — press Enter to keep]' : ' [leave blank to skip]';
  const val = await rl.question(`${label}${hint}: `);
  return val.trim();
}

async function runSetup() {
  const arg = process.argv[2] || '';
  const config = loadConfig();
  ensureRuntimeDirectories(config.paths);

  if (arg === '--dashboard' || arg === 'dashboard') {
    const client = new BackendIpcClient({ autoStart: true });
    const data = await client.request('POST', '/api/auth/bootstrap-link', {});
    const url = `${client.baseUrl}/?bootstrap=${data.bootstrapCode}`;
    console.log(`\nDashboard URL (single-use launch link): ${url}`);
    console.log(`Single-Use Launch Code: ${data.bootstrapCode}`);
    console.log(`(Expires in ${Math.round((data.expiresInSeconds || 600) / 60)} minutes; one-time use.)\n`);
    try {
      openBrowser(url);
    } catch {
      // If auto-opening fails, the user can click or paste the printed URL/code above
    }
    return;
  }

  const masterKeyStore = new MasterKeyStore({
    secretsDir: config.paths.secretsDir,
    mode: process.platform === 'win32' ? 'wincred' : 'file',
  });
  masterKeyStore.getMasterKey();
  masterKeyStore.getIpcSecret();

  const credentialStore = new CredentialStore({
    credentialsDir: config.paths.credentialsDir,
    masterKeyStore,
  });

  const status = credentialStore.getMaskedProviderStatus(config);
  console.log('\n=== AI Social Media Publisher — Secure Local Setup ===');
  console.log('Credentials are encrypted with AES-256-GCM; master key lives in Windows Credential Manager.');
  console.log('Nothing is printed to logs or shared with Antigravity.\n');

  const rl = readline.createInterface({ input, output });
  try {
    console.log('--- 1. YouTube Data API v3 (Google Cloud OAuth Web Client) ---');
    const ytClientId = await promptSecret(rl, 'YouTube OAuth Client ID', status.youtube.configured);
    const ytClientSecret = await promptSecret(rl, 'YouTube OAuth Client Secret', status.youtube.hasClientSecret);
    if (ytClientId || ytClientSecret) {
      credentialStore.saveProviderConfig('youtube', {
        ...(ytClientId ? { clientId: ytClientId } : {}),
        ...(ytClientSecret ? { clientSecret: ytClientSecret } : {}),
      });
    }

    console.log('\n--- 2. Instagram Graph API (Meta Developer App) ---');
    console.log('Note: Enter Meta App ID & App Secret from App settings -> Basic (NOT generated access tokens).');
    const igAppId = await promptSecret(rl, 'Meta App ID', status.instagram.configured);
    const igAppSecret = await promptSecret(rl, 'Meta App Secret', status.instagram.hasAppSecret);
    const validModes = new Set(['meta_unified_login', 'facebook_login', 'instagram_login']);
    const igModeRaw = await rl.question(
      `Instagram Login Mode [current: ${status.instagram.loginMode || 'meta_unified_login'} — meta_unified_login (recommended), facebook_login (legacy), or instagram_login (legacy); press Enter to keep]: `
    );
    const igMode = igModeRaw.trim();
    const effectiveMode = validModes.has(igMode) ? igMode : status.instagram.loginMode || 'meta_unified_login';
    let igConfigId = '';
    if (effectiveMode === 'meta_unified_login') {
      const igConfigIdRaw = await rl.question(
        `Meta Unified Login Configuration ID (config_id) [current: ${status.instagram.configId || 'not set'} — press Enter to keep]: `
      );
      igConfigId = igConfigIdRaw.trim();
    }
    const igRedirectRaw = await rl.question(
      `Instagram Redirect URI [current: ${status.instagram.redirectUri} — press Enter to keep]: `
    );
    const igRedirect = igRedirectRaw.trim();
    if (igAppId || igAppSecret || validModes.has(igMode) || igConfigId || igRedirect) {
      credentialStore.saveProviderConfig('instagram', {
        ...(igAppId ? { appId: igAppId } : {}),
        ...(igAppSecret ? { appSecret: igAppSecret } : {}),
        ...(validModes.has(igMode) ? { loginMode: igMode } : {}),
        ...(igConfigId ? { configId: igConfigId } : {}),
        ...(igRedirect ? { redirectUri: igRedirect } : {}),
      });
    }

    console.log('\n--- 3. Temporary Private Cloud Media Hosting (Cloudflare R2 / S3) ---');
    console.log('Safeguards: R2 Standard storage only, private bucket, <= 1h presigned URLs, 8 GB / 500 MB limits.');
    console.log('Note: Local limits are application safeguards only, NOT a Cloudflare billing cap.');
    const r2AccountId = await promptSecret(rl, 'Cloudflare Account ID', Boolean(status.storage.endpoint));
    const r2Bucket = await promptSecret(rl, 'Private R2 Bucket Name', Boolean(status.storage.bucket));
    const r2AccessKeyId = await promptSecret(rl, 'R2 Access Key ID', Boolean(status.storage.accessKeyIdMasked));
    const r2SecretAccessKey = await promptSecret(rl, 'R2 Secret Access Key', status.storage.hasSecretAccessKey);
    const monthlyCountRaw = await rl.question(
      `Monthly R2 Upload Count Limit [current: ${status.storage.monthlyUploadLimitCount || 200} — press Enter to keep]: `
    );
    const monthlyMbRaw = await rl.question(
      `Monthly R2 Upload Volume Limit in MB [current: ${status.storage.monthlyUploadLimitMb || 10240} MB — press Enter to keep]: `
    );
    const monthlyUploadLimitCount = Number.parseInt(monthlyCountRaw.trim(), 10);
    const monthlyUploadLimitMb = Number.parseInt(monthlyMbRaw.trim(), 10);
    if (
      r2AccountId ||
      r2Bucket ||
      r2AccessKeyId ||
      r2SecretAccessKey ||
      Number.isFinite(monthlyUploadLimitCount) ||
      Number.isFinite(monthlyUploadLimitMb)
    ) {
      credentialStore.saveProviderConfig('storage', {
        provider: 'r2',
        ...(r2AccountId ? { accountId: r2AccountId } : {}),
        ...(r2Bucket ? { bucket: r2Bucket } : {}),
        ...(r2AccessKeyId ? { accessKeyId: r2AccessKeyId } : {}),
        ...(r2SecretAccessKey ? { secretAccessKey: r2SecretAccessKey } : {}),
        ...(Number.isFinite(monthlyUploadLimitCount) && monthlyUploadLimitCount > 0
          ? { monthlyUploadLimitCount }
          : {}),
        ...(Number.isFinite(monthlyUploadLimitMb) && monthlyUploadLimitMb > 0
          ? {
              monthlyUploadLimitMb,
              monthlyUploadLimitBytes: monthlyUploadLimitMb * 1024 * 1024,
            }
          : {}),
      });
    }

    console.log('\n--- 4. AI Metadata Provider (optional if using Ollama or Antigravity) ---');
    const geminiKey = await promptSecret(rl, 'Gemini API Key', status.ai.geminiConfigured);
    const openaiKey = await promptSecret(rl, 'OpenAI API Key', status.ai.openaiConfigured);
    const anthropicKey = await promptSecret(rl, 'Anthropic API Key', status.ai.anthropicConfigured);
    if (geminiKey || openaiKey || anthropicKey) {
      credentialStore.saveProviderConfig('ai', {
        ...(geminiKey ? { geminiApiKey: geminiKey } : {}),
        ...(openaiKey ? { openaiApiKey: openaiKey } : {}),
        ...(anthropicKey ? { anthropicApiKey: anthropicKey } : {}),
      });
    }

    console.log('\n--- 5. Local Dashboard Passcode (optional, recommended) ---');
    const passcode = await promptSecret(rl, 'Dashboard Passcode (min 8 chars)', status.dashboard.passcodeConfigured);
    if (passcode) {
      credentialStore.setDashboardPasscode(passcode);
    }

    const updated = credentialStore.getMaskedProviderStatus(config);
    console.log('\nSetup saved cleanly. Masked readiness summary:');
    console.log(JSON.stringify(updated, null, 2));
  } finally {
    rl.close();
  }
}

runSetup().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});

