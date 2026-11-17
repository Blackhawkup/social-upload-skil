import { decryptPayload, encryptPayload } from '../security/cryptoVault.js';
import { sanitizeErrorMessage } from '../security/redact.js';
import { cleanupTempFile, createOptimizedTempCopy } from '../media/transcoder.js';
import { validateForInstagramReels, validateForYouTube } from '../media/validator.js';
import {
  formatInstagramCaption,
  formatYouTubeDescription,
  normalizeHashtagList,
  normalizeTagList,
} from '../ai/metadataGenerator.js';
import { PlatformError } from './retry.js';

export class PublishService {
  constructor({
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
    logger = null,
  }) {
    this.jobsRepo = jobsRepo;
    this.accountsRepo = accountsRepo;
    this.settingsRepo = settingsRepo;
    this.accountService = accountService;
    this.videoService = videoService;
    this.metadataService = metadataService;
    this.youtubePublisher = youtubePublisher;
    this.instagramPublisher = instagramPublisher;
    this.masterKeyStore = masterKeyStore;
    this.credentialStore = credentialStore;
    this.config = config;
    this.logger = logger;
    this.activeExecutions = new Map();
    this._r2ExecutionQueue = Promise.resolve();
  }

  #enqueueR2Execution(fn) {
    const run = this._r2ExecutionQueue.then(() => fn());
    this._r2ExecutionQueue = run.catch(() => {});
    return run;
  }

  async createAndMaybePublish({
    videoId = null,
    videoPath = null,
    accountIds = [],
    metadataOverrides = null,
    options = {},
    requestedBy = 'antigravity',
    approved = false,
    allowDuplicate = false,
    waitForCompletion = true,
  }) {
    const credsForQueue = this.credentialStore.resolveEffectiveCredentials(this.config);
    const maxQueuedJobs = Math.min(10, Math.max(1, Number(credsForQueue.storage?.maxQueuedJobs || 10)));
    const activeJobCount = this.jobsRepo.countActiveJobs();
    if (activeJobCount >= maxQueuedJobs) {
      throw new PlatformError(
        `Publishing queue limit reached: ${activeJobCount}/${maxQueuedJobs} active or awaiting jobs already queued. Complete, approve, or cancel existing jobs first.`,
        {
          code: 'MAX_QUEUED_JOBS_EXCEEDED',
          statusCode: 429,
          retryable: false,
        }
      );
    }

    const effectiveMode = this.settingsRepo.get('publishMode', this.config.defaultPublishMode);
    let targetAccountIds = Array.isArray(accountIds) ? [...new Set(accountIds.filter(Boolean))] : [];

    // Respect account selection rules: only use defaultAccountIds automatically in Autopilot when explicitly configured
    if (targetAccountIds.length === 0 && effectiveMode === 'autopilot') {
      const defaults = this.settingsRepo.get('defaultAccountIds', []);
      if (Array.isArray(defaults) && defaults.length > 0) {
        targetAccountIds = defaults;
      }
    }

    if (targetAccountIds.length === 0) {
      throw new PlatformError(
        'No destination accounts selected. Select one or more connected accounts first.',
        { code: 'NO_ACCOUNTS_SELECTED', statusCode: 400 }
      );
    }

    const accounts = targetAccountIds.map((id) => {
      const acc = this.accountsRepo.findPublicById(id);
      if (!acc) {
        throw new PlatformError(`Destination account not found: ${id}`, {
          code: 'ACCOUNT_NOT_FOUND',
          statusCode: 404,
        });
      }
      if (acc.connectionStatus === 'disconnected') {
        throw new PlatformError(
          `Account "${acc.displayName}" (${acc.platform}) is disconnected. Reauthorize it before publishing.`,
          { code: 'ACCOUNT_DISCONNECTED', statusCode: 400 }
        );
      }
      return acc;
    });

    const video = videoId
      ? this.videoService.videosRepo.findById(videoId)
      : await this.videoService.analyzeVideo({ videoPath, extractFrames: true });

    if (!video) {
      throw new PlatformError(`Video not found: ${videoId || videoPath}`, {
        code: 'VIDEO_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Duplicate check per destination account
    const duplicateConflicts = [];
    for (const acc of accounts) {
      const existingFp = this.jobsRepo.findDuplicateFingerprint(video.fileSha256, acc.id);
      if (existingFp && !allowDuplicate) {
        duplicateConflicts.push({
          accountId: acc.id,
          accountName: acc.displayName,
          platform: acc.platform,
          existingPostId: existingFp.platform_post_id,
          existingUrl: existingFp.published_url,
          publishedAt: existingFp.published_at,
        });
      }
    }

    if (duplicateConflicts.length > 0) {
      throw new PlatformError(
        `Duplicate upload prevented: this exact video has already been published to ${duplicateConflicts.map((d) => `${d.accountName} (${d.platform})`).join(', ')}. Pass allowDuplicate=true to override.`,
        {
          code: 'DUPLICATE_PUBLICATION',
          statusCode: 409,
        }
      );
    }

    // Generate or attach platform-specific metadata
    const generatedMeta = await this.metadataService.generateForVideo({
      videoId: video.id,
      accountIds: accounts.map((a) => a.id),
      customOverrides: metadataOverrides,
    });

    const preparedItems = [];
    const validationIssues = [];

    for (const acc of accounts) {
      const accountOverride = metadataOverrides?.perAccount?.[acc.id] || {};
      if (acc.platform === 'youtube') {
        const wantShort =
          options.asShort !== undefined
            ? Boolean(options.asShort)
            : Boolean(acc.preferences?.autoDetectShorts ?? true) && Boolean(generatedMeta.youtube.isShort);

        const validation = validateForYouTube(video.probe, { asShort: wantShort });
        if (!validation.valid) {
          validationIssues.push({ accountId: acc.id, accountName: acc.displayName, errors: validation.errors });
        }

        const ytHashtags = normalizeHashtagList(
          accountOverride.hashtags || generatedMeta.youtube.hashtags,
          5
        );
        const ytTags = normalizeTagList(accountOverride.tags || generatedMeta.youtube.tags, 15);
        const ytDesc =
          accountOverride.description !== undefined || accountOverride.hashtags !== undefined
            ? formatYouTubeDescription({
                description: accountOverride.description ?? generatedMeta.youtube.description,
                hashtags: ytHashtags,
              })
            : generatedMeta.youtube.description;

        const itemMetadata = {
          title: String(accountOverride.title || generatedMeta.youtube.title).trim().slice(0, 100),
          description: ytDesc,
          tags: ytTags,
          hashtags: ytHashtags,
          categoryId:
            accountOverride.categoryId ||
            acc.preferences?.defaultCategoryId ||
            generatedMeta.youtube.categoryId ||
            '22',
          privacyStatus:
            options.privacyStatus ||
            accountOverride.privacyStatus ||
            acc.preferences?.defaultPrivacyStatus ||
            this.settingsRepo.get('defaultPrivacyStatus', 'private'),
          publishAt: options.publishAt || accountOverride.publishAt || null,
          isShort: wantShort && validation.qualifiesAsShort,
          pinnedComment: accountOverride.pinnedComment || generatedMeta.youtube.pinnedComment || '',
          defaultLanguage:
            options.defaultLanguage ||
            accountOverride.defaultLanguage ||
            generatedMeta.youtube.defaultLanguage ||
            generatedMeta.detectedLanguage ||
            'en',
          madeForKids: Boolean(
            options.madeForKids ?? accountOverride.madeForKids ?? generatedMeta.youtube.madeForKids ?? false
          ),
        };

        preparedItems.push({
          accountId: acc.id,
          platform: 'youtube',
          metadata: itemMetadata,
          validation,
          bytesTotal: video.fileSizeBytes,
        });
      } else if (acc.platform === 'instagram') {
        const validation = validateForInstagramReels(video.probe, {
          maxVideoSizeBytes: credsForQueue.storage?.maxVideoSizeBytes,
        });
        if (!validation.valid) {
          validationIssues.push({ accountId: acc.id, accountName: acc.displayName, errors: validation.errors });
        }

        const igVisResolution = this.#resolveInstagramVisibility({
          requestedVisibility:
            options.instagramVisibility ||
            accountOverride.instagramVisibility ||
            (options.privacyStatus === 'private' ? 'private' : null) ||
            acc.preferences?.defaultInstagramVisibility ||
            'public',
          shareToFeedOption: options.shareToFeed,
          accountShareToFeedPref: acc.preferences?.shareToFeed,
          confirmPrivateInstagramAccount: Boolean(
            options.confirmPrivateInstagramAccount || accountOverride.confirmPrivateInstagramAccount
          ),
        });

        const igHashtags = normalizeHashtagList(
          accountOverride.hashtags || generatedMeta.instagram.hashtags,
          8
        );
        const igCta = accountOverride.callToAction ?? generatedMeta.instagram.callToAction ?? '';
        const igCaption =
          accountOverride.caption !== undefined ||
          accountOverride.hashtags !== undefined ||
          accountOverride.callToAction !== undefined
            ? formatInstagramCaption({
                caption: accountOverride.caption ?? generatedMeta.instagram.caption,
                hashtags: igHashtags,
                callToAction:
                  accountOverride.caption !== undefined ? accountOverride.callToAction || '' : igCta,
              })
            : generatedMeta.instagram.caption;

        const itemMetadata = {
          caption: igCaption,
          hashtags: igHashtags,
          callToAction: igCta,
          instagramVisibility: igVisResolution.instagramVisibility,
          confirmPrivateInstagramAccount: igVisResolution.confirmPrivateInstagramAccount,
          shareToFeed: igVisResolution.shareToFeed,
          ...(igVisResolution.trialParams ? { trialParams: igVisResolution.trialParams } : {}),
          thumbOffsetMs:
            options.thumbOffsetMs ??
            accountOverride.thumbOffsetMs ??
            generatedMeta.instagram.thumbOffsetMs ??
            null,
          audioName:
            options.audioName ||
            accountOverride.audioName ||
            generatedMeta.instagram.audioName ||
            null,
          padToVertical: Boolean(options.padToVertical),
        };

        preparedItems.push({
          accountId: acc.id,
          platform: 'instagram',
          metadata: itemMetadata,
          validation,
          bytesTotal: video.fileSizeBytes,
        });
      }
    }

    if (validationIssues.length > 0) {
      throw new PlatformError(
        `Video validation failed: ${validationIssues.map((v) => `${v.accountName}: ${v.errors.join('; ')}`).join(' | ')}`,
        { code: 'VIDEO_VALIDATION_FAILED', statusCode: 400 }
      );
    }

    const requiresApproval = effectiveMode === 'review' && approved !== true;
    const initialStatus = requiresApproval ? 'awaiting_approval' : 'queued';

    const job = this.jobsRepo.createJob({
      videoId: video.id,
      fileSha256: video.fileSha256,
      mode: effectiveMode,
      requestedBy,
      status: initialStatus,
      approvedAt: requiresApproval ? null : new Date().toISOString(),
      summary: {
        contentSummary: generatedMeta.contentSummary,
        providerUsed: generatedMeta.providerUsed,
        videoFileName: video.fileName,
        videoDurationSec: video.durationSec,
        videoAspectRatio: video.aspectRatio,
      },
      items: preparedItems,
    });

    if (requiresApproval) {
      this.logger?.info('Created publish job awaiting review approval', {
        jobId: job.id,
        accounts: accounts.map((a) => a.id),
      });
      return { requiresApproval: true, job };
    }

    const promise = this.#executeJob(job.id);
    this.activeExecutions.set(job.id, promise);

    if (waitForCompletion) {
      await promise;
      return {
        requiresApproval: false,
        job: this.jobsRepo.getJobWithItems(job.id),
      };
    }

    return { requiresApproval: false, job };
  }

  async approveAndPublish(jobId, { itemOverrides = {}, waitForCompletion = true } = {}) {
    const job = this.jobsRepo.getJobWithItems(jobId);
    if (!job) {
      throw new PlatformError(`Publish job not found: ${jobId}`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
    }
    if (job.status !== 'awaiting_approval') {
      throw new PlatformError(`Job ${jobId} is "${job.status}", not awaiting_approval.`, {
        code: 'INVALID_JOB_STATE',
        statusCode: 400,
      });
    }

    const plannedUpdates = [];
    for (const item of job.items) {
      const override = itemOverrides[item.id] || itemOverrides[item.accountId];
      let mergedMetadata = override ? { ...item.metadata, ...override } : item.metadata;
      if (item.platform === 'youtube' && override) {
        if (override.hashtags !== undefined) {
          mergedMetadata.hashtags = normalizeHashtagList(override.hashtags, 5);
        }
        if (override.tags !== undefined) {
          mergedMetadata.tags = normalizeTagList(override.tags, 15);
        }
        if (override.description !== undefined || override.hashtags !== undefined) {
          mergedMetadata.description = formatYouTubeDescription({
            description: mergedMetadata.description,
            hashtags: mergedMetadata.hashtags || [],
          });
        }
      }
      if (item.platform === 'instagram' && override) {
        if (override.hashtags !== undefined) {
          mergedMetadata.hashtags = normalizeHashtagList(override.hashtags, 8);
        }
        if (override.caption !== undefined || override.hashtags !== undefined || override.callToAction !== undefined) {
          mergedMetadata.caption = formatInstagramCaption({
            caption: mergedMetadata.caption,
            hashtags: mergedMetadata.hashtags || [],
            callToAction: override.caption !== undefined ? override.callToAction || '' : mergedMetadata.callToAction || '',
          });
        }
        if (
          override.instagramVisibility ||
          override.shareToFeed !== undefined ||
          override.confirmPrivateInstagramAccount !== undefined
        ) {
          const igVisResolution = this.#resolveInstagramVisibility({
            requestedVisibility:
              override.instagramVisibility || item.metadata?.instagramVisibility || 'public',
            shareToFeedOption: override.shareToFeed,
            accountShareToFeedPref: item.metadata?.shareToFeed,
            confirmPrivateInstagramAccount: Boolean(
              override.confirmPrivateInstagramAccount ?? item.metadata?.confirmPrivateInstagramAccount
            ),
          });
          mergedMetadata = {
            ...mergedMetadata,
            instagramVisibility: igVisResolution.instagramVisibility,
            confirmPrivateInstagramAccount: igVisResolution.confirmPrivateInstagramAccount,
            shareToFeed: igVisResolution.shareToFeed,
            ...(igVisResolution.trialParams ? { trialParams: igVisResolution.trialParams } : { trialParams: null }),
          };
        }
      }
      plannedUpdates.push({ id: item.id, metadata: mergedMetadata });
    }

    for (const upd of plannedUpdates) {
      this.jobsRepo.updateItem(upd.id, {
        status: 'pending',
        metadata: upd.metadata,
      });
    }

    this.jobsRepo.updateJob(jobId, {
      status: 'queued',
      approvedAt: new Date().toISOString(),
    });

    const promise = this.#executeJob(jobId);
    this.activeExecutions.set(jobId, promise);

    if (waitForCompletion) {
      await promise;
    }

    return this.jobsRepo.getJobWithItems(jobId);
  }

  cancelJob(jobId) {
    const job = this.jobsRepo.getJobWithItems(jobId);
    if (!job) {
      throw new PlatformError(`Publish job not found: ${jobId}`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
    }
    if (!['awaiting_approval', 'queued'].includes(job.status)) {
      throw new PlatformError(`Cannot cancel job in state "${job.status}".`, {
        code: 'INVALID_JOB_STATE',
        statusCode: 400,
      });
    }

    for (const item of job.items) {
      if (['awaiting_approval', 'pending'].includes(item.status)) {
        this.jobsRepo.updateItem(item.id, { status: 'cancelled' });
      }
    }
    this.jobsRepo.recomputeJobStatus(jobId);
    return this.jobsRepo.getJobWithItems(jobId);
  }

  async retryFailed(jobId, { itemIds = null, waitForCompletion = true } = {}) {
    const job = this.jobsRepo.getJobWithItems(jobId);
    if (!job) {
      throw new PlatformError(`Publish job not found: ${jobId}`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
    }

    const failedItems = job.items.filter((item) => {
      if (item.status !== 'failed') return false;
      if (Array.isArray(itemIds) && itemIds.length > 0) {
        return itemIds.includes(item.id) || itemIds.includes(item.accountId);
      }
      return true;
    });

    if (failedItems.length === 0) {
      throw new PlatformError(`No failed destinations found to retry on job ${jobId}.`, {
        code: 'NOTHING_TO_RETRY',
        statusCode: 400,
      });
    }

    const maxRetryAttempts = 5;
    const exhaustedItem = failedItems.find((item) => (item.attemptCount || 0) >= maxRetryAttempts);
    if (exhaustedItem) {
      throw new PlatformError(
        `Destination "${exhaustedItem.accountName || exhaustedItem.accountId}" has reached the maximum retry limit (${maxRetryAttempts} attempts) and will not be retried automatically or manually on this job.`,
        {
          code: 'MAX_RETRY_ATTEMPTS_EXCEEDED',
          statusCode: 400,
          retryable: false,
        }
      );
    }

    const credsForQueue = this.credentialStore.resolveEffectiveCredentials(this.config);
    const maxQueuedJobs = Math.min(10, Math.max(1, Number(credsForQueue.storage?.maxQueuedJobs || 10)));
    const isAlreadyActive = ['awaiting_approval', 'queued', 'running'].includes(job.status);
    if (!isAlreadyActive && this.jobsRepo.countActiveJobs() >= maxQueuedJobs) {
      throw new PlatformError(
        `Publishing queue limit reached (max ${maxQueuedJobs} active/queued jobs). Cannot retry right now.`,
        { code: 'MAX_QUEUED_JOBS_EXCEEDED', statusCode: 429, retryable: false }
      );
    }

    for (const item of failedItems) {
      this.jobsRepo.updateItem(item.id, {
        status: 'pending',
        errorCode: null,
        errorMessage: null,
      });
    }

    this.jobsRepo.updateJob(jobId, { status: 'running', completedAt: null });

    const promise = this.#executeJob(jobId, { onlyItemIds: failedItems.map((i) => i.id) });
    this.activeExecutions.set(jobId, promise);

    if (waitForCompletion) {
      await promise;
    }

    return this.jobsRepo.getJobWithItems(jobId);
  }

  getJobStatus(jobId) {
    const job = this.jobsRepo.getJobWithItems(jobId);
    if (!job) {
      throw new PlatformError(`Publish job not found: ${jobId}`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
    }
    return job;
  }

  listHistory({ limit = 25, offset = 0, status = null } = {}) {
    return this.jobsRepo.listHistory({ limit, offset, status });
  }

  async #executeJob(jobId, { onlyItemIds = null } = {}) {
    try {
      this.jobsRepo.updateJob(jobId, { status: 'running' });
      const job = this.jobsRepo.getJobWithItems(jobId);
      const video = this.videoService.videosRepo.findById(job.videoId);

      const targetItems = job.items.filter((item) => {
        if (onlyItemIds && !onlyItemIds.includes(item.id)) return false;
        return item.status === 'pending' || item.status === 'awaiting_approval';
      });

      for (const item of targetItems) {
        await this.#executeSingleItem({ job, video, itemId: item.id });
      }

      const finalStatus = this.jobsRepo.recomputeJobStatus(jobId);
      this.logger?.info('Completed publish job execution', { jobId, status: finalStatus });
    } finally {
      this.activeExecutions.delete(jobId);
    }
  }

  async #executeSingleItem({ job, video, itemId }) {
    const publicJob = this.jobsRepo.getJobWithItems(job.id);
    const item = publicJob.items.find((i) => i.id === itemId);
    if (!item) return;

    const internalRow = this.jobsRepo.getInternalItem(itemId);
    let tempTranscodePath = null;

    this.jobsRepo.updateItem(itemId, {
      status: 'validating',
      startedAt: item.startedAt || new Date().toISOString(),
      attemptCount: (item.attemptCount || 0) + 1,
      errorCode: null,
      errorMessage: null,
    });

    try {
      // Ensure valid access token (auto-refreshing if near expiry)
      let { account, accessToken } = await this.accountService.ensureValidAccessToken(item.accountId);

      let uploadFilePath = video.filePath;

      if (item.platform === 'instagram') {
        if (
          Array.isArray(account.scopes) &&
          account.scopes.length > 0 &&
          !account.scopes.includes('instagram_content_publish') &&
          !account.scopes.includes('instagram_business_content_publish')
        ) {
          throw new PlatformError(
            `Account "${account.displayName}" is missing the instagram_content_publish permission. Reauthorize it via Meta Unified Login with publishing permissions granted.`,
            { code: 'MISSING_PUBLISHING_PERMISSION', statusCode: 403, retryable: false }
          );
        }

        const creds = this.credentialStore.resolveEffectiveCredentials(this.config);
        const result = await this.#enqueueR2Execution(async () => {
          const needsPad = Boolean(item.metadata?.padToVertical && video.probe?.orientation === 'landscape');
          if (item.validation?.needsTranscode || needsPad) {
            this.jobsRepo.updateItem(itemId, { status: 'transcoding', progressPct: 5 });
            tempTranscodePath = await createOptimizedTempCopy(video.filePath, {
              transcodeDir: this.config.paths.transcodeDir,
              ffmpegPath: this.config.ffmpegPath,
              targetPlatform: 'instagram',
              padToVertical: needsPad,
            });
            this.jobsRepo.updateItem(itemId, { tempUploadPath: tempTranscodePath });
            uploadFilePath = tempTranscodePath;
          }

          return await this.instagramPublisher.publishReel({
            filePath: uploadFilePath,
            jobItemId: itemId,
            igUserId: account.platformAccountId,
            accessToken,
            metadata: item.metadata,
            storageConfig: creds.storage,
            graphApiVersion: creds.instagram.graphApiVersion,
            loginMode: account.metadata?.loginMode || creds.instagram.loginMode,
            onStageChange: async (stage) => {
              this.jobsRepo.updateItem(itemId, stage);
            },
          });
        });

        this.jobsRepo.updateItem(itemId, {
          status: 'published',
          progressPct: 100,
          platformPostId: result.platformPostId,
          platformContainerId: result.platformContainerId,
          publishedUrl: result.publishedUrl,
          completedAt: new Date().toISOString(),
        });

        this.jobsRepo.recordFingerprint({
          fileSha256: job.fileSha256,
          accountId: account.id,
          platform: 'instagram',
          platformPostId: result.platformPostId,
          publishedUrl: result.publishedUrl,
          jobItemId: itemId,
        });
        return;
      }

      if (item.platform === 'youtube') {
        this.jobsRepo.updateItem(itemId, { status: 'uploading', progressPct: 5 });

        let existingSessionUri = this.#decryptSessionUri(itemId, internalRow?.resumable_session_uri_enc);

        const attemptYouTubeUpload = async (token) => {
          return await this.youtubePublisher.publish({
            filePath: uploadFilePath,
            accessToken: token,
            metadata: item.metadata,
            existingSessionUri,
            isShort: Boolean(item.metadata?.isShort),
            onSessionCreated: async (sessionUri, totalBytes) => {
              existingSessionUri = sessionUri;
              this.jobsRepo.updateItem(itemId, {
                resumableSessionUriEnc: this.#encryptSessionUri(itemId, sessionUri),
                bytesTotal: totalBytes,
              });
            },
            onProgress: async ({ bytesUploaded, bytesTotal, progressPct }) => {
              this.jobsRepo.updateItem(itemId, {
                status: 'uploading',
                bytesUploaded,
                bytesTotal,
                progressPct,
              });
            },
          });
        };

        let result;
        try {
          result = await attemptYouTubeUpload(accessToken);
        } catch (err) {
          if (err?.code === 'TOKEN_EXPIRED') {
            await this.accountService.refreshAccountToken(account.id);
            const refreshed = await this.accountService.ensureValidAccessToken(account.id);
            result = await attemptYouTubeUpload(refreshed.accessToken);
          } else {
            throw err;
          }
        }

        this.jobsRepo.updateItem(itemId, {
          status: 'published',
          progressPct: 100,
          bytesUploaded: video.fileSizeBytes,
          bytesTotal: video.fileSizeBytes,
          resumableSessionUriEnc: null,
          platformPostId: result.platformPostId,
          publishedUrl: result.publishedUrl,
          completedAt: new Date().toISOString(),
        });

        this.jobsRepo.recordFingerprint({
          fileSha256: job.fileSha256,
          accountId: account.id,
          platform: 'youtube',
          platformPostId: result.platformPostId,
          publishedUrl: result.publishedUrl,
          jobItemId: itemId,
        });
      }
    } catch (err) {
      const code = err?.code || 'PUBLISH_FAILED';
      const msg = sanitizeErrorMessage(err);
      const retryable = err?.retryable !== undefined ? Boolean(err.retryable) : code !== 'YOUTUBE_QUOTA_EXCEEDED';

      if (code === 'REAUTH_REQUIRED') {
        this.accountsRepo.updateTokenStatus(item.accountId, {
          connectionStatus: 'reauth_required',
          lastErrorCode: code,
          lastErrorMessage: msg,
        });
      }

      this.jobsRepo.updateItem(itemId, {
        status: 'failed',
        errorCode: code,
        errorMessage: msg,
        retryable,
        completedAt: new Date().toISOString(),
      });

      this.logger?.error('Destination upload failed', {
        jobId: job.id,
        itemId,
        accountId: item.accountId,
        platform: item.platform,
        code,
        error: msg,
      });
    } finally {
      if (tempTranscodePath) {
        cleanupTempFile(tempTranscodePath);
        this.jobsRepo.updateItem(itemId, { tempUploadPath: null });
      }
    }
  }

  #resolveInstagramVisibility({
    requestedVisibility = 'public',
    shareToFeedOption = undefined,
    accountShareToFeedPref = true,
    confirmPrivateInstagramAccount = false,
  }) {
    const mode = String(requestedVisibility || 'public').toLowerCase();
    if (mode === 'private') {
      if (!confirmPrivateInstagramAccount) {
        throw new PlatformError(
          'Instagram Graph API does not have a per-Reel "Private" flag like YouTube. Choose: (1) instagramVisibility="trial_manual" to publish as an off-profile Trial Reel hidden from followers until graduated, (2) instagramVisibility="reels_only" (Reels tab only), (3) confirmPrivateInstagramAccount=true if your Instagram Creator account is set to Private in Instagram Settings, or (4) instagramVisibility="public".',
          { code: 'INSTAGRAM_VISIBILITY_CONFIRMATION_REQUIRED', statusCode: 400 }
        );
      }
      return {
        instagramVisibility: 'private',
        confirmPrivateInstagramAccount: true,
        shareToFeed: shareToFeedOption !== undefined ? Boolean(shareToFeedOption) : Boolean(accountShareToFeedPref ?? true),
        trialParams: null,
      };
    }

    if (mode === 'trial_manual') {
      return {
        instagramVisibility: 'trial_manual',
        confirmPrivateInstagramAccount: false,
        shareToFeed: false,
        trialParams: { graduation_strategy: 'MANUAL' },
      };
    }

    if (mode === 'trial_performance') {
      return {
        instagramVisibility: 'trial_performance',
        confirmPrivateInstagramAccount: false,
        shareToFeed: false,
        trialParams: { graduation_strategy: 'SS_PERFORMANCE' },
      };
    }

    if (mode === 'reels_only') {
      return {
        instagramVisibility: 'reels_only',
        confirmPrivateInstagramAccount: false,
        shareToFeed: false,
        trialParams: null,
      };
    }

    return {
      instagramVisibility: 'public',
      confirmPrivateInstagramAccount: false,
      shareToFeed: shareToFeedOption !== undefined ? Boolean(shareToFeedOption) : Boolean(accountShareToFeedPref ?? true),
      trialParams: null,
    };
  }

  #encryptSessionUri(itemId, uri) {
    if (!uri) return null;
    const masterKey = this.masterKeyStore.getMasterKey();
    return JSON.stringify(
      encryptPayload(masterKey, `resumable_uri:${itemId}`, { uri }, itemId)
    );
  }

  #decryptSessionUri(itemId, encryptedJson) {
    if (!encryptedJson) return null;
    try {
      const masterKey = this.masterKeyStore.getMasterKey();
      const parsed = JSON.parse(encryptedJson);
      const data = decryptPayload(masterKey, `resumable_uri:${itemId}`, parsed, itemId);
      return data.uri || null;
    } catch {
      return null;
    }
  }
}

