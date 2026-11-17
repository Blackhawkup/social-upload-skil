import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApplication } from '../src/api/app.js';
import { loopbackHostAndCorsMiddleware } from '../src/api/middleware/security.js';
import { InstagramOAuthClient } from '../src/integrations/instagram/oauth.js';
import { MasterKeyStore } from '../src/security/masterKeyStore.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startTestServer() {
  const dir = makeTempDir('smp-sec-api-');
  const masterKeyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'memory' });
  const ctx = buildApplication({
    keyStoreMode: 'memory',
    masterKeyStore,
    logToConsole: false,
    configOverrides: {
      port: 0,
      paths: {
        baseDir: dir,
        dataDir: path.join(dir, 'data'),
        credentialsDir: path.join(dir, 'credentials'),
        secretsDir: path.join(dir, 'secrets'),
        tempDir: path.join(dir, 'temp'),
        logsDir: path.join(dir, 'logs'),
        dbPath: path.join(dir, 'data', 'publisher.db'),
      },
      youtube: {
        clientId: 'test-yt-client-id-1234',
        clientSecret: 'test-yt-client-secret-9999',
      },
    },
  });

  // Save real-looking secret into provider config to ensure masked endpoints never leak it
  ctx.credentialStore.saveProviderConfig('youtube', {
    clientId: '1234567890-testclient.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-SUPER-SECRET-VALUE-9999',
  });

  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ipcSecret = ctx.masterKeyStore.getIpcSecret();

  return {
    ctx,
    server,
    baseUrl,
    ipcSecret,
    cleanup: async () => {
      await new Promise((r) => server.close(r));
      ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('OAuth state validation enforces single-use, platform match, expiry, session binding, and PKCE S256', async () => {
  const srv = await startTestServer();
  try {
    const { accountService } = srv.ctx.services;
    const start = accountService.startOAuthConnect({
      platform: 'youtube',
      displayName: 'AI News',
      sessionBinding: 'sess_browser_1',
    });

    const authUrl = new URL(start.authorizationUrl);
    const state = authUrl.searchParams.get('state');
    const codeChallenge = authUrl.searchParams.get('code_challenge');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(state && state.length >= 32);

    // Wrong session binding rejects
    assert.throws(() => {
      srv.ctx.services.accountService.oauthStateManager.consumeState({
        rawState: state,
        expectedPlatform: 'youtube',
        expectedSessionBinding: 'sess_attacker_2',
      });
    }, /session binding mismatch/i);

    // Wrong platform rejects
    assert.throws(() => {
      srv.ctx.services.accountService.oauthStateManager.consumeState({
        rawState: state,
        expectedPlatform: 'instagram',
        expectedSessionBinding: 'sess_browser_1',
      });
    }, /platform mismatch/i);

    // Valid consume returns PKCE codeVerifier whose SHA-256 equals codeChallenge
    const consumed = srv.ctx.services.accountService.oauthStateManager.consumeState({
      rawState: state,
      expectedPlatform: 'youtube',
      expectedSessionBinding: 'sess_browser_1',
    });
    const recomputedChallenge = crypto
      .createHash('sha256')
      .update(consumed.codeVerifier, 'ascii')
      .digest('base64url');
    assert.equal(recomputedChallenge, codeChallenge);

    // Replay attack (consuming same state twice) fails
    assert.throws(() => {
      srv.ctx.services.accountService.oauthStateManager.consumeState({
        rawState: state,
        expectedPlatform: 'youtube',
        expectedSessionBinding: 'sess_browser_1',
      });
    }, /already been consumed/i);
  } finally {
    await srv.cleanup();
  }
});

test('API enforces IPC auth, Host-header loopback protection, CORS block, CSRF protection, and credential masking', async () => {
  const srv = await startTestServer();
  try {
    // 1. Unauthenticated request blocked
    const unauth = await fetch(`${srv.baseUrl}/api/accounts`);
    assert.equal(unauth.status, 401);

    // 2. Wrong bearer token blocked
    const badBearer = await fetch(`${srv.baseUrl}/api/accounts`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badBearer.status, 401);

    // 3. Valid IPC bearer allowed & setup status masks clientSecret
    const setupRes = await fetch(`${srv.baseUrl}/api/setup/status`, {
      headers: { Authorization: `Bearer ${srv.ipcSecret}` },
    });
    assert.equal(setupRes.status, 200);
    const setupText = await setupRes.text();
    assert.equal(setupText.includes('GOCSPX-SUPER-SECRET-VALUE-9999'), false);
    assert.equal(setupText.includes('1234567890-testclient.apps.googleusercontent.com'), false);

    // 4. Foreign Origin blocked (CORS attack prevention)
    const corsRes = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Origin: 'https://evil-site.example' },
    });
    assert.equal(corsRes.status, 403);

    // 5. Bootstrap browser session & verify CSRF token enforcement
    const bootCode = srv.ctx.bootstrapManager.issue();
    const bootRes = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapCode: bootCode }),
    });
    assert.equal(bootRes.status, 200);
    const setCookie = bootRes.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
    const sessionCookie = setCookie.split(';')[0];
    const bootJson = await bootRes.json();
    const csrfToken = bootJson.data.csrfToken;
    assert.ok(csrfToken);

    // Mutating request with cookie ONLY (missing X-CSRF-Token) must fail 403
    const noCsrfRes = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publishMode: 'autopilot' }),
    });
    assert.equal(noCsrfRes.status, 403);

    // Mutating request with cookie AND valid X-CSRF-Token succeeds
    const withCsrfRes = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publishMode: 'autopilot' }),
    });
    assert.equal(withCsrfRes.status, 200);
    const updatedSettings = await withCsrfRes.json();
    assert.equal(updatedSettings.data.settings.publishMode, 'autopilot');

    // 6. Same-origin /api/auth/status restores CSRF token cleanly on reload, but cross-site fetch does not
    const statusReloadRes = await fetch(`${srv.baseUrl}/api/auth/status`, {
      headers: { Cookie: sessionCookie, 'Sec-Fetch-Site': 'same-origin' },
    });
    const statusReloadJson = await statusReloadRes.json();
    assert.equal(statusReloadJson.data.authenticated, true);
    assert.equal(statusReloadJson.data.csrfToken, csrfToken);

    const statusCrossSiteRes = await fetch(`${srv.baseUrl}/api/auth/status`, {
      headers: { Cookie: sessionCookie, 'Sec-Fetch-Site': 'cross-site' },
    });
    const statusCrossSiteJson = await statusCrossSiteRes.json();
    assert.equal(statusCrossSiteJson.data.csrfToken, undefined);

    // 7. Dashboard OAuth connect sets SameSite=Lax smp_oauth_session binding cookie so Google/Meta redirects succeed even when SameSite=Strict smp_session is withheld
    const fakeYoutubeFetch = async (url) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'ya29.cb-test', refresh_token: '1//cb-refresh', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'UC_DASH_1', snippet: { title: 'Dash Channel', customUrl: '@dash' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };
    srv.ctx.services.accountService.youtubeOAuth.fetch = fakeYoutubeFetch;

    const connectRes = await fetch(`${srv.baseUrl}/api/accounts/connect/youtube`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Dash Channel' }),
    });
    assert.equal(connectRes.status, 200);
    const connectJson = await connectRes.json();
    const oauthState = new URL(connectJson.data.authorizationUrl).searchParams.get('state');
    const oauthSetCookie = connectRes.headers.get('set-cookie') || '';
    assert.ok(oauthSetCookie.includes('smp_oauth_session=') && oauthSetCookie.includes('SameSite=Lax'));
    const oauthBindCookie = oauthSetCookie.split(';')[0];

    // Simulate external OAuth redirect callback WITHOUT smp_session (withheld due to SameSite=Strict), ONLY smp_oauth_session
    const cbRes = await fetch(
      `${srv.baseUrl}/api/accounts/oauth/callback/youtube?code=auth_code_1&state=${encodeURIComponent(oauthState)}`,
      { headers: { Cookie: oauthBindCookie } }
    );
    assert.equal(cbRes.status, 200);
    const cbHtml = await cbRes.text();
    assert.match(cbHtml, /Dash Channel/);
  } finally {
    await srv.cleanup();
  }
});

