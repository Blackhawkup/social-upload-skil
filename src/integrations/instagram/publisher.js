import { PlatformError, parseRetryAfterMs, sleep, withExponentialBackoff } from '../../services/retry.js';
import { sanitizeErrorMessage } from '../../security/redact.js';

function parseMetaGraphError(status, payload, headers) {
  const err = payload?.error || {};
  const msg = sanitizeErrorMessage(err.error_user_msg || err.message || `HTTP ${status}`);
  const code = err.code;
  const subcode = err.error_subcode;

  if (code === 190 || status === 401) {
    return new PlatformError(`Instagram authentication expired or revoked: ${msg}`, {
      code: 'REAUTH_REQUIRED',
      statusCode: 401,
      retryable: false,
    });
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
    return new PlatformError(`Instagram API rate/publishing limit reached: ${msg}`, {
      code: 'INSTAGRAM_RATE_LIMITED',
      statusCode: status || 429,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(headers) || 15000,
    });
  }
  if (err.is_transient || status >= 500) {
    return new PlatformError(`Instagram transient server error: ${msg}`, {
      code: 'INSTAGRAM_TRANSIENT_ERROR',
      statusCode: status || 502,
      retryable: true,
    });
  }
  return new PlatformError(`Instagram Graph API error (${code || status}${subcode ? `/${subcode}` : ''}): ${msg}`, {
    code: code ? `META_${code}` : 'INSTAGRAM_API_ERROR',
    statusCode: status || 400,
    retryable: false,
  });
}

