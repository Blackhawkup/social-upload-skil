import { PlatformError } from '../../services/retry.js';
import { registerSensitiveValue, sanitizeErrorMessage } from '../../security/redact.js';

export const UNIFIED_LOGIN_REQUIRED_PERMISSIONS = [
  'instagram_basic',
  'instagram_content_publish',
];

export const FACEBOOK_LOGIN_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
];

export const INSTAGRAM_LOGIN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
];

export function evaluateUnifiedLoginPermissions(grantedScopes = [], declinedScopes = []) {
  const grantedSet = new Set(
    (grantedScopes || []).map((s) => String(s || '').trim()).filter(Boolean)
  );
  const declinedList = [
    ...new Set((declinedScopes || []).map((s) => String(s || '').trim()).filter(Boolean)),
  ];

  const hasBasic = grantedSet.has('instagram_basic') || grantedSet.has('instagram_business_basic');
  const hasPublish =
    grantedSet.has('instagram_content_publish') || grantedSet.has('instagram_business_content_publish');

  const missing = [];
  if (!hasBasic) missing.push('instagram_basic');
  if (!hasPublish) missing.push('instagram_content_publish');

  return {
    ok: hasBasic && hasPublish,
    hasBasic,
    hasPublish,
    missing,
    declined: declinedList,
    scopes: [...grantedSet],
  };
}

export class InstagramOAuthClient {
  constructor({ fetchImpl = fetch, logger = null } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async #safeFetch(url, options) {
    try {
      return await this.fetch(url, options);
    } catch (err) {
      throw new PlatformError(`Meta API request failed: ${sanitizeErrorMessage(err)}`, {
        code: 'META_NETWORK_ERROR',
        statusCode: 502,
        retryable: true,
      });
    }
  }