test('Security hardening blocks cross-port CORS/Host, remote insecure storage HTTP, internal secret paths, and brute-force logins', async () => {
  // 1. Cross-port Host and Origin enforcement when allowedPort is locked
  const mw = loopbackHostAndCorsMiddleware({ allowedPort: 4815 });
  const runMw = (headers) =>
    new Promise((resolve) => {
      const resHeaders = {};
      let statusCode = 200;
      let payload = null;
      const req = { headers, method: 'GET' };
      const res = {
        setHeader: (k, v) => {
          resHeaders[k.toLowerCase()] = v;
        },
        status: (code) => {
          statusCode = code;
          return {
            json: (obj) => {
              payload = obj;
              resolve({ nextCalled: false, statusCode, resHeaders, payload });
            },
            end: () => resolve({ nextCalled: false, statusCode, resHeaders, payload: null }),
          };
        },
      };
      mw(req, res, () => resolve({ nextCalled: true, statusCode: 200, resHeaders, payload: null }));
    });

  assert.equal((await runMw({ host: '127.0.0.1:4815', origin: 'http://127.0.0.1:4815' })).nextCalled, true);
  assert.equal((await runMw({ host: '127.0.0.1:9999' })).statusCode, 403);
  assert.equal((await runMw({ host: 'localhost' })).statusCode, 403);
  assert.equal((await runMw({ host: '127.0.0.1:4815', origin: 'http://127.0.0.1:9999' })).statusCode, 403);
  assert.equal((await runMw({ host: '127.0.0.1:4815', origin: 'http://localhost' })).statusCode, 403);

  // 2. Setup URL validation, internal directory isolation, and login brute-force limiter
  const srv = await startTestServer();
  try {
    const authHeaders = {
      Authorization: `Bearer ${srv.ipcSecret}`,
      'Content-Type': 'application/json',
    };

    // Reject plaintext remote HTTP endpoint for R2/S3 credentials
    const badStorageRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        storage: {
          provider: 's3',
          endpoint: 'http://insecure-bucket.example.com',
          bucket: 'test',
        },
      }),
    });
    assert.equal(badStorageRes.status, 400);

    // Reject javascript: or ftp: OAuth redirect URI
    const badRedirectRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        youtube: { redirectUri: 'ftp://evil.example/cb' },
      }),
    });
    assert.equal(badRedirectRes.status, 400);

    // Reject scanning or setting watch dir inside internal credentials directory
    const secretFile = path.join(srv.ctx.config.paths.credentialsDir, 'provider_youtube.enc');
    const badAnalyzeRes = await fetch(`${srv.baseUrl}/api/videos/analyze`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ videoPath: secretFile }),
    });
    assert.equal(badAnalyzeRes.status, 403);

    const badWatchDirRes = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ videoWatchDirs: [srv.ctx.config.paths.secretsDir] }),
    });
    assert.equal(badWatchDirRes.status, 400);

    // Set dashboard passcode and verify brute-force rate limit triggers 429
    const setPassRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ dashboardPasscode: 'VeryStrongPasscode123!' }),
    });
    assert.equal(setPassRes.status, 200);

    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const loginTry = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: `wrong-attempt-${i}` }),
      });
      if (loginTry.status === 429) {
        got429 = true;
        break;
      }
      assert.equal(loginTry.status, 401);
    }
    assert.equal(got429, true);
  } finally {
    await srv.cleanup();
  }
});

