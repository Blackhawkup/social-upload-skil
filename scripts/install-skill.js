import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');
const SOURCE_SKILL_DIR = path.join(PROJECT_ROOT, 'skill', 'social-media-publisher');
const SKILL_NAME = 'social-media-publisher';
const HOME = os.homedir();

const TARGETS = [
  { agent: 'Antigravity Config (~/.gemini/config/skills)', marker: path.join(HOME, '.gemini', 'config'), destRoot: path.join(HOME, '.gemini', 'config', 'skills') },
  { agent: 'Antigravity Global (~/.gemini/antigravity/skills)', marker: path.join(HOME, '.gemini', 'antigravity'), destRoot: path.join(HOME, '.gemini', 'antigravity', 'skills') },
  { agent: 'Open Standard Agents (~/.agents/skills)', marker: path.join(HOME, '.agents'), destRoot: path.join(HOME, '.agents', 'skills') },
  { agent: 'Gemini CLI (~/.gemini/skills)', marker: path.join(HOME, '.gemini'), destRoot: path.join(HOME, '.gemini', 'skills') },
  { agent: 'Claude Code (~/.claude/skills)', marker: path.join(HOME, '.claude'), destRoot: path.join(HOME, '.claude', 'skills') },
  { agent: 'Codex (~/.codex/skills)', marker: path.join(HOME, '.codex'), destRoot: path.join(HOME, '.codex', 'skills') },
  { agent: 'Cursor (~/.cursor/skills)', marker: path.join(HOME, '.cursor'), destRoot: path.join(HOME, '.cursor', 'skills') },
  { agent: 'OpenCode (~/.config/opencode/skills)', marker: path.join(HOME, '.config', 'opencode'), destRoot: path.join(HOME, '.config', 'opencode', 'skills') },
];

export function copySkillToDir(srcDir, destRoot, skillName = SKILL_NAME) {
  const dest = path.join(destRoot, skillName);
  if (path.resolve(dest) === path.resolve(srcDir)) {
    return dest;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  return dest;
}

function main() {
  const args = process.argv.slice(2);
  const installAll = args.includes('--all');

  if (!fs.existsSync(path.join(SOURCE_SKILL_DIR, 'SKILL.md'))) {
    throw new Error(`Skill source not found at ${SOURCE_SKILL_DIR}`);
  }

  console.log(`\nInstalling global "${SKILL_NAME}" skill from:\n  ${SOURCE_SKILL_DIR}\n`);
  const installed = [];

  for (const target of TARGETS) {
    if (installAll || fs.existsSync(target.marker)) {
      const dest = copySkillToDir(SOURCE_SKILL_DIR, target.destRoot);
      installed.push({ agent: target.agent, dest });
      console.log(`  [OK] ${target.agent} -> ${dest}`);
    }
  }

  if (installed.length === 0) {
    const fallbackDest = copySkillToDir(SOURCE_SKILL_DIR, path.join(HOME, '.agents', 'skills'));
    installed.push({ agent: 'Open Standard (~/.agents/skills)', dest: fallbackDest });
    console.log(`  [OK] Fallback -> ${fallbackDest}`);
  }

  const mcpCfgPath = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
  if (fs.existsSync(mcpCfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpCfgPath, 'utf8'));
      const hasMcp = Boolean(parsed?.mcpServers?.['social-publisher']);
      console.log(
        hasMcp
          ? `\nMCP Server "social-publisher" is registered in ${mcpCfgPath}.`
          : `\nWarning: "social-publisher" MCP server is not registered in ${mcpCfgPath}.`
      );
    } catch {
      // Ignore non-critical inspection warning
    }
  }

  console.log('\nDone. Open a new Antigravity chat or reload MCP servers to pick up updated skill and tool schemas.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    main();
  } catch (err) {
    console.error(`Skill install failed: ${err.message}`);
    process.exit(1);
  }
}

