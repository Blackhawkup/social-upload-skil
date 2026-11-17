import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ensureRuntimeDirectories } from '../config/paths.js';
import { loadConfig } from '../config/env.js';
import { Logger } from '../logging/logger.js';
import { MasterKeyStore } from '../security/masterKeyStore.js';
import { CredentialStore } from '../security/credentialStore.js';
import { OAuthStateManager } from '../security/oauthState.js';
import { openDatabase } from '../db/database.js';
import { AccountsRepository } from '../db/repositories/accountsRepo.js';
import { OAuthStatesRepository } from '../db/repositories/oauthStatesRepo.js';
import { VideosRepository } from '../db/repositories/videosRepo.js';
import { JobsRepository } from '../db/repositories/jobsRepo.js';
import { TempObjectsRepository } from '../db/repositories/tempObjectsRepo.js';
import { R2UsageRepository } from '../db/repositories/r2UsageRepo.js';
import { SettingsRepository } from '../db/repositories/settingsRepo.js';
import { SessionsRepository } from '../db/repositories/sessionsRepo.js';
import { YouTubeOAuthClient } from '../integrations/youtube/oauth.js';
import { YouTubePublisher } from '../integrations/youtube/publisher.js';
import { InstagramOAuthClient } from '../integrations/instagram/oauth.js';
import { InstagramPublisher } from '../integrations/instagram/publisher.js';
import { TempCloudHostingAdapter } from '../integrations/storage/tempHosting.js';
import { AIProviderRouter } from '../ai/providers.js';
import { MetadataGenerator } from '../ai/metadataGenerator.js';
import { AccountService } from '../services/accountService.js';
import { VideoService } from '../services/videoService.js';
import { MetadataService } from '../services/metadataService.js';
import { PublishService } from '../services/publishService.js';
import {
  createRateLimiter,
  errorHandlerMiddleware,
  loopbackHostAndCorsMiddleware,
  securityHeadersMiddleware,
} from './middleware/security.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createHealthRouter } from './routes/health.js';
import { BootstrapTokenManager, createAuthRouter } from './routes/auth.js';
import { createSetupRouter } from './routes/setup.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createVideosRouter } from './routes/videos.js';
import { createCaptionsRouter } from './routes/captions.js';
import { createPublishRouter } from './routes/publish.js';
import { createSettingsRouter } from './routes/settings.js';
import { createStorageRouter } from './routes/storage.js';

