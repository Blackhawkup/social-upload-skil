import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config/env.js';
import { ensureRuntimeDirectories, PROJECT_ROOT } from '../config/paths.js';
import { MasterKeyStore } from '../security/masterKeyStore.js';
import { sanitizeErrorMessage } from '../security/redact.js';

const __filename = fileURLToPath(import.meta.url);

export class BackendIpcClient {
  constructor({ baseUrl = null, ipcSecret = null, autoStart = true, keyStoreMode = null } = {}) {
    this.config = loadConfig();
    ensureRuntimeDirectories(this.config.paths);
    this.baseUrl = (baseUrl || `http://127.0.0.1:${this.config.port || 4815}`).replace(/\/$/, '');
    this.autoStart = autoStart;
    this.ipcSecret = ipcSecret;
    this._startingPromise = null;
    this.masterKeyStore = ipcSecret
      ? null
      : new MasterKeyStore({
          secretsDir: this.config.paths.secretsDir,
          mode: keyStoreMode || (process.platform === 'win32' ? 'wincred' : 'file'),
        });
  }

  async ensureBackendRunning() {
    if (await this.#isHealthy()) return;
    if (!this.autoStart) {
      throw new Error(`Local backend is not reachable at ${this.baseUrl}`);
    }
    if (this._startingPromise) {
      return await this._startingPromise;
    }

    this._startingPromise = this.#spawnBackendAndWait().finally(() => {
      this._startingPromise = null;
    });
    return await this._startingPromise;
  }

  async #spawnBackendAndWait() {
    if (await this.#isHealthy()) return;

    const lockPath = path.join(this.config.paths.dataDir, 'backend.start.lock');
    let lockFd = null;
    try {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 15000) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // ignore missing lock
      }

      try {
        lockFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockFd, String(process.pid));
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        // Another process is actively spawning the backend; wait for health below
      }

      if (lockFd !== null) {
        // Re-check health after acquiring startup lock before spawning
        if (await this.#isHealthy()) return;

        const logPath = path.join(this.config.paths.logsDir, 'daemon.log');
        const outFd = fs.openSync(logPath, 'a');
        const serverEntry = path.join(PROJECT_ROOT, 'src', 'server.js');
        const child = spawn(process.execPath, [serverEntry], {
          cwd: PROJECT_ROOT,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', outFd, outFd],
          env: { ...process.env, SUPPRESS_BOOTSTRAP_LOG: '1' },
        });
        child.unref();
        fs.closeSync(outFd);
      }

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await this.#isHealthy()) return;
      }

      throw new Error('Timed out waiting for local Social Media Publisher backend to start on 127.0.0.1');
    } finally {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    }
  }

  async #isHealthy() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  #getBearer() {
    if (this.ipcSecret) return this.ipcSecret;
    return this.masterKeyStore.getIpcSecret();
  }

  async request(method, apiPath, body = null) {
    await this.ensureBackendRunning();
    const headers = {
      Authorization: `Bearer ${this.#getBearer()}`,
      Accept: 'application/json',
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${this.baseUrl}${apiPath}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const code = json?.error?.code || `HTTP_${res.status}`;
      const msg = sanitizeErrorMessage(json?.error?.message || res.statusText || 'Backend request failed');
      const err = new Error(`[${code}] ${msg}`);
      err.code = code;
      throw err;
    }
    return json.data;
  }
}

function okResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errResult(err) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: true,
            code: err?.code || 'TOOL_ERROR',
            message: sanitizeErrorMessage(err),
          },
          null,
          2
        ),
      },
    ],
  };
}

