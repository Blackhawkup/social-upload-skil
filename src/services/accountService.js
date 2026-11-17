import crypto from 'node:crypto';
import { PlatformError } from './retry.js';
import { sanitizeErrorMessage } from '../security/redact.js';

export class AccountService {
  constructor({
    accountsRepo,
    credentialStore,
    oauthStateManager,
    youtubeOAuth,
    instagramOAuth,
    config,
    logger = null,
  }) {
    this.accountsRepo = accountsRepo;
    this.credentialStore = credentialStore;
    this.oauthStateManager = oauthStateManager;
    this.youtubeOAuth = youtubeOAuth;
    this.instagramOAuth = instagramOAuth;
    this.config = config;
    this.logger = logger;
  }

  listAccounts({ platform = null } = {}) {
    return this.accountsRepo.listAll({ platform });
  }

  getAccount(accountId) {
    const account = this.accountsRepo.findPublicById(accountId);
    if (!account) {
      throw new PlatformError(`Social account not found: ${accountId}`, {
        code: 'ACCOUNT_NOT_FOUND',
        statusCode: 404,
      });
    }
    return account;
  }

  resolveAccountsByQuery(queries, platform = null) {
    const all = this.accountsRepo.listAll({ platform });
    if (!queries || queries.length === 0) return all;
    const matched = [];
    const seen = new Set();

    for (const q of queries) {
      const hits = this.accountsRepo.findByNameOrId(q, platform);
      for (const hit of hits) {
        if (!seen.has(hit.id)) {
          seen.add(hit.id);
          matched.push(hit);
        }
      }
    }
    return matched;
  }

  startOAuthConnect({
    platform,
    displayName = null,
    igLoginMode = null,
    sessionBinding = 'ipc',
    accountIdToReauth = null,
  }) {
    const creds = this.credentialStore.resolveEffectiveCredentials(this.config);
    const mode = accountIdToReauth ? 'reauthorize' : 'connect';

    if (accountIdToReauth) {
      const existing = this.accountsRepo.findPublicById(accountIdToReauth);
      if (!existing || existing.platform !== platform) {
        throw new PlatformError('Account not found for reauthorization.', {
          code: 'ACCOUNT_NOT_FOUND',
          statusCode: 404,
        });
      }
    }

    if (platform === 'youtube') {
      const redirectUri = creds.youtube.redirectUri;
      const stateInfo = this.oauthStateManager.createState({
        platform: 'youtube',
        mode,
        accountId: accountIdToReauth,
        displayName,
        sessionBinding,
        redirectUri,
        usePkce: true,
      });

      const authorizationUrl = this.youtubeOAuth.buildAuthorizationUrl({
        clientId: creds.youtube.clientId,
        redirectUri,
        state: stateInfo.state,
        codeChallenge: stateInfo.codeChallenge,
        codeChallengeMethod: stateInfo.codeChallengeMethod,
      });

      return {
        platform: 'youtube',
        mode,
        stateId: stateInfo.stateId,
        authorizationUrl,
        expiresAt: stateInfo.expiresAt,
      };
    }

    if (platform === 'instagram') {
      const effectiveLoginMode = igLoginMode || creds.instagram.loginMode || 'meta_unified_login';
      const redirectUri = creds.instagram.redirectUri;
      if (
        (effectiveLoginMode === 'meta_unified_login' || effectiveLoginMode === 'instagram_login') &&
        !/^https:\/\//i.test(String(redirectUri || ''))
      ) {
        const label = effectiveLoginMode === 'meta_unified_login' ? 'Meta Unified Login' : 'Instagram Login';
        throw new PlatformError(
          `${label} requires a public https:// Redirect URI (Meta rejects http://127.0.0.1). Run \`npm run tunnel\` or save your https:// Redirect URI in Dashboard -> Setup & Credentials first.`,
          { code: 'INSTAGRAM_HTTPS_REDIRECT_REQUIRED', statusCode: 400 }
        );
      }
      if (effectiveLoginMode === 'meta_unified_login' && !String(creds.instagram.configId || '').trim()) {
        throw new PlatformError(
          'Meta Unified Login Configuration ID (config_id) is required. Save your Configuration ID in Dashboard -> Setup & Credentials first.',
          { code: 'INSTAGRAM_CONFIG_ID_REQUIRED', statusCode: 400 }
        );
      }
      const stateInfo = this.oauthStateManager.createState({
        platform: 'instagram',
        mode,
        accountId: accountIdToReauth,
        displayName,
        igLoginMode: effectiveLoginMode,
        sessionBinding,
        redirectUri,
        usePkce: false,
      });

      const authorizationUrl = this.instagramOAuth.buildAuthorizationUrl({
        appId: creds.instagram.appId,
        configId: creds.instagram.configId,
        redirectUri,
        state: stateInfo.state,
        graphApiVersion: creds.instagram.graphApiVersion,
        loginMode: effectiveLoginMode,
      });

      return {
        platform: 'instagram',
        mode,
        loginMode: effectiveLoginMode,
        stateId: stateInfo.stateId,
        authorizationUrl,
        expiresAt: stateInfo.expiresAt,
      };
    }

    throw new PlatformError(`Unsupported platform: ${platform}`, {
      code: 'UNSUPPORTED_PLATFORM',
      statusCode: 400,
    });
  }

