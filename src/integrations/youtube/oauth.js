import { PlatformError } from '../../services/retry.js';
import { registerSensitiveValue, sanitizeErrorMessage } from '../../security/redact.js';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export class YouTubeOAuthClient {
  constructor({ fetchImpl = fetch, logger = null } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod = 'S256', loginHint = null }) {
    if (!clientId) {
      throw new PlatformError('YouTube OAuth Client ID is not configured. Configure it in the local setup UI or .env.', {
        code: 'YOUTUBE_NOT_CONFIGURED',
        statusCode: 400,
      });
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent select_account',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri }) {
    if (!clientId || !clientSecret) {
      throw new PlatformError('YouTube OAuth credentials are not configured.', {
        code: 'YOUTUBE_NOT_CONFIGURED',
        statusCode: 400,
      });
    }
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PlatformError(
        `Google OAuth token exchange failed: ${sanitizeErrorMessage(data.error_description || data.error || res.statusText)}`,
        { code: data.error || 'OAUTH_EXCHANGE_FAILED', statusCode: res.status }
      );
    }

    registerSensitiveValue(data.access_token);
    registerSensitiveValue(data.refresh_token);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || YOUTUBE_SCOPES.join(' '),
      expiresAt: data.expires_in
        ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
        : null,
    };
  }

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    if (!refreshToken) {
      throw new PlatformError('No YouTube refresh token available; reauthorization required.', {
        code: 'REAUTH_REQUIRED',
        statusCode: 401,
        retryable: false,
      });
    }
    if (!clientId || !clientSecret) {
      throw new PlatformError('YouTube OAuth client credentials are missing.', {
        code: 'YOUTUBE_NOT_CONFIGURED',
        statusCode: 400,
      });
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const isRevoked = data.error === 'invalid_grant' || res.status === 400 || res.status === 401;
      throw new PlatformError(
        `YouTube token refresh failed: ${sanitizeErrorMessage(data.error_description || data.error || res.statusText)}`,
        {
          code: isRevoked ? 'REAUTH_REQUIRED' : 'TOKEN_REFRESH_FAILED',
          statusCode: res.status,
          retryable: res.status >= 500 || res.status === 429,
        }
      );
    }

    registerSensitiveValue(data.access_token);
    if (data.refresh_token) registerSensitiveValue(data.refresh_token);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || YOUTUBE_SCOPES.join(' '),
      expiresAt: data.expires_in
        ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
        : null,
    };
  }

  async fetchAuthenticatedChannel(accessToken) {
    const res = await this.fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status&mine=true',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PlatformError(
        `Failed to identify YouTube channel: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`,
        {
          code: res.status === 401 ? 'TOKEN_EXPIRED' : 'YOUTUBE_CHANNEL_ERROR',
          statusCode: res.status,
          retryable: res.status >= 500 || res.status === 429,
        }
      );
    }

    const channel = data.items?.[0];
    if (!channel) {
      throw new PlatformError('No YouTube channel found on the authorized Google account.', {
        code: 'NO_YOUTUBE_CHANNEL',
        statusCode: 404,
      });
    }

    return {
      channelId: channel.id,
      title: channel.snippet?.title || 'YouTube Channel',
      customUrl: channel.snippet?.customUrl || null,
      thumbnailUrl: channel.snippet?.thumbnails?.default?.url || null,
      privacyStatus: channel.status?.privacyStatus || null,
      madeForKids: channel.status?.madeForKids ?? false,
    };
  }
}

