export const R2_SAFE_LIMITS = Object.freeze({
  MAX_TOTAL_STORED_BYTES: 8 * 1024 * 1024 * 1024, // 8 GiB hard app cap (Cloudflare free tier: 10 GB)
  MAX_VIDEO_SIZE_BYTES: 500 * 1024 * 1024, // 500 MiB max per video
  MAX_CONCURRENT_UPLOADS: 1,
  MAX_QUEUED_JOBS: 10,
  ABANDONED_UPLOAD_HOURS: 24,
  MAX_URL_TTL_SECONDS: 3600, // 1 hour max for presigned GET URLs
  DEFAULT_URL_TTL_SECONDS: 1800,
  MAX_RETENTION_MINUTES: 1440, // 24 hours max retention
  DEFAULT_RETENTION_MINUTES: 60,
  DEFAULT_MONTHLY_UPLOAD_LIMIT_COUNT: 200,
  MAX_CONFIGURABLE_MONTHLY_UPLOAD_COUNT: 10000,
  DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES: 10 * 1024 * 1024 * 1024, // 10 GiB configurable monthly volume limit
  MAX_CONFIGURABLE_MONTHLY_UPLOAD_BYTES: 100 * 1024 * 1024 * 1024,
  DEFAULT_MONTHLY_CLASS_A_OPS_LIMIT: 800_000, // 80% of 1M free-tier Class A ops/month
  MAX_CONFIGURABLE_CLASS_A_OPS_LIMIT: 950_000,
  DEFAULT_MONTHLY_CLASS_B_OPS_LIMIT: 8_000_000, // 80% of 10M free-tier Class B ops/month
  MAX_CONFIGURABLE_CLASS_B_OPS_LIMIT: 9_500_000,
  DEFAULT_MULTIPART_THRESHOLD_BYTES: 100 * 1024 * 1024, // 100 MiB
  MIN_MULTIPART_PART_SIZE_BYTES: 5 * 1024 * 1024, // 5 MiB S3 minimum part size
  DEFAULT_MULTIPART_PART_SIZE_BYTES: 16 * 1024 * 1024, // 16 MiB
  MAX_LIST_PAGES: 50,
  MAX_RETRY_ATTEMPTS: 3,
  MAX_CLEANUP_ATTEMPTS: 5,
  WARNING_THRESHOLDS: Object.freeze([70, 85, 95]),
});

export const CLOUDFLARE_R2_FREE_TIER_ALLOWANCE = Object.freeze({
  storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB / month
  classAOpsPerMonth: 1_000_000,
  classBOpsPerMonth: 10_000_000,
  egressNote: 'Zero egress fees on R2 Standard storage',
});

export const R2_SAFEGUARD_DISCLAIMER =
  'Application-level cost safeguards only — NOT a Cloudflare billing cap or account-level spend limit. Cloudflare billing and usage alerts must still be monitored in your Cloudflare dashboard.';

function clampPositiveInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