export function createSocialPublisherMcpServer(ipcClient) {
  const server = new McpServer({
    name: 'social-publisher',
    version: '1.0.0',
  });

  server.registerTool(
    'list_social_accounts',
    {
      title: 'List Social Media Accounts',
      description:
        'List connected YouTube and Instagram accounts (display names, usernames, IDs, connection status, and preferences). Never returns raw credentials.',
      inputSchema: {
        platform: z.enum(['youtube', 'instagram']).optional().describe('Optional filter by platform'),
      },
    },
    async ({ platform }) => {
      try {
        const qs = platform ? `?platform=${encodeURIComponent(platform)}` : '';
        const data = await ipcClient.request('GET', `/api/accounts${qs}`);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'connect_social_account',
    {
      title: 'Connect Social Media Account',
      description:
        'Start an official OAuth 2.0 flow (with PKCE and CSRF state) to connect or reauthorize a YouTube or Instagram Professional account. Returns an authorizationUrl for the user to open in their browser.',
      inputSchema: {
        platform: z.enum(['youtube', 'instagram']).describe('Target platform'),
        displayName: z.string().min(1).max(120).optional().describe('Friendly label, e.g. "AI News" or "Gaming News"'),
        accountId: z.string().optional().describe('Existing account ID if reauthorizing an expired/disconnected account'),
        igLoginMode: z
          .enum(['meta_unified_login', 'facebook_login', 'instagram_login'])
          .optional()
          .describe('Instagram OAuth mode (defaults to configured mode: meta_unified_login recommended)'),
      },
    },
    async ({ platform, displayName, accountId, igLoginMode }) => {
      try {
        if (accountId) {
          const data = await ipcClient.request('POST', `/api/accounts/${encodeURIComponent(accountId)}/reauthorize`, {
            ...(igLoginMode ? { igLoginMode } : {}),
          });
          return okResult(data);
        }
        const data = await ipcClient.request('POST', `/api/accounts/connect/${platform}`, {
          ...(displayName ? { displayName } : {}),
          ...(igLoginMode ? { igLoginMode } : {}),
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'get_social_account_status',
    {
      title: 'Get Social Account Status',
      description: 'Check connection health, token expiration, and live reachability for a connected account.',
      inputSchema: {
        accountId: z.string().min(1).describe('Internal account ID (e.g. acc_...)'),
        live: z.boolean().optional().default(true).describe('Perform live API verification (auto-refreshes if near expiry)'),
      },
    },
    async ({ accountId, live }) => {
      try {
        const data = await ipcClient.request(
          'GET',
          `/api/accounts/${encodeURIComponent(accountId)}/status?live=${live ? 'true' : 'false'}`
        );
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'refresh_social_account_token',
    {
      title: 'Refresh Social Account Token',
      description: 'Refresh an expired or expiring OAuth access token for a connected YouTube or Instagram account.',
      inputSchema: {
        accountId: z.string().min(1),
      },
    },
    async ({ accountId }) => {
      try {
        const data = await ipcClient.request('POST', `/api/accounts/${encodeURIComponent(accountId)}/refresh`, {});
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'find_video',
    {
      title: 'Find Video',
      description:
        'Discover generated videos from an explicit file path, project name/query, or latest outputs in configured AI video folders (Flow MCP, WhiteboardFilms, StickFilms, Remotion, Videos).',
      inputSchema: {
        explicitPath: z.string().optional().describe('Explicit file or directory path'),
        query: z.string().optional().describe('Optional project slug or filename filter'),
        limit: z.number().int().min(1).max(30).optional().default(5),
      },
    },
    async ({ explicitPath, query, limit }) => {
      try {
        const data = await ipcClient.request('POST', '/api/videos/find', {
          ...(explicitPath ? { explicitPath } : {}),
          ...(query ? { query } : {}),
          limit,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'analyze_video',
    {
      title: 'Analyze Video',
      description:
        'Inspect a video with ffprobe, compute SHA-256 hash, extract keyframes (each with path, timestampSec, and thumbOffsetMs for Reel cover selection), and gather narration transcripts, scripts, or subtitles. Use read_file on returned keyframe JPEG paths so Antigravity can understand the visuals directly before composing captions and hashtags.',
      inputSchema: {
        videoPath: z.string().optional().describe('Path to video file; if omitted, uses latest discovered video'),
        query: z.string().optional().describe('Optional project name filter when videoPath is omitted'),
        extractFrames: z.boolean().optional().default(true),
      },
    },
    async ({ videoPath, query, extractFrames }) => {
      try {
        const data = await ipcClient.request('POST', '/api/videos/analyze', {
          ...(videoPath ? { videoPath } : {}),
          ...(query ? { query } : {}),
          extractFrames,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'generate_social_metadata',
    {
      title: 'Generate or Save Social Metadata',
      description:
        'Validate, sanitize (stripping banned spam hashtags like #fyp/#viral/#trending), and save platform-specific YouTube & Instagram metadata drafts. Recommended workflow: Antigravity inspects video keyframes + transcript via analyze_video and passes its own tailored youtube and instagram drafts inside customOverrides (with authorMode="antigravity"), or omits customOverrides to invoke backend AI/deterministic fallback.',
      inputSchema: {
        videoId: z.string().optional(),
        videoPath: z.string().optional(),
        accountIds: z.array(z.string()).optional(),
        customOverrides: z
          .object({
            authorMode: z.enum(['auto', 'antigravity', 'ai', 'deterministic']).optional(),
            contentSummary: z.string().max(1000).optional(),
            detectedLanguage: z.string().max(16).optional(),
            detectedTone: z.string().max(64).optional(),
            youtube: z
              .object({
                title: z.string().max(100).optional(),
                description: z.string().max(5000).optional(),
                hashtags: z.array(z.string()).optional(),
                tags: z.array(z.string()).optional(),
                categoryId: z.string().optional(),
                pinnedComment: z.string().max(1000).optional(),
                defaultLanguage: z.string().max(16).optional(),
                madeForKids: z.boolean().optional(),
              })
              .optional(),
            instagram: z
              .object({
                caption: z.string().max(2200).optional(),
                hashtags: z.array(z.string()).optional(),
                callToAction: z.string().max(300).optional(),
                emojis: z.array(z.string()).optional(),
                thumbOffsetMs: z.number().int().min(0).optional(),
                audioName: z.string().max(120).optional(),
              })
              .optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        const data = await ipcClient.request('POST', '/api/captions/generate', args);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'validate_video',
    {
      title: 'Validate Video',
      description:
        'Validate codecs, resolution, aspect ratio, duration, and file size against YouTube (standard or Shorts) and Instagram Reels requirements.',
      inputSchema: {
        videoId: z.string().optional(),
        videoPath: z.string().optional(),
        targets: z
          .array(
            z.object({
              accountId: z.string().optional(),
              platform: z.enum(['youtube', 'instagram']),
              isShort: z.boolean().optional(),
            })
          )
          .min(1),
      },
    },
    async (args) => {
      try {
        const data = await ipcClient.request('POST', '/api/videos/validate', args);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'publish_to_youtube',
    {
      title: 'Publish to YouTube',
      description:
        'Publish a video (or Short) to a single authorized YouTube account with Antigravity-authored title, SEO description, hashtags, tags, categoryId, optional pinnedComment suggestion, defaultLanguage, and madeForKids flag. In Review Mode, creates an awaiting_approval job unless approved=true; waits for upload and YouTube processing completion when waitForCompletion=true.',
      inputSchema: {
        accountId: z.string().min(1),
        videoId: z.string().optional(),
        videoPath: z.string().optional(),
        privacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
        publishAt: z.string().optional().describe('ISO-8601 future timestamp for scheduled publish (forces private until publishAt)'),
        asShort: z.boolean().optional(),
        title: z.string().max(100).optional().describe('YouTube title (<=100 chars, composed by Antigravity from video frames/transcript)'),
        description: z.string().max(5000).optional().describe('SEO-friendly YouTube description'),
        hashtags: z.array(z.string()).optional().describe('2-5 relevant hashtags (e.g. ["#aiagents", "#Shorts"]); appended cleanly if omitted from description'),
        tags: z.array(z.string()).optional().describe('5-15 YouTube topic search tags'),
        categoryId: z.string().optional().describe('YouTube numeric category ID (e.g. "28" Tech, "27" Education, "20" Gaming, "22" People & Blogs)'),
        pinnedComment: z.string().max(1000).optional().describe('Copy-ready pinned comment prompt saved with job summary'),
        defaultLanguage: z.string().max(16).optional().describe('BCP-47 language code, e.g. "en"'),
        madeForKids: z.boolean().optional().describe('Self-declared Made for Kids flag (default false)'),
        approved: z.boolean().optional().default(false),
        allowDuplicate: z.boolean().optional().default(false),
        waitForCompletion: z.boolean().optional().default(true),
      },
    },
    async ({
      accountId,
      videoId,
      videoPath,
      privacyStatus,
      publishAt,
      asShort,
      title,
      description,
      hashtags,
      tags,
      categoryId,
      pinnedComment,
      defaultLanguage,
      madeForKids,
      approved,
      allowDuplicate,
      waitForCompletion,
    }) => {
      try {
        const youtubeOverride = {
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(hashtags ? { hashtags } : {}),
          ...(tags ? { tags } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(pinnedComment ? { pinnedComment } : {}),
          ...(defaultLanguage ? { defaultLanguage } : {}),
          ...(madeForKids !== undefined ? { madeForKids } : {}),
        };
        const hasAuthoredYt = Boolean(title || description || (hashtags && hashtags.length > 0));
        const data = await ipcClient.request('POST', '/api/publish/youtube', {
          accountId,
          ...(videoId ? { videoId } : {}),
          ...(videoPath ? { videoPath } : {}),
          ...(Object.keys(youtubeOverride).length
            ? {
                metadataOverrides: {
                  ...(hasAuthoredYt ? { authorMode: 'antigravity' } : {}),
                  youtube: youtubeOverride,
                },
              }
            : {}),
          options: {
            ...(privacyStatus ? { privacyStatus } : {}),
            ...(publishAt ? { publishAt } : {}),
            ...(asShort !== undefined ? { asShort } : {}),
            ...(defaultLanguage ? { defaultLanguage } : {}),
            ...(madeForKids !== undefined ? { madeForKids } : {}),
          },
          approved,
          allowDuplicate,
          waitForCompletion,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'publish_to_instagram',
    {
      title: 'Publish to Instagram',
      description:
        'Publish a video as an Instagram Reel to an authorized Instagram Professional account with Antigravity-authored caption, hashtags, CTA, optional cover thumbOffsetMs (chosen from analyze_video keyframes), and optional audioName, staged via temporary private cloud storage. Supports visibility choices: public, reels_only, trial_manual (hidden Trial Reel until promoted), or private (only when confirmPrivateInstagramAccount=true confirms target IG Creator account itself is Private in Instagram Settings). Waits for checks, upload, cleanup, and container completion when waitForCompletion=true.',
      inputSchema: {
        accountId: z.string().min(1),
        videoId: z.string().optional(),
        videoPath: z.string().optional(),
        caption: z.string().max(2200).optional().describe('Engaging Instagram Reel caption composed by Antigravity'),
        hashtags: z.array(z.string()).optional().describe('3-7 niche Instagram hashtags (spam tags stripped automatically; appended cleanly if not in caption)'),
        callToAction: z.string().max(300).optional().describe('Optional CTA line appended cleanly if not already in caption'),
        thumbOffsetMs: z.number().int().min(0).optional().describe('Cover frame timestamp in milliseconds (pick best keyframe thumbOffsetMs from analyze_video)'),
        audioName: z.string().max(120).optional().describe('Optional custom original audio attribution name on Instagram Reel'),
        shareToFeed: z.boolean().optional(),
        instagramVisibility: z
          .enum(['public', 'reels_only', 'trial_manual', 'trial_performance', 'private'])
          .optional()
          .describe(
            'Visibility mode for Instagram Reel: public (feed+Reels), reels_only (Reels tab only), trial_manual (hidden Trial Reel until promoted), trial_performance, or private (requires confirmPrivateInstagramAccount=true)'
          ),
        confirmPrivateInstagramAccount: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set true only when user confirmed target Instagram Creator account is set Private in IG app settings'),
        padToVertical: z.boolean().optional().describe('Create a temporary non-destructive 9:16 padded copy if source is landscape'),
        approved: z.boolean().optional().default(false),
        allowDuplicate: z.boolean().optional().default(false),
        waitForCompletion: z.boolean().optional().default(true),
      },
    },
    async ({
      accountId,
      videoId,
      videoPath,
      caption,
      hashtags,
      callToAction,
      thumbOffsetMs,
      audioName,
      shareToFeed,
      instagramVisibility,
      confirmPrivateInstagramAccount,
      padToVertical,
      approved,
      allowDuplicate,
      waitForCompletion,
    }) => {
      try {
        const igOverride = {
          ...(caption ? { caption } : {}),
          ...(hashtags ? { hashtags } : {}),
          ...(callToAction ? { callToAction } : {}),
          ...(thumbOffsetMs !== undefined ? { thumbOffsetMs } : {}),
          ...(audioName ? { audioName } : {}),
        };
        const hasAuthoredIg = Boolean(caption || (hashtags && hashtags.length > 0));
        const data = await ipcClient.request('POST', '/api/publish/instagram', {
          accountId,
          ...(videoId ? { videoId } : {}),
          ...(videoPath ? { videoPath } : {}),
          ...(Object.keys(igOverride).length
            ? {
                metadataOverrides: {
                  ...(hasAuthoredIg ? { authorMode: 'antigravity' } : {}),
                  instagram: igOverride,
                },
              }
            : {}),
          options: {
            ...(shareToFeed !== undefined ? { shareToFeed } : {}),
            ...(instagramVisibility ? { instagramVisibility } : {}),
            ...(confirmPrivateInstagramAccount ? { confirmPrivateInstagramAccount } : {}),
            ...(thumbOffsetMs !== undefined ? { thumbOffsetMs } : {}),
            ...(audioName ? { audioName } : {}),
            ...(padToVertical !== undefined ? { padToVertical } : {}),
          },
          approved,
          allowDuplicate,
          waitForCompletion,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'publish_to_multiple_accounts',
    {
      title: 'Publish to Multiple Accounts',
      description:
        'Publish a video across multiple authorized YouTube and Instagram accounts in one job with Antigravity-authored platform-native metadata (pass youtube, instagram, and/or perAccount overrides + contentSummary inside metadataOverrides). Respects Review Mode vs Autopilot Mode, per-platform visibility choices, duplicate prevention, partial failure tracking, and full completion waiting when waitForCompletion=true.',
      inputSchema: {
        accountIds: z.array(z.string().min(1)).describe('List of authorized destination account IDs'),
        videoId: z.string().optional(),
        videoPath: z.string().optional(),
        privacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
        publishAt: z.string().optional(),
        asShort: z.boolean().optional(),
        defaultLanguage: z.string().max(16).optional(),
        madeForKids: z.boolean().optional(),
        shareToFeed: z.boolean().optional(),
        instagramVisibility: z
          .enum(['public', 'reels_only', 'trial_manual', 'trial_performance', 'private'])
          .optional(),
        confirmPrivateInstagramAccount: z.boolean().optional().default(false),
        thumbOffsetMs: z.number().int().min(0).optional(),
        audioName: z.string().max(120).optional(),
        padToVertical: z.boolean().optional(),
        metadataOverrides: z
          .object({
            authorMode: z.enum(['auto', 'antigravity', 'ai', 'deterministic']).optional(),
            contentSummary: z.string().max(1000).optional(),
            detectedLanguage: z.string().max(16).optional(),
            detectedTone: z.string().max(64).optional(),
            youtube: z.record(z.unknown()).optional(),
            instagram: z.record(z.unknown()).optional(),
            perAccount: z.record(z.record(z.unknown())).optional(),
          })
          .optional(),
        approved: z.boolean().optional().default(false),
        allowDuplicate: z.boolean().optional().default(false),
        waitForCompletion: z.boolean().optional().default(true),
      },
    },
    async ({
      accountIds,
      videoId,
      videoPath,
      privacyStatus,
      publishAt,
      asShort,
      defaultLanguage,
      madeForKids,
      shareToFeed,
      instagramVisibility,
      confirmPrivateInstagramAccount,
      thumbOffsetMs,
      audioName,
      padToVertical,
      metadataOverrides,
      approved,
      allowDuplicate,
      waitForCompletion,
    }) => {
      try {
        const data = await ipcClient.request('POST', '/api/publish/multiple', {
          accountIds,
          ...(videoId ? { videoId } : {}),
          ...(videoPath ? { videoPath } : {}),
          ...(metadataOverrides ? { metadataOverrides } : {}),
          options: {
            ...(privacyStatus ? { privacyStatus } : {}),
            ...(publishAt ? { publishAt } : {}),
            ...(asShort !== undefined ? { asShort } : {}),
            ...(defaultLanguage ? { defaultLanguage } : {}),
            ...(madeForKids !== undefined ? { madeForKids } : {}),
            ...(shareToFeed !== undefined ? { shareToFeed } : {}),
            ...(instagramVisibility ? { instagramVisibility } : {}),
            ...(confirmPrivateInstagramAccount ? { confirmPrivateInstagramAccount } : {}),
            ...(thumbOffsetMs !== undefined ? { thumbOffsetMs } : {}),
            ...(audioName ? { audioName } : {}),
            ...(padToVertical !== undefined ? { padToVertical } : {}),
          },
          approved,
          allowDuplicate,
          waitForCompletion,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'approve_publishing_job',
    {
      title: 'Approve Publishing Job',
      description:
        'Approve and execute a Review Mode publishing job (optionally overriding per-item title, caption, tags, or privacy status).',
      inputSchema: {
        jobId: z.string().min(1),
        itemOverrides: z.record(z.record(z.unknown())).optional(),
        waitForCompletion: z.boolean().optional().default(true),
      },
    },
    async ({ jobId, itemOverrides, waitForCompletion }) => {
      try {
        const data = await ipcClient.request('POST', `/api/publish/${encodeURIComponent(jobId)}/approve`, {
          ...(itemOverrides ? { itemOverrides } : {}),
          waitForCompletion,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'get_publishing_status',
    {
      title: 'Get Publishing Status',
      description: 'Retrieve live upload progress, processing status, errors, and published URLs for a publishing job.',
      inputSchema: {
        jobId: z.string().min(1),
      },
    },
    async ({ jobId }) => {
      try {
        const data = await ipcClient.request('GET', `/api/publish/${encodeURIComponent(jobId)}/status`);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'get_publishing_history',
    {
      title: 'Get Publishing History',
      description: 'List recent publishing jobs, destination results, published URLs, and any failed uploads.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(20),
        status: z
          .enum([
            'awaiting_approval',
            'queued',
            'running',
            'completed',
            'partial_success',
            'failed',
            'cancelled',
          ])
          .optional(),
      },
    },
    async ({ limit, status }) => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (status) params.set('status', status);
        const data = await ipcClient.request('GET', `/api/publish/history?${params.toString()}`);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'retry_failed_publication',
    {
      title: 'Retry Failed Publication',
      description:
        'Retry only the failed destination(s) of a failed or partial_success publishing job without re-uploading destinations that already succeeded.',
      inputSchema: {
        jobId: z.string().min(1),
        itemIds: z.array(z.string()).optional().describe('Optional subset of failed item IDs or account IDs'),
        waitForCompletion: z.boolean().optional().default(true),
      },
    },
    async ({ jobId, itemIds, waitForCompletion }) => {
      try {
        const data = await ipcClient.request('POST', `/api/publish/${encodeURIComponent(jobId)}/retry`, {
          ...(itemIds ? { itemIds } : {}),
          waitForCompletion,
        });
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'get_r2_usage_status',
    {
      title: 'Get Cloudflare R2 Usage & Safety Limits',
      description:
        'Check Cloudflare R2 temporary storage usage, configurable monthly upload limits, 70%/85%/95% warnings, local operation logs, and optionally run an abandoned/multipart cleanup sweep. Note: local safeguards are NOT a Cloudflare billing cap.',
      inputSchema: {
        live: z.boolean().optional().default(true).describe('Measure live bucket usage via R2 ListObjectsV2 (fail closed if unreachable)'),
        runCleanup: z.boolean().optional().default(false).describe('Run 24h abandoned object and incomplete multipart upload cleanup before reporting'),
      },
    },
    async ({ live, runCleanup }) => {
      try {
        if (runCleanup) {
          const data = await ipcClient.request('POST', '/api/storage/cleanup', {});
          return okResult(data);
        }
        const data = await ipcClient.request('GET', `/api/storage/usage?live=${live ? 'true' : 'false'}`);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'get_publishing_settings',
    {
      title: 'Get Publishing Settings and Readiness',
      description:
        'Retrieve current publishing mode (review vs autopilot), default accounts, watched video directories, dashboard launch URL, masked credential setup readiness, and local Cloudflare R2 free-tier safety status (never returns raw secrets).',
      inputSchema: {},
    },
    async () => {
      try {
        const [settingsData, setupData] = await Promise.all([
          ipcClient.request('GET', '/api/settings'),
          ipcClient.request('GET', '/api/setup/status'),
        ]);
        return okResult({
          settings: settingsData.settings,
          setupReadiness: setupData,
          r2Usage: setupData.r2Usage || null,
          dashboardUrl: ipcClient.baseUrl,
        });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    'update_publishing_settings',
    {
      title: 'Update Publishing Settings',
      description: 'Update publishing mode (review or autopilot), default accounts, default privacy status, or video watch directories.',
      inputSchema: {
        publishMode: z.enum(['review', 'autopilot']).optional(),
        defaultAccountIds: z.array(z.string()).optional(),
        videoWatchDirs: z.array(z.string()).optional(),
        autoDetectShorts: z.boolean().optional(),
        defaultPrivacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
      },
    },
    async (args) => {
      try {
        const data = await ipcClient.request('POST', '/api/settings', args);
        return okResult(data);
      } catch (err) {
        return errResult(err);
      }
    }
  );

  return server;
}

export async function runStdioMcpServer() {
  const ipcClient = new BackendIpcClient();
  const server = createSocialPublisherMcpServer(ipcClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioMcpServer().catch((err) => {
    process.stderr.write(`[social-publisher-mcp] Fatal error: ${sanitizeErrorMessage(err)}\n`);
    process.exit(1);
  });
}