  buildAuthorizationUrl({
    appId,
    configId = '',
    redirectUri,
    state,
    graphApiVersion = 'v22.0',
    loginMode = 'meta_unified_login',
  }) {
    if (!appId) {
      throw new PlatformError('Meta App ID is not configured. Configure it in the local setup UI or .env.', {
        code: 'INSTAGRAM_NOT_CONFIGURED',
        statusCode: 400,
      });
    }

    if (loginMode === 'meta_unified_login') {
      const cleanConfigId = String(configId || '').trim();
      if (!cleanConfigId) {
        throw new PlatformError(
          'Meta Unified Login Configuration ID (config_id) is required. Save it in Dashboard -> Setup & Credentials.',
          {
            code: 'INSTAGRAM_CONFIG_ID_REQUIRED',
            statusCode: 400,
          }
        );
      }
      // Facebook Login for Business / Instagram Unified Login uses config_id + override_default_response_type
      // and must NOT include a `scope` parameter alongside `config_id`.
      const params = new URLSearchParams({
        client_id: String(appId).trim(),
        redirect_uri: redirectUri,
        config_id: cleanConfigId,
        response_type: 'code',
        override_default_response_type: 'true',
        state,
      });
      return `https://www.facebook.com/${graphApiVersion}/dialog/oauth?${params.toString()}`;
    }

    if (loginMode === 'instagram_login') {
      const params = new URLSearchParams({
        enable_fb_login: 'false',
        force_reauth: 'true',
        client_id: appId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: INSTAGRAM_LOGIN_SCOPES.join(','),
        state,
      });
      return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
    }

    if (loginMode === 'facebook_login') {
      const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        state,
        scope: FACEBOOK_LOGIN_SCOPES.join(','),
        response_type: 'code',
        auth_type: 'rerequest',
      });
      return `https://www.facebook.com/${graphApiVersion}/dialog/oauth?${params.toString()}`;
    }

    throw new PlatformError(`Unsupported Instagram OAuth login mode: ${loginMode}`, {
      code: 'UNSUPPORTED_INSTAGRAM_LOGIN_MODE',
      statusCode: 400,
    });
  }

  async exchangeCode({
    code,
    appId,
    appSecret,
    redirectUri,
    graphApiVersion = 'v22.0',
    loginMode = 'meta_unified_login',
  }) {
    if (!appId || !appSecret) {
      throw new PlatformError('Meta App credentials are not configured.', {
        code: 'INSTAGRAM_NOT_CONFIGURED',
        statusCode: 400,
      });
    }
    registerSensitiveValue(appSecret);

    if (loginMode === 'meta_unified_login') {
      return await this.#exchangeMetaUnifiedLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion });
    }
    if (loginMode === 'instagram_login') {
      return await this.#exchangeInstagramLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion });
    }
    if (loginMode === 'facebook_login') {
      return await this.#exchangeFacebookLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion });
    }
    throw new PlatformError(`Unsupported Instagram OAuth login mode: ${loginMode}`, {
      code: 'UNSUPPORTED_INSTAGRAM_LOGIN_MODE',
      statusCode: 400,
    });
  }

  async #exchangeMetaUnifiedLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion }) {
    const cleanCode = String(code || '').replace(/#_$/, '').trim();
    if (!cleanCode) {
      throw new PlatformError('Missing OAuth authorization code.', {
        code: 'INVALID_OAUTH_CALLBACK',
        statusCode: 400,
      });
    }

    const tokenUrl = new URL(`https://graph.facebook.com/${graphApiVersion}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', String(appId).trim());
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', cleanCode);

    const tokenRes = await this.#safeFetch(tokenUrl.toString());
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new PlatformError(
        `Meta Unified Login OAuth exchange failed: ${sanitizeErrorMessage(tokenData?.error?.message || tokenRes.statusText)}`,
        { code: 'OAUTH_EXCHANGE_FAILED', statusCode: tokenRes.status || 400 }
      );
    }
    registerSensitiveValue(tokenData.access_token);

    let finalToken = tokenData.access_token;
    let expiresAt = null;
    const rawExpiresIn = Number(tokenData.expires_in || 0);

    if (Number.isFinite(rawExpiresIn) && rawExpiresIn > 0) {
      if (rawExpiresIn < 7 * 24 * 60 * 60) {
        // Short-lived user token: attempt long-lived exchange with Meta App Secret
        const longUrl = new URL(`https://graph.facebook.com/${graphApiVersion}/oauth/access_token`);
        longUrl.searchParams.set('grant_type', 'fb_exchange_token');
        longUrl.searchParams.set('client_id', String(appId).trim());
        longUrl.searchParams.set('client_secret', appSecret);
        longUrl.searchParams.set('fb_exchange_token', finalToken);

        const longRes = await this.#safeFetch(longUrl.toString());
        const longData = await longRes.json().catch(() => ({}));
        if (longRes.ok && longData.access_token) {
          finalToken = longData.access_token;
          registerSensitiveValue(finalToken);
          const longExpiresIn = Number(longData.expires_in || 0);
          expiresAt = longExpiresIn > 0 ? new Date(Date.now() + longExpiresIn * 1000).toISOString() : null;
        } else {
          expiresAt = new Date(Date.now() + rawExpiresIn * 1000).toISOString();
        }
      } else {
        expiresAt = new Date(Date.now() + rawExpiresIn * 1000).toISOString();
      }
    }

    const permInfo = await this.verifyTokenPermissions({
      accessToken: finalToken,
      appId,
      appSecret,
      graphApiVersion,
      failOnUnavailable: true,
    });
    if (!expiresAt && permInfo.expiresAt) {
      expiresAt = permInfo.expiresAt;
    }

    const accounts = await this.discoverInstagramAccounts(finalToken, {
      graphApiVersion,
      loginMode: 'meta_unified_login',
    });

    return {
      accessToken: finalToken,
      refreshToken: finalToken,
      expiresAt,
      scopes: permInfo.scopes,
      accounts,
      loginMode: 'meta_unified_login',
    };
  }

  async verifyTokenPermissions({
    accessToken,
    appId = '',
    appSecret = '',
    graphApiVersion = 'v22.0',
    failOnUnavailable = true,
  }) {
    if (appSecret) registerSensitiveValue(appSecret);
    if (accessToken) registerSensitiveValue(accessToken);

    let debugRes = null;
    let debugData = {};
    let debugExpiresAt = null;
    let debugScopes = [];

    if (appId && appSecret) {
      const debugUrl = new URL(`https://graph.facebook.com/${graphApiVersion}/debug_token`);
      debugUrl.searchParams.set('input_token', accessToken);
      debugUrl.searchParams.set('access_token', `${String(appId).trim()}|${appSecret}`);

      debugRes = await this.#safeFetch(debugUrl.toString());
      debugData = await debugRes.json().catch(() => ({}));

      if (debugRes.ok && debugData?.data) {
        if (debugData.data.is_valid === false) {
          throw new PlatformError(
            `Meta access token is invalid or revoked: ${sanitizeErrorMessage(debugData.data.error?.message || 'Token invalid')}`,
            { code: 'REAUTH_REQUIRED', statusCode: 401 }
          );
        }
        const expUnix = Number(debugData.data.expires_at || 0);
        if (Number.isFinite(expUnix) && expUnix > 0) {
          debugExpiresAt = new Date(expUnix * 1000).toISOString();
        }
        const topScopes = Array.isArray(debugData.data.scopes) ? debugData.data.scopes : [];
        const granularScopes = Array.isArray(debugData.data.granular_scopes)
          ? debugData.data.granular_scopes.map((g) => g?.scope).filter(Boolean)
          : [];
        debugScopes = [...new Set([...topScopes, ...granularScopes].map((s) => String(s).trim()).filter(Boolean))];

        if (debugScopes.length > 0) {
          const check = evaluateUnifiedLoginPermissions(debugScopes);
          if (!check.ok) {
            throw new PlatformError(
              `Missing required Instagram publishing permission(s): ${check.missing.join(', ')}. Ensure instagram_basic and instagram_content_publish are enabled in your Meta Unified Login Configuration and granted during login.`,
              {
                code: 'MISSING_PUBLISHING_PERMISSION',
                statusCode: 403,
                details: { grantedScopes: check.scopes, missingPermissions: check.missing },
              }
            );
          }
          return { scopes: check.scopes, expiresAt: debugExpiresAt, source: 'debug_token' };
        }
      } else if (debugData?.error?.code === 190 || debugRes.status === 401) {
        throw new PlatformError(
          `Meta token verification failed: ${sanitizeErrorMessage(debugData?.error?.message || debugRes.statusText)}`,
          { code: 'REAUTH_REQUIRED', statusCode: 401 }
        );
      }
    }

    const permRes = await this.#safeFetch(
      `https://graph.facebook.com/${graphApiVersion}/me/permissions`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const permData = await permRes.json().catch(() => ({}));

    if (permRes.ok && Array.isArray(permData?.data)) {
      const granted = [];
      const declined = [];
      for (const entry of permData.data) {
        if (!entry?.permission) continue;
        if (String(entry.status || '').toLowerCase() === 'granted') {
          granted.push(entry.permission);
        } else {
          declined.push(entry.permission);
        }
      }
      const check = evaluateUnifiedLoginPermissions(granted, declined);
      if (!check.ok) {
        const declinedNote = check.declined.length > 0 ? ` Declined: ${check.declined.join(', ')}.` : '';
        throw new PlatformError(
          `Missing required Instagram publishing permission(s): ${check.missing.join(', ')}.${declinedNote} Grant instagram_basic and instagram_content_publish during Meta Unified Login.`,
          {
            code: 'MISSING_PUBLISHING_PERMISSION',
            statusCode: 403,
            details: {
              grantedScopes: check.scopes,
              missingPermissions: check.missing,
              declinedPermissions: check.declined,
            },
          }
        );
      }
      return { scopes: check.scopes, expiresAt: debugExpiresAt, source: 'me_permissions' };
    }

    if (permData?.error?.code === 190 || permRes.status === 401) {
      throw new PlatformError(
        `Meta token expired or revoked: ${sanitizeErrorMessage(permData?.error?.message || permRes.statusText)}`,
        { code: 'REAUTH_REQUIRED', statusCode: 401 }
      );
    }

    if (debugRes?.ok && debugData?.data) {
      throw new PlatformError(
        'Meta Unified Login token has no granted Instagram publishing permissions (instagram_basic, instagram_content_publish).',
        {
          code: 'MISSING_PUBLISHING_PERMISSION',
          statusCode: 403,
          details: { grantedScopes: [], missingPermissions: UNIFIED_LOGIN_REQUIRED_PERMISSIONS },
        }
      );
    }

    if (failOnUnavailable) {
      const errMsg =
        permData?.error?.message ||
        debugData?.error?.message ||
        `debug_token HTTP ${debugRes?.status || 'n/a'}, permissions HTTP ${permRes.status}`;
      throw new PlatformError(
        `Unable to verify Meta Unified Login publishing permissions: ${sanitizeErrorMessage(errMsg)}`,
        { code: 'OAUTH_PERMISSION_CHECK_FAILED', statusCode: 403 }
      );
    }

    return { scopes: null, expiresAt: debugExpiresAt, source: 'unavailable' };
  }

  async #exchangeFacebookLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion }) {
    const shortRes = await this.fetch(`https://graph.facebook.com/${graphApiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });
    const shortData = await shortRes.json().catch(() => ({}));
    if (!shortRes.ok || !shortData.access_token) {
      throw new PlatformError(
        `Meta OAuth exchange failed: ${sanitizeErrorMessage(shortData?.error?.message || shortRes.statusText)}`,
        { code: 'OAUTH_EXCHANGE_FAILED', statusCode: shortRes.status }
      );
    }
    registerSensitiveValue(shortData.access_token);

    // Exchange short-lived token (~1h) for long-lived token (~60 days)
    const longRes = await this.fetch(`https://graph.facebook.com/${graphApiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortData.access_token,
      }).toString(),
    });
    const longData = await longRes.json().catch(() => ({}));
    const finalToken = longRes.ok && longData.access_token ? longData.access_token : shortData.access_token;
    const expiresIn = longRes.ok && longData.expires_in ? Number(longData.expires_in) : Number(shortData.expires_in || 5184000);
    registerSensitiveValue(finalToken);

    const accounts = await this.discoverInstagramAccounts(finalToken, { graphApiVersion, loginMode: 'facebook_login' });
    return {
      accessToken: finalToken,
      refreshToken: finalToken, // Meta long-lived token can be exchanged via fb_exchange_token while still valid
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scopes: FACEBOOK_LOGIN_SCOPES,
      accounts,
      loginMode: 'facebook_login',
    };
  }

  async #exchangeInstagramLoginCode({ code, appId, appSecret, redirectUri, graphApiVersion }) {
    const cleanCode = String(code || '').replace(/#_$/, '').trim();
    const shortRes = await this.fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: cleanCode,
      }).toString(),
    });
    const shortData = await shortRes.json().catch(() => ({}));
    const tokenEntry = Array.isArray(shortData?.data) ? shortData.data[0] : shortData;
    const shortToken = tokenEntry?.access_token;
    if (!shortRes.ok || !shortToken) {
      throw new PlatformError(
        `Instagram Login OAuth exchange failed: ${sanitizeErrorMessage(shortData?.error_message || shortData?.error?.message || shortRes.statusText)}`,
        { code: 'OAUTH_EXCHANGE_FAILED', statusCode: shortRes.status }
      );
    }
    registerSensitiveValue(shortToken);

    // Exchange for 60-day long-lived token
    const longUrl = new URL('https://graph.instagram.com/access_token');
    longUrl.searchParams.set('grant_type', 'ig_exchange_token');
    longUrl.searchParams.set('client_secret', appSecret);
    longUrl.searchParams.set('access_token', shortToken);

    const longRes = await this.fetch(longUrl.toString());
    const longData = await longRes.json().catch(() => ({}));
    const finalToken = longRes.ok && longData.access_token ? longData.access_token : shortToken;
    const expiresIn = longRes.ok && longData.expires_in ? Number(longData.expires_in) : 5184000;
    registerSensitiveValue(finalToken);

    const accounts = await this.discoverInstagramAccounts(finalToken, { graphApiVersion, loginMode: 'instagram_login' });
    return {
      accessToken: finalToken,
      refreshToken: finalToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scopes: INSTAGRAM_LOGIN_SCOPES,
      accounts,
      loginMode: 'instagram_login',
    };
  }

  async discoverInstagramAccounts(accessToken, { graphApiVersion = 'v22.0', loginMode = 'meta_unified_login' } = {}) {
    if (loginMode === 'instagram_login') {
      const res = await this.#safeFetch(
        `https://graph.instagram.com/${graphApiVersion}/me?fields=user_id,username,name,account_type,profile_picture_url`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user_id) {
        throw new PlatformError(
          `Failed to identify Instagram account: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`,
          { code: res.status === 401 ? 'TOKEN_EXPIRED' : 'INSTAGRAM_ACCOUNT_ERROR', statusCode: res.status }
        );
      }
      const accountType = data.account_type || 'BUSINESS';
      if (!['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(accountType).toUpperCase())) {
        throw new PlatformError(
          'Instagram account must be a Professional (Business or Creator) account to use the official publishing API.',
          { code: 'INSTAGRAM_PROFESSIONAL_REQUIRED', statusCode: 400 }
        );
      }
      return [
        {
          igUserId: String(data.user_id),
          username: data.username || null,
          name: data.name || data.username || 'Instagram Account',
          profilePictureUrl: data.profile_picture_url || null,
          accountType,
          facebookPageId: null,
          facebookPageName: null,
        },
      ];
    }

    if (loginMode === 'meta_unified_login') {
      const byId = new Map();
      let nextUrl = `https://graph.facebook.com/${graphApiVersion}/me/assigned_instagram_accounts?fields=id,username,name,profile_picture_url`;
      let assignedRes = null;
      let assignedData = {};

      for (let pageCount = 0; pageCount < 10 && nextUrl; pageCount++) {
        assignedRes = await this.#safeFetch(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        assignedData = await assignedRes.json().catch(() => ({}));

        if (!assignedRes.ok) {
          if (assignedData?.error?.code === 190 || assignedRes.status === 401) {
            throw new PlatformError(
              `Meta Unified Login token expired or revoked: ${sanitizeErrorMessage(assignedData?.error?.message || assignedRes.statusText)}`,
              { code: 'TOKEN_EXPIRED', statusCode: assignedRes.status || 401 }
            );
          }
          break;
        }

        for (const ig of assignedData.data || []) {
          if (!ig?.id) continue;
          const igId = String(ig.id);
          if (!byId.has(igId)) {
            byId.set(igId, {
              igUserId: igId,
              username: ig.username || null,
              name: ig.name || ig.username || 'Instagram Account',
              profilePictureUrl: ig.profile_picture_url || null,
              accountType: 'PROFESSIONAL',
              facebookPageId: null,
              facebookPageName: null,
            });
          }
        }

        const candidateNext = assignedData?.paging?.next;
        if (candidateNext) {
          try {
            const parsedNext = new URL(candidateNext);
            nextUrl = parsedNext.hostname === 'graph.facebook.com' ? candidateNext : null;
          } catch {
            nextUrl = null;
          }
        } else {
          nextUrl = null;
        }
      }

      // Best-effort fallback to /me/accounts for page-linked Business Login setups if no direct assigned accounts were returned
      if (byId.size === 0) {
        const pagesRes = await this.#safeFetch(
          `https://graph.facebook.com/${graphApiVersion}/me/accounts?fields=id,name,instagram_business_account{id,username,name,profile_picture_url}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        const pagesData = await pagesRes.json().catch(() => ({}));
        if (pagesRes.ok) {
          for (const page of pagesData.data || []) {
            const ig = page.instagram_business_account;
            if (!ig?.id) continue;
            const igId = String(ig.id);
            if (!byId.has(igId)) {
              byId.set(igId, {
                igUserId: igId,
                username: ig.username || null,
                name: ig.name || ig.username || page.name || 'Instagram Account',
                profilePictureUrl: ig.profile_picture_url || null,
                accountType: 'PROFESSIONAL',
                facebookPageId: String(page.id),
                facebookPageName: page.name || null,
              });
            }
          }
        } else if (pagesData?.error?.code === 190 || pagesRes.status === 401) {
          throw new PlatformError(
            `Meta Unified Login token expired or revoked: ${sanitizeErrorMessage(pagesData?.error?.message || pagesRes.statusText)}`,
            { code: 'TOKEN_EXPIRED', statusCode: pagesRes.status || 401 }
          );
        }
      }

      if (byId.size === 0) {
        if (assignedRes && !assignedRes.ok) {
          throw new PlatformError(
            `Failed to discover assigned Instagram Professional accounts: ${sanitizeErrorMessage(assignedData?.error?.message || assignedRes.statusText)}`,
            { code: 'INSTAGRAM_ACCOUNT_DISCOVERY_FAILED', statusCode: assignedRes.status || 400 }
          );
        }
        throw new PlatformError(
          'No Instagram Professional account was assigned to this Meta Unified Login session. Select your Instagram Business/Creator account and Business Portfolio in the Meta login prompt.',
          { code: 'NO_INSTAGRAM_PROFESSIONAL_ACCOUNT', statusCode: 404 }
        );
      }

      return [...byId.values()];
    }

    const pagesRes = await this.#safeFetch(
      `https://graph.facebook.com/${graphApiVersion}/me/accounts?fields=id,name,instagram_business_account{id,username,name,profile_picture_url}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const pagesData = await pagesRes.json().catch(() => ({}));
    if (!pagesRes.ok) {
      const code = pagesData?.error?.code === 190 ? 'TOKEN_EXPIRED' : 'INSTAGRAM_PAGE_DISCOVERY_FAILED';
      throw new PlatformError(
        `Failed to fetch linked Instagram Business/Creator accounts: ${sanitizeErrorMessage(pagesData?.error?.message || pagesRes.statusText)}`,
        { code, statusCode: pagesRes.status }
      );
    }

    const found = [];
    for (const page of pagesData.data || []) {
      const ig = page.instagram_business_account;
      if (ig?.id) {
        found.push({
          igUserId: String(ig.id),
          username: ig.username || null,
          name: ig.name || ig.username || page.name || 'Instagram Account',
          profilePictureUrl: ig.profile_picture_url || null,
          accountType: 'PROFESSIONAL',
          facebookPageId: String(page.id),
          facebookPageName: page.name || null,
        });
      }
    }

    if (found.length === 0) {
      throw new PlatformError(
        'No Instagram Business or Creator account linked to an authorized Facebook Page was found.',
        { code: 'NO_INSTAGRAM_PROFESSIONAL_ACCOUNT', statusCode: 404 }
      );
    }

    return found;
  }

  async refreshLongLivedToken({
    accessToken,
    appId,
    appSecret,
    graphApiVersion = 'v22.0',
    loginMode = 'meta_unified_login',
  }) {
    if (!accessToken) {
      throw new PlatformError('Missing Instagram access token; reauthorization required.', {
        code: 'REAUTH_REQUIRED',
        statusCode: 401,
      });
    }
    registerSensitiveValue(accessToken);

    if (loginMode === 'instagram_login') {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', accessToken);
      const res = await this.#safeFetch(url.toString());
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) {
        throw new PlatformError(
          `Instagram token refresh failed: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`,
          {
            code: data?.error?.code === 190 ? 'REAUTH_REQUIRED' : 'TOKEN_REFRESH_FAILED',
            statusCode: res.status,
            retryable: res.status >= 500,
          }
        );
      }
      registerSensitiveValue(data.access_token);
      return {
        accessToken: data.access_token,
        refreshToken: data.access_token,
        expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
      };
    }

    if (!appId || !appSecret) {
      throw new PlatformError('Meta App credentials are required to refresh long-lived tokens.', {
        code: 'INSTAGRAM_NOT_CONFIGURED',
        statusCode: 400,
      });
    }
    registerSensitiveValue(appSecret);

    // Unified Login typically issues a non-expiring Business Integration System User Access Token (SUAT).
    // Check debug_token first so valid non-expiring SUAT tokens verify cleanly instead of failing fb_exchange_token.
    if (loginMode === 'meta_unified_login') {
      const permCheck = await this.verifyTokenPermissions({
        accessToken,
        appId,
        appSecret,
        graphApiVersion,
        failOnUnavailable: false,
      });
      if (permCheck.source === 'debug_token' && !permCheck.expiresAt) {
        return {
          accessToken,
          refreshToken: accessToken,
          expiresAt: null,
          scopes: permCheck.scopes,
        };
      }
    }

    const res = await this.#safeFetch(`https://graph.facebook.com/${graphApiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: accessToken,
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const isAuthErr = data?.error?.code === 190 || res.status === 400 || res.status === 401;
      throw new PlatformError(
        `Meta token refresh failed: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`,
        {
          code: isAuthErr ? 'REAUTH_REQUIRED' : 'TOKEN_REFRESH_FAILED',
          statusCode: res.status,
          retryable: res.status >= 500,
        }
      );
    }

    registerSensitiveValue(data.access_token);
    return {
      accessToken: data.access_token,
      refreshToken: data.access_token,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
    };
  }

  async verifyTokenHealth({
    igUserId,
    accessToken,
    appId = '',
    appSecret = '',
    graphApiVersion = 'v22.0',
    loginMode = 'meta_unified_login',
  }) {
    const base = loginMode === 'instagram_login' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const fields = loginMode === 'instagram_login' ? 'user_id,username' : 'id,username';
    const target = loginMode === 'instagram_login' ? 'me' : igUserId;

    const res = await this.#safeFetch(`${base}/${graphApiVersion}/${target}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PlatformError(
        `Instagram account verification failed: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`,
        {
          code: data?.error?.code === 190 || res.status === 401 ? 'REAUTH_REQUIRED' : 'INSTAGRAM_STATUS_ERROR',
          statusCode: res.status,
        }
      );
    }

    if (loginMode === 'meta_unified_login') {
      const permCheck = await this.verifyTokenPermissions({
        accessToken,
        appId,
        appSecret,
        graphApiVersion,
        failOnUnavailable: false,
      });
      if (permCheck.scopes) {
        return { ...data, scopes: permCheck.scopes };
      }
    }

    return data;
  }
}