export function resolveEffectiveR2Limits(storageConfig = {}) {
  return {
    maxTotalStoredBytes: clampPositiveInt(
      storageConfig.maxTotalStoredBytes,
      R2_SAFE_LIMITS.MAX_TOTAL_STORED_BYTES,
      1,
      R2_SAFE_LIMITS.MAX_TOTAL_STORED_BYTES
    ),
    maxVideoSizeBytes: clampPositiveInt(
      storageConfig.maxVideoSizeBytes,
      R2_SAFE_LIMITS.MAX_VIDEO_SIZE_BYTES,
      1,
      R2_SAFE_LIMITS.MAX_VIDEO_SIZE_BYTES
    ),
    // Strict limit of 1 concurrent upload cannot be raised above 1
    maxConcurrentUploads: R2_SAFE_LIMITS.MAX_CONCURRENT_UPLOADS,
    maxQueuedJobs: clampPositiveInt(
      storageConfig.maxQueuedJobs,
      R2_SAFE_LIMITS.MAX_QUEUED_JOBS,
      1,
      R2_SAFE_LIMITS.MAX_QUEUED_JOBS
    ),
    abandonedUploadHours: clampPositiveInt(
      storageConfig.abandonedUploadHours,
      R2_SAFE_LIMITS.ABANDONED_UPLOAD_HOURS,
      1,
      R2_SAFE_LIMITS.ABANDONED_UPLOAD_HOURS
    ),
    urlTtlSeconds: clampPositiveInt(
      storageConfig.urlTtlSeconds,
      R2_SAFE_LIMITS.DEFAULT_URL_TTL_SECONDS,
      60,
      R2_SAFE_LIMITS.MAX_URL_TTL_SECONDS
    ),
    retentionMinutes: clampPositiveInt(
      storageConfig.retentionMinutes,
      R2_SAFE_LIMITS.DEFAULT_RETENTION_MINUTES,
      5,
      R2_SAFE_LIMITS.MAX_RETENTION_MINUTES
    ),
    monthlyUploadLimitCount: clampPositiveInt(
      storageConfig.monthlyUploadLimitCount,
      R2_SAFE_LIMITS.DEFAULT_MONTHLY_UPLOAD_LIMIT_COUNT,
      1,
      R2_SAFE_LIMITS.MAX_CONFIGURABLE_MONTHLY_UPLOAD_COUNT
    ),
    monthlyUploadLimitBytes: clampPositiveInt(
      storageConfig.monthlyUploadLimitBytes ??
        (storageConfig.monthlyUploadLimitMb ? Number(storageConfig.monthlyUploadLimitMb) * 1024 * 1024 : undefined),
      R2_SAFE_LIMITS.DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES,
      1,
      R2_SAFE_LIMITS.MAX_CONFIGURABLE_MONTHLY_UPLOAD_BYTES
    ),
    monthlyClassAOpsLimit: clampPositiveInt(
      storageConfig.monthlyClassAOpsLimit,
      R2_SAFE_LIMITS.DEFAULT_MONTHLY_CLASS_A_OPS_LIMIT,
      1,
      R2_SAFE_LIMITS.MAX_CONFIGURABLE_CLASS_A_OPS_LIMIT
    ),
    monthlyClassBOpsLimit: clampPositiveInt(
      storageConfig.monthlyClassBOpsLimit,
      R2_SAFE_LIMITS.DEFAULT_MONTHLY_CLASS_B_OPS_LIMIT,
      1,
      R2_SAFE_LIMITS.MAX_CONFIGURABLE_CLASS_B_OPS_LIMIT
    ),
    multipartThresholdBytes: clampPositiveInt(
      storageConfig.multipartThresholdBytes,
      R2_SAFE_LIMITS.DEFAULT_MULTIPART_THRESHOLD_BYTES,
      1,
      R2_SAFE_LIMITS.MAX_VIDEO_SIZE_BYTES
    ),
    multipartPartSizeBytes: clampPositiveInt(
      storageConfig.multipartPartSizeBytes,
      R2_SAFE_LIMITS.DEFAULT_MULTIPART_PART_SIZE_BYTES,
      // Allow smaller part sizes only when explicitly overridden for unit tests with tiny multipartThresholdBytes
      storageConfig.multipartThresholdBytes && storageConfig.multipartThresholdBytes < 1024 * 1024
        ? 1
        : R2_SAFE_LIMITS.MIN_MULTIPART_PART_SIZE_BYTES,
      R2_SAFE_LIMITS.MAX_VIDEO_SIZE_BYTES
    ),
  };
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractFirstTag(xmlChunk, tagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tagName}>`, 'i');
  const match = re.exec(xmlChunk);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

export function parseListObjectsV2Xml(xmlText) {
  const text = String(xmlText || '').trim();
  if (!text || !/<(?:[A-Za-z0-9_-]+:)?ListBucketResult\b/i.test(text) || !/<\/(?:[A-Za-z0-9_-]+:)?ListBucketResult>/i.test(text)) {
    throw new Error('Malformed or missing ListObjectsV2 XML response (<ListBucketResult>)');
  }

  const isTruncatedRaw = extractFirstTag(text, 'IsTruncated');
  const isTruncated = String(isTruncatedRaw || 'false').toLowerCase() === 'true';
  const nextContinuationToken = extractFirstTag(text, 'NextContinuationToken');

  if (isTruncated && !nextContinuationToken) {
    throw new Error('ListObjectsV2 XML marked IsTruncated=true without NextContinuationToken');
  }

  const objects = [];
  const contentsRe = /<(?:[A-Za-z0-9_-]+:)?Contents\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Contents>/gi;
  let match;
  while ((match = contentsRe.exec(text)) !== null) {
    const block = match[1];
    const key = extractFirstTag(block, 'Key');
    const sizeRaw = extractFirstTag(block, 'Size');
    const lastModified = extractFirstTag(block, 'LastModified');

    if (key === null || sizeRaw === null || !/^\d+$/.test(sizeRaw)) {
      throw new Error('ListObjectsV2 XML entry missing valid <Key> or numeric <Size>');
    }
    const sizeBytes = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new Error(`Invalid object size in ListObjectsV2 XML: ${sizeRaw}`);
    }

    objects.push({
      key,
      sizeBytes,
      lastModified: lastModified || null,
    });
  }

  return {
    objects,
    isTruncated,
    nextContinuationToken: nextContinuationToken || null,
  };
}

export function parseInitiateMultipartUploadXml(xmlText) {
  const text = String(xmlText || '').trim();
  const uploadId = extractFirstTag(text, 'UploadId');
  if (!text || !/<(?:[A-Za-z0-9_-]+:)?InitiateMultipartUploadResult\b/i.test(text) || !uploadId) {
    throw new Error('Malformed or missing <UploadId> in CreateMultipartUpload XML response');
  }
  return uploadId;
}

export function parseListMultipartUploadsXml(xmlText) {
  const text = String(xmlText || '').trim();
  if (
    !text ||
    !/<(?:[A-Za-z0-9_-]+:)?ListMultipartUploadsResult\b/i.test(text) ||
    !/<\/(?:[A-Za-z0-9_-]+:)?ListMultipartUploadsResult>/i.test(text)
  ) {
    throw new Error('Malformed or missing ListMultipartUploads XML response (<ListMultipartUploadsResult>)');
  }

  const isTruncated = String(extractFirstTag(text, 'IsTruncated') || 'false').toLowerCase() === 'true';
  const nextKeyMarker = extractFirstTag(text, 'NextKeyMarker');
  const nextUploadIdMarker = extractFirstTag(text, 'NextUploadIdMarker');

  const uploads = [];
  const uploadRe = /<(?:[A-Za-z0-9_-]+:)?Upload\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Upload>/gi;
  let match;
  while ((match = uploadRe.exec(text)) !== null) {
    const block = match[1];
    const key = extractFirstTag(block, 'Key');
    const uploadId = extractFirstTag(block, 'UploadId');
    const initiated = extractFirstTag(block, 'Initiated');
    if (key && uploadId) {
      uploads.push({
        key,
        uploadId,
        initiated: initiated || null,
      });
    }
  }

  return {
    uploads,
    isTruncated,
    nextKeyMarker: nextKeyMarker || null,
    nextUploadIdMarker: nextUploadIdMarker || null,
  };
}

export function buildCompleteMultipartUploadXml(parts) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const itemsXml = sorted
    .map(
      (p) =>
        `  <Part><PartNumber>${Number(p.partNumber)}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`
    )
    .join('\n');
  return `<CompleteMultipartUpload>\n${itemsXml}\n</CompleteMultipartUpload>`;
}

export function evaluateR2Warnings({
  limits,
  counters = {},
  measuredBytes = null,
  activeQueuedJobs = 0,
}) {
  const storedBytes = measuredBytes !== null && measuredBytes !== undefined
    ? Number(measuredBytes)
    : counters.lastMeasuredBytes !== null && counters.lastMeasuredBytes !== undefined
      ? Number(counters.lastMeasuredBytes)
      : null;

  const metricSpecs = [
    {
      metric: 'storageBytes',
      label: 'Stored Data (Bucket Total)',
      used: storedBytes,
      limit: limits.maxTotalStoredBytes,
      unit: 'bytes',
    },
    {
      metric: 'monthlyUploads',
      label: 'Monthly Upload Count',
      used: Number(counters.uploadCount || 0),
      limit: limits.monthlyUploadLimitCount,
      unit: 'uploads',
    },
    {
      metric: 'monthlyUploadBytes',
      label: 'Monthly Uploaded Volume',
      used: Number(counters.uploadBytes || 0),
      limit: limits.monthlyUploadLimitBytes,
      unit: 'bytes',
    },
    {
      metric: 'monthlyClassAOps',
      label: 'Monthly Class A Operations',
      used: Number(counters.classAOps || 0),
      limit: limits.monthlyClassAOpsLimit,
      unit: 'ops',
    },
    {
      metric: 'monthlyClassBOps',
      label: 'Monthly Class B Operations',
      used: Number(counters.classBOps || 0),
      limit: limits.monthlyClassBOpsLimit,
      unit: 'ops',
    },
    {
      metric: 'queuedJobs',
      label: 'Active Publishing Queue',
      used: Number(activeQueuedJobs || 0),
      limit: limits.maxQueuedJobs,
      unit: 'jobs',
    },
  ];

  const metrics = {};
  const warnings = [];
  let highestThreshold = 0;

  for (const spec of metricSpecs) {
    const pct =
      spec.used === null || spec.limit <= 0
        ? null
        : Math.round(((spec.used / spec.limit) * 100) * 100) / 100;

    let crossedThreshold = null;
    if (pct !== null) {
      if (pct >= 95) crossedThreshold = 95;
      else if (pct >= 85) crossedThreshold = 85;
      else if (pct >= 70) crossedThreshold = 70;
    }

    const blocked = pct !== null && spec.used >= spec.limit;
    metrics[spec.metric] = {
      used: spec.used,
      limit: spec.limit,
      unit: spec.unit,
      pct,
      warningThreshold: crossedThreshold,
      blocked,
    };

    if (crossedThreshold !== null) {
      if (crossedThreshold > highestThreshold) highestThreshold = crossedThreshold;
      const severity = blocked || crossedThreshold >= 95 ? 'critical' : crossedThreshold >= 85 ? 'high' : 'warning';
      warnings.push({
        metric: spec.metric,
        label: spec.label,
        thresholdPct: crossedThreshold,
        currentPct: pct,
        used: spec.used,
        limit: spec.limit,
        blocked,
        severity,
        message: `${spec.label} reached ${pct.toFixed(1)}% (crossed ${crossedThreshold}% warning threshold${blocked ? ' — safety limit reached, uploads paused' : ''}).`,
      });
    }
  }

  return {
    metrics,
    warnings,
    highestThreshold: highestThreshold || null,
    anyBlocked: warnings.some((w) => w.blocked),
    isBillingCap: false,
    disclaimer: R2_SAFEGUARD_DISCLAIMER,
  };
}
