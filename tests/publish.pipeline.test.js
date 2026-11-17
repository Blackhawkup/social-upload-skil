import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildApplication } from '../src/api/app.js';
import { MasterKeyStore } from '../src/security/masterKeyStore.js';
import { YouTubeOAuthClient } from '../src/integrations/youtube/oauth.js';
import { YouTubePublisher } from '../src/integrations/youtube/publisher.js';
import { InstagramOAuthClient } from '../src/integrations/instagram/oauth.js';
import { InstagramPublisher } from '../src/integrations/instagram/publisher.js';
import { TempCloudHostingAdapter } from '../src/integrations/storage/tempHosting.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function generateSampleMp4(outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=540x960:d=4:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=520:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      outPath,
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
}

function createHarness(dir, { mockFetchImpl, defaultPublishMode = 'review' }) {
  const masterKeyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'memory' });
  const tempObjectsDir = path.join(dir, 'mock-r2');

  const youtubeOAuth = new YouTubeOAuthClient({ fetchImpl: mockFetchImpl });
  const youtubePublisher = new YouTubePublisher({
    fetchImpl: mockFetchImpl,
    chunkSizeBytes: 64 * 1024, // small chunk size so multi-chunk upload & resume execute cleanly
  });
  const instagramOAuth = new InstagramOAuthClient({ fetchImpl: mockFetchImpl });

  const ctx = buildApplication({
    keyStoreMode: 'memory',
    masterKeyStore,
    logToConsole: false,
    fetchImpl: mockFetchImpl,
    youtubeOAuth,
    youtubePublisher,
    instagramOAuth,
    configOverrides: {
      port: 0,
      defaultPublishMode,
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
      youtube: { clientId: 'yt-cid', clientSecret: 'yt-csecret' },
      instagram: { appId: 'ig-aid', appSecret: 'ig-asecret' },
    },
  });

  // Wire mock TempCloudHostingAdapter using ctx's tempObjectsRepo
  const tempHosting = new TempCloudHostingAdapter({
    tempObjectsRepo: ctx.repos.tempObjectsRepo,
    fetchImpl: mockFetchImpl,
    mockDir: tempObjectsDir,
  });
  const instagramPublisher = new InstagramPublisher({
    tempHosting,
    fetchImpl: mockFetchImpl,
    containerPollIntervalMs: 10,
  });
  ctx.services.publishService.instagramPublisher = instagramPublisher;

  return { ctx, tempObjectsDir };
}

function seedAccount(ctx, { id, platform, displayName, platformAccountId, accessToken, refreshToken, expiresAt }) {
  const ref = ctx.credentialStore.createCredentialRef(platform === 'youtube' ? 'yt' : 'ig');
  ctx.credentialStore.saveAccountTokens({
    accountId: id,
    platform,
    credentialRef: ref,
    tokens: {
      accessToken,
      refreshToken,
      expiresAt,
      scope: platform === 'youtube' ? 'youtube.upload' : 'instagram_content_publish',
    },
  });
  return ctx.repos.accountsRepo.upsertAccount({
    id,
    platform,
    displayName,
    username: `@${displayName.toLowerCase().replace(/\s+/g, '')}`,
    platformAccountId,
    connectionStatus: 'connected',
    credentialRef: ref,
    tokenExpiresAt: expiresAt,
  });
}

