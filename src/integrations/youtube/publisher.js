import fs from 'node:fs';
import { PlatformError, parseRetryAfterMs, sleep, withExponentialBackoff } from '../../services/retry.js';
import { sanitizeErrorMessage } from '../../security/redact.js';

// Google Resumable Upload requires chunk sizes to be multiples of 256 KiB (except final chunk)
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB

function parseGoogleApiError(status, payload, headers) {
  const errObj = payload?.error || {};
  const reason = errObj?.errors?.[0]?.reason || '';
  const message = sanitizeErrorMessage(errObj.message || payload?.message || `HTTP ${status}`);

  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'uploadLimitExceeded') {
    return new PlatformError(`YouTube quota/upload limit reached: ${message}`, {
      code: 'YOUTUBE_QUOTA_EXCEEDED',
      statusCode: status,
      retryable: false,
    });
  }
  if (status === 401) {
    return new PlatformError(`YouTube authentication expired: ${message}`, {
      code: 'TOKEN_EXPIRED',
      statusCode: 401,
      retryable: false,
    });
  }
  if (status === 429 || status >= 500) {
    return new PlatformError(`YouTube transient error (${status}): ${message}`, {
      code: status === 429 ? 'RATE_LIMITED' : 'YOUTUBE_TRANSIENT_ERROR',
      statusCode: status,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(headers),
    });
  }
  return new PlatformError(`YouTube API error (${status}): ${message}`, {
    code: reason || 'YOUTUBE_API_ERROR',
    statusCode: status,
    retryable: false,
  });
}

function parseResumeRange(rangeHeader) {
  if (!rangeHeader) return 0;
  // Example: "bytes=0-8388607"
  const match = /bytes=0-(\d+)/i.exec(rangeHeader);
  if (!match) return 0;
  return Number.parseInt(match[1], 10) + 1;
}

export class YouTubePublisher {
  constructor({ fetchImpl = fetch, logger = null, chunkSizeBytes = CHUNK_SIZE_BYTES } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
    this.chunkSizeBytes = chunkSizeBytes;
  }

  async publish({
    filePath,
    accessToken,
    metadata,
    existingSessionUri = null,
    isShort = false,
    onSessionCreated = null,
    onProgress = null,
    pollProcessing = true,
    maxProcessingPolls = 12,
    processingPollIntervalMs = 4000,
  }) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    if (totalBytes <= 0) {
      throw new PlatformError('Cannot upload an empty video file to YouTube.', {
        code: 'EMPTY_VIDEO_FILE',
        statusCode: 400,
      });
    }

    const privacyStatus = metadata.publishAt ? 'private' : metadata.privacyStatus || 'private';
    if (metadata.publishAt) {
      const ts = new Date(metadata.publishAt).getTime();
      if (Number.isNaN(ts) || ts <= Date.now() + 60_000) {
        throw new PlatformError('YouTube scheduled publishAt must be a valid future ISO-8601 timestamp.', {
          code: 'INVALID_PUBLISH_AT',
          statusCode: 400,
        });
      }
    }

