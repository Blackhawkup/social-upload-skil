# AI Social Media Publisher

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)
[![Antigravity Skill](https://img.shields.io/badge/Antigravity-Global%20Skill-orange.svg)](https://deepmind.google/technologies/gemini/)

A local-first, multi-account **YouTube Data API v3** and **Instagram Graph API** publishing system with an official **Antigravity Global Agent Skill**, a native **MCP Server** (`social-publisher`), local loopback backend, and a modern React management console.

Published videos are analyzed directly from their actual frames and transcripts, allowing Antigravity to craft platform-tailored titles, descriptions, captions, and hashtags—then publish across multiple authorized channels with zero credentials exposed to the cloud, chat logs, or source code.

---

## Table of Contents

- [Architecture](#architecture)
- [Core Features](#core-features)
- [Prerequisites](#prerequisites)
- [Quick Start Installation](#quick-start-installation)
- [Registering with Antigravity / MCP](#registering-with-antigravity--mcp)
- [Platform Setup Guides](#platform-setup-guides)
  - [1. YouTube Data API v3 (Google Cloud Console)](#1-youtube-data-api-v3-google-cloud-console)
  - [2. Instagram Graph API (Meta for Developers)](#2-instagram-graph-api-meta-for-developers)
  - [3. Temporary Cloud Media Staging (Cloudflare R2)](#3-temporary-cloud-media-staging-cloudflare-r2)
- [Usage with Antigravity](#usage-with-antigravity)
- [Publishing Modes](#publishing-modes)
- [MCP Tools Reference](#mcp-tools-reference)
- [CLI Commands Reference](#cli-commands-reference)
- [Security & Credential Vault](#security--credential-vault)
- [Troubleshooting & FAQs](#troubleshooting--faqs)
- [Testing](#testing)
- [License](#license)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Antigravity AI Agent                            │
│  (Discovers video, reads keyframes/narration, crafts tailored copy)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Model Context Protocol (stdio)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Local MCP Server (social-publisher)                   │
│  (17 native agent tools for readiness, auth, discovery, publish)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Loopback IPC (Bearer Authenticated)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Local Backend Service (127.0.0.1:4815)                   │
│  ┌───────────────────────┐  ┌───────────────────────────────────────┐  │
│  │   SQLite Database     │  │ Windows Credential Manager Master Key │  │
│  │  (Accounts, History,  │  │   + AES-256-GCM Per-Account Vault     │  │
│  │   R2 Usage Records)   │  │   (Zero secrets in DB or git)         │  │
│  └───────────────────────┘  └───────────────────────────────────────┘  │
│  ┌───────────────────────┐  ┌───────────────────────────────────────┐  │
│  │  FFmpeg Video Probe   │  │   React Management Dashboard          │  │
│  │  & Validation Engine  │  │   (http://127.0.0.1:4815)                 │  │
│  └───────────────────────┘  └───────────────────────────────────────┘  │
└───────┬───────────────────────────────┬────────────────────────┬───────┘
        │ Resumable Upload              │ Meta Graph API         │ SigV4
        ▼                               ▼                        ▼
┌──────────────┐               ┌─────────────────┐      ┌─────────────────┐
│ YouTube v3   │               │ Instagram Reels │      │ Cloudflare R2   │
│ Data API     │               │ (Creator/Biz)   │      │ (Temp Staging + │
└──────────────┘               └─────────────────┘      │ Auto Deletion)  │
                                                        └─────────────────┘
```

---

## Core Features

- **Global Antigravity Skill**: Canonical agent workflow in `skill/social-media-publisher/` automatically deployed across your agent environments (`~/.gemini/config/skills/`, `~/.gemini/antigravity/skills/`, and `~/.agents/skills/`).
- **YouTube Data API v3**:
  - Official OAuth 2.0 with PKCE (`S256`) and single-use `state` binding.
  - Chunked resumable `videos.insert` uploads with automatic recovery from interrupted connections (HTTP 308 resume).
  - Native YouTube Shorts detection and validation (vertical 9:16 or square `<= 180s`).
  - Privacy controls: `public`, `private`, `unlisted`, or scheduled `publishAt`.
- **Instagram Graph API**:
  - Supports **Meta Unified Login** (`meta_unified_login` via Facebook Login for Business + `config_id`), legacy `facebook_login`, and `instagram_login`.
  - Professional Instagram account support (Creator and Business).
  - Reels publishing with container status polling.
  - Granular visibility: `public` (Feed + Reels), `reels_only` (Reels tab only), `trial_manual` (official Meta Trial Reels hidden from profile and followers until promoted), and private account handling.
- **Cloudflare R2 Temporary Staging Adapter**:
  - Automatic signed upload and generation of time-limited SigV4 presigned URLs for Meta container ingestion.
  - Automatic post-publish deletion + hourly cleanup sweeps.
  - **Local Free-Tier Cost Guard**: Hard application safeguards capping stored data to 8 GB, max video size to 500 MB, 1 concurrent upload, 10 max queued jobs, bounded retries, and local usage logging with 70%/85%/95% warnings.
- **Human-in-the-Loop Review Mode**:
  - Generates metadata, extracts keyframes, and presents full visual draft summaries for user confirmation before publishing.
  - Optional Autopilot Mode for unattended publishing to pre-authorized accounts.
- **Zero-Exposure Credential Vault**:
  - Master encryption key stored in **Windows Credential Manager** (or DPAPI).
  - Per-account AES-256-GCM encrypted vaults with HKDF-SHA256 key derivation and AAD binding.
  - Strict loopback isolation (`127.0.0.1`), CSRF tokens, and automatic regex scrubbing of logs and errors.

---

## Prerequisites

1. **Node.js**: Version **22.0.0** or newer (`node --version`).
2. **FFmpeg & ffprobe**: Required for video inspection, keyframe extraction, and validation.
   - Windows: `winget install Gyan.FFmpeg` or install via Scoop/Chocolatey.
   - Linux: `sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`
3. *(Optional for Instagram Meta Unified Login)* **cloudflared**: Needed only to provide a secure temporary HTTPS tunnel for Meta's OAuth redirect URL during account connection.
   - Windows: `winget install --id Cloudflare.cloudflared -e`
   - macOS: `brew install cloudflare/cloudflare/cloudflared`

---

## Quick Start Installation

```bash
# 1. Clone the repository
git clone https://github.com/Blackhawkup/social-upload-skil.git
cd social-upload-skil

# 2. Install backend dependencies
npm install

# 3. Install and build dashboard UI
npm run dashboard:install
npm run dashboard:build

# 4. Install skill into your global Antigravity/agent directories
npm run install:skill

# 5. Run local test suite (30 automated tests, zero external network calls)
npm test
```

---

## Registering with Antigravity / MCP

To give Antigravity access to the 17 publishing tools, register the `social-publisher` MCP server in your Antigravity configuration file:

**Location**: `%USERPROFILE%\.gemini\config\mcp_config.json` (or `~/.gemini/config/mcp_config.json`)

Add the following to the `mcpServers` object:

```json
{
  "mcpServers": {
    "social-publisher": {
      "command": "node",
      "args": [
        "E:\\YT\\new skill to connect yt and insta, auto upload\\src\\mcp\\server.js"
      ]
    }
  }
}
```
*(Replace the path with your actual clone directory path using escaped backslashes on Windows or forward slashes).*

Then reload your Antigravity session or start a new chat. The tools and global skill will be ready immediately.

---

## Platform Setup Guides

Never paste secrets into chat. Configure credentials locally using either:
- **Interactive CLI Wizard**: `npm run setup`
- **Local Web Console**: `npm run dashboard` (or navigate to `http://127.0.0.1:4815` -> **Setup & Credentials**)

### 1. YouTube Data API v3 (Google Cloud Console)

1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Enable **YouTube Data API v3** under **APIs & Services -> Enabled APIs & services**.
3. Go to **APIs & Services -> OAuth consent screen** (or **Google Auth Platform -> Audience**):
   - User Type: **External**.
   - If Publishing Status is **Testing**, scroll to **Test users**, click **+ Add users**, and enter your Google account email(s).
4. Go to **APIs & Services -> Credentials -> + Create Credentials -> OAuth client ID**:
   - Application type: **Web application**.
   - Name: `AI Social Media Publisher`.
   - **Authorized redirect URIs**: Add this exact URL:
     ```
     http://127.0.0.1:4815/api/accounts/oauth/callback/youtube
     ```
   - Click **Create**.
5. Save the generated **Client ID** and **Client Secret** into `npm run setup` or the local Dashboard.
6. Under the Dashboard **Accounts** tab, click **+ Connect YouTube Channel** to authorize your channel.

### 2. Instagram Graph API (Meta for Developers)

1. Open [Meta for Developers](https://developers.facebook.com/) and create a Meta App (Type: **Business**).
2. Ensure your target Instagram account is switched to a **Professional account (Creator or Business)** in the Instagram mobile app.
3. **Recommended Flow: Meta Unified Login**:
   - In your Meta App dashboard, add **Instagram** -> select **API setup with Unified login**.
   - Copy your **Meta Unified Login Configuration ID (`config_id`)**.
   - Start the temporary callback tunnel in your terminal:
     ```bash
     npm run tunnel
     ```
   - Copy the printed public URL (e.g. `https://<id>.trycloudflare.com/api/accounts/oauth/callback/instagram`) and paste it into Meta's **Valid OAuth Redirect URIs**.
   - In `npm run setup` or Dashboard **Setup & Credentials**, enter:
     - Main Meta App ID & App Secret (from **App settings -> Basic**)
     - Configuration ID (`config_id`)
     - Your HTTPS redirect URI
4. Click **+ Connect Instagram Professional Account** to link your Instagram account.

### 3. Temporary Cloud Media Staging (Cloudflare R2)

Instagram's Graph API requires video files to be hosted at an accessible URL during ingestion. We use a private Cloudflare R2 bucket with short-lived presigned URLs.

1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), navigate to **R2** and click **Create bucket**.
   - Storage class: **Standard**.
   - Public access: **Disabled** (keep private).
2. Go to **R2 -> Manage R2 API Tokens -> Create API Token**:
   - Permissions: **Object Read & Write**.
   - Scope: Specific bucket (choose your private bucket).
3. Save your credentials in `npm run setup` or the Dashboard:
   - Cloudflare Account ID
   - Bucket Name
   - R2 Access Key ID
   - R2 Secret Access Key
4. All uploaded media is automatically deleted as soon as Meta completes processing.

---

## Usage with Antigravity

Because the skill is installed globally, simply talk to Antigravity naturally:

### Discover & Author Metadata
> *"Inspect my latest video in WhiteboardFilms and write YouTube title, description, tags, and hashtags."*

Antigravity calls `find_video`, analyzes the video frames with `analyze_video`, reads the storyboard/script sidecar, and crafts grounded copy.

### Review Mode Publishing (Default)
> *"Publish preview.mp4 to my Blackhawkup YouTube channel as Unlisted."*

Antigravity validates the video specs, presents a full summary card with generated copy, and waits for your explicit approval before uploading.

### Multi-Platform Crossposting
> *"Publish my latest Short to both AI News YouTube and Personal Instagram Reels."*

Antigravity checks both account health statuses, ensures the video complies with YouTube Shorts (`<= 180s`, vertical/square) and Instagram Reels specs, stages the file on Cloudflare R2, uploads to YouTube and Instagram in parallel, monitors processing to 100%, and returns live URLs.

---

## Publishing Modes

| Mode | Behavior | Best Used For |
| :--- | :--- | :--- |
| **Review Mode** *(Default)* | Antigravity inspects frames, drafts copy, and presents a complete review card. Uploads **only** after your explicit confirmation. | Default daily workflow, high-quality review. |
| **Autopilot Mode** | Validates media, generates copy, and publishes automatically to pre-authorized accounts without waiting for approval. | Batch processing and automated background pipelines. |

Toggle modes anytime in the Dashboard **Settings** tab or via MCP `update_publishing_settings`.

---

## MCP Tools Reference

The `social-publisher` MCP server provides 17 tools:

| Category | Tool | Description |
| :--- | :--- | :--- |
| **Settings & Status** | `get_publishing_settings` | Get current publishing mode, default accounts, watch dirs, and masked credential status. |
| | `update_publishing_settings` | Update publish mode (`review`/`autopilot`), default accounts, or privacy defaults. |
| **Account Management** | `list_social_accounts` | List connected YouTube and Instagram accounts with masked metadata. |
| | `get_social_account_status` | Perform live token health and reachability checks for an account. |
| | `connect_social_account` | Generate official OAuth authorization URLs for YouTube or Instagram. |
| | `refresh_social_account_token`| Manually trigger OAuth token refresh. |
| **Media Discovery** | `find_video` | Search output folders (Flow MCP, WhiteboardFilms, StickFilms, Videos) for videos. |
| | `analyze_video` | Extract keyframes, audio waveform, and sidecar script context. |
| | `validate_video` | Validate codec, aspect ratio, duration, and platform specifications (Shorts/Reels). |
| **Metadata Authoring** | `generate_social_metadata` | Author or save Antigravity-grounded captions, tags, and hashtags. |
| **Publishing Pipeline** | `publish_to_youtube` | Upload a video to YouTube with privacy, category, tags, and Shorts support. |
| | `publish_to_instagram` | Upload and publish an Instagram Reel with visibility and cover selection. |
| | `publish_to_multiple_accounts` | Fan out a video to multiple YouTube and Instagram accounts concurrently. |
| | `approve_publishing_job` | Approve and execute a pending Review Mode job. |
| **Monitoring & History**| `get_publishing_status` | Check live upload percentage and container processing status. |
| | `get_publishing_history` | Retrieve past publishing jobs and failure details. |
| | `retry_failed_publication` | Safely retry only the failed destination(s) of a past job. |
| **Storage & Cost Guard**| `get_r2_usage_status` | Inspect Cloudflare R2 bucket storage usage, cost limits, and run cleanup sweeps. |

---

## CLI Commands Reference

| Command | Description |
| :--- | :--- |
| `npm start` | Start the local loopback backend server (`http://127.0.0.1:4815`). |
| `npm run setup` | Launch interactive terminal credential configuration wizard. |
| `npm run dashboard` | Generate single-use launch link and open local React management console. |
| `npm run tunnel` | Launch Cloudflare tunnel for Meta OAuth redirect callback. |
| `npm run install:skill` | Sync canonical skill files to Antigravity global agent skill directories. |
| `npm test` | Run complete Node.js test suite (`tests/*.test.js`). |
| `npm run dashboard:build` | Compile dashboard production assets via Vite (`dashboard/dist/`). |
| `npm run dashboard:dev` | Start dashboard Vite development server on port 5173 with proxy. |

---

## Security & Credential Vault

1. **Strict Loopback Binding**: The Express backend binds strictly to `127.0.0.1:4815`. Cross-origin browser requests and non-loopback Host headers are rejected.
2. **Master Key Isolation**: Application encryption uses AES-256-GCM. The master encryption key is managed by **Windows Credential Manager** (under `AntigravitySocialPublisher:MasterKey`) and never touches the database.
3. **Per-Account AAD Isolation**: Each account's credentials live in a separate `.enc` file encrypted with an HKDF-SHA256 derived key bound to account ID and platform.
4. **Zero-Secret AI Context**: Neither Antigravity nor API responses ever receive raw credentials, tokens, or private keys. All sensitive strings are scrubbed via proactive redaction filters.
5. **Session Security**: Dashboard sessions use `HttpOnly; SameSite=Strict` cookies and cryptographically signed per-session CSRF tokens.

---

## Troubleshooting & FAQs

### Error 400: `redirect_uri_mismatch` on Google OAuth
- Ensure your Google Cloud OAuth Client ID is of type **Web application** (not Desktop app).
- Check that `http://127.0.0.1:4815/api/accounts/oauth/callback/youtube` is added under **Authorized redirect URIs** (do not use `localhost` or a trailing slash).
- Click **Save** in Google Cloud Console and wait 1–5 minutes for propagation.

### Error 403: `access_denied` on Google OAuth
- If your Google OAuth consent screen is in **Testing** status, Google blocks unlisted users. Go to **OAuth consent screen -> Audience -> Test users**, click **+ Add users**, and add your Google account email.

### Meta Unified Login Redirect URL Rejected
- Meta rejects `http://127.0.0.1` and `localhost` in Meta Unified Login mode. Run `npm run tunnel` to obtain a secure HTTPS Cloudflare tunnel URL, and register that in Meta for Developers.

### Video fails YouTube Shorts validation
- YouTube Shorts must be vertical (9:16) or square (1:1) with a duration of 180 seconds or less. Landscape videos are uploaded as standard YouTube videos, not Shorts.

---

## Testing

The project includes an end-to-end test suite utilizing Node.js native test runner and mocked platform endpoints:

```bash
npm test
```

All 30 automated tests verify:
- Cryptographic vault encryption, master key isolation, and Windows Credential Manager integration.
- YouTube resumable upload recovery and Shorts aspect ratio enforcement.
- Instagram Reels validation, Trial Reels, and Meta Unified Login token exchanges.
- Cloudflare R2 SigV4 URL signing, bucket storage caps (8 GB limit), and cost guard sweeps.
- Host header spoofing defense, CSRF mitigation, and IPC token authentication.

---

## License

This project is licensed under the [MIT License](LICENSE).
