import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverVideos } from '../src/media/discovery.js';
import { probeVideoFile } from '../src/media/probe.js';
import { validateForInstagramReels, validateForYouTube } from '../src/media/validator.js';
import { createOptimizedTempCopy, cleanupTempFile } from '../src/media/transcoder.js';
import { extractKeyframes, extractProjectContext } from '../src/media/extractor.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function generateTestVideo(outPath, { width = 1080, height = 1920, duration = 4, vCodec = 'libx264', aCodec = 'aac' } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=navy:s=${width}x${height}:d=${duration}:r=30`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${duration}`,
      '-c:v',
      vCodec,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      aCodec,
      '-shortest',
      outPath,
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
}

test('Video discovery, ffprobe inspection, sidecar context extraction, and keyframe extraction', async () => {
  const dir = makeTempDir('smp-media-');
  try {
    const projectDir = path.join(dir, 'WhiteboardFilms', 'films', 'ai-agents-explained');
    const outDir = path.join(projectDir, 'out');
    const videoPath = path.join(outDir, 'ai-agents-explained.mp4');
    const previewPath = path.join(outDir, 'preview.mp4');

    generateTestVideo(previewPath, { width: 720, height: 1280, duration: 4 });
    generateTestVideo(videoPath, { width: 1080, height: 1920, duration: 4 });

    fs.writeFileSync(
      path.join(projectDir, 'film.json'),
      JSON.stringify({ title: 'AI Agents Explained', language: 'en' })
    );
    fs.writeFileSync(
      path.join(projectDir, 'script.md'),
      '# Narration\n\nAI agents combine reasoning with tool execution to complete complex workflows automatically.'
    );
    fs.writeFileSync(path.join(projectDir, 'storyboard.md'), 'Scene 1: Robot diagram');

    const discovered = discoverVideos({ watchDirs: [path.join(dir, 'WhiteboardFilms', 'films')], limit: 5 });
    assert.ok(discovered.length >= 1);
    assert.equal(discovered[0].filePath, videoPath);
    assert.equal(discovered[0].sourceWorkflow, 'whiteboard-explainer');

    const probe = await probeVideoFile(videoPath);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.equal(probe.aspectRatio, '9:16');
    assert.equal(probe.orientation, 'vertical');
    assert.equal(probe.videoCodec, 'h264');
    assert.equal(probe.audioCodec, 'aac');
    assert.ok(probe.durationSec >= 3.8 && probe.durationSec <= 4.5);

    const ctx = extractProjectContext(videoPath, projectDir);
    assert.equal(ctx.titleHint, 'AI Agents Explained');
    assert.ok(ctx.scriptText.includes('AI agents combine reasoning'));

    const frames = await extractKeyframes(videoPath, probe.durationSec, {
      framesDir: path.join(dir, 'frames'),
      videoIdOrHash: probe.fileSha256,
      count: 3,
    });
    assert.equal(frames.length, 3);
    assert.ok(fs.existsSync(frames[0].path));
    assert.equal(typeof frames[0].timestampSec, 'number');
    assert.equal(frames[0].thumbOffsetMs, Math.round(frames[0].timestampSec * 1000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Platform validation enforces YouTube Shorts rules (rejects landscape short videos) and Instagram Reels specs + non-destructive transcode', async () => {
  const dir = makeTempDir('smp-val-');
  try {
    const verticalMp4 = path.join(dir, 'vertical.mp4');
    const horizontalMp4 = path.join(dir, 'horizontal.mp4');
    const tooShortMp4 = path.join(dir, 'too-short.mp4');
    const webmClip = path.join(dir, 'clip.webm');

    generateTestVideo(verticalMp4, { width: 540, height: 960, duration: 4 });
    generateTestVideo(horizontalMp4, { width: 640, height: 360, duration: 5 });
    generateTestVideo(tooShortMp4, { width: 540, height: 960, duration: 1 });
    generateTestVideo(webmClip, { width: 540, height: 960, duration: 4, vCodec: 'libvpx', aCodec: 'libvorbis' });

    const vProbe = await probeVideoFile(verticalMp4);
    const hProbe = await probeVideoFile(horizontalMp4);
    const sProbe = await probeVideoFile(tooShortMp4);
    const wProbe = await probeVideoFile(webmClip);

    // 9:16 4s qualifies as YouTube Short and Instagram Reel
    const ytShortOk = validateForYouTube(vProbe, { asShort: true });
    assert.equal(ytShortOk.valid, true);
    assert.equal(ytShortOk.qualifiesAsShort, true);

    const igOk = validateForInstagramReels(vProbe);
    assert.equal(igOk.valid, true);
    assert.equal(igOk.needsTranscode, false);

    // 16:9 5s MUST NOT qualify as a YouTube Short
    const ytHorizontalAsShort = validateForYouTube(hProbe, { asShort: true });
    assert.equal(ytHorizontalAsShort.qualifiesAsShort, false);
    assert.equal(ytHorizontalAsShort.valid, false);
    assert.ok(ytHorizontalAsShort.errors.some((e) => /does not qualify as a YouTube Short/i.test(e)));

    // 1s clip fails Instagram 3s minimum
    const igTooShort = validateForInstagramReels(sProbe);
    assert.equal(igTooShort.valid, false);

    // Individual video > 500 MB fails Instagram Reels R2 free-tier validation
    const igOversized = validateForInstagramReels({
      ...vProbe,
      fileSizeBytes: 500 * 1024 * 1024 + 1024,
    });
    assert.equal(igOversized.valid, false);
    assert.ok(igOversized.errors.some((e) => /500 MB/i.test(e)));

    // .webm flags needsTranscode for Instagram & non-destructive temp copy produces valid H.264/AAC MP4
    const igWebm = validateForInstagramReels(wProbe);
    assert.equal(igWebm.needsTranscode, true);
    const originalHashBefore = wProbe.fileSha256;

    const optimized = await createOptimizedTempCopy(webmClip, {
      transcodeDir: path.join(dir, 'transcoded'),
      targetPlatform: 'instagram',
    });
    try {
      const optProbe = await probeVideoFile(optimized);
      assert.equal(optProbe.videoCodec, 'h264');
      assert.equal(optProbe.audioCodec, 'aac');
      assert.equal(validateForInstagramReels(optProbe).needsTranscode, false);

      // Verify original file untouched
      const wProbeAfter = await probeVideoFile(webmClip);
      assert.equal(wProbeAfter.fileSha256, originalHashBefore);
    } finally {
      cleanupTempFile(optimized);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

