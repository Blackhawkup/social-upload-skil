import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSignedS3Headers, createPresignedS3GetUrl } from '../src/integrations/storage/r2SigV4.js';
import { R2_SAFE_LIMITS, R2_SAFEGUARD_DISCLAIMER } from '../src/integrations/storage/r2CostGuard.js';
import { TempCloudHostingAdapter } from '../src/integrations/storage/tempHosting.js';
import { openDatabase } from '../src/db/database.js';
import { TempObjectsRepository } from '../src/db/repositories/tempObjectsRepo.js';
import { HARD_MAX_RETRY_ATTEMPTS, withExponentialBackoff } from '../src/services/retry.js';
import { buildApplication } from '../src/api/app.js';
import { MasterKeyStore } from '../src/security/masterKeyStore.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeListObjectsXml(objects = [], { isTruncated = false, nextToken = '' } = {}) {
  const contents = objects
    .map(
      (o) =>
        `<Contents><Key>${o.key}</Key><LastModified>${o.lastModified || '2026-11-10T12:00:00.000Z'}</LastModified><Size>${o.sizeBytes}</Size></Contents>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>private-ig-temp</Name>
  <IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>
  ${isTruncated ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''}
  ${contents}
</ListBucketResult>`;
}

const BASE_STORAGE_CONFIG = {
  provider: 'r2',
  accountId: 'acct123',
  bucket: 'private-ig-temp',
  accessKeyId: 'AKIA_TEST_KEY',
  secretAccessKey: 'SECRET_TEST_KEY_VALUE',
  region: 'auto',
  urlTtlSeconds: 900,
  retentionMinutes: 60,
};

