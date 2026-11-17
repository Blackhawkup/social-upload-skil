import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function stripSrtFormatting(text) {
  return text
    .replace(/^\d+\s*$/gm, '')
    .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g, '')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // Ignore malformed sidecar JSON
  }
  return null;
}

function readTextSafe(filePath, maxChars = 12000) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').slice(0, maxChars).trim();
    }
  } catch {
    // Ignore unreadable sidecar text
  }
  return '';
}

export function extractProjectContext(videoPath, projectDir) {
  const result = {
    titleHint: '',
    languageHint: '',
    scriptText: '',
    transcriptText: '',
    storyboardNotes: '',
    sidecarFiles: [],
  };

  const dirsToCheck = [...new Set([path.dirname(videoPath), projectDir].filter(Boolean))];
  const videoStem = path.basename(videoPath, path.extname(videoPath));

  for (const dir of dirsToCheck) {
    const filmJson = readJsonSafe(path.join(dir, 'film.json'));
    if (filmJson) {
      result.sidecarFiles.push(path.join(dir, 'film.json'));
      if (filmJson.title && !result.titleHint) result.titleHint = String(filmJson.title);
      if (filmJson.language && !result.languageHint) result.languageHint = String(filmJson.language);
      const filmNotes = [filmJson.topic, filmJson.idea, filmJson.description]
        .filter(Boolean)
        .map((s) => String(s).trim())
        .join('\n');
      if (filmNotes && !result.storyboardNotes) {
        result.storyboardNotes = filmNotes.slice(0, 4000);
      }
    }

    const scriptMd = readTextSafe(path.join(dir, 'script.md'));
    if (scriptMd && !result.scriptText) {
      result.sidecarFiles.push(path.join(dir, 'script.md'));
      result.scriptText = scriptMd.replace(/^#\s*Narration\s*/i, '').trim();
    }

    const scriptJson = readJsonSafe(path.join(dir, 'script.json'));
    if (scriptJson && !result.scriptText) {
      result.sidecarFiles.push(path.join(dir, 'script.json'));
      if (Array.isArray(scriptJson)) {
        result.scriptText = scriptJson.map((entry) => (typeof entry === 'string' ? entry : entry.text || entry.line || '')).filter(Boolean).join(' ');
      } else if (typeof scriptJson === 'object') {
        result.scriptText = String(scriptJson.script || scriptJson.text || '');
      }
    }

    const storyboardMd = readTextSafe(path.join(dir, 'storyboard.md'), 6000);
    if (storyboardMd && !result.storyboardNotes) {
      result.sidecarFiles.push(path.join(dir, 'storyboard.md'));
      result.storyboardNotes = storyboardMd;
    }

    const beatsMd = readTextSafe(path.join(dir, 'beats.md'), 6000);
    if (beatsMd && !result.storyboardNotes) {
      result.sidecarFiles.push(path.join(dir, 'beats.md'));
      result.storyboardNotes = beatsMd;
    }

    // Check voice/words.json or voice/voice.json (WhiteboardFilms / StickFilms)
    const wordsJson = readJsonSafe(path.join(dir, 'voice', 'words.json'));
    if (wordsJson && !result.transcriptText) {
      result.sidecarFiles.push(path.join(dir, 'voice', 'words.json'));
      const wordsArr = Array.isArray(wordsJson) ? wordsJson : wordsJson.words || [];
      const joined = wordsArr.map((w) => (typeof w === 'string' ? w : w.word || w.text || '')).filter(Boolean).join(' ');
      if (joined) result.transcriptText = joined;
    }

    const voiceJson = readJsonSafe(path.join(dir, 'voice', 'voice.json'));
    if (voiceJson && !result.transcriptText) {
      result.sidecarFiles.push(path.join(dir, 'voice', 'voice.json'));
      if (Array.isArray(voiceJson.lines)) {
        result.transcriptText = voiceJson.lines.map((l) => l.text || '').filter(Boolean).join(' ');
      } else if (voiceJson.text) {
        result.transcriptText = String(voiceJson.text);
      }
    }

    // Check matching SRT / VTT / TXT / MD sidecar files next to video
    for (const ext of ['.srt', '.vtt', '.txt']) {
      const candidate = path.join(dir, `${videoStem}${ext}`);
      const raw = readTextSafe(candidate);
      if (raw && !result.transcriptText) {
        result.sidecarFiles.push(candidate);
        result.transcriptText = ext === '.txt' ? raw : stripSrtFormatting(raw);
      }
    }

    for (const noteName of ['caption.txt', 'description.txt', 'prompt.txt', `${videoStem}.md`]) {
      const candidate = path.join(dir, noteName);
      const raw = readTextSafe(candidate, 4000);
      if (raw && !result.storyboardNotes) {
        result.sidecarFiles.push(candidate);
        result.storyboardNotes = raw;
      }
    }
  }

  return result;
}

export async function extractKeyframes(
  videoPath,
  durationSec,
  { framesDir, videoIdOrHash, ffmpegPath = 'ffmpeg', count = 5 }
) {
  const outDir = path.join(framesDir, String(videoIdOrHash).slice(0, 24));
  fs.mkdirSync(outDir, { recursive: true });

  const safeDuration = Math.max(1, durationSec || 5);
  const frameCount = Math.min(Math.max(2, count), 8);
  const extracted = [];

  for (let i = 0; i < frameCount; i++) {
    // Sample evenly between 8% and 92% of the video to avoid pure blank fade-in/fade-out frames
    const pct = 0.08 + (0.84 * i) / Math.max(1, frameCount - 1);
    const timestamp = Math.max(0.1, Math.min(safeDuration - 0.1, safeDuration * pct)).toFixed(2);
    const timestampSec = Number(timestamp);
    const thumbOffsetMs = Math.round(timestampSec * 1000);
    const framePath = path.join(outDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`);

    try {
      await execFileAsync(
        ffmpegPath,
        ['-y', '-ss', String(timestamp), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-vf', 'scale=768:-2', framePath],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      );
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
        extracted.push({
          timestampSec,
          thumbOffsetMs,
          path: framePath,
        });
      }
    } catch {
      // Continue extracting remaining timestamps even if one seek fails
    }
  }

  return extracted;
}

export async function transcribeWithWhisperCli(
  videoPath,
  { tempDir, ffmpegPath = 'ffmpeg', whisperCliPath = '', whisperModelPath = '' }
) {
  if (!whisperCliPath || !fs.existsSync(whisperCliPath)) {
    return '';
  }

  const wavPath = path.join(tempDir, `audio_${Date.now()}.wav`);
  try {
    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', wavPath],
      { windowsHide: true }
    );
    const args = [];
    if (whisperModelPath) args.push('-m', whisperModelPath);
    args.push('-f', wavPath, '--no-timestamps');
    const { stdout } = await execFileAsync(whisperCliPath, args, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  } finally {
    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch {
      // Ignore cleanup error
    }
  }
}

