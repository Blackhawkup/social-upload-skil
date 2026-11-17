import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PlatformError, withExponentialBackoff } from '../../services/retry.js';
import { registerSensitiveValue, sanitizeErrorMessage } from '../../security/redact.js';
import { R2UsageRepository } from '../../db/repositories/r2UsageRepo.js';
import { buildSignedS3Headers, createPresignedS3GetUrl } from './r2SigV4.js';
import {
  buildCompleteMultipartUploadXml,
  CLOUDFLARE_R2_FREE_TIER_ALLOWANCE,
  evaluateR2Warnings,
  parseInitiateMultipartUploadXml,
  parseListMultipartUploadsXml,
  parseListObjectsV2Xml,
  R2_SAFE_LIMITS,
  R2_SAFEGUARD_DISCLAIMER,
  resolveEffectiveR2Limits,
} from './r2CostGuard.js';

export class TempCloudHostingAdapter {
  constructor({
    tempObjectsRepo,
    r2UsageRepo = null,
    jobsRepo = null,
    fetchImpl = fetch,
    logger = null,
    mockDir = null,
    retryBaseDelayMs = 500,
    maxListPages = R2_SAFE_LIMITS.MAX_LIST_PAGES,
  } = {}) {
    this.tempObjectsRepo = tempObjectsRepo;
    this.r2UsageRepo = r2UsageRepo || (tempObjectsRepo?.db ? new R2UsageRepository(tempObjectsRepo.db) : null);
    this.jobsRepo = jobsRepo;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.mockDir = mockDir;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.maxListPages = maxListPages;

    this._activeUploads = 0;
    this._activeMultipartUploadIds = new Set();
    this._lastWarnedThresholdByMetric = new Map();
  }

  resolveEndpoint(storageConfig = {}) {
    if (storageConfig.endpoint) return storageConfig.endpoint;
    if (storageConfig.accountId) {
      return `https://${storageConfig.accountId}.r2.cloudflarestorage.com`;
    }
    return '';
  }

  isConfigured(storageConfig = {}) {
    if (storageConfig.provider === 'mock') return true;
    const endpoint = this.resolveEndpoint(storageConfig);
    return Boolean(endpoint && storageConfig.bucket && storageConfig.accessKeyId && storageConfig.secretAccessKey);
  }

  getActiveUploadCount() {
    return this._activeUploads;
  }

