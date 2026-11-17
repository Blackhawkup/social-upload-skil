import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createOptimizedTempCopy(
  sourcePath,
  {
    transcodeDir,
    ffmpegPath = 'ffmpeg',
    targetPlatform = 'instagram',
    padToVertical = false,
  }
) {
  fs.mkdirSync(transcodeDir, { recursive: true });
  const baseName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_-]+/g, '_');
  const outPath = path.join(transcodeDir, `${baseName}_${targetPlatform}_${crypto.randomBytes(6).toString('hex')}.mp4`);

  const args = ['-y', '-i', sourcePath];

  if (padToVertical) {
    // Preserve full frame inside 1080x1920 9:16 canvas without cropping or modifying original file
    args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black');
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    outPath
  );

  await execFileAsync(ffmpegPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('FFmpeg failed to produce a valid temporary optimized video copy');
  }
  return outPath;
}

export function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-fatal
  }
}