test('Review Mode awaits approval, executes multi-platform publish with token refresh, R2 temp cleanup, and duplicate prevention', async () => {
  const dir = makeTempDir('smp-pub-');
  try {
    const videoPath = path.join(dir, 'videos', 'ai-news-short.mp4');
    generateSampleMp4(videoPath);

    let ytRefreshed = false;
    let ytUploadedBytes = 0;
    let igPublishCalls = 0;
    let igPollCount = 0;

    const mockFetch = async (url, init = {}) => {
      const u = String(url);

      // Google OAuth token refresh
      if (u === 'https://oauth2.googleapis.com/token') {
        ytRefreshed = true;
        return new Response(
          JSON.stringify({ access_token: 'ya29.fresh-yt-token', expires_in: 3600 }),
          { status: 200 }
        );
      }

      // YouTube resumable upload init
      if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        const bodyObj = JSON.parse(init.body || '{}');
        // Verify publishAt forces privacyStatus='private'
        if (bodyObj.status?.publishAt) {
          assert.equal(bodyObj.status.privacyStatus, 'private');
        }
        return new Response(null, {
          status: 200,
          headers: { Location: 'https://upload.youtube.test/session/abc123' },
        });
      }

      // YouTube resumable chunk upload
      if (u === 'https://upload.youtube.test/session/abc123') {
        const range = init.headers?.['Content-Range'] || '';
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
        if (match) {
          const end = Number(match[2]) + 1;
          const total = Number(match[3]);
          ytUploadedBytes = end;
          if (end < total) {
            return new Response(null, {
              status: 308,
              headers: { Range: `bytes=0-${end - 1}` },
            });
          }
          return new Response(
            JSON.stringify({ id: 'ytVid999', status: { uploadStatus: 'uploaded', privacyStatus: 'private' } }),
            { status: 200 }
          );
        }
      }

      // YouTube video status polling
      if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'ytVid999', status: { uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }],
          }),
          { status: 200 }
        );
      }

      // Instagram content publishing limit
      if (u.includes('/content_publishing_limit')) {
        return new Response(JSON.stringify({ data: [{ quota_usage: 2, config: { quota_total: 50 } }] }), { status: 200 });
      }

      // Instagram create container
      if (u.endsWith('/178414999/media')) {
        const bodyStr = String(init.body || '');
        assert.ok(bodyStr.includes('media_type=REELS'));
        assert.ok(bodyStr.includes('https%3A%2F%2Fmock-r2.local%2F'));
        return new Response(JSON.stringify({ id: 'ig_container_1' }), { status: 200 });
      }

      // Instagram container polling
      if (u.includes('/ig_container_1?fields=status_code')) {
        igPollCount++;
        const code = igPollCount >= 2 ? 'FINISHED' : 'IN_PROGRESS';
        return new Response(JSON.stringify({ status_code: code }), { status: 200 });
      }

      // Instagram media_publish
      if (u.endsWith('/178414999/media_publish')) {
        igPublishCalls++;
        return new Response(JSON.stringify({ id: 'ig_media_777' }), { status: 200 });
      }

      // Instagram permalink
      if (u.includes('/ig_media_777?fields=id,permalink')) {
        return new Response(
          JSON.stringify({ id: 'ig_media_777', permalink: 'https://www.instagram.com/reel/Cxyz123/' }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ error: { message: `Unhandled mock URL: ${u}` } }), { status: 404 });
    };

    const { ctx, tempObjectsDir } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'review' });

    // Seed expired YouTube token (to test automatic refresh) and active Instagram account
    const ytAcc = seedAccount(ctx, {
      id: 'acc_yt_ai',
      platform: 'youtube',
      displayName: 'AI News YouTube',
      platformAccountId: 'UC_AI_NEWS',
      accessToken: 'ya29.expired-token',
      refreshToken: '1//yt-refresh-token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const igAcc = seedAccount(ctx, {
      id: 'acc_ig_ai',
      platform: 'instagram',
      displayName: 'AI News Instagram',
      platformAccountId: '178414999',
      accessToken: 'EAA_IG_ACTIVE',
      refreshToken: 'EAA_IG_ACTIVE',
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });

    // 1. In Review Mode, createAndMaybePublish pauses at awaiting_approval
    const futureIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const pending = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: [ytAcc.id, igAcc.id],
      options: { publishAt: futureIso, privacyStatus: 'public' },
      approved: false,
    });

    assert.equal(pending.requiresApproval, true);
    assert.equal(pending.job.status, 'awaiting_approval');
    assert.equal(ytRefreshed, false);
    assert.equal(igPublishCalls, 0);

    // 2. Approve and execute
    const completed = await ctx.services.publishService.approveAndPublish(pending.job.id, {
      itemOverrides: {
        [ytAcc.id]: { title: 'Approved Custom AI Title' },
      },
      waitForCompletion: true,
    });

    assert.equal(completed.status, 'completed');
    assert.equal(ytRefreshed, true);
    assert.ok(ytUploadedBytes > 0);
    assert.equal(igPublishCalls, 1);

    const ytItem = completed.items.find((i) => i.platform === 'youtube');
    const igItem = completed.items.find((i) => i.platform === 'instagram');
    assert.equal(ytItem.status, 'published');
    assert.equal(ytItem.publishedUrl, 'https://www.youtube.com/shorts/ytVid999');
    assert.equal(igItem.status, 'published');
    assert.equal(igItem.publishedUrl, 'https://www.instagram.com/reel/Cxyz123/');

    // Verify temporary cloud object was cleaned up
    const remainingMockFiles = fs.existsSync(tempObjectsDir) ? fs.readdirSync(tempObjectsDir) : [];
    assert.equal(remainingMockFiles.length, 0);
    const dbTempRows = ctx.db.prepare('SELECT status FROM temp_cloud_objects').all();
    assert.equal(dbTempRows.length, 1);
    assert.equal(dbTempRows[0].status, 'deleted');

    // 3. Duplicate prevention blocks silent re-upload to same account
    await assert.rejects(
      () =>
        ctx.services.publishService.createAndMaybePublish({
          videoPath,
          accountIds: [ytAcc.id],
          approved: true,
        }),
      (err) => err.code === 'DUPLICATE_PUBLICATION'
    );

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Partial success: YouTube succeeds, Instagram fails accurately, and retry runs ONLY failed Instagram destination', async () => {
  const dir = makeTempDir('smp-partial-');
  try {
    const videoPath = path.join(dir, 'videos', 'gaming-clip.mp4');
    generateSampleMp4(videoPath);

    let ytInitCount = 0;
    let igAttempt = 0;

    const mockFetch = async (url, init = {}) => {
      const u = String(url);

      if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        ytInitCount++;
        return new Response(null, {
          status: 200,
          headers: { Location: 'https://upload.youtube.test/session/partial1' },
        });
      }
      if (u === 'https://upload.youtube.test/session/partial1') {
        const range = init.headers?.['Content-Range'] || '';
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
        const end = Number(match[2]) + 1;
        const total = Number(match[3]);
        if (end < total) {
          return new Response(null, { status: 308, headers: { Range: `bytes=0-${end - 1}` } });
        }
        return new Response(JSON.stringify({ id: 'ytPartialOk', status: { uploadStatus: 'uploaded' } }), { status: 200 });
      }
      if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'ytPartialOk', processingDetails: { processingStatus: 'succeeded' } }] }),
          { status: 200 }
        );
      }
      if (u.includes('/content_publishing_limit')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (u.endsWith('/178414888/media')) {
        igAttempt++;
        return new Response(JSON.stringify({ id: `ig_cont_${igAttempt}` }), { status: 200 });
      }
      if (u.includes('/ig_cont_1?fields=status_code')) {
        // Simulate Meta processing failure on first attempt (MUST NOT fake success!)
        return new Response(JSON.stringify({ status_code: 'ERROR', status: 'Unsupported codec frame' }), { status: 200 });
      }
      if (u.includes('/ig_cont_2?fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (u.endsWith('/178414888/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_media_retried' }), { status: 200 });
      }
      if (u.includes('/ig_media_retried?fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'ig_media_retried', permalink: 'https://www.instagram.com/reel/RetriedOK/' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'autopilot' });

    const ytAcc = seedAccount(ctx, {
      id: 'acc_yt_g',
      platform: 'youtube',
      displayName: 'Gaming News YT',
      platformAccountId: 'UC_GAMING',
      accessToken: 'ya29.valid',
      refreshToken: '1//valid',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const igAcc = seedAccount(ctx, {
      id: 'acc_ig_g',
      platform: 'instagram',
      displayName: 'Gaming News IG',
      platformAccountId: '178414888',
      accessToken: 'EAA_VALID',
      refreshToken: 'EAA_VALID',
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });

    const firstRun = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: [ytAcc.id, igAcc.id],
      waitForCompletion: true,
    });

    assert.equal(firstRun.job.status, 'partial_success');
    assert.equal(firstRun.job.items.find((i) => i.platform === 'youtube').status, 'published');
    assert.equal(firstRun.job.items.find((i) => i.platform === 'instagram').status, 'failed');
    assert.equal(ytInitCount, 1);

    // Retry ONLY failed Instagram destination — YouTube must NOT be uploaded again
    const retried = await ctx.services.publishService.retryFailed(firstRun.job.id, { waitForCompletion: true });
    assert.equal(retried.status, 'completed');
    assert.equal(ytInitCount, 1);
    assert.equal(igAttempt, 2);
    assert.equal(retried.items.find((i) => i.platform === 'instagram').publishedUrl, 'https://www.instagram.com/reel/RetriedOK/');

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Interrupted YouTube upload recovers on restart and resumes from server byte offset (308 Range)', async () => {
  const dir = makeTempDir('smp-resume-');
  try {
    const videoPath = path.join(dir, 'videos', 'resume-test.mp4');
    // Generate slightly longer video (~100KB+) so multi-chunk 16KB resume offset works cleanly
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=540x960:rate=24:duration=5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=520:duration=5',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        videoPath,
      ],
      { windowsHide: true, stdio: 'ignore' }
    );

    let putCalls = 0;
    let resumedFromOffset = null;

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://upload.youtube.test/session/resume777') {
        putCalls++;
        const range = init.headers?.['Content-Range'] || '';
        if (range.startsWith('bytes */')) {
          // Server reports first 16384 bytes were already received before restart
          return new Response(null, { status: 308, headers: { Range: 'bytes=0-16383' } });
        }
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
        const start = Number(match[1]);
        const end = Number(match[2]) + 1;
        const total = Number(match[3]);
        if (resumedFromOffset === null) resumedFromOffset = start;
        if (end < total) {
          return new Response(null, { status: 308, headers: { Range: `bytes=0-${end - 1}` } });
        }
        return new Response(JSON.stringify({ id: 'ytResumedId', status: { uploadStatus: 'uploaded' } }), { status: 200 });
      }
      if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'ytResumedId', processingDetails: { processingStatus: 'succeeded' } }] }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'autopilot' });
    const ytAcc = seedAccount(ctx, {
      id: 'acc_yt_res',
      platform: 'youtube',
      displayName: 'Resume Test YT',
      platformAccountId: 'UC_RES',
      accessToken: 'ya29.valid',
      refreshToken: '1//valid',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const video = await ctx.services.videoService.analyzeVideo({ videoPath, extractFrames: false });
    const job = ctx.repos.jobsRepo.createJob({
      videoId: video.id,
      fileSha256: video.fileSha256,
      mode: 'autopilot',
      status: 'running',
      items: [{ accountId: ytAcc.id, platform: 'youtube', status: 'uploading', bytesTotal: video.fileSizeBytes }],
    });
    const itemId = job.items[0].id;
    const encryptedUri = ctx.services.publishService;
    // Save encrypted resumable session URI via internal helper path
    const { encryptPayload } = await import('../src/security/cryptoVault.js');
    const enc = JSON.stringify(
      encryptPayload(
        ctx.masterKeyStore.getMasterKey(),
        `resumable_uri:${itemId}`,
        { uri: 'https://upload.youtube.test/session/resume777' },
        itemId
      )
    );
    ctx.repos.jobsRepo.updateItem(itemId, { resumableSessionUriEnc: enc });

    // Simulate backend reboot recovery
    const rec = ctx.repos.jobsRepo.recoverInterruptedOnBoot();
    assert.equal(rec.recoveredItems, 1);

    const resumedJob = await encryptedUri.retryFailed(job.id, { waitForCompletion: true });
    assert.equal(resumedJob.status, 'completed', resumedJob.items[0].errorMessage || '');
    assert.equal(resumedFromOffset, 16384);
    assert.ok(putCalls >= 2);
    assert.equal(resumedJob.items[0].platformPostId, 'ytResumedId');

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Revoked refresh token (invalid_grant) marks account as reauth_required cleanly', async () => {
  const dir = makeTempDir('smp-revoked-');
  try {
    const mockFetch = async (url) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked.' }), {
          status: 400,
        });
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch });
    const acc = seedAccount(ctx, {
      id: 'acc_revoked',
      platform: 'youtube',
      displayName: 'Revoked YT',
      platformAccountId: 'UC_REVOKED',
      accessToken: 'ya29.old',
      refreshToken: '1//revoked',
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await assert.rejects(() => ctx.services.accountService.refreshAccountToken(acc.id), (err) => err.code === 'REAUTH_REQUIRED');
    const updated = ctx.repos.accountsRepo.findPublicById(acc.id);
    assert.equal(updated.connectionStatus, 'reauth_required');

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Instagram visibility enforces private-account confirmation and supports Trial Reels (trial_manual) and public posting', async () => {
  const dir = makeTempDir('smp-igvis-');
  try {
    const videoPath = path.join(dir, 'videos', 'ig-vis.mp4');
    generateSampleMp4(videoPath);

    const seenContainerPayloads = [];
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/content_publishing_limit')) {
        return new Response(JSON.stringify({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] }), { status: 200 });
      }
      if (u.endsWith('/178414555/media')) {
        seenContainerPayloads.push({
          contentType: init.headers?.['Content-Type'] || init.headers?.['content-type'],
          body: String(init.body || ''),
        });
        return new Response(JSON.stringify({ id: `c_${seenContainerPayloads.length}` }), { status: 200 });
      }
      if (u.includes('?fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (u.endsWith('/178414555/media_publish')) {
        return new Response(JSON.stringify({ id: `m_${seenContainerPayloads.length}` }), { status: 200 });
      }
      if (u.includes('?fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'm', permalink: 'https://www.instagram.com/reel/Trial123/' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'autopilot' });
    const igAcc = seedAccount(ctx, {
      id: 'acc_ig_vis',
      platform: 'instagram',
      displayName: 'Personal IG',
      platformAccountId: '178414555',
      accessToken: 'EAA_IG_VIS',
      refreshToken: 'EAA_IG_VIS',
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });

    // 1. Requesting "private" without confirmation must fail closed rather than posting publicly
    await assert.rejects(
      () =>
        ctx.services.publishService.createAndMaybePublish({
          videoPath,
          accountIds: [igAcc.id],
          options: { instagramVisibility: 'private' },
          approved: true,
          waitForCompletion: true,
        }),
      (err) => err.code === 'INSTAGRAM_VISIBILITY_CONFIRMATION_REQUIRED'
    );

    // 2. Requesting "trial_manual" sends JSON with trial_params.graduation_strategy = MANUAL
    const trialJob = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: [igAcc.id],
      options: { instagramVisibility: 'trial_manual' },
      approved: true,
      waitForCompletion: true,
    });
    assert.equal(
      trialJob.job.status,
      'completed',
      `Expected completed, got ${trialJob.job.status}: [${trialJob.job.items[0]?.errorCode}] ${trialJob.job.items[0]?.errorMessage}`
    );
    assert.equal(seenContainerPayloads[0].contentType, 'application/json');
    const parsedTrial = JSON.parse(seenContainerPayloads[0].body);
    assert.equal(parsedTrial.trial_params.graduation_strategy, 'MANUAL');
    assert.equal(parsedTrial.share_to_feed, false);

    // 3. Explicit Private Creator confirmation allows publishing safely with allowDuplicate for same test video
    const privJob = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: [igAcc.id],
      options: { instagramVisibility: 'private', confirmPrivateInstagramAccount: true },
      approved: true,
      allowDuplicate: true,
      waitForCompletion: true,
    });
    assert.equal(privJob.job.status, 'completed');
    assert.equal(privJob.job.items[0].metadata.instagramVisibility, 'private');

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('Meta Unified Login account enforces instagram_content_publish permission and publishes Reels via graph.facebook.com with SUAT', async () => {
  const dir = makeTempDir('smp-unified-pub-');
  try {
    const videoPath = path.join(dir, 'videos', 'unified-reel.mp4');
    generateSampleMp4(videoPath);

    const seenGraphUrls = [];
    const mockFetch = async (url) => {
      const u = String(url);
      if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
        seenGraphUrls.push(u);
      }
      if (u.includes('/content_publishing_limit')) {
        return new Response(JSON.stringify({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] }), { status: 200 });
      }
      if (u.endsWith('/17841436528234277/media')) {
        return new Response(JSON.stringify({ id: 'ig_unified_c1' }), { status: 200 });
      }
      if (u.includes('/ig_unified_c1?fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (u.endsWith('/17841436528234277/media_publish')) {
        return new Response(JSON.stringify({ id: 'ig_unified_m1' }), { status: 200 });
      }
      if (u.includes('/ig_unified_m1?fields=id,permalink')) {
        return new Response(
          JSON.stringify({ id: 'ig_unified_m1', permalink: 'https://www.instagram.com/reel/UnifiedOk1/' }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'autopilot' });
    ctx.credentialStore.saveProviderConfig('ai', { provider: 'deterministic' });

    // 1. Account missing instagram_content_publish must fail fast BEFORE calling Meta / staging R2
    const limitedRef = ctx.credentialStore.createCredentialRef('ig');
    ctx.credentialStore.saveAccountTokens({
      accountId: 'acc_ig_limited',
      platform: 'instagram',
      credentialRef: limitedRef,
      tokens: {
        accessToken: 'EAAG_LIMITED',
        refreshToken: 'EAAG_LIMITED',
        expiresAt: null,
        scope: 'instagram_basic',
      },
    });
    ctx.repos.accountsRepo.upsertAccount({
      id: 'acc_ig_limited',
      platform: 'instagram',
      displayName: 'Limited IG',
      username: '@limited',
      platformAccountId: '178414000000',
      connectionStatus: 'connected',
      credentialRef: limitedRef,
      tokenExpiresAt: null,
      scopes: ['instagram_basic'],
      metadata: { loginMode: 'meta_unified_login' },
    });

    const deniedJob = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: ['acc_ig_limited'],
      approved: true,
      waitForCompletion: true,
    });
    assert.equal(deniedJob.job.status, 'failed');
    assert.equal(deniedJob.job.items[0].errorCode, 'MISSING_PUBLISHING_PERMISSION');
    assert.equal(seenGraphUrls.length, 0);

    // 2. Account with full Unified Login permissions + non-expiring SUAT publishes via graph.facebook.com
    const fullRef = ctx.credentialStore.createCredentialRef('ig');
    ctx.credentialStore.saveAccountTokens({
      accountId: 'acc_ig_stablehawk',
      platform: 'instagram',
      credentialRef: fullRef,
      tokens: {
        accessToken: 'EAAG_STABLEHAWK_SUAT',
        refreshToken: 'EAAG_STABLEHAWK_SUAT',
        expiresAt: null,
        scope: 'instagram_basic,instagram_content_publish',
      },
    });
    ctx.repos.accountsRepo.upsertAccount({
      id: 'acc_ig_stablehawk',
      platform: 'instagram',
      displayName: 'StableHawk',
      username: '@stablehawk',
      platformAccountId: '17841436528234277',
      connectionStatus: 'connected',
      credentialRef: fullRef,
      tokenExpiresAt: null,
      scopes: ['instagram_basic', 'instagram_content_publish'],
      metadata: { loginMode: 'meta_unified_login' },
    });

    const okJob = await ctx.services.publishService.createAndMaybePublish({
      videoPath,
      accountIds: ['acc_ig_stablehawk'],
      approved: true,
      allowDuplicate: true,
      waitForCompletion: true,
    });
    assert.equal(okJob.job.status, 'completed', okJob.job.items[0]?.errorMessage || '');
    assert.equal(okJob.job.items[0].publishedUrl, 'https://www.instagram.com/reel/UnifiedOk1/');
    assert.ok(seenGraphUrls.length >= 4);
    assert.ok(seenGraphUrls.every((u) => u.startsWith('https://graph.facebook.com/')));

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('PublishService enforces max 10 queued jobs, serializes concurrent R2 uploads to 1, and caps item retries at 5', async () => {
  const dir = makeTempDir('smp-queue-cap-');
  try {
    const videoPath = path.join(dir, 'videos', 'queue-test.mp4');
    generateSampleMp4(videoPath);

    let maxObservedActiveUploads = 0;
    let currentInFlightR2 = 0;
    let igPublishCounter = 0;

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.includes('/content_publishing_limit')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (u.endsWith('/178414666/media')) {
        currentInFlightR2++;
        if (currentInFlightR2 > maxObservedActiveUploads) maxObservedActiveUploads = currentInFlightR2;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(JSON.stringify({ id: `c_q_${++igPublishCounter}` }), { status: 200 });
      }
      if (u.includes('?fields=status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
      }
      if (u.endsWith('/178414666/media_publish')) {
        currentInFlightR2 = Math.max(0, currentInFlightR2 - 1);
        return new Response(JSON.stringify({ id: `m_q_${igPublishCounter}` }), { status: 200 });
      }
      if (u.includes('?fields=id,permalink')) {
        return new Response(JSON.stringify({ id: 'm', permalink: 'https://www.instagram.com/reel/Queued1/' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const { ctx } = createHarness(dir, { mockFetchImpl: mockFetch, defaultPublishMode: 'review' });
    ctx.credentialStore.saveProviderConfig('ai', { provider: 'deterministic' });
    const igAcc = seedAccount(ctx, {
      id: 'acc_ig_queue',
      platform: 'instagram',
      displayName: 'Queue Test IG',
      platformAccountId: '178414666',
      accessToken: 'EAA_QUEUE_ACTIVE',
      refreshToken: 'EAA_QUEUE_ACTIVE',
      expiresAt: null,
    });

    // 1. Create 10 awaiting_approval jobs -> all succeed
    const jobsCreated = [];
    for (let i = 0; i < 10; i++) {
      const created = await ctx.services.publishService.createAndMaybePublish({
        videoPath,
        accountIds: [igAcc.id],
        approved: false,
        allowDuplicate: true,
      });
      jobsCreated.push(created.job);
    }
    assert.equal(ctx.repos.jobsRepo.countActiveJobs(), 10);

    // 2. 11th job MUST be rejected cleanly with MAX_QUEUED_JOBS_EXCEEDED
    await assert.rejects(
      () =>
        ctx.services.publishService.createAndMaybePublish({
          videoPath,
          accountIds: [igAcc.id],
          approved: false,
          allowDuplicate: true,
        }),
      (err) => err.code === 'MAX_QUEUED_JOBS_EXCEEDED'
    );

    // 3. Approve two jobs concurrently -> R2 execution queue serializes them so concurrent active uploads never exceed 1
    const [done1, done2] = await Promise.all([
      ctx.services.publishService.approveAndPublish(jobsCreated[0].id, { waitForCompletion: true }),
      ctx.services.publishService.approveAndPublish(jobsCreated[1].id, { waitForCompletion: true }),
    ]);
    assert.equal(done1.status, 'completed');
    assert.equal(done2.status, 'completed');
    assert.equal(maxObservedActiveUploads, 1);

    // 4. Item retry cap (5 attempts) prevents infinite manual retry loops
    const failedJob = ctx.repos.jobsRepo.createJob({
      videoId: done1.videoId,
      fileSha256: done1.fileSha256,
      mode: 'autopilot',
      status: 'failed',
      items: [{ accountId: igAcc.id, platform: 'instagram', status: 'failed', bytesTotal: 100 }],
    });
    ctx.repos.jobsRepo.updateItem(failedJob.items[0].id, { attemptCount: 5 });

    await assert.rejects(
      () => ctx.services.publishService.retryFailed(failedJob.id, { waitForCompletion: true }),
      (err) => err.code === 'MAX_RETRY_ATTEMPTS_EXCEEDED'
    );

    ctx.db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});
