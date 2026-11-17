import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseFrameRate(rawRate) {
  if (!rawRate || typeof rawRate !== 'string') return null;
  if (rawRate.includes('/')) {
    const [numStr, denStr] = rawRate.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (!Number.isNaN(num) && !Number.isNaN(den) && den > 0) {
      return Math.round((num / den) * 100) / 100;
    }
  }
  const n = Number(rawRate);
  return Number.isNaN(n) ? null : n;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function classifyAspectRatio(width, height) {
  if (!width || !height) return { label: 'unknown', ratio: null, orientation: 'unknown' };
  const ratio = width / height;
  const g = gcd(width, height);
  const simplified = `${Math.round(width / g)}:${Math.round(height / g)}`;

  let label = simplified;
  if (Math.abs(ratio - 9 / 16) < 0.04) label = '9:16';
  else if (Math.abs(ratio - 16 / 9) < 0.04) label = '16:9';
  else if (Math.abs(ratio - 1) < 0.04) label = '1:1';
  else if (Math.abs(ratio - 4 / 5) < 0.04) label = '4:5';

  let orientation = 'square';
  if (ratio > 1.05) orientation = 'landscape';
  else if (ratio < 0.95) orientation = 'vertical';

  return {
    label,
    ratio: Math.round(ratio * 1000) / 1000,
    orientation,
  };
}

export async function probeVideoFile(filePath, { ffprobePath = 'ffprobe' } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Video file does not exist: ${filePath}`);
  }
  fs.accessSync(filePath, fs.constants.R_OK);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Video file is empty (0 bytes): ${filePath}`);
  }

  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const format = parsed.format || {};

  if (!videoStream) {
    throw new Error('File does not contain a valid video stream');
  }

  const width = Number(videoStream.width) || 0;
  const height = Number(videoStream.height) || 0;
  const durationSec = Number(format.duration || videoStream.duration || 0) || 0;
  const aspect = classifyAspectRatio(width, height);
  const fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);
  const fileSha256 = await computeFileSha256(filePath);

  return {
    filePath,
    fileSizeBytes: stat.size,
    fileSha256,
    containerFormat: String(format.format_name || '').toLowerCase(),
    durationSec: Math.round(durationSec * 100) / 100,
    bitrate: Number(format.bit_rate || 0) || null,
    width,
    height,
    aspectRatio: aspect.label,
    aspectNumeric: aspect.ratio,
    orientation: aspect.orientation,
    videoCodec: String(videoStream.codec_name || '').toLowerCase(),
    pixelFormat: String(videoStream.pix_fmt || '').toLowerCase(),
    fps,
    hasAudio: Boolean(audioStream),
    audioCodec: audioStream ? String(audioStream.codec_name || '').toLowerCase() : null,
    audioSampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    audioChannels: audioStream?.channels ? Number(audioStream.channels) : null,
  };
}