test('Instagram Login HTTPS tunnel callback enforces strict host allowlisting, 302 loopback handoff, and OAuth token exchange', async () => {
  const http = await import('node:http');
  const srv = await startTestServer();
  try {
    const authHeaders = {
      Authorization: `Bearer ${srv.ipcSecret}`,
      'Content-Type': 'application/json',
    };

    // Save Instagram App ID/Secret with default http://127.0.0.1 redirectUri first
    await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          appId: 'ig-app-123',
          appSecret: 'ig-sec-999',
          loginMode: 'instagram_login',
        },
      }),
    });

    // Attempting instagram_login with http:// loopback fails clearly with INSTAGRAM_HTTPS_REDIRECT_REQUIRED
    const noHttpsRes = await fetch(`${srv.baseUrl}/api/accounts/connect/instagram`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ igLoginMode: 'instagram_login' }),
    });
    assert.equal(noHttpsRes.status, 400);
    const noHttpsJson = await noHttpsRes.json();
    assert.equal(noHttpsJson.error.code, 'INSTAGRAM_HTTPS_REDIRECT_REQUIRED');

    // Configure an HTTPS tunnel redirect URI
    const tunnelHost = 'demo-ig-tunnel.trycloudflare.com';
    const tunnelRedirectUri = `https://${tunnelHost}/api/accounts/oauth/callback/instagram`;
    const saveHttpsRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          loginMode: 'instagram_login',
          redirectUri: tunnelRedirectUri,
        },
      }),
    });
    assert.equal(saveHttpsRes.status, 200);
    const saveHttpsJson = await saveHttpsRes.json();
    assert.equal(saveHttpsJson.data.instagram.redirectUri, tunnelRedirectUri);
    assert.equal(saveHttpsJson.data.instagram.loginMode, 'instagram_login');

    // Helper for raw HTTP requests with custom Host headers (Node fetch ignores Host override)
    const port = srv.server.address().port;
    const rawGet = (reqPath, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          }
        );
        req.on('error', reject);
        req.end();
      });

    // Non-callback routes must STILL reject the tunnel Host header (403 FORBIDDEN_HOST)
    const blockedSetup = await rawGet('/api/setup/status', { Host: tunnelHost });
    assert.equal(blockedSetup.status, 403);
    const blockedAccounts = await rawGet('/api/accounts', { Host: tunnelHost });
    assert.equal(blockedAccounts.status, 403);
    const blockedRoot = await rawGet('/', { Host: tunnelHost });
    assert.equal(blockedRoot.status, 403);

    // Mismatched external Host on the callback route must ALSO fail 403
    const blockedEvilCb = await rawGet('/api/accounts/oauth/callback/instagram?code=x&state=y', {
      Host: 'evil.example.com',
    });
    assert.equal(blockedEvilCb.status, 403);

    // Foreign Origin on the allowed tunnel callback must still fail 403 FORBIDDEN_ORIGIN
    const blockedOriginCb = await rawGet('/api/accounts/oauth/callback/instagram?code=x&state=y', {
      Host: tunnelHost,
      Origin: 'https://evil.example',
    });
    assert.equal(blockedOriginCb.status, 403);

    // Mock Instagram OAuth endpoints (using Meta's `{ data: [{ access_token }] }` format)
    let capturedExchangeBody = '';
    srv.ctx.services.accountService.instagramOAuth.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://api.instagram.com/oauth/access_token') {
        capturedExchangeBody = String(init.body || '');
        return new Response(
          JSON.stringify({ data: [{ access_token: 'IG_SHORT_TOKEN', user_id: '17841436528234277' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://graph.instagram.com/access_token')) {
        return new Response(
          JSON.stringify({ access_token: 'IGAA_LONG_LIVED_TOKEN', expires_in: 5184000 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://graph.instagram.com/v22.0/me')) {
        return new Response(
          JSON.stringify({
            user_id: '17841436528234277',
            username: 'stablehawk',
            name: 'StableHawk',
            account_type: 'CREATOR',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    // Bootstrap dashboard session & start Instagram OAuth flow
    const bootCode = srv.ctx.bootstrapManager.issue();
    const bootRes = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapCode: bootCode }),
    });
    const sessionCookie = bootRes.headers.get('set-cookie').split(';')[0];
    const { data: { csrfToken } } = await bootRes.json();

    const connectRes = await fetch(`${srv.baseUrl}/api/accounts/connect/instagram`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'StableHawk IG', igLoginMode: 'instagram_login' }),
    });
    assert.equal(connectRes.status, 200);
    const connectJson = await connectRes.json();
    const authUrl = new URL(connectJson.data.authorizationUrl);
    assert.equal(authUrl.origin + authUrl.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.equal(authUrl.searchParams.get('redirect_uri'), tunnelRedirectUri);
    assert.equal(authUrl.searchParams.get('enable_fb_login'), 'false');
    assert.equal(authUrl.searchParams.get('force_reauth'), 'true');
    const oauthState = authUrl.searchParams.get('state');
    const oauthBindCookie = (connectRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(oauthBindCookie.startsWith('smp_oauth_session='));

    // 1) Meta redirects browser to HTTPS tunnel callback (NO cookies on tunnel host) -> 302 loopback handoff
    const tunnelCb = await rawGet(
      `/api/accounts/oauth/callback/instagram?code=${encodeURIComponent('ig_auth_code_1#_')}&state=${encodeURIComponent(oauthState)}`,
      { Host: tunnelHost }
    );
    assert.equal(tunnelCb.status, 302);
    const handoffUrl = new URL(tunnelCb.headers.location);
    assert.equal(handoffUrl.origin, `http://127.0.0.1:${port}`);
    assert.equal(handoffUrl.pathname, '/api/accounts/oauth/callback/instagram');

    // 2) Browser follows 302 to 127.0.0.1 WITH smp_oauth_session cookie -> completes token exchange
    const localCbRes = await fetch(handoffUrl.toString(), {
      headers: { Cookie: oauthBindCookie },
    });
    assert.equal(localCbRes.status, 200);
    const localCbHtml = await localCbRes.text();
    assert.match(localCbHtml, /StableHawk IG/);
    assert.ok(capturedExchangeBody.includes(`redirect_uri=${encodeURIComponent(tunnelRedirectUri)}`));
    assert.ok(capturedExchangeBody.includes('code=ig_auth_code_1'));

    // Resetting redirectUri to empty restores default local loopback URI
    const resetRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ instagram: { redirectUri: '' } }),
    });
    assert.equal(resetRes.status, 200);
    const resetJson = await resetRes.json();
    assert.match(resetJson.data.instagram.redirectUri, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await srv.cleanup();
  }
});

