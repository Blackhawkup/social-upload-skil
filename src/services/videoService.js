import path from 'node:path';
import {
  discoverVideos,
  detectWorkflowContext,
  isPathInsideAnyDir,
  isSupportedVideoFile,
} from '../media/discovery.js';
import { probeVideoFile } from '../media/probe.js';
import { validateVideoForTargets } from '../media/validator.js';
import { extractKeyframes, extractProjectContext, transcribeWithWhisperCli } from '../media/extractor.js';
import { PlatformError } from './retry.js';

export class VideoService {
  constructor({ videosRepo, settingsRepo, config, logger = null }) {
    this.videosRepo = videosRepo;
    this.settingsRepo = settingsRepo;
    this.config = config;
    this.logger = logger;
  }

  #blockedInternalDirs() {
    const p = this.config?.paths || {};
    return [p.credentialsDir, p.secretsDir, p.dataDir, p.logsDir].filter(Boolean);
  }

  findVideos({ explicitPath = null, query = null, limit = 10, watchDirs = null } = {}) {
    const configuredDirs =
      watchDirs || this.settingsRepo.get('videoWatchDirs', this.config.videoWatchDirs);

    const candidates = discoverVideos({
      explicitPath,
      query,
      watchDirs: configuredDirs,
      blockedDirs: this.#blockedInternalDirs(),
      limit,
    });

    if (candidates.length === 0) {
      return [];
    }
    return candidates;
  }

  async analyzeVideo({ videoPath = null, query = null, extractFrames = true } = {}) {
    let targetPath = videoPath;
    let workflowCtx = null;

    if (!targetPath) {
      const found = this.findVideos({ query, limit: 1 });
      if (found.length === 0) {
        throw new PlatformError(
          'No generated video found in configured output directories. Pass an explicit filePath or configure VIDEO_WATCH_DIRS.',
          { code: 'VIDEO_NOT_FOUND', statusCode: 404 }
        );
      }
      targetPath = found[0].filePath;
      workflowCtx = { sourceWorkflow: found[0].sourceWorkflow, projectDir: found[0].projectDir };
    } else {
      targetPath = path.resolve(targetPath);
      if (isPathInsideAnyDir(targetPath, this.#blockedInternalDirs())) {
        throw new PlatformError('Access to internal credentials, secrets, data, or logs paths is blocked.', {
          code: 'FORBIDDEN_PATH',
          statusCode: 403,
        });
      }
      if (!isSupportedVideoFile(targetPath)) {
        throw new PlatformError(`Unsupported video file extension: ${path.basename(targetPath)}`, {
          code: 'UNSUPPORTED_VIDEO_EXTENSION',
          statusCode: 400,
        });
      }
      workflowCtx = detectWorkflowContext(targetPath);
    }

    const probe = await probeVideoFile(targetPath, { ffprobePath: this.config.ffprobePath });

    const projectContext = extractProjectContext(targetPath, workflowCtx.projectDir);

    if (!projectContext.transcriptText && !projectContext.scriptText && probe.hasAudio) {
      const whisperText = await transcribeWithWhisperCli(targetPath, {
        tempDir: this.config.paths.tempDir,
        ffmpegPath: this.config.ffmpegPath,
        whisperCliPath: this.config.whisperCliPath,
        whisperModelPath: this.config.whisperModelPath,
      });
      if (whisperText) {
        projectContext.transcriptText = whisperText;
      }
    }

    const keyframes = extractFrames
      ? await extractKeyframes(targetPath, probe.durationSec, {
          framesDir: this.config.paths.framesDir,
          videoIdOrHash: probe.fileSha256,
          ffmpegPath: this.config.ffmpegPath,
          count: 5,
        })
      : [];

    const analysis = {
      analyzedAt: new Date().toISOString(),
      projectContext,
      keyframes,
      qualifiesAsYouTubeShort:
        (probe.orientation === 'vertical' || probe.orientation === 'square') &&
        probe.durationSec > 0 &&
        probe.durationSec <= 180,
    };

    const record = this.videosRepo.upsertVideo({
      filePath: probe.filePath,
      fileName: path.basename(probe.filePath),
      fileSha256: probe.fileSha256,
      fileSizeBytes: probe.fileSizeBytes,
      sourceWorkflow: workflowCtx.sourceWorkflow,
      projectDir: workflowCtx.projectDir,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      aspectRatio: probe.aspectRatio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      probe,
      analysis,
    });

    return record;
  }

  async validateVideo({ videoId = null, videoPath = null, targets = [] }) {
    const video = videoId
      ? this.videosRepo.findById(videoId)
      : await this.analyzeVideo({ videoPath, extractFrames: false });

    if (!video) {
      throw new PlatformError(`Video record not found: ${videoId || videoPath}`, {
        code: 'VIDEO_NOT_FOUND',
        statusCode: 404,
      });
    }

    const probe = video.probe?.fileSha256
      ? video.probe
      : await probeVideoFile(video.filePath, { ffprobePath: this.config.ffprobePath });

    const maxInstagramVideoSizeBytes =
      this.config?.storage?.maxVideoSizeBytes || 500 * 1024 * 1024;
    const validationResults = validateVideoForTargets(probe, targets, { maxInstagramVideoSizeBytes });
    return {
      video,
      results: validationResults,
      allValid: validationResults.every((r) => r.valid),
    };
  }
}