  async handleOAuthCallback({ platform, code, state, error = null, errorDescription = null, expectedSessionBinding = null }) {
    if (error) {
      throw new PlatformError(`OAuth authorization denied: ${sanitizeErrorMessage(errorDescription || error)}`, {
        code: 'OAUTH_DENIED',
        statusCode: 400,
      });
    }
    if (!code || !state) {
      throw new PlatformError('Missing OAuth authorization code or state parameter.', {
        code: 'INVALID_OAUTH_CALLBACK',
        statusCode: 400,
      });
    }

    const consumed = this.oauthStateManager.consumeState({
      rawState: state,
      expectedPlatform: platform,
      expectedSessionBinding,
    });
    const creds = this.credentialStore.resolveEffectiveCredentials(this.config);

    if (platform === 'youtube') {
      const tokenData = await this.youtubeOAuth.exchangeCode({
        code,
        codeVerifier: consumed.codeVerifier,
        clientId: creds.youtube.clientId,
        clientSecret: creds.youtube.clientSecret,
        redirectUri: consumed.redirectUri,
      });
      const channel = await this.youtubeOAuth.fetchAuthenticatedChannel(tokenData.accessToken);

      const existing = consumed.accountId
        ? this.accountsRepo.findInternalById(consumed.accountId)
        : this.accountsRepo.findInternalByPlatformAccountId('youtube', channel.channelId);

      const accountId = existing?.id || `acc_${crypto.randomBytes(8).toString('hex')}`;
      const credentialRef = existing?.credentialRef || this.credentialStore.createCredentialRef('yt');
      const existingTokens = existing
        ? this.credentialStore.loadAccountTokens({
            accountId: existing.id,
            platform: 'youtube',
            credentialRef: existing.credentialRef,
          })
        : null;
      const effectiveTokens = {
        ...tokenData,
        refreshToken: tokenData.refreshToken || existingTokens?.refreshToken || '',
      };

      this.credentialStore.saveAccountTokens({
        accountId,
        platform: 'youtube',
        credentialRef,
        tokens: effectiveTokens,
      });

      const saved = this.accountsRepo.upsertAccount({
        id: accountId,
        platform: 'youtube',
        displayName: consumed.displayName || existing?.displayName || channel.title,
        username: channel.customUrl || channel.title,
        platformAccountId: channel.channelId,
        connectionStatus: 'connected',
        credentialRef,
        tokenExpiresAt: effectiveTokens.expiresAt,
        scopes: tokenData.scope ? tokenData.scope.split(/\s+/) : [],
        preferences: existing?.preferences || {
          defaultPrivacyStatus: 'private',
          defaultCategoryId: '22',
          defaultTags: [],
          autoDetectShorts: true,
        },
        metadata: {
          channelTitle: channel.title,
          customUrl: channel.customUrl,
          thumbnailUrl: channel.thumbnailUrl,
          madeForKids: channel.madeForKids,
        },
      });

      this.logger?.info('Connected YouTube account', { accountId: saved.id, displayName: saved.displayName });
      return [this.accountsRepo.findPublicById(saved.id)];
    }

    if (platform === 'instagram') {
      const exchange = await this.instagramOAuth.exchangeCode({
        code,
        appId: creds.instagram.appId,
        appSecret: creds.instagram.appSecret,
        redirectUri: consumed.redirectUri,
        graphApiVersion: creds.instagram.graphApiVersion,
        loginMode: consumed.igLoginMode || creds.instagram.loginMode,
      });

      const connected = [];
      for (const igAcc of exchange.accounts) {
        const existing = consumed.accountId
          ? this.accountsRepo.findInternalById(consumed.accountId)
          : this.accountsRepo.findInternalByPlatformAccountId('instagram', igAcc.igUserId);

        // If reauthorizing a specific account, only update that IG account if multiple returned
        if (consumed.accountId && existing && existing.platformAccountId !== igAcc.igUserId && exchange.accounts.length > 1) {
          continue;
        }

        const accountId = existing?.id || `acc_${crypto.randomBytes(8).toString('hex')}`;
        const credentialRef = existing?.credentialRef || this.credentialStore.createCredentialRef('ig');

        this.credentialStore.saveAccountTokens({
          accountId,
          platform: 'instagram',
          credentialRef,
          tokens: {
            accessToken: exchange.accessToken,
            refreshToken: exchange.refreshToken,
            expiresAt: exchange.expiresAt,
            scope: exchange.scopes.join(','),
          },
        });

        const label =
          exchange.accounts.length === 1 && consumed.displayName
            ? consumed.displayName
            : existing?.displayName || (igAcc.username ? `@${igAcc.username}` : igAcc.name);

        const saved = this.accountsRepo.upsertAccount({
          id: accountId,
          platform: 'instagram',
          displayName: label,
          username: igAcc.username ? `@${igAcc.username.replace(/^@/, '')}` : null,
          platformAccountId: igAcc.igUserId,
          connectionStatus: 'connected',
          credentialRef,
          tokenExpiresAt: exchange.expiresAt,
          scopes: exchange.scopes,
          preferences: existing?.preferences || {
            shareToFeed: true,
          },
          metadata: {
            name: igAcc.name,
            accountType: igAcc.accountType,
            profilePictureUrl: igAcc.profilePictureUrl,
            facebookPageId: igAcc.facebookPageId,
            facebookPageName: igAcc.facebookPageName,
            loginMode: exchange.loginMode,
          },
        });
        connected.push(this.accountsRepo.findPublicById(saved.id));
        this.logger?.info('Connected Instagram account', { accountId: saved.id, displayName: saved.displayName });
      }

      if (connected.length === 0) {
        throw new PlatformError('Authorized Instagram account did not match the requested account.', {
          code: 'ACCOUNT_MISMATCH',
          statusCode: 400,
        });
      }
      return connected;
    }

    throw new PlatformError(`Unsupported platform: ${platform}`, { code: 'UNSUPPORTED_PLATFORM', statusCode: 400 });
  }