test('Meta Unified Login enforces config_id/HTTPS, rejects pasted tokens, handles Cloudflare callback, SUAT exchange, assigned account discovery, and keeps legacy facebook_login independent', async () => {
  const http = await import('node:http');
  const srv = await startTestServer();
  try {
    const authHeaders = {
      Authorization: `Bearer ${srv.ipcSecret}`,
      'Content-Type': 'application/json',
    };

    // 1. Reject accidentally pasted Meta/IG access tokens in App ID / App Secret fields
    const tokenAsSecretRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          appId: '123456789012345',
          appSecret: 'EAAG1234567890abcdefghijklmnopQRSTUVWXYZ123456',
          loginMode: 'meta_unified_login',
        },
      }),
    });
    assert.equal(tokenAsSecretRes.status, 400);
    const tokenAsIdRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          appId: 'IGAAR1234567890abcdefghijklmnopQRSTUVWXYZ123456',
          loginMode: 'meta_unified_login',
        },
      }),
    });
    assert.equal(tokenAsIdRes.status, 400);

    // 2. Save App ID & App Secret without HTTPS / config_id -> configured stays false until config_id is saved
    const partialRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          appId: '987654321098765',
          appSecret: 'meta_app_secret_example_1234',
          loginMode: 'meta_unified_login',
        },
      }),
    });
    assert.equal(partialRes.status, 200);
    const partialJson = await partialRes.json();
    assert.equal(partialJson.data.instagram.loginMode, 'meta_unified_login');
    assert.equal(partialJson.data.instagram.configured, false);

    // Missing HTTPS redirect fails clearly for meta_unified_login
    const noHttpsRes = await fetch(`${srv.baseUrl}/api/accounts/connect/instagram`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ igLoginMode: 'meta_unified_login' }),
    });
    assert.equal(noHttpsRes.status, 400);
    assert.equal((await noHttpsRes.json()).error.code, 'INSTAGRAM_HTTPS_REDIRECT_REQUIRED');

    // Save HTTPS Cloudflare tunnel URI without config_id -> still fails clearly with INSTAGRAM_CONFIG_ID_REQUIRED
    const tunnelHost = 'unified-reels.trycloudflare.com';
    const tunnelRedirectUri = `https://${tunnelHost}/api/accounts/oauth/callback/instagram`;
    await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ instagram: { redirectUri: tunnelRedirectUri } }),
    });
    const noConfigRes = await fetch(`${srv.baseUrl}/api/accounts/connect/instagram`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ igLoginMode: 'meta_unified_login' }),
    });
    assert.equal(noConfigRes.status, 400);
    assert.equal((await noConfigRes.json()).error.code, 'INSTAGRAM_CONFIG_ID_REQUIRED');

    // 3. Save Configuration ID -> configured becomes true, never exposes raw appSecret
    const fullSaveRes = await fetch(`${srv.baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        instagram: {
          configId: '1608840587925023',
          loginMode: 'meta_unified_login',
          redirectUri: tunnelRedirectUri,
        },
      }),
    });
    assert.equal(fullSaveRes.status, 200);
    const fullSaveJson = await fullSaveRes.json();
    assert.equal(fullSaveJson.data.instagram.configured, true);
    assert.equal(fullSaveJson.data.instagram.configId, '1608840587925023');
    assert.equal(fullSaveJson.data.instagram.hasAppSecret, true);
    assert.equal(JSON.stringify(fullSaveJson).includes('meta_app_secret_example_1234'), false);

    // 4. Verify Unified Login authorization URL parameters (no `scope`, uses Facebook Login for Business)
    const bootCode = srv.ctx.bootstrapManager.issue();
    const bootRes = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapCode: bootCode }),
    });
    const sessionCookie = bootRes.headers.get('set-cookie').split(';')[0];
    const { data: { csrfToken } } = await bootRes.json();

    const connectRes = await fetch(`${srv.baseUrl}/api/accounts/connect/instagram`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'StableHawk', igLoginMode: 'meta_unified_login' }),
    });
    assert.equal(connectRes.status, 200);
    const connectJson = await connectRes.json();
    assert.equal(connectJson.data.loginMode, 'meta_unified_login');
    const authUrl = new URL(connectJson.data.authorizationUrl);
    assert.equal(authUrl.origin + authUrl.pathname, 'https://www.facebook.com/v22.0/dialog/oauth');
    assert.equal(authUrl.searchParams.get('client_id'), '987654321098765');
    assert.equal(authUrl.searchParams.get('config_id'), '1608840587925023');
    assert.equal(authUrl.searchParams.get('redirect_uri'), tunnelRedirectUri);
    assert.equal(authUrl.searchParams.get('response_type'), 'code');
    assert.equal(authUrl.searchParams.get('override_default_response_type'), 'true');
    assert.equal(authUrl.searchParams.get('scope'), null);
    const oauthState = authUrl.searchParams.get('state');
    const oauthBindCookie = (connectRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(oauthState && oauthState.length >= 32);

    // 5. Mock Graph API Unified Login endpoints
    let exchangeUrlSeen = null;
    let debugTokenUrlSeen = null;
    let assignedEndpointCalled = false;

    srv.ctx.services.accountService.instagramOAuth.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith('https://graph.facebook.com/v22.0/oauth/access_token')) {
        exchangeUrlSeen = new URL(u);
        return new Response(
          JSON.stringify({ access_token: 'EAAG_SUAT_STABLEHAWK_TOKEN_123456', token_type: 'bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://graph.facebook.com/v22.0/debug_token')) {
        debugTokenUrlSeen = new URL(u);
        return new Response(
          JSON.stringify({
            data: {
              app_id: '987654321098765',
              type: 'SYSTEM_USER',
              is_valid: true,
              expires_at: 0,
              scopes: ['instagram_basic', 'instagram_content_publish'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://graph.facebook.com/v22.0/me/assigned_instagram_accounts')) {
        assignedEndpointCalled = true;
        assert.equal(init.headers?.Authorization, 'Bearer EAAG_SUAT_STABLEHAWK_TOKEN_123456');
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '17841436528234277',
                username: 'stablehawk',
                name: 'StableHawk',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.startsWith('https://graph.facebook.com/v22.0/17841436528234277')) {
        return new Response(
          JSON.stringify({ id: '17841436528234277', username: 'stablehawk' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    // Tunnel request on non-callback routes still blocked (403 FORBIDDEN_HOST)
    const port = srv.server.address().port;
    const rawGet = (reqPath, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          }
        );
        req.on('error', reject);
        req.end();
      });

    assert.equal((await rawGet('/api/accounts', { Host: tunnelHost })).status, 403);

    // 6. Tunnel callback redirects 302 -> 127.0.0.1 & exchanges code with App ID + App Secret
    const tunnelCb = await rawGet(
      `/api/accounts/oauth/callback/instagram?code=${encodeURIComponent('unified_code_xyz#_')}&state=${encodeURIComponent(oauthState)}`,
      { Host: tunnelHost }
    );
    assert.equal(tunnelCb.status, 302);
    const handoffUrl = new URL(tunnelCb.headers.location);
    assert.equal(handoffUrl.origin, `http://127.0.0.1:${port}`);

    const localCbRes = await fetch(handoffUrl.toString(), {
      headers: { Cookie: oauthBindCookie },
    });
    assert.equal(localCbRes.status, 200);
    assert.match(await localCbRes.text(), /StableHawk/);

    assert.ok(exchangeUrlSeen, 'Expected GET /oauth/access_token exchange');
    assert.equal(exchangeUrlSeen.searchParams.get('client_id'), '987654321098765');
    assert.equal(exchangeUrlSeen.searchParams.get('client_secret'), 'meta_app_secret_example_1234');
    assert.equal(exchangeUrlSeen.searchParams.get('redirect_uri'), tunnelRedirectUri);
    assert.equal(exchangeUrlSeen.searchParams.get('code'), 'unified_code_xyz');
    assert.ok(debugTokenUrlSeen, 'Expected GET /debug_token verification');
    assert.equal(debugTokenUrlSeen.searchParams.get('access_token'), '987654321098765|meta_app_secret_example_1234');
    assert.equal(assignedEndpointCalled, true);

    const accounts = srv.ctx.services.accountService.listAccounts({ platform: 'instagram' });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].platformAccountId, '17841436528234277');
    assert.equal(accounts[0].username, '@stablehawk');
    assert.equal(accounts[0].tokenExpiresAt, null);
    assert.equal(accounts[0].metadata.loginMode, 'meta_unified_login');
    assert.deepEqual(accounts[0].scopes, ['instagram_basic', 'instagram_content_publish']);

    // Verify encrypted token vault does not expose plaintext in SQLite
    const rawAccount = srv.ctx.repos.accountsRepo.findInternalById(accounts[0].id);
    const tokens = srv.ctx.credentialStore.loadAccountTokens({
      accountId: rawAccount.id,
      platform: 'instagram',
      credentialRef: rawAccount.credentialRef,
    });
    assert.equal(tokens.accessToken, 'EAAG_SUAT_STABLEHAWK_TOKEN_123456');

    // Live health check & refresh succeed cleanly on non-expiring SUAT
    const statusRes = await fetch(`${srv.baseUrl}/api/accounts/${accounts[0].id}/status?live=true`, {
      headers: { Authorization: `Bearer ${srv.ipcSecret}` },
    });
    assert.equal(statusRes.status, 200);
    assert.equal((await statusRes.json()).data.account.connectionStatus, 'connected');

    const refreshRes = await fetch(`${srv.baseUrl}/api/accounts/${accounts[0].id}/refresh`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    });
    assert.equal(refreshRes.status, 200);
    const refreshJson = await refreshRes.json();
    assert.equal(refreshJson.data.account.connectionStatus, 'connected');
    assert.equal(refreshJson.data.account.tokenExpiresAt, null);

    // 7. Legacy facebook_login remains independently usable with scopes & no config_id
    const legacyFbStart = srv.ctx.services.accountService.startOAuthConnect({
      platform: 'instagram',
      igLoginMode: 'facebook_login',
      sessionBinding: 'ipc',
    });
    const legacyFbUrl = new URL(legacyFbStart.authorizationUrl);
    assert.equal(legacyFbUrl.origin + legacyFbUrl.pathname, 'https://www.facebook.com/v22.0/dialog/oauth');
    assert.equal(legacyFbUrl.searchParams.get('config_id'), null);
    assert.ok(legacyFbUrl.searchParams.get('scope')?.includes('instagram_content_publish'));
  } finally {
    await srv.cleanup();
  }
});

