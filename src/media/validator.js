import path from 'node:path';

export function validateForYouTube(probe, { asShort = false } = {}) {
  const errors = [];
  const warnings = [];
  const recommendations = [];

  const ext = path.extname(probe.filePath).toLowerCase();
  const allowedExts = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
  if (!allowedExts.has(ext)) {
    errors.push(`Unsupported container extension "${ext}" for YouTube.`);
  }

  const maxBytes = 256 * 1024 * 1024 * 1024;
  if (probe.fileSizeBytes > maxBytes) {
    errors.push('File exceeds YouTube 256 GB maximum size limit.');
  }
  if (probe.durationSec <= 0) {
    errors.push('Video duration could not be verified (> 0 seconds required).');
  }
  if (probe.durationSec > 12 * 3600) {
    errors.push('Video exceeds YouTube 12-hour maximum duration.');
  }

  const shortsEligibleByAspect =
    probe.orientation === 'vertical' ||
    probe.orientation === 'square' ||
    (probe.aspectNumeric !== null && probe.aspectNumeric <= 1.05);
  const shortsEligibleByDuration = probe.durationSec > 0 && probe.durationSec <= 180;
  const qualifiesAsShort = shortsEligibleByAspect && shortsEligibleByDuration;

  if (asShort && !qualifiesAsShort) {
    if (!shortsEligibleByAspect) {
      errors.push(
        `Video aspect ratio (${probe.width}x${probe.height}, ${probe.aspectRatio}, ${probe.orientation}) does not qualify as a YouTube Short. Shorts require vertical (9:16) or square (1:1) framing.`
      );
    }
    if (!shortsEligibleByDuration) {
      errors.push(
        `Video duration (${probe.durationSec}s) exceeds the 180-second (3-minute) maximum for YouTube Shorts.`
      );
    }
  } else if (qualifiesAsShort && probe.orientation === 'square') {
    warnings.push('Video is square (1:1); vertical 9:16 (1080x1920) is recommended for full-screen Shorts.');
  } else if (!asShort && qualifiesAsShort) {
    recommendations.push('Video qualifies as a YouTube Short (vertical/square and <= 180s).');
  }

  if (!['h264', 'hevc', 'vp9', 'av1'].includes(probe.videoCodec)) {
    warnings.push(`Video codec "${probe.videoCodec}" may require slower server-side processing; H.264 is recommended.`);
  }
  if (probe.hasAudio && !['aac', 'mp3', 'opus', 'flac'].includes(probe.audioCodec)) {
    warnings.push(`Audio codec "${probe.audioCodec}" is non-standard; AAC-LC is recommended.`);
  }
  if (!probe.hasAudio) {
    warnings.push('Video has no audio track.');
  }

  return {
    platform: 'youtube',
    targetFormat: asShort ? 'youtube_short' : 'youtube_video',
    valid: errors.length === 0,
    needsTranscode: false,
    qualifiesAsShort,
    errors,
    warnings,
    recommendations,
  };
}

export const DEFAULT_MAX_INSTAGRAM_R2_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB R2 free-tier cost protection limit

export function validateForInstagramReels(probe, { maxVideoSizeBytes = DEFAULT_MAX_INSTAGRAM_R2_VIDEO_BYTES } = {}) {
  const errors = [];
  const warnings = [];
  const recommendations = [];
  let needsTranscode = false;
  const transcodeReasons = [];

  const ext = path.extname(probe.filePath).toLowerCase();
  if (!['.mp4', '.mov'].includes(ext)) {
    needsTranscode = true;
    transcodeReasons.push(`Container "${ext}" must be MP4 or MOV for Instagram Reels.`);
  }

  if (!['h264', 'hevc'].includes(probe.videoCodec)) {
    needsTranscode = true;
    transcodeReasons.push(`Video codec "${probe.videoCodec}" must be H.264 or HEVC for Instagram Reels.`);
  }

  if (probe.hasAudio && probe.audioCodec !== 'aac') {
    needsTranscode = true;
    transcodeReasons.push(`Audio codec "${probe.audioCodec}" must be AAC for Instagram Reels.`);
  }

  if (probe.hasAudio && probe.audioSampleRate && probe.audioSampleRate > 48000) {
    needsTranscode = true;
    transcodeReasons.push(`Audio sample rate ${probe.audioSampleRate}Hz exceeds 48kHz limit.`);
  }

  if (probe.durationSec < 3) {
    errors.push(`Video duration (${probe.durationSec}s) is below Instagram Reels 3-second minimum.`);
  } else if (probe.durationSec > 900) {
    errors.push(`Video duration (${probe.durationSec}s) exceeds Instagram Reels 15-minute (900s) API limit.`);
  } else if (probe.durationSec > 90) {
    warnings.push(
      `Video is ${probe.durationSec}s. Instagram Graph API accepts up to 15 minutes, though videos <= 90s perform best for Reels discovery tab eligibility.`
    );
  }

  const effectiveMaxBytes = Math.min(
    DEFAULT_MAX_INSTAGRAM_R2_VIDEO_BYTES,
    Math.max(1, Number(maxVideoSizeBytes) || DEFAULT_MAX_INSTAGRAM_R2_VIDEO_BYTES)
  );
  if (probe.fileSizeBytes > effectiveMaxBytes) {
    const limitMb = Math.round(effectiveMaxBytes / (1024 * 1024));
    const sizeMb = (probe.fileSizeBytes / (1024 * 1024)).toFixed(1);
    errors.push(
      `Video size (${sizeMb} MB) exceeds the ${limitMb} MB individual video limit for temporary R2 staging and Instagram Reels.`
    );
  }

  if (probe.width < 540) {
    warnings.push(`Video width (${probe.width}px) is below recommended 1080px (minimum 540px recommended).`);
  }

  if (probe.orientation === 'landscape') {
    warnings.push(
      `Video is landscape (${probe.width}x${probe.height}, ${probe.aspectRatio}). Vertical 9:16 (1080x1920) is strongly recommended for Instagram Reels to avoid heavy cropping.`
    );
    recommendations.push('Consider creating a temporary 9:16 vertical padded copy or regenerating in 9:16 format.');
  }

  if (!probe.hasAudio) {
    warnings.push('Video has no audio track; Reels engagement is typically much higher with narration or audio.');
  }

  return {
    platform: 'instagram',
    targetFormat: 'instagram_reel',
    valid: errors.length === 0,
    needsTranscode,
    transcodeReasons,
    errors,
    warnings,
    recommendations,
  };
}

export function validateVideoForTargets(probe, targets, { maxInstagramVideoSizeBytes = DEFAULT_MAX_INSTAGRAM_R2_VIDEO_BYTES } = {}) {
  const results = [];
  for (const target of targets) {
    if (target.platform === 'youtube') {
      results.push({
        accountId: target.accountId,
        ...validateForYouTube(probe, { asShort: Boolean(target.isShort) }),
      });
    } else if (target.platform === 'instagram') {
      results.push({
        accountId: target.accountId,
        ...validateForInstagramReels(probe, { maxVideoSizeBytes: maxInstagramVideoSizeBytes }),
      });
    }
  }
  return results;
}