  async refreshAccountToken(accountId) {
    const account = this.accountsRepo.findInternalById(accountId);
    if (!account) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }

    const tokens = this.credentialStore.loadAccountTokens({
      accountId: account.id,
      platform: account.platform,
      credentialRef: account.credentialRef,
    });
    if (!tokens) {
      this.accountsRepo.updateTokenStatus(account.id, {
        connectionStatus: 'reauth_required',
        lastErrorCode: 'MISSING_CREDENTIALS',
        lastErrorMessage: 'Stored credentials missing; reauthorization required.',
      });
      throw new PlatformError('Account credentials not found; please reauthorize.', {
        code: 'REAUTH_REQUIRED',
        statusCode: 401,
      });
    }

    const creds = this.credentialStore.resolveEffectiveCredentials(this.config);

    try {
      let refreshed;
      if (account.platform === 'youtube') {
        refreshed = await this.youtubeOAuth.refreshAccessToken({
          refreshToken: tokens.refreshToken,
          clientId: creds.youtube.clientId,
          clientSecret: creds.youtube.clientSecret,
        });
      } else {
        refreshed = await this.instagramOAuth.refreshLongLivedToken({
          accessToken: tokens.accessToken,
          appId: creds.instagram.appId,
          appSecret: creds.instagram.appSecret,
          graphApiVersion: creds.instagram.graphApiVersion,
          loginMode: account.metadata?.loginMode || creds.instagram.loginMode,
        });
      }

      this.credentialStore.saveAccountTokens({
        accountId: account.id,
        platform: account.platform,
        credentialRef: account.credentialRef,
        tokens: {
          ...tokens,
          ...refreshed,
        },
      });

      return this.accountsRepo.updateTokenStatus(account.id, {
        connectionStatus: 'connected',
        tokenExpiresAt: refreshed.expiresAt,
      });
    } catch (err) {
      const code = err?.code === 'REAUTH_REQUIRED' ? 'reauth_required' : 'error';
      this.accountsRepo.updateTokenStatus(account.id, {
        connectionStatus: code,
        lastErrorCode: err?.code || 'TOKEN_REFRESH_FAILED',
        lastErrorMessage: sanitizeErrorMessage(err),
      });
      throw err;
    }
  }

  async ensureValidAccessToken(accountId) {
    const account = this.accountsRepo.findInternalById(accountId);
    if (!account) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    if (account.connectionStatus === 'disconnected') {
      throw new PlatformError(`Account "${account.displayName}" is disconnected. Reauthorize before publishing.`, {
        code: 'ACCOUNT_DISCONNECTED',
        statusCode: 401,
      });
    }

    const tokens = this.credentialStore.loadAccountTokens({
      accountId: account.id,
      platform: account.platform,
      credentialRef: account.credentialRef,
    });
    if (!tokens?.accessToken) {
      throw new PlatformError(`Missing access token for "${account.displayName}". Please reauthorize.`, {
        code: 'REAUTH_REQUIRED',
        statusCode: 401,
      });
    }

    const expiresMs = (tokens.expiresAt || account.tokenExpiresAt)
      ? new Date(tokens.expiresAt || account.tokenExpiresAt).getTime()
      : null;

    // Auto-refresh if expired or within 5 minutes of expiring (or for IG if within 7 days of 60-day expiry)
    const refreshThresholdMs = account.platform === 'instagram' ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
    const shouldRefresh = expiresMs !== null && !Number.isNaN(expiresMs) && expiresMs - Date.now() <= refreshThresholdMs;

    if (shouldRefresh) {
      await this.refreshAccountToken(account.id);
      const updatedTokens = this.credentialStore.loadAccountTokens({
        accountId: account.id,
        platform: account.platform,
        credentialRef: account.credentialRef,
      });
      return { account: this.accountsRepo.findInternalById(account.id), accessToken: updatedTokens.accessToken };
    }

    return { account, accessToken: tokens.accessToken };
  }

  async checkAccountStatus(accountId, { verifyLive = true } = {}) {
    const account = this.accountsRepo.findInternalById(accountId);
    if (!account) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    if (!verifyLive || account.connectionStatus === 'disconnected') {
      return this.accountsRepo.findPublicById(accountId);
    }

    try {
      const { accessToken } = await this.ensureValidAccessToken(accountId);
      const creds = this.credentialStore.resolveEffectiveCredentials(this.config);

      if (account.platform === 'youtube') {
        await this.youtubeOAuth.fetchAuthenticatedChannel(accessToken);
      } else {
        await this.instagramOAuth.verifyTokenHealth({
          igUserId: account.platformAccountId,
          accessToken,
          appId: creds.instagram.appId,
          appSecret: creds.instagram.appSecret,
          graphApiVersion: creds.instagram.graphApiVersion,
          loginMode: account.metadata?.loginMode || creds.instagram.loginMode,
        });
      }

      return this.accountsRepo.updateTokenStatus(accountId, {
        connectionStatus: 'connected',
      });
    } catch (err) {
      const nextStatus = err?.code === 'REAUTH_REQUIRED' ? 'reauth_required' : 'error';
      return this.accountsRepo.updateTokenStatus(accountId, {
        connectionStatus: nextStatus,
        lastErrorCode: err?.code || 'STATUS_CHECK_FAILED',
        lastErrorMessage: sanitizeErrorMessage(err),
      });
    }
  }

  updatePreferences(accountId, patch) {
    const updated = this.accountsRepo.updatePreferences(accountId, patch);
    if (!updated) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    return updated;
  }

  disconnectAccount(accountId) {
    const account = this.accountsRepo.findInternalById(accountId);
    if (!account) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    this.credentialStore.deleteAccountTokens(account.credentialRef);
    return this.accountsRepo.updateTokenStatus(accountId, {
      connectionStatus: 'disconnected',
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  }

  deleteAccount(accountId) {
    const account = this.accountsRepo.findInternalById(accountId);
    if (!account) {
      throw new PlatformError(`Account not found: ${accountId}`, { code: 'ACCOUNT_NOT_FOUND', statusCode: 404 });
    }
    this.credentialStore.deleteAccountTokens(account.credentialRef);
    this.accountsRepo.deleteById(accountId);
    return { deleted: true, accountId };
  }
}