export function buildApplication(options = {}) {
  const config = loadConfig(options.configOverrides || {});
  ensureRuntimeDirectories(config.paths);

  const logger =
    options.logger ||
    new Logger({
      level: config.logLevel,
      logFile: path.join(config.paths.logsDir, 'publisher.log'),
      toConsole: options.logToConsole ?? true,
    });

  const db = openDatabase(config.paths.dbPath);

  const masterKeyStore =
    options.masterKeyStore ||
    new MasterKeyStore({
      secretsDir: config.paths.secretsDir,
      mode: options.keyStoreMode || (process.platform === 'win32' ? 'wincred' : 'file'),
    });

  // Ensure master key & IPC secret are initialized early
  masterKeyStore.getMasterKey();
  masterKeyStore.getIpcSecret();

  const credentialStore = new CredentialStore({
    credentialsDir: config.paths.credentialsDir,
    masterKeyStore,
  });

  const accountsRepo = new AccountsRepository(db);
  const oauthStatesRepo = new OAuthStatesRepository(db);
  const videosRepo = new VideosRepository(db);
  const jobsRepo = new JobsRepository(db);
  const tempObjectsRepo = new TempObjectsRepository(db);
  const r2UsageRepo = new R2UsageRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const csrfHmacKey = crypto
    .createHmac('sha256', masterKeyStore.getMasterKey())
    .update('session-csrf-v1')
    .digest();
  const sessionsRepo = new SessionsRepository(db, { csrfHmacKey });

  // Recover interrupted jobs from any previous unexpected shutdown
  const recovery = jobsRepo.recoverInterruptedOnBoot();
  if (recovery.recoveredItems > 0) {
    logger.warn('Recovered interrupted publish items after startup', recovery);
  }

  const oauthStateManager = new OAuthStateManager({ oauthStatesRepo, masterKeyStore });

  const fetchImpl = options.fetchImpl || fetch;
  const youtubeOAuth = options.youtubeOAuth || new YouTubeOAuthClient({ fetchImpl, logger });
  const youtubePublisher = options.youtubePublisher || new YouTubePublisher({ fetchImpl, logger });
  const instagramOAuth = options.instagramOAuth || new InstagramOAuthClient({ fetchImpl, logger });
  const tempHosting =
    options.tempHosting ||
    new TempCloudHostingAdapter({
      tempObjectsRepo,
      r2UsageRepo,
      jobsRepo,
      fetchImpl,
      logger,
      mockDir: config.paths.mockStorageDir,
    });
  const instagramPublisher =
    options.instagramPublisher || new InstagramPublisher({ tempHosting, fetchImpl, logger });

  const aiProviderRouter = options.aiProviderRouter || new AIProviderRouter({ fetchImpl, logger });
  const metadataGenerator = new MetadataGenerator({ aiProviderRouter });

  const accountService = new AccountService({
    accountsRepo,
    credentialStore,
    oauthStateManager,
    youtubeOAuth,
    instagramOAuth,
    config,
    logger,
  });

  const videoService = new VideoService({ videosRepo, settingsRepo, config, logger });
  const metadataService = new MetadataService({
    videoService,
    videosRepo,
    accountsRepo,
    credentialStore,
    metadataGenerator,
    config,
  });

  const publishService = new PublishService({
    jobsRepo,
    accountsRepo,
    settingsRepo,
    accountService,
    videoService,
    metadataService,
    youtubePublisher,
    instagramPublisher,
    masterKeyStore,
    credentialStore,
    config,
    logger,
  });

  const bootstrapManager = new BootstrapTokenManager();
  const requireAuth = createAuthMiddleware({ masterKeyStore, sessionsRepo });

  function normalizeHttpsHost(hostValue) {
    const raw = String(hostValue || '').trim().toLowerCase();
    return raw.endsWith(':443') ? raw.slice(0, -4) : raw;
  }

  function allowExternalOAuthCallback(req) {
    if (req.method !== 'GET') return false;
    const match = /^\/api\/accounts\/oauth\/callback\/(youtube|instagram)$/.exec(req.path || '');
    if (!match) return false;
    const platform = match[1];
    try {
      const creds = credentialStore.resolveEffectiveCredentials(config);
      const configuredRedirect = creds?.[platform]?.redirectUri;
      if (!configuredRedirect) return false;
      const parsed = new URL(configuredRedirect);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.pathname !== req.path) return false;
      const reqHost = normalizeHttpsHost(req.headers.host);
      const targetHost = normalizeHttpsHost(parsed.host);
      return Boolean(reqHost && targetHost && reqHost === targetHost);
    } catch {
      return false;
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeadersMiddleware());
  app.use(
    loopbackHostAndCorsMiddleware({
      allowedPort: options.enforcePort ? config.port : null,
      allowExternalOAuthCallback,
    })
  );
  app.use(express.json({ limit: '2mb' }));

  const generalLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: options.rateLimitMax || 240 });
  const sensitiveLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: options.sensitiveRateLimitMax || 40 });
  const authAttemptLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: options.authAttemptRateLimitMax || 8,
  });

  const oauthCookieSecret = crypto
    .createHmac('sha256', masterKeyStore.getMasterKey())
    .update('oauth-bind-cookie-v1')
    .digest();

  app.use('/api/health', createHealthRouter());
  app.use(
    '/api/auth',
    sensitiveLimiter,
    createAuthRouter({ sessionsRepo, credentialStore, bootstrapManager, requireAuth, authAttemptLimiter })
  );
  app.use(
    '/api/accounts',
    generalLimiter,
    createAccountsRouter({
      accountService,
      sessionsRepo,
      requireAuth,
      oauthCookieSecret,
      defaultPort: config.port,
    })
  );
  app.use('/api/setup', sensitiveLimiter, requireAuth, createSetupRouter({ credentialStore, config, tempHosting }));
  app.use('/api/storage', sensitiveLimiter, requireAuth, createStorageRouter({ tempHosting, credentialStore, config }));
  app.use('/api/videos', generalLimiter, requireAuth, createVideosRouter({ videoService }));
  app.use('/api/captions', generalLimiter, requireAuth, createCaptionsRouter({ metadataService }));
  app.use('/api/publish', generalLimiter, requireAuth, createPublishRouter({ publishService }));
  app.use('/api/settings', generalLimiter, requireAuth, createSettingsRouter({ settingsRepo, config }));

  // Serve lightweight React dashboard if built
  if (fs.existsSync(config.paths.dashboardDistDir)) {
    app.use(express.static(config.paths.dashboardDistDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.paths.dashboardDistDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(200).send(
        'AI Social Media Publisher Backend is running on 127.0.0.1. Build the React dashboard with `npm run dashboard:build`.'
      );
    });
  }

  app.use(errorHandlerMiddleware(logger));

  const cleanupTempStorage = async () => {
    const creds = credentialStore.resolveEffectiveCredentials(config);
    return await tempHosting.runRetentionCleanup(creds.storage);
  };

  return {
    app,
    db,
    config,
    logger,
    masterKeyStore,
    credentialStore,
    bootstrapManager,
    tempHosting,
    cleanupTempStorage,
    repos: {
      accountsRepo,
      oauthStatesRepo,
      videosRepo,
      jobsRepo,
      tempObjectsRepo,
      r2UsageRepo,
      settingsRepo,
      sessionsRepo,
    },
    services: {
      accountService,
      videoService,
      metadataService,
      publishService,
    },
  };
}

