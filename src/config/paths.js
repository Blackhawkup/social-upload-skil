import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveRuntimePaths(overrides = {}) {
  const baseDir = overrides.baseDir ? path.resolve(overrides.baseDir) : PROJECT_ROOT;
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : path.join(baseDir, 'data');
  const credentialsDir = overrides.credentialsDir
    ? path.resolve(overrides.credentialsDir)
    : path.join(baseDir, 'credentials');
  const secretsDir = overrides.secretsDir
    ? path.resolve(overrides.secretsDir)
    : path.join(baseDir, 'secrets');
  const tempDir = overrides.tempDir ? path.resolve(overrides.tempDir) : path.join(baseDir, 'temp');
  const logsDir = overrides.logsDir ? path.resolve(overrides.logsDir) : path.join(baseDir, 'logs');
  const dbPath = overrides.dbPath ? path.resolve(overrides.dbPath) : path.join(dataDir, 'publisher.db');
  const dashboardDistDir = path.join(PROJECT_ROOT, 'dashboard', 'dist');

  return {
    projectRoot: PROJECT_ROOT,
    baseDir,
    dataDir,
    credentialsDir,
    secretsDir,
    tempDir,
    framesDir: path.join(tempDir, 'frames'),
    transcodeDir: path.join(tempDir, 'transcoded'),
    mockStorageDir: path.join(tempDir, 'mock-cloud-storage'),
    logsDir,
    dbPath,
    dashboardDistDir,
  };
}

export function ensureRuntimeDirectories(paths) {
  const dirs = [
    paths.dataDir,
    paths.credentialsDir,
    paths.secretsDir,
    paths.tempDir,
    paths.framesDir,
    paths.transcodeDir,
    paths.logsDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDefaultVideoWatchDirs() {
  return [
    expandHome('~/flow-mcp-out'),
    expandHome('~/WhiteboardFilms/films'),
    expandHome('~/StickFilms/films'),
    expandHome('~/Videos'),
  ];
}