export class InstagramPublisher {
  constructor({ tempHosting, fetchImpl = fetch, logger = null } = {}) {
    this.tempHosting = tempHosting;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async publishReel({
    filePath,
    jobItemId,
    igUserId,
    accessToken,
    metadata,
    storageConfig,
    graphApiVersion = 'v22.0',
    loginMode = 'meta_unified_login',
    onStageChange = null,
    maxContainerPolls = 36,
    containerPollIntervalMs = 5000,
  }) {
    const graphBase = loginMode === 'instagram_login' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';

    // 1. Optional quota check before staging media
    await this.#checkPublishingLimit({ graphBase, graphApiVersion, igUserId, accessToken });

    // 2. Stage video on private temporary cloud storage with presigned time-limited GET URL
    if (onStageChange) await onStageChange({ status: 'staging', progressPct: 15 });

    const staged = await this.tempHosting.uploadTemporaryVideo({
      filePath,
      jobItemId,
      storageConfig,
      contentType: 'video/mp4',
    });

    try {
      // 3. Create Instagram Reels container
      if (onStageChange) await onStageChange({ status: 'uploading', progressPct: 40 });

      const hasTrialParams = Boolean(metadata.trialParams?.graduation_strategy);
      let createHeaders;
      let createBody;

      if (hasTrialParams) {
        const jsonPayload = {
          media_type: 'REELS',
          video_url: staged.presignedUrl,
          caption: String(metadata.caption || '').slice(0, 2200),
          share_to_feed: metadata.shareToFeed !== false,
          trial_params: {
            graduation_strategy: metadata.trialParams.graduation_strategy,
          },
        };
        if (metadata.thumbOffsetMs !== undefined && metadata.thumbOffsetMs !== null) {
          jsonPayload.thumb_offset = Math.max(0, Math.floor(metadata.thumbOffsetMs));
        }
        if (metadata.audioName) {
          jsonPayload.audio_name = String(metadata.audioName).slice(0, 120);
        }
        createHeaders = {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        };
        createBody = JSON.stringify(jsonPayload);
      } else {
        const createPayload = new URLSearchParams({
          media_type: 'REELS',
          video_url: staged.presignedUrl,
          caption: String(metadata.caption || '').slice(0, 2200),
          share_to_feed: String(metadata.shareToFeed !== false),
        });
        if (metadata.thumbOffsetMs !== undefined && metadata.thumbOffsetMs !== null) {
          createPayload.set('thumb_offset', String(Math.max(0, Math.floor(metadata.thumbOffsetMs))));
        }
        if (metadata.audioName) {
          createPayload.set('audio_name', String(metadata.audioName).slice(0, 120));
        }
        createHeaders = {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        createBody = createPayload.toString();
      }

      const containerId = await withExponentialBackoff(
        async () => {
          const res = await this.fetch(`${graphBase}/${graphApiVersion}/${encodeURIComponent(igUserId)}/media`, {
            method: 'POST',
            headers: createHeaders,
            body: createBody,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.id) {
            throw parseMetaGraphError(res.status, data, res.headers);
          }
          return String(data.id);
        },
        { maxAttempts: 3 }
      );

      if (onStageChange) {
        await onStageChange({ status: 'processing', progressPct: 60, platformContainerId: containerId });
      }

      // 4. Poll container processing until FINISHED
      let containerStatus = 'IN_PROGRESS';
      for (let i = 0; i < maxContainerPolls; i++) {
        const statusData = await withExponentialBackoff(
          async () => {
            const res = await this.fetch(
              `${graphBase}/${graphApiVersion}/${encodeURIComponent(containerId)}?fields=status_code,status`,
              {
                headers: { Authorization: `Bearer ${accessToken}` },
              }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw parseMetaGraphError(res.status, data, res.headers);
            }
            return data;
          },
          { maxAttempts: 3 }
        );

        containerStatus = String(statusData.status_code || '').toUpperCase();
        if (containerStatus === 'FINISHED' || containerStatus === 'PUBLISHED') {
          break;
        }
        if (containerStatus === 'ERROR' || containerStatus === 'EXPIRED') {
          throw new PlatformError(
            `Instagram media container processing failed (${containerStatus}): ${sanitizeErrorMessage(statusData.status || 'Processing error')}`,
            {
              code: containerStatus === 'EXPIRED' ? 'INSTAGRAM_CONTAINER_EXPIRED' : 'INSTAGRAM_PROCESSING_FAILED',
              statusCode: 422,
              retryable: containerStatus === 'ERROR',
            }
          );
        }

        const pct = Math.min(88, 60 + Math.round(((i + 1) / maxContainerPolls) * 28));
        if (onStageChange) await onStageChange({ status: 'processing', progressPct: pct });
        if (i < maxContainerPolls - 1) {
          await sleep(containerPollIntervalMs);
        }
      }

      if (containerStatus !== 'FINISHED' && containerStatus !== 'PUBLISHED') {
        throw new PlatformError(
          `Instagram media container timed out while still ${containerStatus || 'IN_PROGRESS'}.`,
          { code: 'INSTAGRAM_PROCESSING_TIMEOUT', statusCode: 504, retryable: true }
        );
      }

      // 5. Publish container
      if (onStageChange) await onStageChange({ status: 'processing', progressPct: 92 });

      const mediaId = await withExponentialBackoff(
        async () => {
          const res = await this.fetch(
            `${graphBase}/${graphApiVersion}/${encodeURIComponent(igUserId)}/media_publish`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ creation_id: containerId }).toString(),
            }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.id) {
            throw parseMetaGraphError(res.status, data, res.headers);
          }
          return String(data.id);
        },
        { maxAttempts: 3 }
      );

      // 6. Retrieve published permalink
      let permalink = null;
      try {
        const metaRes = await this.fetch(
          `${graphBase}/${graphApiVersion}/${encodeURIComponent(mediaId)}?fields=id,permalink,shortcode`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (metaRes.ok) {
          const metaData = await metaRes.json();
          permalink = metaData.permalink || (metaData.shortcode ? `https://www.instagram.com/reel/${metaData.shortcode}/` : null);
        }
      } catch {
        // Permalink lookup is best-effort after confirmed media_publish id
      }

      return {
        platformPostId: mediaId,
        platformContainerId: containerId,
        publishedUrl: permalink,
      };
    } finally {
      // 7. Always delete temporary private R2 object after upload/publish attempt
      await this.tempHosting.deleteTemporaryVideo({
        recordId: staged.recordId,
        provider: staged.provider,
        bucket: staged.bucket,
        objectKey: staged.objectKey,
        storageConfig,
        status: 'deleted',
      });
    }
  }

  async #checkPublishingLimit({ graphBase, graphApiVersion, igUserId, accessToken }) {
    try {
      const res = await this.fetch(
        `${graphBase}/${graphApiVersion}/${encodeURIComponent(igUserId)}/content_publishing_limit?fields=config,quota_usage`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) return;
      const json = await res.json().catch(() => ({}));
      const entry = json.data?.[0];
      const usage = entry?.quota_usage;
      const total = entry?.config?.quota_total;
      if (typeof usage === 'number' && typeof total === 'number' && usage >= total) {
        throw new PlatformError(
          `Instagram 24-hour publishing limit reached (${usage}/${total}).`,
          { code: 'INSTAGRAM_DAILY_LIMIT_REACHED', statusCode: 429, retryable: false }
        );
      }
    } catch (err) {
      if (err instanceof PlatformError && err.code === 'INSTAGRAM_DAILY_LIMIT_REACHED') {
        throw err;
      }
    }
  }
}

