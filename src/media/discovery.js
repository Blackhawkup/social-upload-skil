import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'incoming',
  'temp',
  'tmp',
  'art',
  'voice',
  'frames',
  'credentials',
  'secrets',
  'data',
  'logs',
]);

export function isPathInsideAnyDir(targetPath, blockedDirs = []) {
  if (!targetPath || !Array.isArray(blockedDirs) || blockedDirs.length === 0) return false;
  const resolvedTarget = path.resolve(targetPath);
  const cmpTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  for (const dir of blockedDirs) {
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    const cmpDir = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
    if (cmpTarget === cmpDir || cmpTarget.startsWith(cmpDir + path.sep)) {
      return true;
    }
  }
  return false;
}

export function isSupportedVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function detectWorkflowContext(videoPath) {
  const normalized = path.resolve(videoPath);
  const lower = normalized.toLowerCase();
  const dir = path.dirname(normalized);
  const parentDir = path.dirname(dir);

  if (lower.includes('whiteboardfilms') || fs.existsSync(path.join(parentDir, 'storyboard.md'))) {
    return { sourceWorkflow: 'whiteboard-explainer', projectDir: parentDir };
  }
  if (lower.includes('stickfilms') || fs.existsSync(path.join(parentDir, 'beats.md'))) {
    return { sourceWorkflow: 'stick-film', projectDir: parentDir };
  }
  if (lower.includes('flow-mcp-out')) {
    return { sourceWorkflow: 'flow-mcp', projectDir: dir };
  }
  if (
    fs.existsSync(path.join(dir, 'remotion.config.ts')) ||
    fs.existsSync(path.join(dir, 'remotion.config.js')) ||
    fs.existsSync(path.join(parentDir, 'remotion.config.ts')) ||
    fs.existsSync(path.join(parentDir, 'remotion.config.js')) ||
    lower.includes('remotion')
  ) {
    const projectDir =
      fs.existsSync(path.join(parentDir, 'package.json')) ? parentDir : dir;
    return { sourceWorkflow: 'remotion', projectDir };
  }
  return { sourceWorkflow: 'manual', projectDir: dir };
}

function walkVideos(rootDir, maxDepth = 4, currentDepth = 0, out = []) {
  if (!rootDir || !fs.existsSync(rootDir) || currentDepth > maxDepth) return out;

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
        walkVideos(full, maxDepth, currentDepth + 1, out);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > 0) {
            const ctx = detectWorkflowContext(full);
            const isPreview = /^preview\./i.test(entry.name);
            const inOutDir = path.basename(path.dirname(full)).toLowerCase() === 'out';
            out.push({
              filePath: full,
              fileName: entry.name,
              fileSizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              modifiedMs: stat.mtimeMs,
              sourceWorkflow: ctx.sourceWorkflow,
              projectDir: ctx.projectDir,
              isPreview,
              inOutDir,
            });
          }
        } catch {
          // Ignore unreadable file during scan
        }
      }
    }
  }
  return out;
}

export function discoverVideos({
  explicitPath = null,
  query = null,
  watchDirs = [],
  blockedDirs = [],
  limit = 10,
} = {}) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (isPathInsideAnyDir(resolved, blockedDirs)) {
      throw new Error('Access to internal credentials, secrets, data, or logs directories is blocked.');
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Video file not found at explicit path: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const dirVideos = walkVideos(resolved, 4);
      dirVideos.sort((a, b) => b.modifiedMs - a.modifiedMs);
      return dirVideos.slice(0, limit);
    }
    if (!isSupportedVideoFile(resolved)) {
      throw new Error(`Unsupported file type at explicit path: ${path.basename(resolved)}`);
    }
    const ctx = detectWorkflowContext(resolved);
    return [
      {
        filePath: resolved,
        fileName: path.basename(resolved),
        fileSizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        modifiedMs: stat.mtimeMs,
        sourceWorkflow: ctx.sourceWorkflow,
        projectDir: ctx.projectDir,
        isPreview: /^preview\./i.test(path.basename(resolved)),
        inOutDir: path.basename(path.dirname(resolved)).toLowerCase() === 'out',
      },
    ];
  }

  let candidates = [];
  for (const dir of watchDirs) {
    if (!isPathInsideAnyDir(dir, blockedDirs)) {
      walkVideos(dir, 4, 0, candidates);
    }
  }

  // Deduplicate by resolved lowercase path on Windows
  const uniqueMap = new Map();
  for (const item of candidates) {
    const key = path.resolve(item.filePath).toLowerCase();
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }
  candidates = [...uniqueMap.values()];

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    candidates = candidates.filter(
      (c) =>
        c.fileName.toLowerCase().includes(q) ||
        c.filePath.toLowerCase().includes(q) ||
        (c.projectDir && path.basename(c.projectDir).toLowerCase().includes(q))
    );
  }

  // Sort newest first; when two files are in the same project out/ folder within 2 min, prefer final over preview.mp4
  candidates.sort((a, b) => {
    if (a.projectDir && b.projectDir && a.projectDir === b.projectDir && a.isPreview !== b.isPreview) {
      if (Math.abs(a.modifiedMs - b.modifiedMs) < 120_000) {
        return a.isPreview ? 1 : -1;
      }
    }
    return b.modifiedMs - a.modifiedMs;
  });

  return candidates.slice(0, limit);
}

