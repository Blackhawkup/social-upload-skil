import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApplication } from '../src/api/app.js';
import { MasterKeyStore } from '../src/security/masterKeyStore.js';
import { BackendIpcClient, createSocialPublisherMcpServer } from '../src/mcp/server.js';
import { YouTubePublisher } from '../src/integrations/youtube/publisher.js';
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
      'color=c=purple:s=540x960:d=4:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=4',
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

test('MCP server exposes all required tools and executes Review Mode -> Approve -> Publish end-to-end', async () => {
  const dir = makeTempDir('smp-mcp-');
  const videoDir = path.join(dir, 'flow-mcp-out', 'demo-clip');
  const videoPath = path.join(videoDir, 'demo-clip.mp4');
  generateSampleMp4(videoPath);
  fs.writeFileSync(path.join(videoDir, 'demo-clip.txt'), 'Quick demo showing automated video publishing.');

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
      return new Response(null, { status: 200, headers: { Location: 'https://upload.youtube.test/mcp/1' } });
    }
    if (u === 'https://upload.youtube.test/mcp/1') {
      const range = init.headers?.['Content-Range'] || '';
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (match && Number(match[2]) + 1 < Number(match[3])) {
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${Number(match[2])}` } });
      }
      return new Response(JSON.stringify({ id: 'ytMcp123', status: { uploadStatus: 'uploaded' } }), { status: 200 });
    }
    if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status')) {
      return new Response(
        JSON.stringify({ items: [{ id: 'ytMcp123', processingDetails: { processingStatus: 'succeeded' } }] }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };

  const masterKeyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'memory' });
  const ctx = buildApplication({
    keyStoreMode: 'memory',
    masterKeyStore,
    logToConsole: false,
    fetchImpl: mockFetch,
    youtubePublisher: new YouTubePublisher({ fetchImpl: mockFetch, chunkSizeBytes: 128 * 1024 }),
    configOverrides: {
      port: 0,
      defaultPublishMode: 'review',
      videoWatchDirs: [path.join(dir, 'flow-mcp-out')],
      paths: {
        baseDir: dir,
        dataDir: path.join(dir, 'data'),
        credentialsDir: path.join(dir, 'credentials'),
        secretsDir: path.join(dir, 'secrets'),
        tempDir: path.join(dir, 'temp'),
        logsDir: path.join(dir, 'logs'),
        dbPath: path.join(dir, 'data', 'publisher.db'),
      },
      youtube: { clientId: 'mcp-test-cid', clientSecret: 'mcp-test-csec' },
    },
  });

  const ref = ctx.credentialStore.createCredentialRef('yt');
  ctx.credentialStore.saveAccountTokens({
    accountId: 'acc_mcp_yt',
    platform: 'youtube',
    credentialRef: ref,
    tokens: { accessToken: 'ya29.mcp-valid', refreshToken: '1//mcp-valid', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  ctx.repos.accountsRepo.upsertAccount({
    id: 'acc_mcp_yt',
    platform: 'youtube',
    displayName: 'AI News',
    username: '@ainews',
    platformAccountId: 'UC_MCP_AI',
    connectionStatus: 'connected',
    credentialRef: ref,
  });

  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ipcSecret = ctx.masterKeyStore.getIpcSecret();

  const ipcClient = new BackendIpcClient({ baseUrl, ipcSecret, autoStart: false });
  const mcpServer = createSocialPublisherMcpServer(ipcClient);
  const mcpClient = new Client({ name: 'test-antigravity', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

  try {
    const { tools } = await mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      'list_social_accounts',
      'connect_social_account',
      'get_social_account_status',
      'find_video',
      'analyze_video',
      'generate_social_metadata',
      'validate_video',
      'publish_to_youtube',
      'publish_to_instagram',
      'publish_to_multiple_accounts',
      'get_publishing_status',
      'get_publishing_history',
      'retry_failed_publication',
      'approve_publishing_job',
      'get_publishing_settings',
      'get_r2_usage_status',
    ]) {
      assert.ok(names.has(required), `Missing required MCP tool: ${required}`);
    }

    const callToolJson = async (name, args = {}) => {
      const res = await mcpClient.callTool({ name, arguments: args });
      assert.equal(res.isError, undefined, `Tool ${name} errored: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };

    const accList = await callToolJson('list_social_accounts');
    assert.equal(accList.accounts.length, 1);
    assert.equal(accList.accounts[0].displayName, 'AI News');

    const oauthStart = await callToolJson('connect_social_account', { platform: 'youtube', displayName: 'Second Channel' });
    assert.ok(oauthStart.authorizationUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));

    ctx.credentialStore.saveProviderConfig('instagram', {
      appId: 'mcp-meta-app-123',
      appSecret: 'mcp-meta-secret-456',
      configId: '1608840587925023',
      loginMode: 'meta_unified_login',
      redirectUri: 'https://mcp-tunnel.trycloudflare.com/api/accounts/oauth/callback/instagram',
    });
    const igUnifiedStart = await callToolJson('connect_social_account', {
      platform: 'instagram',
      displayName: 'StableHawk',
      igLoginMode: 'meta_unified_login',
    });
    const igAuthUrl = new URL(igUnifiedStart.authorizationUrl);
    assert.equal(igAuthUrl.origin + igAuthUrl.pathname, 'https://www.facebook.com/v22.0/dialog/oauth');
    assert.equal(igAuthUrl.searchParams.get('config_id'), '1608840587925023');
    assert.equal(igAuthUrl.searchParams.get('override_default_response_type'), 'true');
    assert.equal(igAuthUrl.searchParams.get('scope'), null);

    const found = await callToolJson('find_video', { limit: 5 });
    assert.equal(found.videos.length, 1);
    assert.equal(found.videos[0].filePath, videoPath);

    const analyzed = await callToolJson('analyze_video', { videoPath });
    assert.equal(analyzed.video.aspectRatio, '9:16');
    assert.ok(analyzed.video.analysis.projectContext.transcriptText.includes('automated video publishing'));

    const validation = await callToolJson('validate_video', {
      videoId: analyzed.video.id,
      targets: [{ accountId: 'acc_mcp_yt', platform: 'youtube', isShort: true }],
    });
    assert.equal(validation.allValid, true);

    const meta = await callToolJson('generate_social_metadata', {
      videoId: analyzed.video.id,
      accountIds: ['acc_mcp_yt'],
    });
    assert.ok(meta.youtube.title.length > 0);
    assert.ok(meta.instagram.caption.length > 0);

    // Review mode requires approval first
    const reviewJob = await callToolJson('publish_to_multiple_accounts', {
      accountIds: ['acc_mcp_yt'],
      videoId: analyzed.video.id,
      approved: false,
    });
    assert.equal(reviewJob.requiresApproval, true);
    assert.equal(reviewJob.job.status, 'awaiting_approval');

    // Approve via MCP
    const approvedRes = await callToolJson('approve_publishing_job', {
      jobId: reviewJob.job.id,
      waitForCompletion: true,
    });
    assert.equal(approvedRes.job.status, 'completed');
    assert.equal(approvedRes.job.items[0].publishedUrl, 'https://www.youtube.com/shorts/ytMcp123');

    const hist = await callToolJson('get_publishing_history', { limit: 5 });
    assert.equal(hist.jobs.length, 1);

    const r2ToolRes = await callToolJson('get_r2_usage_status', { live: false, runCleanup: false });
    assert.equal(r2ToolRes.limits.maxTotalStoredBytes, 8 * 1024 * 1024 * 1024);
    assert.equal(r2ToolRes.limits.maxVideoSizeBytes, 500 * 1024 * 1024);
    assert.equal(r2ToolRes.limits.maxConcurrentUploads, 1);
    assert.equal(r2ToolRes.limits.maxQueuedJobs, 10);
    assert.equal(r2ToolRes.isBillingCap, false);
  } finally {
    await mcpClient.close();
    await mcpServer.close();
    await new Promise((r) => server.close(r));
    ctx.db.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('MCP tools accept Antigravity-authored captions, hashtags, and extras (thumbOffsetMs, audioName, pinnedComment, defaultLanguage, madeForKids)', async () => {
  const dir = makeTempDir('smp-mcp-agy-');
  const videoDir = path.join(dir, 'flow-mcp-out', 'agy-reel');
  const videoPath = path.join(videoDir, 'agy-reel.mp4');
  generateSampleMp4(videoPath);

  let capturedYtInit = null;
  let capturedIgContainer = null;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
      capturedYtInit = JSON.parse(init.body || '{}');
      return new Response(null, { status: 200, headers: { Location: 'https://upload.youtube.test/mcp/agy1' } });
    }
    if (u === 'https://upload.youtube.test/mcp/agy1') {
      const range = init.headers?.['Content-Range'] || '';
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (match && Number(match[2]) + 1 < Number(match[3])) {
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${Number(match[2])}` } });
      }
      return new Response(JSON.stringify({ id: 'ytAgy42', status: { uploadStatus: 'uploaded' } }), { status: 200 });
    }
    if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status')) {
      return new Response(
        JSON.stringify({ items: [{ id: 'ytAgy42', processingDetails: { processingStatus: 'succeeded' } }] }),
        { status: 200 }
      );
    }
    if (u.includes('/content_publishing_limit')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (u.endsWith('/178414321/media')) {
      capturedIgContainer = JSON.parse(String(init.body || '{}'));
      return new Response(JSON.stringify({ id: 'ig_agy_c1' }), { status: 200 });
    }
    if (u.includes('/ig_agy_c1?fields=status_code')) {
      return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
    }
    if (u.endsWith('/178414321/media_publish')) {
      return new Response(JSON.stringify({ id: 'ig_agy_m1' }), { status: 200 });
    }
    if (u.includes('/ig_agy_m1?fields=id,permalink')) {
      return new Response(JSON.stringify({ id: 'ig_agy_m1', permalink: 'https://www.instagram.com/reel/AgyReel1/' }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 404 });
  };

  const masterKeyStore = new MasterKeyStore({ secretsDir: path.join(dir, 'secrets'), mode: 'memory' });
  const ctx = buildApplication({
    keyStoreMode: 'memory',
    masterKeyStore,
    logToConsole: false,
    fetchImpl: mockFetch,
    youtubePublisher: new YouTubePublisher({ fetchImpl: mockFetch, chunkSizeBytes: 128 * 1024 }),
    configOverrides: {
      port: 0,
      defaultPublishMode: 'autopilot',
      storageProvider: 'mock',
      videoWatchDirs: [path.join(dir, 'flow-mcp-out')],
      paths: {
        baseDir: dir,
        dataDir: path.join(dir, 'data'),
        credentialsDir: path.join(dir, 'credentials'),
        secretsDir: path.join(dir, 'secrets'),
        tempDir: path.join(dir, 'temp'),
        logsDir: path.join(dir, 'logs'),
        dbPath: path.join(dir, 'data', 'publisher.db'),
      },
      youtube: { clientId: 'mcp-agy-yt', clientSecret: 'mcp-agy-yt-sec' },
      instagram: { appId: 'mcp-agy-ig', appSecret: 'mcp-agy-ig-sec' },
    },
  });

  const tempHosting = new TempCloudHostingAdapter({
    tempObjectsRepo: ctx.repos.tempObjectsRepo,
    fetchImpl: mockFetch,
    mockDir: path.join(dir, 'mock-r2'),
  });
  ctx.services.publishService.instagramPublisher = new InstagramPublisher({
    tempHosting,
    fetchImpl: mockFetch,
    containerPollIntervalMs: 10,
  });

  const ytRef = ctx.credentialStore.createCredentialRef('yt');
  ctx.credentialStore.saveAccountTokens({
    accountId: 'acc_agy_yt',
    platform: 'youtube',
    credentialRef: ytRef,
    tokens: { accessToken: 'ya29.agy', refreshToken: '1//agy', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  ctx.repos.accountsRepo.upsertAccount({
    id: 'acc_agy_yt',
    platform: 'youtube',
    displayName: 'AGY YT',
    platformAccountId: 'UC_AGY',
    connectionStatus: 'connected',
    credentialRef: ytRef,
  });

  const igRef = ctx.credentialStore.createCredentialRef('ig');
  ctx.credentialStore.saveAccountTokens({
    accountId: 'acc_agy_ig',
    platform: 'instagram',
    credentialRef: igRef,
    tokens: { accessToken: 'EAA.agy', refreshToken: 'EAA.agy', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
  });
  ctx.repos.accountsRepo.upsertAccount({
    id: 'acc_agy_ig',
    platform: 'instagram',
    displayName: 'AGY IG',
    platformAccountId: '178414321',
    connectionStatus: 'connected',
    credentialRef: igRef,
  });

  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ipcClient = new BackendIpcClient({
    baseUrl,
    ipcSecret: ctx.masterKeyStore.getIpcSecret(),
    autoStart: false,
  });
  const mcpServer = createSocialPublisherMcpServer(ipcClient);
  const mcpClient = new Client({ name: 'test-antigravity-authoring', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

  try {
    const callToolJson = async (name, args = {}) => {
      const res = await mcpClient.callTool({ name, arguments: args });
      assert.equal(res.isError, undefined, `Tool ${name} errored: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };

    const analyzed = await callToolJson('analyze_video', { videoPath, extractFrames: true });
    assert.ok(analyzed.video.analysis.keyframes.length >= 2);
    const chosenThumbOffsetMs = analyzed.video.analysis.keyframes[0].thumbOffsetMs;
    assert.equal(typeof chosenThumbOffsetMs, 'number');

    const ytRes = await callToolJson('publish_to_youtube', {
      accountId: 'acc_agy_yt',
      videoId: analyzed.video.id,
      privacyStatus: 'unlisted',
      title: 'How Antigravity Writes Native Social Metadata',
      description: 'Agent-authored description grounded in extracted frames.',
      hashtags: ['#aiengineering', '#fyp', '#Shorts'],
      tags: ['agent workflow', 'viral', 'nodejs'],
      categoryId: '28',
      pinnedComment: 'Which step in this workflow saves you the most time?',
      defaultLanguage: 'en',
      madeForKids: false,
      approved: true,
      waitForCompletion: true,
    });
    assert.equal(ytRes.job.status, 'completed');
    assert.equal(ytRes.job.summary.providerUsed, 'antigravity:agent');
    assert.equal(capturedYtInit.snippet.title, 'How Antigravity Writes Native Social Metadata');
    assert.equal(capturedYtInit.snippet.categoryId, '28');
    assert.equal(capturedYtInit.snippet.defaultLanguage, 'en');
    assert.equal(capturedYtInit.status.selfDeclaredMadeForKids, false);
    assert.ok(capturedYtInit.snippet.description.includes('#aiengineering'));
    assert.equal(capturedYtInit.snippet.description.includes('#fyp'), false);

    const igRes = await callToolJson('publish_to_instagram', {
      accountId: 'acc_agy_ig',
      videoId: analyzed.video.id,
      caption: 'Visual-first walkthrough authored directly from keyframes.',
      hashtags: ['#aiengineering', '#trending', '#automation'],
      callToAction: 'Save this workflow for your next launch!',
      thumbOffsetMs: chosenThumbOffsetMs,
      audioName: 'Original Creator Narration',
      instagramVisibility: 'trial_manual',
      approved: true,
      waitForCompletion: true,
    });
    assert.equal(igRes.job.status, 'completed');
    assert.equal(igRes.job.summary.providerUsed, 'antigravity:agent');
    assert.equal(capturedIgContainer.thumb_offset, chosenThumbOffsetMs);
    assert.equal(capturedIgContainer.audio_name, 'Original Creator Narration');
    assert.equal(capturedIgContainer.trial_params.graduation_strategy, 'MANUAL');
    assert.ok(capturedIgContainer.caption.includes('Save this workflow for your next launch!'));
    assert.ok(capturedIgContainer.caption.includes('#automation'));
    assert.equal(capturedIgContainer.caption.includes('#trending'), false);
  } finally {
    await mcpClient.close();
    await mcpServer.close();
    await new Promise((r) => server.close(r));
    ctx.db.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});