    const snippet = {
      title: String(metadata.title || 'Untitled Video').slice(0, 100),
      description: String(metadata.description || '').slice(0, 5000),
      tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 30).map((t) => String(t).slice(0, 100)) : [],
      categoryId: String(metadata.categoryId || '22'),
    };
    if (metadata.defaultLanguage) {
      snippet.defaultLanguage = metadata.defaultLanguage;
    }

    const statusObj = {
      privacyStatus,
      selfDeclaredMadeForKids: Boolean(metadata.madeForKids ?? false),
    };
    if (metadata.publishAt) {
      statusObj.publishAt = new Date(metadata.publishAt).toISOString();
    }

    let sessionUri = existingSessionUri;
    let offset = 0;

    if (sessionUri) {
      const probe = await this.#probeResumableOffset(sessionUri, totalBytes);
      if (probe.expired) {
        sessionUri = null;
        offset = 0;
      } else if (probe.completedResource) {
        return await this.#finalizeVideoResult({
          videoResource: probe.completedResource,
          accessToken,
          isShort,
          pollProcessing,
          maxProcessingPolls,
          processingPollIntervalMs,
        });
      } else if (probe.nextOffset >= totalBytes) {
        // Clamp defensively if server reported >= totalBytes without 200/201 body
        offset = Math.max(0, totalBytes - 1);
      } else {
        offset = probe.nextOffset;
      }
    }

    if (!sessionUri) {
      sessionUri = await withExponentialBackoff(
        async () => {
          const initRes = await this.fetch(
            'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Length': String(totalBytes),
                'X-Upload-Content-Type': 'video/*',
              },
              body: JSON.stringify({ snippet, status: statusObj }),
            }
          );
          if (!initRes.ok) {
            const errJson = await initRes.json().catch(() => ({}));
            throw parseGoogleApiError(initRes.status, errJson, initRes.headers);
          }
          const location = initRes.headers.get('location');
          if (!location) {
            throw new PlatformError('YouTube did not return a resumable upload Location header.', {
              code: 'MISSING_UPLOAD_LOCATION',
              statusCode: 502,
              retryable: true,
            });
          }
          return location;
        },
        { maxAttempts: 3 }
      );

      if (onSessionCreated) {
        await onSessionCreated(sessionUri, totalBytes);
      }
    }

    const fd = fs.openSync(filePath, 'r');
    let uploadedResource = null;

    try {
      while (offset < totalBytes) {
        const end = Math.min(offset + this.chunkSizeBytes, totalBytes);
        const chunkLen = end - offset;
        const buf = Buffer.allocUnsafe(chunkLen);
        fs.readSync(fd, buf, 0, chunkLen, offset);

        const chunkResult = await withExponentialBackoff(
          async () => {
            const res = await this.fetch(sessionUri, {
              method: 'PUT',
              headers: {
                'Content-Length': String(chunkLen),
                'Content-Range': `bytes ${offset}-${end - 1}/${totalBytes}`,
                'Content-Type': 'video/*',
              },
              body: buf,
            });

            if (res.status === 308) {
              const rangeHdr = res.headers.get('range');
              const next = rangeHdr ? parseResumeRange(rangeHdr) : end;
              return { done: false, nextOffset: next };
            }
            if (res.status === 200 || res.status === 201) {
              const json = await res.json();
              return { done: true, resource: json };
            }

            const errJson = await res.json().catch(() => ({}));
            throw parseGoogleApiError(res.status, errJson, res.headers);
          },
          {
            maxAttempts: 4,
            onRetry: ({ attempt, delayMs }) => {
              this.logger?.warn('Retrying YouTube upload chunk', { attempt, delayMs, offset, totalBytes });
            },
          }
        );

        if (chunkResult.done) {
          offset = totalBytes;
          uploadedResource = chunkResult.resource;
        } else {
          offset = chunkResult.nextOffset;
        }

        if (onProgress) {
          const pct = Math.min(99, Math.round((offset / totalBytes) * 100));
          await onProgress({ bytesUploaded: offset, bytesTotal: totalBytes, progressPct: pct });
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    if (!uploadedResource?.id) {
      throw new PlatformError('YouTube upload completed without returning a video ID.', {
        code: 'MISSING_VIDEO_ID',
        statusCode: 502,
      });
    }

    return await this.#finalizeVideoResult({
      videoResource: uploadedResource,
      accessToken,
      isShort,
      pollProcessing,
      maxProcessingPolls,
      processingPollIntervalMs,
    });
  }

  async #probeResumableOffset(sessionUri, totalBytes) {
    try {
      const res = await this.fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': `bytes */${totalBytes}`,
        },
      });
      if (res.status === 308) {
        return { expired: false, nextOffset: parseResumeRange(res.headers.get('range')) };
      }
      if (res.status === 200 || res.status === 201) {
        const resource = await res.json().catch(() => null);
        return { expired: false, completedResource: resource };
      }
      if (res.status === 404 || res.status === 410) {
        return { expired: true, nextOffset: 0 };
      }
      return { expired: true, nextOffset: 0 };
    } catch {
      return { expired: false, nextOffset: 0 };
    }
  }

  async #finalizeVideoResult({
    videoResource,
    accessToken,
    isShort,
    pollProcessing,
    maxProcessingPolls,
    processingPollIntervalMs,
  }) {
    const videoId = videoResource.id;
    let processingStatus = videoResource.status?.uploadStatus || 'uploaded';

    if (pollProcessing && accessToken) {
      for (let i = 0; i < maxProcessingPolls; i++) {
        try {
          const statusRes = await this.fetch(
            `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          if (statusRes.ok) {
            const json = await statusRes.json();
            const item = json.items?.[0];
            if (item) {
              const pStatus = item.processingDetails?.processingStatus;
              const uStatus = item.status?.uploadStatus;
              processingStatus = pStatus || uStatus || processingStatus;
              if (uStatus === 'rejected' || uStatus === 'failed' || pStatus === 'failed') {
                throw new PlatformError(
                  `YouTube video processing failed (${item.status?.rejectionReason || item.processingDetails?.processingFailureReason || 'unknown'})`,
                  { code: 'YOUTUBE_PROCESSING_FAILED', statusCode: 422, retryable: false }
                );
              }
              if (pStatus === 'succeeded' || uStatus === 'processed') {
                break;
              }
            }
          }
        } catch (err) {
          if (err instanceof PlatformError && err.code === 'YOUTUBE_PROCESSING_FAILED') {
            throw err;
          }
        }
        if (i < maxProcessingPolls - 1) {
          await sleep(processingPollIntervalMs);
        }
      }
    }

    const publishedUrl = isShort
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;

    return {
      platformPostId: videoId,
      publishedUrl,
      processingStatus,
      privacyStatus: videoResource.status?.privacyStatus || null,
    };
  }
}