test('Meta Unified Login enforces publishing permissions, supports /me/accounts fallback, and upgrades short-lived tokens', async () => {
  // 1. Rejects when debug_token shows instagram_content_publish was NOT granted
  const missingPublishClient = new InstagramOAuthClient({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'EAAG_LIMITED_TOKEN_12345' }), { status: 200 });
      }
      if (u.includes('/debug_token')) {
        return new Response(
          JSON.stringify({ data: { is_valid: true, expires_at: 0, scopes: ['instagram_basic'] } }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    },
  });
  await assert.rejects(
    () =>
      missingPublishClient.exchangeCode({
        code: 'c1',
        appId: '111',
        appSecret: 'sec_111',
        redirectUri: 'https://t.example/cb',
        loginMode: 'meta_unified_login',
      }),
    (err) => err.code === 'MISSING_PUBLISHING_PERMISSION' && err.statusCode === 403
  );

  // 2. Falls back to /me/permissions when debug_token lacks scopes and rejects declined instagram_content_publish
  const declinedPermClient = new InstagramOAuthClient({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'EAAG_DECLINED_TOKEN_12345' }), { status: 200 });
      }
      if (u.includes('/debug_token')) {
        return new Response(JSON.stringify({ data: { is_valid: true, scopes: [] } }), { status: 200 });
      }
      if (u.includes('/me/permissions')) {
        return new Response(
          JSON.stringify({
            data: [
              { permission: 'instagram_basic', status: 'granted' },
              { permission: 'instagram_content_publish', status: 'declined' },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    },
  });
  await assert.rejects(
    () =>
      declinedPermClient.exchangeCode({
        code: 'c2',
        appId: '111',
        appSecret: 'sec_111',
        redirectUri: 'https://t.example/cb',
        loginMode: 'meta_unified_login',
      }),
    (err) => err.code === 'MISSING_PUBLISHING_PERMISSION'
  );

  // 3. Upgrades short-lived token via fb_exchange_token and falls back to /me/accounts when /me/assigned_instagram_accounts is empty
  let upgradedCalled = false;
  let fallbackPagesCalled = false;
  const fallbackClient = new InstagramOAuthClient({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('grant_type=fb_exchange_token')) {
        upgradedCalled = true;
        return new Response(
          JSON.stringify({ access_token: 'EAAG_LONG_UPGRADED_99999', expires_in: 5184000 }),
          { status: 200 }
        );
      }
      if (u.includes('/oauth/access_token')) {
        return new Response(
          JSON.stringify({ access_token: 'EAAG_SHORT_TOKEN_12345', expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (u.includes('/debug_token')) {
        return new Response(
          JSON.stringify({
            data: {
              is_valid: true,
              granular_scopes: [
                { scope: 'instagram_basic', target_ids: ['17841436528234277'] },
                { scope: 'instagram_content_publish', target_ids: ['17841436528234277'] },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (u.includes('/me/assigned_instagram_accounts')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (u.includes('/me/accounts')) {
        fallbackPagesCalled = true;
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'page_1',
                name: 'StableHawk Page',
                instagram_business_account: {
                  id: '17841436528234277',
                  username: 'stablehawk',
                  name: 'StableHawk',
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    },
  });

  const exchanged = await fallbackClient.exchangeCode({
    code: 'c3',
    appId: '111',
    appSecret: 'sec_111',
    redirectUri: 'https://t.example/cb',
    loginMode: 'meta_unified_login',
  });
  assert.equal(upgradedCalled, true);
  assert.equal(fallbackPagesCalled, true);
  assert.equal(exchanged.accessToken, 'EAAG_LONG_UPGRADED_99999');
  assert.ok(exchanged.expiresAt);
  assert.equal(exchanged.accounts[0].igUserId, '17841436528234277');
  assert.equal(exchanged.accounts[0].facebookPageId, 'page_1');
});