  #safeRecordUsage(event) {
    if (!this.r2UsageRepo) return null;
    try {
      return this.r2UsageRepo.recordEvent(event);
    } catch {
      return null;
    }
  }

  #readCountersFailClosed(bucket, jobItemId = null) {
    if (!this.r2UsageRepo) {
      throw new PlatformError(
        'Cannot measure monthly R2 usage because local usage telemetry storage is unavailable (fail closed).',
        {
          code: 'R2_USAGE_MEASUREMENT_FAILED',
          statusCode: 503,
          retryable: false,
          details: { isBillingCap: false, disclaimer: R2_SAFEGUARD_DISCLAIMER },
        }
      );
    }
    try {
      return this.r2UsageRepo.getMonthlyCounters();
    } catch (err) {
      const msg = sanitizeErrorMessage(err);
      this.logger?.error('Fail-closed: unable to read local R2 monthly usage counters', {
        bucket,
        jobItemId,
        error: msg,
      });
      throw new PlatformError(
        `Cannot reliably read local monthly R2 usage counters; blocking R2 upload (fail closed): ${msg}`,
        {
          code: 'R2_USAGE_MEASUREMENT_FAILED',
          statusCode: 503,
          retryable: false,
          details: { isBillingCap: false, disclaimer: R2_SAFEGUARD_DISCLAIMER },
        }
      );
    }
  }

  #emitThresholdWarnings({ limits, counters, measuredBytes = null, bucket = null, jobItemId = null }) {
    const activeQueuedJobs = this.jobsRepo ? this.jobsRepo.countActiveJobs() : 0;
    const evalResult = evaluateR2Warnings({ limits, counters, measuredBytes, activeQueuedJobs });
    const monthKey = counters.monthKey || this.r2UsageRepo?.getMonthKey() || new Date().toISOString().slice(0, 7);

    for (const warning of evalResult.warnings) {
      const cacheKey = `${monthKey}:${warning.metric}`;
      const prevLogged = this._lastWarnedThresholdByMetric.get(cacheKey) || 0;
      if (warning.thresholdPct > prevLogged) {
        this._lastWarnedThresholdByMetric.set(cacheKey, warning.thresholdPct);
        this.logger?.warn('Cloudflare R2 free-tier cost protection threshold reached', {
          metric: warning.metric,
          thresholdPct: warning.thresholdPct,
          currentPct: warning.currentPct,
          used: warning.used,
          limit: warning.limit,
          bucket,
          isBillingCap: false,
        });
        this.#safeRecordUsage({
          monthKey,
          eventType: 'threshold_warning',
          opClass: 'GUARD',
          operation: `threshold_${warning.thresholdPct}pct_${warning.metric}`,
          bucket,
          measuredBytes,
          utilizationPct: warning.currentPct,
          warningLevel: String(warning.thresholdPct),
          status: 'warning',
          jobItemId,
          details: {
            metric: warning.metric,
            label: warning.label,
            thresholdPct: warning.thresholdPct,
            used: warning.used,
            limit: warning.limit,
            message: warning.message,
            isBillingCap: false,
          },
        });
      }
    }

    return evalResult;
  }

  async measureBucketUsage(storageConfig = {}, { prefix = null, jobItemId = null } = {}) {
    if (storageConfig.provider === 'mock') {
      if (storageConfig.mockFailUsageMeasurement) {
        throw new PlatformError('Mock storage failed usage measurement check (fail closed).', {
          code: 'R2_USAGE_MEASUREMENT_FAILED',
          statusCode: 503,
          retryable: false,
        });
      }

      const targetDir = this.mockDir;
      const objects = [];
      let totalBytes = 0;

      if (targetDir) {
        try {
          if (fs.existsSync(targetDir)) {
            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isFile()) continue;
              const fullPath = path.join(targetDir, entry.name);
              const stat = fs.statSync(fullPath);
              const mockMatch = /^ig-temp_([^_]+)_(.+)$/.exec(entry.name);
              const key = mockMatch ? `ig-temp/${mockMatch[1]}/${mockMatch[2]}` : entry.name;
              if (prefix && !key.startsWith(prefix)) {
                continue;
              }
              totalBytes += stat.size;
              objects.push({
                key,
                fileName: entry.name,
                filePath: fullPath,
                sizeBytes: stat.size,
                lastModified: stat.mtime.toISOString(),
              });
            }
          }
        } catch (err) {
          throw new PlatformError(
            `Failed to measure mock storage usage (fail closed): ${sanitizeErrorMessage(err)}`,
            { code: 'R2_USAGE_MEASUREMENT_FAILED', statusCode: 503, retryable: false }
          );
        }
      }

      const measuredAt = new Date().toISOString();
      if (!prefix && this.r2UsageRepo) {
        this.r2UsageRepo.updateMeasurementSnapshot({
          measuredBytes: totalBytes,
          objectCount: objects.length,
          measuredAt,
        });
        this.#safeRecordUsage({
          eventType: 'measure_usage',
          opClass: 'A',
          operation: 'ListObjectsV2(mock)',
          bucket: 'mock-bucket',
          measuredBytes: totalBytes,
          status: 'ok',
          jobItemId,
          classAOpsDelta: 1,
          details: { objectCount: objects.length, totalBytes },
        });
      }
      return {
        totalBytes,
        objectCount: objects.length,
        objects,
        pages: 1,
        measuredAt,
      };
    }

    if (!this.isConfigured(storageConfig)) {
      throw new PlatformError(
        'Cannot measure Cloudflare R2 storage usage: storage credentials are not configured (fail closed).',
        { code: 'R2_USAGE_MEASUREMENT_FAILED', statusCode: 400, retryable: false }
      );
    }

    const endpointUrl = this.resolveEndpoint(storageConfig);
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    const allObjects = [];
    let totalBytes = 0;
    let continuationToken = null;
    let pages = 0;

    try {
      for (let page = 1; page <= this.maxListPages; page++) {
        pages = page;
        const parsed = await withExponentialBackoff(
          async () => {
            const queryParams = {
              'list-type': '2',
              ...(prefix ? { prefix } : {}),
              ...(continuationToken ? { 'continuation-token': continuationToken } : {}),
            };
            const signed = buildSignedS3Headers({
              method: 'GET',
              endpointUrl,
              bucket: storageConfig.bucket,
              objectKey: '',
              queryParams,
              accessKeyId: storageConfig.accessKeyId,
              secretAccessKey: storageConfig.secretAccessKey,
              region: storageConfig.region || 'auto',
              payloadHash: emptyHash,
            });

            const res = await this.fetch(signed.url, {
              method: 'GET',
              headers: signed.headers,
            });

            if (!res.ok) {
              const text = await res.text().catch(() => '');
              const retryable = res.status === 429 || res.status >= 500;
              throw new PlatformError(
                `R2 storage usage measurement failed (HTTP ${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
                {
                  code: 'R2_USAGE_MEASUREMENT_FAILED',
                  statusCode: res.status,
                  retryable,
                }
              );
            }

            const xmlText = await res.text().catch(() => '');
            let result;
            try {
              result = parseListObjectsV2Xml(xmlText);
            } catch (parseErr) {
              throw new PlatformError(
                `R2 ListObjectsV2 returned unreliable/malformed XML (fail closed): ${parseErr.message}`,
                {
                  code: 'R2_USAGE_MEASUREMENT_FAILED',
                  statusCode: 502,
                  retryable: false,
                }
              );
            }
            return result;
          },
          {
            maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS,
            baseDelayMs: this.retryBaseDelayMs,
            onRetry: ({ attempt, delayMs, error }) => {
              this.logger?.warn('Retrying R2 ListObjectsV2 storage usage check', {
                attempt,
                delayMs,
                bucket: storageConfig.bucket,
                error: error?.message,
              });
            },
          }
        );

        let pageBytes = 0;
        for (const obj of parsed.objects) {
          allObjects.push(obj);
          totalBytes += obj.sizeBytes;
          pageBytes += obj.sizeBytes;
        }

        this.#safeRecordUsage({
          eventType: 'measure_usage',
          opClass: 'A',
          operation: 'ListObjectsV2',
          bucket: storageConfig.bucket,
          bytesDelta: 0,
          measuredBytes: !prefix && !parsed.isTruncated ? totalBytes : null,
          status: 'ok',
          jobItemId,
          classAOpsDelta: 1,
          details: { page, prefix: prefix || null, objectsInPage: parsed.objects.length, pageBytes, runningTotalBytes: totalBytes },
        });

        if (!parsed.isTruncated) {
          continuationToken = null;
          break;
        }
        continuationToken = parsed.nextContinuationToken;
        if (page >= this.maxListPages && parsed.isTruncated) {
          throw new PlatformError(
            `R2 storage usage measurement exceeded maximum pagination depth (${this.maxListPages} pages); failing closed to prevent unmeasured growth.`,
            { code: 'R2_USAGE_MEASUREMENT_FAILED', statusCode: 503, retryable: false }
          );
        }
      }

      const measuredAt = new Date().toISOString();
      if (!prefix && this.r2UsageRepo) {
        this.r2UsageRepo.updateMeasurementSnapshot({
          measuredBytes: totalBytes,
          objectCount: allObjects.length,
          measuredAt,
        });
      }

      this.logger?.info('Measured Cloudflare R2 bucket usage', {
        bucket: storageConfig.bucket,
        prefix: prefix || null,
        totalBytes,
        objectCount: allObjects.length,
        pages,
      });

      return {
        totalBytes,
        objectCount: allObjects.length,
        objects: allObjects,
        pages,
        measuredAt,
      };
    } catch (err) {
      const wrapped =
        err instanceof PlatformError && err.code === 'R2_USAGE_MEASUREMENT_FAILED'
          ? new PlatformError(err.message, {
              code: 'R2_USAGE_MEASUREMENT_FAILED',
              statusCode: err.statusCode,
              retryable: false,
              details: err.details || { isBillingCap: false, disclaimer: R2_SAFEGUARD_DISCLAIMER },
            })
          : new PlatformError(
              `Cannot reliably measure R2 storage usage; blocking upload (fail closed): ${sanitizeErrorMessage(err)}`,
              {
                code: 'R2_USAGE_MEASUREMENT_FAILED',
                statusCode: err?.statusCode || 503,
                retryable: false,
                details: { isBillingCap: false, disclaimer: R2_SAFEGUARD_DISCLAIMER },
              }
            );

      this.#safeRecordUsage({
        eventType: 'fail_closed',
        opClass: 'GUARD',
        operation: 'ListObjectsV2',
        bucket: storageConfig.bucket,
        warningLevel: 'FAIL_CLOSED',
        status: 'error',
        jobItemId,
        details: { error: wrapped.message },
      });
      this.logger?.error('R2 usage measurement failed (fail closed)', {
        bucket: storageConfig.bucket,
        error: wrapped.message,
      });
      throw wrapped;
    }
  }

  async uploadTemporaryVideo({ filePath, jobItemId = null, storageConfig = {}, contentType = 'video/mp4' }) {
    const limits = resolveEffectiveR2Limits(storageConfig);

    // 1. Strict concurrency limit: max 1 active R2 upload at any time (checked before any await!)
    if (this._activeUploads >= limits.maxConcurrentUploads) {
      this.#safeRecordUsage({
        eventType: 'limit_blocked',
        opClass: 'GUARD',
        operation: 'concurrent_upload_guard',
        bucket: storageConfig.bucket || null,
        warningLevel: '100',
        status: 'blocked',
        jobItemId,
        details: {
          reason: 'R2_CONCURRENT_UPLOAD_LIMIT',
          activeUploads: this._activeUploads,
          maxConcurrentUploads: limits.maxConcurrentUploads,
          isBillingCap: false,
        },
      });
      throw new PlatformError(
        `R2 upload blocked: maximum concurrent upload limit reached (${limits.maxConcurrentUploads} active upload allowed).`,
        {
          code: 'R2_CONCURRENT_UPLOAD_LIMIT',
          statusCode: 429,
          retryable: true,
          details: { isBillingCap: false, disclaimer: R2_SAFEGUARD_DISCLAIMER },
        }
      );
    }

    this._activeUploads += 1;

    try {
      if (!this.isConfigured(storageConfig)) {
        throw new PlatformError(
          'Instagram Graph API requires temporary private cloud media hosting (Cloudflare R2 / S3-compatible). Configure R2 bucket and credentials in local setup.',
          { code: 'TEMP_STORAGE_NOT_CONFIGURED', statusCode: 400, retryable: false }
        );
      }

      // 2. Validate local video file size (strict 500 MB max)
      let fileStat;
      try {
        fileStat = fs.statSync(filePath);
      } catch (statErr) {
        throw new PlatformError(`Video file not readable for R2 staging: ${sanitizeErrorMessage(statErr)}`, {
          code: 'VIDEO_FILE_UNREADABLE',
          statusCode: 400,
          retryable: false,
        });
      }
      if (!fileStat.isFile() || fileStat.size <= 0) {
        throw new PlatformError('Cannot upload an empty or non-regular video file to R2.', {
          code: 'EMPTY_VIDEO_FILE',
          statusCode: 400,
          retryable: false,
        });
      }

      const fileSizeBytes = fileStat.size;
      if (fileSizeBytes > limits.maxVideoSizeBytes) {
        const limitMb = (limits.maxVideoSizeBytes / (1024 * 1024)).toFixed(0);
        const actualMb = (fileSizeBytes / (1024 * 1024)).toFixed(1);
        this.#safeRecordUsage({
          eventType: 'limit_blocked',
          opClass: 'GUARD',
          operation: 'video_size_limit',
          bucket: storageConfig.bucket || null,
          bytesDelta: fileSizeBytes,
          utilizationPct: Math.round((fileSizeBytes / limits.maxVideoSizeBytes) * 10000) / 100,
          warningLevel: '100',
          status: 'blocked',
          jobItemId,
          details: { fileSizeBytes, maxVideoSizeBytes: limits.maxVideoSizeBytes, isBillingCap: false },
        });
        throw new PlatformError(
          `R2 upload rejected: video is ${actualMb} MB, exceeding the strict ${limitMb} MB individual video limit (${R2_SAFEGUARD_DISCLAIMER}).`,
          {
            code: 'R2_VIDEO_TOO_LARGE',
            statusCode: 400,
            retryable: false,
            details: { fileSizeBytes, maxVideoSizeBytes: limits.maxVideoSizeBytes, isBillingCap: false },
          }
        );
      }

      // 3. Fail-closed read of monthly counters
      const bucketName = storageConfig.provider === 'mock' ? 'mock-bucket' : storageConfig.bucket;
      const counters = this.#readCountersFailClosed(bucketName, jobItemId);

      // 4. Pre-upload live bucket storage measurement (fail closed if unreadable)
      const measured = await this.measureBucketUsage(storageConfig, { jobItemId });

      // Evaluate & record any crossed 70% / 85% / 95% warning thresholds prior to upload checks
      this.#emitThresholdWarnings({
        limits,
        counters,
        measuredBytes: measured.totalBytes,
        bucket: bucketName,
        jobItemId,
      });

      // 5. Enforce 8 GB max total stored data safeguard
      if (measured.totalBytes + fileSizeBytes > limits.maxTotalStoredBytes) {
        const capGb = (limits.maxTotalStoredBytes / 1024 ** 3).toFixed(2);
        const curGb = (measured.totalBytes / 1024 ** 3).toFixed(3);
        const vidMb = (fileSizeBytes / 1024 ** 2).toFixed(2);
        const pct = Math.round(((measured.totalBytes + fileSizeBytes) / limits.maxTotalStoredBytes) * 10000) / 100;
        this.#safeRecordUsage({
          eventType: 'limit_blocked',
          opClass: 'GUARD',
          operation: 'max_total_stored_bytes',
          bucket: bucketName,
          bytesDelta: fileSizeBytes,
          measuredBytes: measured.totalBytes,
          utilizationPct: pct,
          warningLevel: '100',
          status: 'blocked',
          jobItemId,
          details: {
            measuredBytes: measured.totalBytes,
            fileSizeBytes,
            maxTotalStoredBytes: limits.maxTotalStoredBytes,
            isBillingCap: false,
          },
        });
        throw new PlatformError(
          `R2 upload rejected: current bucket usage (${curGb} GB) plus this video (${vidMb} MB) exceeds the ${capGb} GB local R2 storage safety limit. Run cleanup or delete abandoned temporary objects first. (${R2_SAFEGUARD_DISCLAIMER})`,
          {
            code: 'R2_STORAGE_LIMIT_EXCEEDED',
            statusCode: 429,
            retryable: false,
            details: {
              measuredBytes: measured.totalBytes,
              fileSizeBytes,
              maxTotalStoredBytes: limits.maxTotalStoredBytes,
              isBillingCap: false,
            },
          }
        );
      }

      // 6. Enforce configurable monthly upload count limit
      if (counters.uploadCount + 1 > limits.monthlyUploadLimitCount) {
        const pct = Math.round(((counters.uploadCount + 1) / limits.monthlyUploadLimitCount) * 10000) / 100;
        this.#safeRecordUsage({
          eventType: 'limit_blocked',
          opClass: 'GUARD',
          operation: 'monthly_upload_limit_count',
          bucket: bucketName,
          utilizationPct: pct,
          warningLevel: '100',
          status: 'blocked',
          jobItemId,
          details: {
            uploadCount: counters.uploadCount,
            monthlyUploadLimitCount: limits.monthlyUploadLimitCount,
            isBillingCap: false,
          },
        });
        throw new PlatformError(
          `R2 upload rejected: monthly upload count (${counters.uploadCount}/${limits.monthlyUploadLimitCount}) has reached the configured local monthly limit. (${R2_SAFEGUARD_DISCLAIMER})`,
          {
            code: 'R2_MONTHLY_UPLOAD_LIMIT_EXCEEDED',
            statusCode: 429,
            retryable: false,
            details: {
              uploadCount: counters.uploadCount,
              monthlyUploadLimitCount: limits.monthlyUploadLimitCount,
              isBillingCap: false,
            },
          }
        );
      }

      // 7. Enforce configurable monthly upload bytes limit
      if (counters.uploadBytes + fileSizeBytes > limits.monthlyUploadLimitBytes) {
        const limitMb = (limits.monthlyUploadLimitBytes / (1024 * 1024)).toFixed(1);
        const usedMb = (counters.uploadBytes / (1024 * 1024)).toFixed(1);
        const pct = Math.round(((counters.uploadBytes + fileSizeBytes) / limits.monthlyUploadLimitBytes) * 10000) / 100;
        this.#safeRecordUsage({
          eventType: 'limit_blocked',
          opClass: 'GUARD',
          operation: 'monthly_upload_limit_bytes',
          bucket: bucketName,
          bytesDelta: fileSizeBytes,
          utilizationPct: pct,
          warningLevel: '100',
          status: 'blocked',
          jobItemId,
          details: {
            uploadBytes: counters.uploadBytes,
            fileSizeBytes,
            monthlyUploadLimitBytes: limits.monthlyUploadLimitBytes,
            isBillingCap: false,
          },
        });
        throw new PlatformError(
          `R2 upload rejected: monthly upload volume (${usedMb} MB + ${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB) would exceed the ${limitMb} MB configured local monthly upload limit. (${R2_SAFEGUARD_DISCLAIMER})`,
          {
            code: 'R2_MONTHLY_BYTES_LIMIT_EXCEEDED',
            statusCode: 429,
            retryable: false,
            details: {
              uploadBytes: counters.uploadBytes,
              fileSizeBytes,
              monthlyUploadLimitBytes: limits.monthlyUploadLimitBytes,
              isBillingCap: false,
            },
          }
        );
      }

      // 8. Enforce Class A / Class B operation free-tier safety ceilings
      const useMultipart = fileSizeBytes >= limits.multipartThresholdBytes;
      const estimatedNewClassAOps = useMultipart
        ? 2 + Math.ceil(fileSizeBytes / limits.multipartPartSizeBytes)
        : 1;
      if (
        counters.classAOps + estimatedNewClassAOps > limits.monthlyClassAOpsLimit ||
        counters.classBOps + 1 > limits.monthlyClassBOpsLimit
      ) {
        this.#safeRecordUsage({
          eventType: 'limit_blocked',
          opClass: 'GUARD',
          operation: 'monthly_ops_safety_limit',
          bucket: bucketName,
          warningLevel: '100',
          status: 'blocked',
          jobItemId,
          details: {
            classAOps: counters.classAOps,
            monthlyClassAOpsLimit: limits.monthlyClassAOpsLimit,
            classBOps: counters.classBOps,
            monthlyClassBOpsLimit: limits.monthlyClassBOpsLimit,
            isBillingCap: false,
          },
        });
        throw new PlatformError(
          `R2 upload rejected: monthly Class A/B operation count would exceed configured local R2 free-tier safety limit. (${R2_SAFEGUARD_DISCLAIMER})`,
          {
            code: 'R2_MONTHLY_OPS_LIMIT_EXCEEDED',
            statusCode: 429,
            retryable: false,
            details: { isBillingCap: false },
          }
        );
      }

      const ext = path.extname(filePath) || '.mp4';
      const objectKey = `ig-temp/${new Date().toISOString().slice(0, 10)}/${crypto.randomBytes(16).toString('hex')}${ext}`;
      const expiresAt = new Date(Date.now() + limits.retentionMinutes * 60 * 1000).toISOString();

      // Mock provider path (used in tests)
      if (storageConfig.provider === 'mock') {
        const targetDir = this.mockDir || path.join(path.dirname(filePath), 'mock-cloud-storage');
        fs.mkdirSync(targetDir, { recursive: true });
        const dest = path.join(targetDir, objectKey.replace(/\//g, '_'));
        fs.copyFileSync(filePath, dest);

        const recordId = this.tempObjectsRepo.recordUpload({
          jobItemId,
          provider: 'mock',
          bucket: 'mock-bucket',
          objectKey,
          fileSizeBytes,
          uploadPhase: 'completed',
          expiresAt,
        });

        this.#safeRecordUsage({
          eventType: 'upload_put',
          opClass: 'A',
          operation: 'PutObject(mock)',
          bucket: 'mock-bucket',
          objectKey,
          bytesDelta: fileSizeBytes,
          measuredBytes: measured.totalBytes + fileSizeBytes,
          status: 'ok',
          jobItemId,
          countUpload: true,
          uploadBytesDelta: fileSizeBytes,
          classAOpsDelta: 1,
          details: { storageClass: 'STANDARD', publicAccess: false },
        });
        this.#safeRecordUsage({
          eventType: 'presign_get',
          opClass: 'B',
          operation: 'PresignedGetUrl(mock)',
          bucket: 'mock-bucket',
          objectKey,
          status: 'ok',
          jobItemId,
          classBOpsDelta: 1,
          details: { urlTtlSeconds: limits.urlTtlSeconds },
        });

        const updatedCounters = this.r2UsageRepo.getMonthlyCounters();
        this.#emitThresholdWarnings({
          limits,
          counters: updatedCounters,
          measuredBytes: measured.totalBytes + fileSizeBytes,
          bucket: 'mock-bucket',
          jobItemId,
        });

        return {
          recordId,
          provider: 'mock',
          bucket: 'mock-bucket',
          objectKey,
          fileSizeBytes,
          presignedUrl: `https://mock-r2.local/${objectKey}?X-Amz-Expires=${limits.urlTtlSeconds}&X-Amz-Signature=mock`,
          expiresAt,
          storageClass: 'STANDARD',
          isBillingCap: false,
          disclaimer: R2_SAFEGUARD_DISCLAIMER,
        };
      }

      const endpointUrl = this.resolveEndpoint(storageConfig);
      let recordId;

      if (useMultipart) {
        recordId = await this.#uploadMultipart({
          filePath,
          fileSizeBytes,
          endpointUrl,
          objectKey,
          jobItemId,
          storageConfig,
          limits,
          contentType,
          expiresAt,
          measuredBytesBefore: measured.totalBytes,
        });
      } else {
        recordId = await this.#uploadSinglePut({
          filePath,
          fileSizeBytes,
          endpointUrl,
          objectKey,
          jobItemId,
          storageConfig,
          contentType,
          expiresAt,
          measuredBytesBefore: measured.totalBytes,
        });
      }

      // Generate strictly short-lived (<= 3600s) private presigned GET URL for Instagram ingestion
      const presignedUrl = createPresignedS3GetUrl({
        endpointUrl,
        bucket: storageConfig.bucket,
        objectKey,
        accessKeyId: storageConfig.accessKeyId,
        secretAccessKey: storageConfig.secretAccessKey,
        region: storageConfig.region || 'auto',
        expiresSeconds: limits.urlTtlSeconds,
      });
      registerSensitiveValue(presignedUrl);

      this.#safeRecordUsage({
        eventType: 'presign_get',
        opClass: 'B',
        operation: 'PresignedGetUrl',
        bucket: storageConfig.bucket,
        objectKey,
        status: 'ok',
        jobItemId,
        classBOpsDelta: 1,
        details: { urlTtlSeconds: limits.urlTtlSeconds, publicAccess: false },
      });

      const postCounters = this.r2UsageRepo.getMonthlyCounters();
      this.#emitThresholdWarnings({
        limits,
        counters: postCounters,
        measuredBytes: measured.totalBytes + fileSizeBytes,
        bucket: storageConfig.bucket,
        jobItemId,
      });

      return {
        recordId,
        provider: storageConfig.provider || 'r2',
        bucket: storageConfig.bucket,
        objectKey,
        fileSizeBytes,
        presignedUrl,
        expiresAt,
        storageClass: 'STANDARD',
        isBillingCap: false,
        disclaimer: R2_SAFEGUARD_DISCLAIMER,
      };
    } finally {
      this._activeUploads = Math.max(0, this._activeUploads - 1);
    }
  }

  async #uploadSinglePut({
    filePath,
    fileSizeBytes,
    endpointUrl,
    objectKey,
    jobItemId,
    storageConfig,
    contentType,
    expiresAt,
    measuredBytesBefore,
  }) {
    const bodyBuf = fs.readFileSync(filePath);
    const payloadHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');

    await withExponentialBackoff(
      async (attempt) => {
        const signed = buildSignedS3Headers({
          method: 'PUT',
          endpointUrl,
          bucket: storageConfig.bucket,
          objectKey,
          accessKeyId: storageConfig.accessKeyId,
          secretAccessKey: storageConfig.secretAccessKey,
          region: storageConfig.region || 'auto',
          contentType,
          payloadHash,
        });

        let res;
        try {
          res = await this.fetch(signed.url, {
            method: 'PUT',
            headers: signed.headers,
            body: bodyBuf,
          });
        } catch (netErr) {
          this.#safeRecordUsage({
            eventType: 'upload_put_attempt',
            opClass: 'A',
            operation: 'PutObject',
            bucket: storageConfig.bucket,
            objectKey,
            status: 'error',
            jobItemId,
            classAOpsDelta: 1,
            details: { attempt, error: sanitizeErrorMessage(netErr) },
          });
          throw new PlatformError(
            `Temporary cloud media upload network failure: ${sanitizeErrorMessage(netErr)}`,
            { code: 'TEMP_STORAGE_UPLOAD_FAILED', statusCode: 503, retryable: true }
          );
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          this.#safeRecordUsage({
            eventType: 'upload_put_attempt',
            opClass: 'A',
            operation: 'PutObject',
            bucket: storageConfig.bucket,
            objectKey,
            status: 'error',
            jobItemId,
            classAOpsDelta: 1,
            details: { attempt, httpStatus: res.status },
          });
          throw new PlatformError(
            `Temporary cloud media upload failed (${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
            {
              code: 'TEMP_STORAGE_UPLOAD_FAILED',
              statusCode: res.status,
              retryable: res.status === 429 || res.status >= 500,
            }
          );
        }
      },
      {
        maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS,
        baseDelayMs: this.retryBaseDelayMs,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger?.warn('Retrying R2 PutObject upload', { attempt, delayMs, objectKey, error: error?.message });
        },
      }
    );

    const recordId = this.tempObjectsRepo.recordUpload({
      jobItemId,
      provider: storageConfig.provider || 'r2',
      bucket: storageConfig.bucket,
      objectKey,
      fileSizeBytes,
      uploadPhase: 'completed',
      expiresAt,
    });

    this.#safeRecordUsage({
      eventType: 'upload_put',
      opClass: 'A',
      operation: 'PutObject',
      bucket: storageConfig.bucket,
      objectKey,
      bytesDelta: fileSizeBytes,
      measuredBytes: measuredBytesBefore + fileSizeBytes,
      status: 'ok',
      jobItemId,
      countUpload: true,
      uploadBytesDelta: fileSizeBytes,
      classAOpsDelta: 1,
      details: { storageClass: 'STANDARD', publicAccess: false },
    });

    return recordId;
  }

  async #uploadMultipart({
    filePath,
    fileSizeBytes,
    endpointUrl,
    objectKey,
    jobItemId,
    storageConfig,
    limits,
    contentType,
    expiresAt,
    measuredBytesBefore,
  }) {
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');

    // 1. CreateMultipartUpload
    const uploadId = await withExponentialBackoff(
      async () => {
        const signed = buildSignedS3Headers({
          method: 'POST',
          endpointUrl,
          bucket: storageConfig.bucket,
          objectKey,
          queryParams: { uploads: '' },
          accessKeyId: storageConfig.accessKeyId,
          secretAccessKey: storageConfig.secretAccessKey,
          region: storageConfig.region || 'auto',
          contentType,
          payloadHash: emptyHash,
        });

        const res = await this.fetch(signed.url, {
          method: 'POST',
          headers: signed.headers,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new PlatformError(
            `R2 CreateMultipartUpload failed (${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
            {
              code: 'TEMP_STORAGE_UPLOAD_FAILED',
              statusCode: res.status,
              retryable: res.status === 429 || res.status >= 500,
            }
          );
        }
        const xml = await res.text();
        return parseInitiateMultipartUploadXml(xml);
      },
      { maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS, baseDelayMs: this.retryBaseDelayMs }
    );

    this._activeMultipartUploadIds.add(uploadId);

    const recordId = this.tempObjectsRepo.recordUploadIntent({
      jobItemId,
      provider: storageConfig.provider || 'r2',
      bucket: storageConfig.bucket,
      objectKey,
      fileSizeBytes,
      multipartUploadId: uploadId,
      expiresAt,
    });

    this.#safeRecordUsage({
      eventType: 'multipart_create',
      opClass: 'A',
      operation: 'CreateMultipartUpload',
      bucket: storageConfig.bucket,
      objectKey,
      status: 'ok',
      jobItemId,
      classAOpsDelta: 1,
      details: { uploadId, storageClass: 'STANDARD' },
    });

    const parts = [];
    const partSize = limits.multipartPartSizeBytes;
    const fd = fs.openSync(filePath, 'r');

    try {
      let offset = 0;
      let partNumber = 1;

      while (offset < fileSizeBytes) {
        const chunkLen = Math.min(partSize, fileSizeBytes - offset);
        const buf = Buffer.allocUnsafe(chunkLen);
        fs.readSync(fd, buf, 0, chunkLen, offset);
        const partHash = crypto.createHash('sha256').update(buf).digest('hex');
        const currentPart = partNumber;

        const etag = await withExponentialBackoff(
          async () => {
            const signed = buildSignedS3Headers({
              method: 'PUT',
              endpointUrl,
              bucket: storageConfig.bucket,
              objectKey,
              queryParams: { partNumber: String(currentPart), uploadId },
              accessKeyId: storageConfig.accessKeyId,
              secretAccessKey: storageConfig.secretAccessKey,
              region: storageConfig.region || 'auto',
              contentType: 'application/octet-stream',
              payloadHash: partHash,
            });
            const res = await this.fetch(signed.url, {
              method: 'PUT',
              headers: signed.headers,
              body: buf,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new PlatformError(
                `R2 UploadPart #${currentPart} failed (${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
                {
                  code: 'TEMP_STORAGE_UPLOAD_FAILED',
                  statusCode: res.status,
                  retryable: res.status === 429 || res.status >= 500,
                }
              );
            }
            const hdrEtag = res.headers.get('etag');
            if (!hdrEtag) {
              throw new PlatformError(`R2 UploadPart #${currentPart} response missing ETag header.`, {
                code: 'TEMP_STORAGE_UPLOAD_FAILED',
                statusCode: 502,
                retryable: false,
              });
            }
            return hdrEtag;
          },
          { maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS, baseDelayMs: this.retryBaseDelayMs }
        );

        this.#safeRecordUsage({
          eventType: 'multipart_part',
          opClass: 'A',
          operation: 'UploadPart',
          bucket: storageConfig.bucket,
          objectKey,
          bytesDelta: chunkLen,
          status: 'ok',
          jobItemId,
          classAOpsDelta: 1,
          details: { uploadId, partNumber: currentPart, chunkLen },
        });

        parts.push({ partNumber: currentPart, etag });
        offset += chunkLen;
        partNumber += 1;
      }

      // 3. CompleteMultipartUpload
      const completeXml = buildCompleteMultipartUploadXml(parts);
      const completeHash = crypto.createHash('sha256').update(completeXml, 'utf8').digest('hex');

      await withExponentialBackoff(
        async () => {
          const signed = buildSignedS3Headers({
            method: 'POST',
            endpointUrl,
            bucket: storageConfig.bucket,
            objectKey,
            queryParams: { uploadId },
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
            region: storageConfig.region || 'auto',
            contentType: 'application/xml',
            payloadHash: completeHash,
          });
          const res = await this.fetch(signed.url, {
            method: 'POST',
            headers: signed.headers,
            body: completeXml,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new PlatformError(
              `R2 CompleteMultipartUpload failed (${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
              {
                code: 'TEMP_STORAGE_UPLOAD_FAILED',
                statusCode: res.status,
                retryable: res.status === 429 || res.status >= 500,
              }
            );
          }
        },
        { maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS, baseDelayMs: this.retryBaseDelayMs }
      );

      this.tempObjectsRepo.markUploadCompleted(recordId, { fileSizeBytes });
      this.#safeRecordUsage({
        eventType: 'multipart_complete',
        opClass: 'A',
        operation: 'CompleteMultipartUpload',
        bucket: storageConfig.bucket,
        objectKey,
        bytesDelta: fileSizeBytes,
        measuredBytes: measuredBytesBefore + fileSizeBytes,
        status: 'ok',
        jobItemId,
        countUpload: true,
        uploadBytesDelta: fileSizeBytes,
        classAOpsDelta: 1,
        details: { uploadId, partsCount: parts.length },
      });

      return recordId;
    } catch (err) {
      await this.#abortMultipartUpload({
        endpointUrl,
        bucket: storageConfig.bucket,
        objectKey,
        uploadId,
        storageConfig,
        recordId,
        jobItemId,
        reason: err?.message || 'Multipart upload failed',
      });
      throw err;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
      this._activeMultipartUploadIds.delete(uploadId);
    }
  }

  async #abortMultipartUpload({
    endpointUrl,
    bucket,
    objectKey,
    uploadId,
    storageConfig,
    recordId = null,
    jobItemId = null,
    reason = 'Aborted incomplete multipart upload',
  }) {
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    try {
      await withExponentialBackoff(
        async () => {
          const signed = buildSignedS3Headers({
            method: 'DELETE',
            endpointUrl,
            bucket,
            objectKey,
            queryParams: { uploadId },
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
            region: storageConfig.region || 'auto',
            payloadHash: emptyHash,
          });
          const res = await this.fetch(signed.url, {
            method: 'DELETE',
            headers: signed.headers,
          });
          if (!res.ok && res.status !== 404) {
            throw new PlatformError(`R2 AbortMultipartUpload failed (HTTP ${res.status})`, {
              code: 'R2_MULTIPART_ABORT_FAILED',
              statusCode: res.status,
              retryable: res.status === 429 || res.status >= 500,
            });
          }
        },
        { maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS, baseDelayMs: this.retryBaseDelayMs }
      );

      if (recordId) {
        this.tempObjectsRepo.markUploadAborted(recordId, reason);
      } else if (this.tempObjectsRepo) {
        const tracked = this.tempObjectsRepo.findByObjectKey(objectKey, bucket);
        if (tracked && tracked.status !== 'deleted') {
          this.tempObjectsRepo.markUploadAborted(tracked.id, reason);
        }
      }

      this.#safeRecordUsage({
        eventType: 'multipart_abort',
        opClass: 'FREE',
        operation: 'AbortMultipartUpload',
        bucket,
        objectKey,
        status: 'ok',
        jobItemId,
        countAbortMultipart: true,
        details: { uploadId, reason: sanitizeErrorMessage(reason) },
      });

      this.logger?.info('Aborted incomplete R2 multipart upload', { bucket, objectKey, uploadId });
      return true;
    } catch (abortErr) {
      const msg = sanitizeErrorMessage(abortErr);
      this.#safeRecordUsage({
        eventType: 'multipart_abort_failed',
        opClass: 'FREE',
        operation: 'AbortMultipartUpload',
        bucket,
        objectKey,
        status: 'error',
        jobItemId,
        details: { uploadId, error: msg },
      });
      this.logger?.warn('Failed to abort incomplete R2 multipart upload', { bucket, objectKey, uploadId, error: msg });
      return false;
    }
  }

  async deleteTemporaryVideo({
    recordId = null,
    provider,
    bucket,
    objectKey,
    storageConfig = {},
    status = 'deleted',
    force = false,
  }) {
    const existingRow = recordId ? this.tempObjectsRepo.findById(recordId) : null;
    if (!force && existingRow && existingRow.cleanup_attempts >= R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS) {
      return false;
    }

    try {
      if (provider === 'mock') {
        if (this.mockDir) {
          const dest = path.join(this.mockDir, objectKey.replace(/\//g, '_'));
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
        }
        if (recordId) {
          this.tempObjectsRepo.markDeleted(recordId, status);
        }
        this.#safeRecordUsage({
          eventType: 'delete_object',
          opClass: 'FREE',
          operation: 'DeleteObject(mock)',
          bucket: bucket || 'mock-bucket',
          objectKey,
          bytesDelta: -(existingRow?.file_size_bytes || 0),
          status: 'ok',
          jobItemId: existingRow?.job_item_id || null,
          countDelete: true,
          details: { targetStatus: status },
        });
        return true;
      }

      const endpointUrl = this.resolveEndpoint(storageConfig);
      if (!endpointUrl || !storageConfig.accessKeyId || !storageConfig.secretAccessKey) {
        if (recordId) {
          this.tempObjectsRepo.markDeleteFailed(recordId, 'Missing storage credentials for cleanup');
        }
        this.#safeRecordUsage({
          eventType: 'delete_failed',
          opClass: 'FREE',
          operation: 'DeleteObject',
          bucket: bucket || storageConfig.bucket || null,
          objectKey,
          status: 'error',
          jobItemId: existingRow?.job_item_id || null,
          details: { error: 'Missing storage credentials for cleanup' },
        });
        return false;
      }

      const payloadHash = crypto.createHash('sha256').update('').digest('hex');

      await withExponentialBackoff(
        async () => {
          const signed = buildSignedS3Headers({
            method: 'DELETE',
            endpointUrl,
            bucket: bucket || storageConfig.bucket,
            objectKey,
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
            region: storageConfig.region || 'auto',
            payloadHash,
          });

          const res = await this.fetch(signed.url, {
            method: 'DELETE',
            headers: signed.headers,
          });

          if (!res.ok && res.status !== 404) {
            throw new PlatformError(`HTTP ${res.status}`, {
              code: 'R2_DELETE_FAILED',
              statusCode: res.status,
              retryable: res.status === 429 || res.status >= 500,
            });
          }
        },
        {
          maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS,
          baseDelayMs: this.retryBaseDelayMs,
        }
      );

      if (recordId) {
        this.tempObjectsRepo.markDeleted(recordId, status);
      } else {
        this.tempObjectsRepo.markDeletedByKey({ objectKey, bucket: bucket || storageConfig.bucket, status });
      }

      this.#safeRecordUsage({
        eventType: 'delete_object',
        opClass: 'FREE',
        operation: 'DeleteObject',
        bucket: bucket || storageConfig.bucket,
        objectKey,
        bytesDelta: -(existingRow?.file_size_bytes || 0),
        status: 'ok',
        jobItemId: existingRow?.job_item_id || null,
        countDelete: true,
        details: { targetStatus: status },
      });
      return true;
    } catch (err) {
      const msg = sanitizeErrorMessage(err);
      const updated = recordId ? this.tempObjectsRepo.markDeleteFailed(recordId, msg) : null;
      this.#safeRecordUsage({
        eventType: 'delete_failed',
        opClass: 'FREE',
        operation: 'DeleteObject',
        bucket: bucket || storageConfig.bucket || null,
        objectKey,
        status: 'error',
        jobItemId: existingRow?.job_item_id || null,
        details: {
          error: msg,
          cleanupAttempts: updated?.cleanup_attempts ?? null,
          maxCleanupAttempts: R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS,
        },
      });
      this.logger?.warn('Failed to delete temporary cloud media object', {
        recordId,
        objectKey,
        cleanupAttempts: updated?.cleanup_attempts,
        error: msg,
      });
      return false;
    }
  }

  async cleanupAbandonedUploads(storageConfig = {}, { now = new Date(), force = false } = {}) {
    const limits = resolveEffectiveR2Limits(storageConfig);
    const abandonedHours = limits.abandonedUploadHours;
    const nowIso = now.toISOString();
    const cutoffMs = now.getTime() - abandonedHours * 3600_000;

    // 1. Clean DB-tracked expired or >=24h-abandoned uploads (respecting MAX_CLEANUP_ATTEMPTS so retries never loop forever)
    const due = this.tempObjectsRepo.listDueForCleanup(nowIso, {
      abandonedHours,
      maxAttempts: R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS,
      force,
    });
    let cleanedDb = 0;
    const handledKeys = new Set();

    for (const item of due) {
      handledKeys.add(item.object_key);
      const ok = await this.deleteTemporaryVideo({
        recordId: item.id,
        provider: item.provider,
        bucket: item.bucket,
        objectKey: item.object_key,
        storageConfig,
        status: 'expired_cleaned',
        force,
      });
      if (ok) cleanedDb++;
    }

    // 2. Clean untracked/remote objects under ig-temp/ older than 24 hours
    let abandonedRemoteFound = 0;
    let cleanedRemote = 0;

    if (this.isConfigured(storageConfig)) {
      try {
        const listed = await this.measureBucketUsage(storageConfig, { prefix: 'ig-temp/' });
        for (const obj of listed.objects) {
          if (handledKeys.has(obj.key)) continue;
          const lmMs = obj.lastModified ? new Date(obj.lastModified).getTime() : NaN;
          if (Number.isNaN(lmMs) || lmMs > cutoffMs) continue;

          const tracked = this.tempObjectsRepo.findByObjectKey(obj.key, storageConfig.bucket || 'mock-bucket');
          if (!force && tracked && tracked.cleanup_attempts >= R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS) {
            continue;
          }

          abandonedRemoteFound++;
          const ok = await this.deleteTemporaryVideo({
            recordId: tracked?.id || null,
            provider: storageConfig.provider || 'r2',
            bucket: storageConfig.bucket || 'mock-bucket',
            objectKey: obj.key,
            storageConfig,
            status: 'expired_cleaned',
            force,
          });
          if (ok) cleanedRemote++;
        }
      } catch (err) {
        this.logger?.warn('Remote 24h abandoned object scan failed', {
          error: sanitizeErrorMessage(err),
        });
      }
    }

    return {
      checked: due.length,
      cleanedDb,
      abandonedRemoteFound,
      cleanedRemote,
      cleaned: cleanedDb + cleanedRemote,
    };
  }

  async cleanupIncompleteMultipartUploads(storageConfig = {}) {
    if (storageConfig.provider === 'mock' || !this.isConfigured(storageConfig)) {
      return { skipped: true, checked: 0, aborted: 0 };
    }

    const endpointUrl = this.resolveEndpoint(storageConfig);
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    const allUploads = [];
    let keyMarker = null;
    let uploadIdMarker = null;

    for (let page = 1; page <= this.maxListPages; page++) {
      const parsed = await withExponentialBackoff(
        async () => {
          const queryParams = {
            uploads: '',
            prefix: 'ig-temp/',
            ...(keyMarker ? { 'key-marker': keyMarker } : {}),
            ...(uploadIdMarker ? { 'upload-id-marker': uploadIdMarker } : {}),
          };
          const signed = buildSignedS3Headers({
            method: 'GET',
            endpointUrl,
            bucket: storageConfig.bucket,
            objectKey: '',
            queryParams,
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
            region: storageConfig.region || 'auto',
            payloadHash: emptyHash,
          });
          const res = await this.fetch(signed.url, {
            method: 'GET',
            headers: signed.headers,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new PlatformError(
              `R2 ListMultipartUploads failed (${res.status}): ${sanitizeErrorMessage(text || res.statusText)}`,
              {
                code: 'R2_LIST_MULTIPART_FAILED',
                statusCode: res.status,
                retryable: res.status === 429 || res.status >= 500,
              }
            );
          }
          const xml = await res.text();
          return parseListMultipartUploadsXml(xml);
        },
        { maxAttempts: R2_SAFE_LIMITS.MAX_RETRY_ATTEMPTS, baseDelayMs: this.retryBaseDelayMs }
      );

      this.#safeRecordUsage({
        eventType: 'list_multipart',
        opClass: 'A',
        operation: 'ListMultipartUploads',
        bucket: storageConfig.bucket,
        status: 'ok',
        classAOpsDelta: 1,
        details: { page, uploadsInPage: parsed.uploads.length },
      });

      allUploads.push(...parsed.uploads);
      if (!parsed.isTruncated || !parsed.nextKeyMarker) {
        break;
      }
      keyMarker = parsed.nextKeyMarker;
      uploadIdMarker = parsed.nextUploadIdMarker;
    }

    let aborted = 0;
    for (const upload of allUploads) {
      if (this._activeMultipartUploadIds.has(upload.uploadId)) {
        continue;
      }
      const ok = await this.#abortMultipartUpload({
        endpointUrl,
        bucket: storageConfig.bucket,
        objectKey: upload.key,
        uploadId: upload.uploadId,
        storageConfig,
        reason: 'Incomplete multipart upload aborted by cleanup sweep',
      });
      if (ok) aborted++;
    }

    return {
      skipped: false,
      checked: allUploads.length,
      aborted,
    };
  }

  async runRetentionCleanup(storageConfig = {}, options = {}) {
    let abandoned = { checked: 0, cleanedDb: 0, abandonedRemoteFound: 0, cleanedRemote: 0, cleaned: 0 };
    let multipart = { skipped: true, checked: 0, aborted: 0 };

    try {
      abandoned = await this.cleanupAbandonedUploads(storageConfig, options);
    } catch (err) {
      this.logger?.warn('Abandoned upload cleanup sweep failed', { error: sanitizeErrorMessage(err) });
    }

    try {
      multipart = await this.cleanupIncompleteMultipartUploads(storageConfig);
    } catch (err) {
      this.logger?.warn('Incomplete multipart upload cleanup sweep failed', { error: sanitizeErrorMessage(err) });
    }

    this.#safeRecordUsage({
      eventType: 'cleanup_sweep',
      opClass: 'FREE',
      operation: 'RetentionAndMultipartSweep',
      bucket: storageConfig.provider === 'mock' ? 'mock-bucket' : storageConfig.bucket || null,
      status: 'ok',
      details: { abandoned, multipart },
    });

    return {
      checked: abandoned.checked,
      cleaned: abandoned.cleaned,
      abandoned,
      multipart,
    };
  }

  async getUsageStatus(storageConfig = {}, { live = false } = {}) {
    const limits = resolveEffectiveR2Limits(storageConfig);
    const counters = this.r2UsageRepo ? this.r2UsageRepo.getMonthlyCounters() : {
      monthKey: new Date().toISOString().slice(0, 7),
      uploadCount: 0,
      uploadBytes: 0,
      deleteCount: 0,
      abortMultipartCount: 0,
      classAOps: 0,
      classBOps: 0,
      lastMeasuredBytes: null,
      lastMeasuredObjects: null,
      lastMeasuredAt: null,
    };

    let measured = null;
    let measurementReliable = counters.lastMeasuredBytes !== null;
    let measurementError = null;

    if (live && this.isConfigured(storageConfig)) {
      try {
        measured = await this.measureBucketUsage(storageConfig);
        measurementReliable = true;
      } catch (err) {
        measurementReliable = false;
        measurementError = sanitizeErrorMessage(err);
      }
    } else if (!this.isConfigured(storageConfig)) {
      measurementReliable = false;
    }

    const updatedCounters = this.r2UsageRepo ? this.r2UsageRepo.getMonthlyCounters() : counters;
    const measuredBytes = measured ? measured.totalBytes : updatedCounters.lastMeasuredBytes;
    const activeQueuedJobs = this.jobsRepo ? this.jobsRepo.countActiveJobs() : 0;
    const evaluation = evaluateR2Warnings({
      limits,
      counters: updatedCounters,
      measuredBytes,
      activeQueuedJobs,
    });

    const recentLogs = this.r2UsageRepo
      ? this.r2UsageRepo.getRecentLogs({ limit: 35, monthKey: updatedCounters.monthKey })
      : [];

    const trackedObjects = this.tempObjectsRepo
      ? this.tempObjectsRepo.sumActiveTrackedBytes()
      : { totalBytes: 0, objectCount: 0 };

    return {
      configured: this.isConfigured(storageConfig),
      provider: storageConfig.provider || 'r2',
      bucket: storageConfig.bucket || '',
      storageClass: 'STANDARD',
      publicAccess: false,
      activeConcurrentUploads: this._activeUploads,
      activeQueuedJobs,
      measurementReliable,
      measurementError,
      measured: measured || {
        totalBytes: updatedCounters.lastMeasuredBytes,
        objectCount: updatedCounters.lastMeasuredObjects,
        measuredAt: updatedCounters.lastMeasuredAt,
      },
      trackedObjects,
      counters: updatedCounters,
      limits,
      evaluation,
      cloudflareFreeTier: CLOUDFLARE_R2_FREE_TIER_ALLOWANCE,
      isBillingCap: false,
      disclaimer: R2_SAFEGUARD_DISCLAIMER,
      recentLogs,
    };
  }
}