test('Cloudflare R2 SigV4 enforces Standard private storage, query param signing, short-lived URLs (<=3600s), and retention cleanup', async () => {
  const dir = makeTempDir('smp-r2-');
  try {
    const fixedNow = new Date('2026-11-10T12:00:00.000Z');
    const signedPut = buildSignedS3Headers({
      method: 'PUT',
      endpointUrl: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'private-ig-temp',
      objectKey: 'ig-temp/2026-11-10/video.mp4',
      accessKeyId: 'AKIA_TEST_KEY',
      secretAccessKey: 'SECRET_TEST_KEY_VALUE',
      region: 'auto',
      contentType: 'video/mp4',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: fixedNow,
    });

    assert.equal(signedPut.url, 'https://acct123.r2.cloudflarestorage.com/private-ig-temp/ig-temp/2026-11-10/video.mp4');
    assert.ok(signedPut.headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIA_TEST_KEY/20261110/auto/s3/aws4_request'));
    assert.equal(signedPut.headers['x-amz-date'], '20261110T120000Z');
    // Ensure never public ACL or non-Standard tier headers
    assert.equal(signedPut.headers['x-amz-acl'], undefined);
    assert.equal(signedPut.headers['x-amz-storage-class'], undefined);

    // Query parameter signing for ListObjectsV2 & Multipart uploads
    const signedList = buildSignedS3Headers({
      method: 'GET',
      endpointUrl: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'private-ig-temp',
      objectKey: '',
      queryParams: { 'list-type': '2', prefix: 'ig-temp/' },
      accessKeyId: 'AKIA_TEST_KEY',
      secretAccessKey: 'SECRET_TEST_KEY_VALUE',
      now: fixedNow,
    });
    assert.equal(
      signedList.url,
      'https://acct123.r2.cloudflarestorage.com/private-ig-temp?list-type=2&prefix=ig-temp%2F'
    );

    // Short-lived presigned URL clamps any oversized expiry to 3600 seconds (1 hour)
    const clampedPresigned = createPresignedS3GetUrl({
      endpointUrl: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'private-ig-temp',
      objectKey: 'ig-temp/2026-11-10/video.mp4',
      accessKeyId: 'AKIA_TEST_KEY',
      secretAccessKey: 'SECRET_TEST_KEY_VALUE',
      region: 'auto',
      expiresSeconds: 604800,
      now: fixedNow,
    });
    const clampedParsed = new URL(clampedPresigned);
    assert.equal(clampedParsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(clampedParsed.searchParams.get('X-Amz-Expires'), '3600');
    assert.match(clampedParsed.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);

    // Verify pre-upload ListObjectsV2 + PUT + DB audit log + retention cleanup
    const db = openDatabase(path.join(dir, 'test.db'));
    const tempRepo = new TempObjectsRepository(db);
    const deletedUrls = [];
    const seenMethods = [];
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      seenMethods.push(`${init.method}:${u.split('?')[1] || 'path'}`);
      if (init.method === 'GET' && u.includes('list-type=2')) {
        return new Response(makeListObjectsXml([]), { status: 200 });
      }
      if (init.method === 'GET' && u.includes('uploads=')) {
        return new Response(
          '<?xml version="1.0"?><ListMultipartUploadsResult><Bucket>private-ig-temp</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
          { status: 200 }
        );
      }
      if (init.method === 'PUT') {
        assert.equal(init.headers?.['x-amz-acl'], undefined);
        return new Response(null, { status: 200 });
      }
      if (init.method === 'DELETE') {
        deletedUrls.push(u);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };

    const adapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      fetchImpl: mockFetch,
      retryBaseDelayMs: 1,
    });
    const dummyVideo = path.join(dir, 'sample.mp4');
    fs.writeFileSync(dummyVideo, 'fake-mp4-bytes');

    const uploaded = await adapter.uploadTemporaryVideo({
      filePath: dummyVideo,
      jobItemId: null,
      storageConfig: BASE_STORAGE_CONFIG,
    });
    assert.ok(uploaded.presignedUrl.includes('X-Amz-Expires=900'));
    assert.equal(uploaded.storageClass, 'STANDARD');
    assert.equal(uploaded.isBillingCap, false);
    assert.ok(seenMethods[0].startsWith('GET:list-type=2'));

    // Force object expiration into the past & run cleanup sweep
    db.prepare("UPDATE temp_cloud_objects SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(
      uploaded.recordId
    );
    const cleaned = await adapter.runRetentionCleanup(BASE_STORAGE_CONFIG);
    assert.equal(cleaned.cleaned, 1);
    assert.equal(deletedUrls.length, 1);

    const row = db.prepare('SELECT status FROM temp_cloud_objects WHERE id = ?').get(uploaded.recordId);
    assert.equal(row.status, 'expired_cleaned');

    const logs = adapter.r2UsageRepo.getRecentLogs();
    assert.ok(logs.some((l) => l.operation === 'ListObjectsV2'));
    assert.ok(logs.some((l) => l.operation === 'PutObject'));
    assert.ok(logs.some((l) => l.operation === 'DeleteObject'));
    assert.equal(JSON.stringify(logs).includes('SECRET_TEST_KEY_VALUE'), false);

    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('R2 cost guard enforces 8 GB storage cap (via paginated ListObjectsV2) and fails closed if usage is unreadable', async () => {
  const dir = makeTempDir('smp-r2-cap-');
  try {
    assert.equal(R2_SAFE_LIMITS.MAX_TOTAL_STORED_BYTES, 8 * 1024 * 1024 * 1024);
    assert.equal(R2_SAFE_LIMITS.MAX_VIDEO_SIZE_BYTES, 500 * 1024 * 1024);
    assert.equal(R2_SAFE_LIMITS.MAX_CONCURRENT_UPLOADS, 1);
    assert.equal(R2_SAFE_LIMITS.MAX_QUEUED_JOBS, 10);

    const db = openDatabase(path.join(dir, 'test.db'));
    const tempRepo = new TempObjectsRepository(db);
    const sample = path.join(dir, 'clip.mp4');
    fs.writeFileSync(sample, Buffer.alloc(1024, 1)); // 1024 bytes

    // 1. Paginated ListObjectsV2 summing to 8 GB - 512 bytes -> 1024 byte video pushes total over 8 GB -> REJECT!
    let putCalled = false;
    const near8GbFetch = async (url, init = {}) => {
      const u = String(url);
      if (init.method === 'PUT') putCalled = true;
      if (init.method === 'GET' && u.includes('list-type=2')) {
        if (!u.includes('continuation-token=page2')) {
          return new Response(
            makeListObjectsXml(
              [{ key: 'ig-temp/2026-11-10/big1.mp4', sizeBytes: 4 * 1024 * 1024 * 1024 }],
              { isTruncated: true, nextToken: 'page2' }
            ),
            { status: 200 }
          );
        }
        return new Response(
          makeListObjectsXml([
            { key: 'ig-temp/2026-11-10/big2.mp4', sizeBytes: 4 * 1024 * 1024 * 1024 - 512 },
          ]),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    };

    const adapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      fetchImpl: near8GbFetch,
      retryBaseDelayMs: 1,
    });

    await assert.rejects(
      () => adapter.uploadTemporaryVideo({ filePath: sample, storageConfig: BASE_STORAGE_CONFIG }),
      (err) => err.code === 'R2_STORAGE_LIMIT_EXCEEDED' && err.details?.isBillingCap === false
    );
    assert.equal(putCalled, false, 'Must NEVER send PUT when 8 GB cap would be exceeded');

    // 2. Fail closed on persistent HTTP 500 from ListObjectsV2 (retries bounded to 3 attempts, zero PUT)
    let listAttempts = 0;
    const err500Adapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async (url, init = {}) => {
        if (init.method === 'PUT') putCalled = true;
        if (String(url).includes('list-type=2')) {
          listAttempts++;
          return new Response('Internal Error', { status: 500 });
        }
        return new Response('', { status: 404 });
      },
    });
    await assert.rejects(
      () => err500Adapter.uploadTemporaryVideo({ filePath: sample, storageConfig: BASE_STORAGE_CONFIG }),
      (err) => err.code === 'R2_USAGE_MEASUREMENT_FAILED' && err.retryable === false
    );
    assert.equal(listAttempts, 3);
    assert.equal(putCalled, false);

    // 3. Fail closed on malformed/empty 200 XML from ListObjectsV2 immediately (no retry loop, zero PUT)
    let badXmlAttempts = 0;
    const badXmlAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async () => {
        badXmlAttempts++;
        return new Response('', { status: 200 });
      },
    });
    await assert.rejects(
      () => badXmlAdapter.uploadTemporaryVideo({ filePath: sample, storageConfig: BASE_STORAGE_CONFIG }),
      (err) => err.code === 'R2_USAGE_MEASUREMENT_FAILED'
    );
    assert.equal(badXmlAttempts, 1);

    // 4. Fail closed when ListObjectsV2 pagination stays truncated past maxListPages
    const infiniteTruncatedAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      maxListPages: 3,
      fetchImpl: async () =>
        new Response(
          makeListObjectsXml([{ key: 'ig-temp/p.mp4', sizeBytes: 100 }], { isTruncated: true, nextToken: 'next' }),
          { status: 200 }
        ),
    });
    await assert.rejects(
      () => infiniteTruncatedAdapter.uploadTemporaryVideo({ filePath: sample, storageConfig: BASE_STORAGE_CONFIG }),
      (err) => err.code === 'R2_USAGE_MEASUREMENT_FAILED'
    );

    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('R2 enforces 500 MB max individual video size and max 1 concurrent upload', async () => {
  const dir = makeTempDir('smp-r2-size-conc-');
  try {
    const db = openDatabase(path.join(dir, 'test.db'));
    const tempRepo = new TempObjectsRepository(db);

    // 1. 500 MB + 4 KB sparse video file rejected BEFORE reading or calling R2
    const oversizedVideo = path.join(dir, 'oversized.mp4');
    fs.writeFileSync(oversizedVideo, '');
    fs.truncateSync(oversizedVideo, 500 * 1024 * 1024 + 4096);

    let r2FetchCalls = 0;
    const adapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async () => {
        r2FetchCalls++;
        return new Response('', { status: 200 });
      },
    });

    await assert.rejects(
      () => adapter.uploadTemporaryVideo({ filePath: oversizedVideo, storageConfig: BASE_STORAGE_CONFIG }),
      (err) => err.code === 'R2_VIDEO_TOO_LARGE'
    );
    assert.equal(r2FetchCalls, 0);

    // 2. Concurrent upload > 1 immediately rejected with R2_CONCURRENT_UPLOAD_LIMIT
    const normalVideo = path.join(dir, 'normal.mp4');
    fs.writeFileSync(normalVideo, Buffer.alloc(512, 7));

    let releaseFirstUpload;
    const firstUploadGate = new Promise((r) => {
      releaseFirstUpload = r;
    });
    let putCount = 0;

    const slowAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async (url, init = {}) => {
        if (init.method === 'GET' && String(url).includes('list-type=2')) {
          await firstUploadGate;
          return new Response(makeListObjectsXml([]), { status: 200 });
        }
        if (init.method === 'PUT') {
          putCount++;
          return new Response(null, { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });

    const p1 = slowAdapter.uploadTemporaryVideo({ filePath: normalVideo, storageConfig: BASE_STORAGE_CONFIG });
    const p2 = slowAdapter.uploadTemporaryVideo({ filePath: normalVideo, storageConfig: BASE_STORAGE_CONFIG });

    // 2nd upload fails immediately while 1st is in-flight
    await assert.rejects(p2, (err) => err.code === 'R2_CONCURRENT_UPLOAD_LIMIT');
    assert.equal(slowAdapter.getActiveUploadCount(), 1);

    // Release 1st upload -> completes cleanly -> concurrency slot frees back to 0
    releaseFirstUpload();
    const res1 = await p1;
    assert.ok(res1.recordId);
    assert.equal(putCount, 1);
    assert.equal(slowAdapter.getActiveUploadCount(), 0);

    // Sequential upload now works cleanly
    const res3 = await slowAdapter.uploadTemporaryVideo({ filePath: normalVideo, storageConfig: BASE_STORAGE_CONFIG });
    assert.ok(res3.recordId);
    assert.equal(putCount, 2);

    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Configurable monthly upload limits + 70%/85%/95% threshold warnings + disclaimer + local logging', async () => {
  const dir = makeTempDir('smp-r2-monthly-');
  try {
    const db = openDatabase(path.join(dir, 'test.db'));
    const tempRepo = new TempObjectsRepository(db);
    const loggedMessages = [];
    const logger = {
      info: () => {},
      warn: (msg, meta) => loggedMessages.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => loggedMessages.push({ level: 'error', msg, meta }),
    };

    const adapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      logger,
      retryBaseDelayMs: 1,
      fetchImpl: async (url, init = {}) => {
        if (init.method === 'GET' && String(url).includes('list-type=2')) {
          return new Response(makeListObjectsXml([]), { status: 200 });
        }
        if (init.method === 'PUT') return new Response(null, { status: 200 });
        return new Response('', { status: 404 });
      },
    });

    const sample = path.join(dir, 'sample.mp4');
    fs.writeFileSync(sample, Buffer.alloc(1024, 3));

    // Configure monthly limit of 20 uploads so we hit 70% (#14), 85% (#17), 95% (#19), 100% (#20), and block #21
    const cfg = { ...BASE_STORAGE_CONFIG, monthlyUploadLimitCount: 20, monthlyUploadLimitBytes: 1024 * 1024 };
    for (let i = 0; i < 20; i++) {
      await adapter.uploadTemporaryVideo({ filePath: sample, storageConfig: cfg });
    }

    // 21st upload blocked cleanly
    await assert.rejects(
      () => adapter.uploadTemporaryVideo({ filePath: sample, storageConfig: cfg }),
      (err) => err.code === 'R2_MONTHLY_UPLOAD_LIMIT_EXCEEDED'
    );

    const status = await adapter.getUsageStatus(cfg, { live: false });
    assert.equal(status.counters.uploadCount, 20);
    assert.equal(status.isBillingCap, false);
    assert.match(status.disclaimer, /NOT a Cloudflare billing cap/i);
    assert.equal(status.evaluation.anyBlocked, true);

    const warningLevels = adapter.r2UsageRepo
      .getRecentLogs({ limit: 100 })
      .filter((l) => l.eventType === 'threshold_warning' && l.details?.metric === 'monthlyUploads')
      .map((l) => Number(l.warningLevel));

    assert.ok(warningLevels.includes(70), `Expected 70% warning, got ${JSON.stringify(warningLevels)}`);
    assert.ok(warningLevels.includes(85), `Expected 85% warning, got ${JSON.stringify(warningLevels)}`);
    assert.ok(warningLevels.includes(95), `Expected 95% warning, got ${JSON.stringify(warningLevels)}`);
    assert.ok(loggedMessages.some((m) => m.level === 'warn' && m.meta?.thresholdPct === 95));

    // Verify monthly byte volume limit also blocks cleanly
    const bytesLimitedCfg = {
      ...BASE_STORAGE_CONFIG,
      monthlyUploadLimitCount: 500,
      monthlyUploadLimitBytes: 20 * 1024, // 20 KB already consumed!
    };
    await assert.rejects(
      () => adapter.uploadTemporaryVideo({ filePath: sample, storageConfig: bytesLimitedCfg }),
      (err) => err.code === 'R2_MONTHLY_BYTES_LIMIT_EXCEEDED'
    );

    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Multipart upload aborts immediately on failure, and cleanup sweeps abort orphan multipart uploads + 24h abandoned objects + stop infinite retries', async () => {
  const dir = makeTempDir('smp-r2-clean-');
  try {
    const db = openDatabase(path.join(dir, 'test.db'));
    const tempRepo = new TempObjectsRepository(db);

    // 1. Bounded retry hard ceiling even if caller passes Infinity
    let backoffCalls = 0;
    await assert.rejects(
      () =>
        withExponentialBackoff(
          async () => {
            backoffCalls++;
            const err = new Error('transient');
            err.retryable = true;
            throw err;
          },
          { maxAttempts: Infinity, baseDelayMs: 0, sleepFn: async () => {} }
        ),
      /transient/
    );
    assert.equal(backoffCalls, HARD_MAX_RETRY_ATTEMPTS);

    // 2. Multipart upload failure triggers immediate AbortMultipartUpload
    const multiVideo = path.join(dir, 'multi.mp4');
    fs.writeFileSync(multiVideo, Buffer.alloc(120, 9));
    const abortedUploads = [];
    let partAttempt = 0;

    const multipartFailFetch = async (url, init = {}) => {
      const u = String(url);
      if (init.method === 'GET' && u.includes('list-type=2')) {
        return new Response(makeListObjectsXml([]), { status: 200 });
      }
      if (init.method === 'POST' && u.includes('uploads=')) {
        return new Response(
          '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>up_fail_1</UploadId></InitiateMultipartUploadResult>',
          { status: 200 }
        );
      }
      if (init.method === 'PUT' && u.includes('partNumber=')) {
        partAttempt++;
        if (partAttempt === 1) {
          return new Response(null, { status: 200, headers: { ETag: '"etag1"' } });
        }
        return new Response('Bad Part Request', { status: 400 }); // Non-retryable 400 on part 2
      }
      if (init.method === 'DELETE' && u.includes('uploadId=up_fail_1')) {
        abortedUploads.push(u);
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 404 });
    };

    const mpAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      fetchImpl: multipartFailFetch,
      retryBaseDelayMs: 1,
    });
    const mpCfg = {
      ...BASE_STORAGE_CONFIG,
      multipartThresholdBytes: 100,
      multipartPartSizeBytes: 50,
    };

    await assert.rejects(
      () => mpAdapter.uploadTemporaryVideo({ filePath: multiVideo, storageConfig: mpCfg }),
      (err) => err.code === 'TEMP_STORAGE_UPLOAD_FAILED'
    );
    assert.equal(abortedUploads.length, 1, 'Failed multipart upload MUST call AbortMultipartUpload immediately');
    const mpDbRow = db.prepare("SELECT status, upload_phase, aborted_at FROM temp_cloud_objects WHERE multipart_upload_id = 'up_fail_1'").get();
    assert.equal(mpDbRow.upload_phase, 'aborted');
    assert.ok(mpDbRow.aborted_at);

    // 3. Cleanup sweep:
    // - DB abandoned (>24h created_at even if future expires_at)
    // - Remote untracked >24h object (preserves recent 1h object!)
    // - Incomplete orphan multipart uploads (spares active in-flight uploadId)
    const oldCreatedIso = new Date(Date.now() - 25 * 3600_000).toISOString();
    const freshIso = new Date(Date.now() - 1 * 3600_000).toISOString();
    const futureExpIso = new Date(Date.now() + 48 * 3600_000).toISOString();

    const abandonedId = tempRepo.recordUpload({
      jobItemId: null,
      provider: 'r2',
      bucket: 'private-ig-temp',
      objectKey: 'ig-temp/2026-11-08/db-abandoned.mp4',
      fileSizeBytes: 2048,
      expiresAt: futureExpIso,
    });
    db.prepare('UPDATE temp_cloud_objects SET created_at = ? WHERE id = ?').run(oldCreatedIso, abandonedId);

    const deletedKeys = [];
    const abortedSweepIds = [];

    const sweepAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        if (init.method === 'GET' && u.includes('list-type=2')) {
          return new Response(
            makeListObjectsXml([
              { key: 'ig-temp/2026-11-08/db-abandoned.mp4', sizeBytes: 2048, lastModified: oldCreatedIso },
              { key: 'ig-temp/2026-11-08/orphan-untracked.mp4', sizeBytes: 4096, lastModified: oldCreatedIso },
              { key: 'ig-temp/2026-11-11/fresh-recent.mp4', sizeBytes: 1024, lastModified: freshIso },
            ]),
            { status: 200 }
          );
        }
        if (init.method === 'GET' && u.includes('uploads=')) {
          return new Response(
            `<?xml version="1.0"?>
<ListMultipartUploadsResult>
  <IsTruncated>false</IsTruncated>
  <Upload><Key>ig-temp/2026-11-09/crashed.mp4</Key><UploadId>up_orphan_stale</UploadId><Initiated>${oldCreatedIso}</Initiated></Upload>
  <Upload><Key>ig-temp/2026-11-11/active.mp4</Key><UploadId>up_active_now</UploadId><Initiated>${freshIso}</Initiated></Upload>
</ListMultipartUploadsResult>`,
            { status: 200 }
          );
        }
        if (init.method === 'DELETE' && u.includes('uploadId=')) {
          abortedSweepIds.push(new URL(u).searchParams.get('uploadId'));
          return new Response(null, { status: 204 });
        }
        if (init.method === 'DELETE') {
          deletedKeys.push(new URL(u).pathname);
          return new Response(null, { status: 204 });
        }
        return new Response('', { status: 404 });
      },
    });

    sweepAdapter._activeMultipartUploadIds.add('up_active_now');
    const sweepRes = await sweepAdapter.runRetentionCleanup(BASE_STORAGE_CONFIG);
    assert.equal(sweepRes.cleaned, 2);
    assert.equal(deletedKeys.length, 2);
    assert.ok(deletedKeys.some((p) => p.endsWith('/ig-temp/2026-11-08/db-abandoned.mp4')));
    assert.ok(deletedKeys.some((p) => p.endsWith('/ig-temp/2026-11-08/orphan-untracked.mp4')));
    assert.equal(deletedKeys.some((p) => p.endsWith('/ig-temp/2026-11-11/fresh-recent.mp4')), false);
    assert.deepEqual(abortedSweepIds, ['up_orphan_stale']);

    // 4. Permanent delete failures hit MAX_CLEANUP_ATTEMPTS (5) and STOP retrying indefinitely
    const stuckId = tempRepo.recordUpload({
      jobItemId: null,
      provider: 'r2',
      bucket: 'private-ig-temp',
      objectKey: 'ig-temp/2026-11-08/stuck-403.mp4',
      fileSizeBytes: 512,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    let deleteHitCount = 0;
    const stuckAdapter = new TempCloudHostingAdapter({
      tempObjectsRepo: tempRepo,
      retryBaseDelayMs: 1,
      fetchImpl: async (url, init = {}) => {
        if (init.method === 'GET' && String(url).includes('list-type=2')) {
          return new Response(makeListObjectsXml([]), { status: 200 });
        }
        if (init.method === 'GET' && String(url).includes('uploads=')) {
          return new Response('<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>', { status: 200 });
        }
        if (init.method === 'DELETE') {
          deleteHitCount++;
          return new Response('Access Denied', { status: 403 }); // non-retryable 403 -> 1 HTTP call per sweep
        }
        return new Response('', { status: 404 });
      },
    });

    for (let i = 0; i < 8; i++) {
      await stuckAdapter.runRetentionCleanup(BASE_STORAGE_CONFIG);
    }
    assert.equal(deleteHitCount, R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS, 'Must stop periodic delete retries after MAX_CLEANUP_ATTEMPTS');
    const stuckRow = tempRepo.findById(stuckId);
    assert.equal(stuckRow.cleanup_attempts, R2_SAFE_LIMITS.MAX_CLEANUP_ATTEMPTS);

    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Storage API routes expose R2 usage status, configurable monthly limits, cleanup trigger, and billing disclaimer', async () => {
  const dir = makeTempDir('smp-r2-api-');
  const masterKeyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'memory' });
  const ctx = buildApplication({
    keyStoreMode: 'memory',
    masterKeyStore,
    logToConsole: false,
    configOverrides: {
      port: 0,
      storageProvider: 'mock',
      paths: {
        baseDir: dir,
        dataDir: path.join(dir, 'data'),
        credentialsDir: path.join(dir, 'credentials'),
        secretsDir: path.join(dir, 'secrets'),
        tempDir: path.join(dir, 'temp'),
        logsDir: path.join(dir, 'logs'),
        dbPath: path.join(dir, 'data', 'publisher.db'),
      },
    },
  });

  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      Authorization: `Bearer ${ctx.masterKeyStore.getIpcSecret()}`,
      'Content-Type': 'application/json',
    };

    // Reject oversized presigned URL TTL (> 3600s)
    const badTtlRes = await fetch(`${baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ storage: { urlTtlSeconds: 7200 } }),
    });
    assert.equal(badTtlRes.status, 400);

    // Save valid configurable monthly limits
    const saveRes = await fetch(`${baseUrl}/api/setup/credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        storage: {
          urlTtlSeconds: 1200,
          monthlyUploadLimitCount: 45,
          monthlyUploadLimitMb: 2048,
        },
      }),
    });
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.data.storage.monthlyUploadLimitCount, 45);
    assert.equal(saveJson.data.storage.monthlyUploadLimitMb, 2048);

    const usageRes = await fetch(`${baseUrl}/api/storage/usage?live=true`, { headers });
    assert.equal(usageRes.status, 200);
    const usageJson = await usageRes.json();
    assert.equal(usageJson.data.limits.maxTotalStoredBytes, 8 * 1024 * 1024 * 1024);
    assert.equal(usageJson.data.limits.maxVideoSizeBytes, 500 * 1024 * 1024);
    assert.equal(usageJson.data.limits.maxConcurrentUploads, 1);
    assert.equal(usageJson.data.limits.maxQueuedJobs, 10);
    assert.equal(usageJson.data.limits.monthlyUploadLimitCount, 45);
    assert.equal(usageJson.data.limits.monthlyUploadLimitBytes, 2048 * 1024 * 1024);
    assert.equal(usageJson.data.storageClass, 'STANDARD');
    assert.equal(usageJson.data.publicAccess, false);
    assert.equal(usageJson.data.isBillingCap, false);
    assert.equal(usageJson.data.disclaimer, R2_SAFEGUARD_DISCLAIMER);

    const cleanupRes = await fetch(`${baseUrl}/api/storage/cleanup`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(cleanupRes.status, 200);
    const cleanupJson = await cleanupRes.json();
    assert.equal(cleanupJson.data.usage.isBillingCap, false);
  } finally {
    await new Promise((r) => server.close(r));
    ctx.db.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});
