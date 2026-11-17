import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from '../config/env.js';
import { BackendIpcClient } from '../mcp/server.js';

function commandExists(cmd) {
  const probe = spawnSync(cmd, ['--version'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return !probe.error && probe.status === 0;
}

const VALID_MODES = new Set(['meta_unified_login', 'facebook_login', 'instagram_login']);

function parseModeArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--mode=')) {
      const m = arg.slice('--mode='.length).trim();
      return VALID_MODES.has(m) ? m : null;
    }
    if (arg === '--mode' && args[i + 1]) {
      const m = args[i + 1].trim();
      return VALID_MODES.has(m) ? m : null;
    }
  }
  return null;
}

async function runTunnel() {
  const args = process.argv.slice(2);
  const autoSave = !args.includes('--no-save');
  const explicitMode = parseModeArg(args);
  const config = loadConfig();
  const port = config.port || 4815;
  const localUrl = `http://127.0.0.1:${port}`;

  if (!commandExists('cloudflared')) {
    console.error('\n[cloudflared not found]');
    console.error('Meta Unified Login and Instagram Login reject http://127.0.0.1 and require a public https:// callback URL.');
    console.error('Install the official Cloudflare Tunnel client once on Windows:\n');
    console.error('  winget install --id Cloudflare.cloudflared -e\n');
    console.error('Then open a new terminal and re-run:\n');
    console.error('  npm run tunnel\n');
    process.exit(1);
  }

  const client = new BackendIpcClient({ autoStart: true });
  await client.ensureBackendRunning();
  const currentSetup = await client.request('GET', '/api/setup/status').catch(() => null);
  const activeMode = explicitMode || currentSetup?.instagram?.loginMode || config.instagram.loginMode || 'meta_unified_login';

  console.log(`\nStarting Cloudflare Quick Tunnel -> ${localUrl} ...`);
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', localUrl], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;
  const handleChunk = async (chunk) => {
    const text = chunk.toString('utf8');
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (match && !announced) {
      announced = true;
      const redirectUri = `${match[0]}/api/accounts/oauth/callback/instagram`;

      if (autoSave) {
        try {
          await client.request('POST', '/api/setup/credentials', {
            instagram: {
              ...(explicitMode ? { loginMode: explicitMode } : {}),
              redirectUri,
            },
          });
          console.log(
            `\n[Saved locally] Saved HTTPS Redirect URI (keeping Instagram OAuth mode: "${activeMode}").`
          );
        } catch (err) {
          console.error(`\n[Warning] Could not auto-save Redirect URI: ${err.message}`);
        }
      }

      console.log('\n==============================================================');
      console.log('Instagram HTTPS Redirect URL (copy into Meta Developer Portal):');
      console.log(`\n  ${redirectUri}\n`);
      console.log('Next steps:');
      if (activeMode === 'instagram_login') {
        console.log('  1. In Meta Developer Portal -> Instagram -> API setup with Instagram login:');
        console.log('     Paste the URL above into "Redirect URL" and click Save.');
        console.log('  2. Save your Instagram App ID & Instagram App Secret in Dashboard -> Setup & Credentials.');
      } else {
        console.log('  1. In Meta Developer Portal -> Instagram -> API setup with Unified login:');
        console.log('     Paste the URL above into "Redirect URL" and click Save.');
        console.log('     (Also ensure it is allowed in Facebook Login for Business -> Valid OAuth Redirect URIs.)');
        console.log('  2. Save your Meta App ID & Meta App Secret (from App settings -> Basic)');
        console.log('     and your Configuration ID (config_id) in Dashboard -> Setup & Credentials.');
        console.log('     Do NOT paste generated access tokens into App ID or App Secret.');
      }
      console.log('  3. Click "+ Connect Instagram Professional Account" in Dashboard -> Accounts');
      console.log('     (or ask Antigravity to generate your Instagram login link).');
      console.log('  4. Once Instagram shows "Connected!", press Ctrl+C here to close the tunnel.');
      console.log('==============================================================\n');
    }
  };

  child.stdout.on('data', (chunk) => {
    void handleChunk(chunk);
  });
  child.stderr.on('data', (chunk) => {
    void handleChunk(chunk);
  });

  const shutdown = () => {
    if (!child.killed) {
      child.kill('SIGINT');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', (code) => {
    if (!announced) {
      console.error(`cloudflared exited before producing a tunnel URL (code ${code ?? 'unknown'}).`);
      process.exit(code || 1);
    }
    process.exit(code || 0);
  });
}

runTunnel().catch((err) => {
  console.error('Tunnel helper failed:', err.message);
  process.exit(1);
});

