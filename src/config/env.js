import dotenv from 'dotenv';
import path from 'node:path';
import { expandHome, getDefaultVideoWatchDirs, PROJECT_ROOT, resolveRuntimePaths } from './paths.js';

let dotenvLoaded = false;

export function loadEnvFile(envPath = path.join(PROJECT_ROOT, '.env')) {
  if (!dotenvLoaded) {
    dotenv.config({ path: envPath, quiet: true });
    dotenvLoaded = true;
  }
}

function parseWatchDirs(raw) {
  if (!raw || !raw.trim()) {
    return getDefaultVideoWatchDirs();
  }
  return raw
    .split(/[;,]/)
    .map((entry) => expandHome(entry.trim()))
    .filter(Boolean);
}

function parseIntBounded(value, fallback, min, max) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

const VALID_INSTAGRAM_LOGIN_MODES = new Set(['meta_unified_login', 'facebook_login', 'instagram_login']);

export function normalizeInstagramLoginMode(rawMode, fallback = 'meta_unified_login') {
  const normalized = String(rawMode || '').trim();
  return VALID_INSTAGRAM_LOGIN_MODES.has(normalized) ? normalized : fallback;
}

export function loadConfig(overrides = {}) {
  loadEnvFile(overrides.envPath);

  const port = overrides.port ?? parseIntBounded(process.env.PORT, 4815, 0, 65535);
  // Security requirement: restrict backend strictly to loopback 127.0.0.1
  const host = '127.0.0.1';
  const appBaseUrl = overrides.appBaseUrl || process.env.APP_BASE_URL || `http://127.0.0.1:${port || 4815}`;
  const paths = resolveRuntimePaths(overrides.paths || {});

  return {
    host,
    port,
    appBaseUrl,
    logLevel: overrides.logLevel || process.env.LOG_LEVEL || 'info',
    defaultPublishMode:
      (overrides.defaultPublishMode || process.env.DEFAULT_PUBLISH_MODE || 'review') === 'autopilot'
        ? 'autopilot'
        : 'review',
    videoWatchDirs: overrides.videoWatchDirs || parseWatchDirs(process.env.VIDEO_WATCH_DIRS),
    ffmpegPath: overrides.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: overrides.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe',
    whisperCliPath: overrides.whisperCliPath || process.env.WHISPER_CLI_PATH || '',
    whisperModelPath: overrides.whisperModelPath || process.env.WHISPER_MODEL_PATH || '',
    youtube: {
      clientId: process.env.YOUTUBE_CLIENT_ID || '',
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
      redirectUri: process.env.YOUTUBE_REDIRECT_URI || `${appBaseUrl}/api/accounts/oauth/callback/youtube`,
      ...(overrides.youtube || {}),
    },
    instagram: {
      appId: process.env.META_APP_ID || '',
      appSecret: process.env.META_APP_SECRET || '',
      configId: process.env.META_LOGIN_CONFIG_ID || process.env.INSTAGRAM_CONFIG_ID || '',
      graphApiVersion: process.env.META_GRAPH_API_VERSION || 'v22.0',
      redirectUri: process.env.INSTAGRAM_REDIRECT_URI || `${appBaseUrl}/api/accounts/oauth/callback/instagram`,
      loginMode: normalizeInstagramLoginMode(process.env.INSTAGRAM_LOGIN_MODE, 'meta_unified_login'),
      ...(overrides.instagram || {}),
    },
    storage: {
      provider: overrides.storageProvider || process.env.TEMP_STORAGE_PROVIDER || 'r2',
      accountId: process.env.R2_ACCOUNT_ID || '',
      bucket: process.env.R2_BUCKET || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      endpoint: process.env.R2_ENDPOINT || '',
      region: process.env.R2_REGION || 'auto',
      urlTtlSeconds: parseIntBounded(process.env.TEMP_MEDIA_URL_TTL_SECONDS, 1800, 60, 3600),
      retentionMinutes: parseIntBounded(process.env.TEMP_MEDIA_RETENTION_MINUTES, 60, 5, 1440),
      maxTotalStoredBytes: parseIntBounded(
        process.env.R2_MAX_TOTAL_STORED_BYTES,
        8 * 1024 * 1024 * 1024,
        1024 * 1024,
        8 * 1024 * 1024 * 1024
      ),
      maxVideoSizeBytes: parseIntBounded(
        process.env.R2_MAX_VIDEO_SIZE_BYTES,
        500 * 1024 * 1024,
        1024 * 1024,
        500 * 1024 * 1024
      ),
      maxConcurrentUploads: 1,
      maxQueuedJobs: parseIntBounded(process.env.MAX_QUEUED_JOBS, 10, 1, 10),
      abandonedUploadHours: parseIntBounded(process.env.R2_ABANDONED_UPLOAD_HOURS, 24, 1, 24),
      monthlyUploadLimitCount: parseIntBounded(process.env.R2_MONTHLY_UPLOAD_LIMIT_COUNT, 200, 1, 10000),
      monthlyUploadLimitBytes: parseIntBounded(
        process.env.R2_MONTHLY_UPLOAD_LIMIT_MB,
        10 * 1024,
        1,
        100 * 1024
      ) * 1024 * 1024,
      monthlyClassAOpsLimit: parseIntBounded(process.env.R2_MONTHLY_CLASS_A_OPS_LIMIT, 800000, 1, 950000),
      monthlyClassBOpsLimit: parseIntBounded(process.env.R2_MONTHLY_CLASS_B_OPS_LIMIT, 8000000, 1, 9500000),
      ...(overrides.storage || {}),
    },
    ai: {
      provider: process.env.AI_PROVIDER || 'auto',
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      openaiApiKey: process.env.OPENAI_API_KEY || '',
      openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:8b',
      ...(overrides.ai || {}),
    },
    paths,
  };
}
