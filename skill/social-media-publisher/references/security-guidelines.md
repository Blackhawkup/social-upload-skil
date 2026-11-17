# Credential Security & Login Walkthrough

## Secret Isolation Guarantees

- **Zero secrets in chat or AI context**: Never ask the user to paste OAuth secrets, API keys, passwords, or tokens into Antigravity.
- **Encrypted local storage**:
  - Master AES-256-GCM encryption key lives in **Windows Credential Manager** (`AntigravitySocialPublisher:MasterKey`, completely separate from SQLite).
  - Each connected social media account has its own isolated encrypted vault file (`credentials/<credential_ref>.enc`), encrypted using `AES-256-GCM` + `HKDF-SHA256` per-account derived key + AAD bound to `(accountId, platform, credentialRef)`.
  - App-level credentials (Google OAuth Client ID/Secret, Meta App ID/Secret, Cloudflare R2 keys, optional external AI API keys) live in separate encrypted provider files or local `.env` and only surface via masked indicators (`********1234` / boolean `configured` flags). Note: **external LLM API keys are optional** when publishing through Antigravity, because Antigravity itself analyzes frames/transcripts and authors captions and hashtags!
- **Loopback & IPC security**:
  - Express backend binds strictly to `127.0.0.1:4815` with Host-header & CORS enforcement.
  - Antigravity MCP authenticates via an isolated IPC Bearer token stored in Windows Credential Manager.
  - Local dashboard uses `HttpOnly; SameSite=Strict` session cookies + `X-CSRF-Token` validation.
  - Official OAuth 2.0 flows enforce single-use cryptographic `state` validation and PKCE (`S256`) for Google.

## Exact User Login & Setup Steps (Once Per Environment / Account)

When `get_publishing_settings` or `list_social_accounts` shows missing credentials or no connected accounts, walk the user through these exact steps cleanly:

### Part 1: One-Time App Credentials (Local Only — Never In Chat)
1. Open the local Dashboard (`npm run dashboard` inside `e:\YT\new skill to connect yt and insta, auto upload`, or visit `http://127.0.0.1:4815` -> **Setup & Credentials**) OR run `npm run setup`:
   - **YouTube**: Paste Google Cloud **OAuth 2.0 Web Client ID & Secret** (Authorized Redirect URI: `http://127.0.0.1:4815/api/accounts/oauth/callback/youtube`).
   - **Instagram**:
     - For **`meta_unified_login` (recommended — Meta API setup with Unified login / Facebook Login for Business)**:
       1. In Meta Developer Portal -> **App settings -> Basic**, copy the main **Meta App ID** and **Meta App Secret** (never paste a generated `EAA...`/`IGAA...` access token into App ID or App Secret).
       2. In Meta Developer Portal -> **Instagram -> API setup with Unified login**, copy the **Configuration ID (`config_id`)** and confirm `instagram_basic` and `instagram_content_publish` are included in the configuration.
       3. Meta requires a public `https://` Redirect URL. Run `npm run tunnel` (uses `cloudflared` quick tunnel -> `https://<subdomain>.trycloudflare.com/api/accounts/oauth/callback/instagram`, auto-saved locally without clobbering `meta_unified_login`), and paste that exact HTTPS URL into Meta (**Redirect URL** -> Save). Only the matching `GET /api/accounts/oauth/callback/instagram` request is allowed through the tunnel and immediately bounces back to `127.0.0.1:4815`.
       4. Save **Meta App ID**, **Meta App Secret**, **Configuration ID (`config_id`)**, and the HTTPS Redirect URI in **Setup & Credentials**.
     - For legacy **`facebook_login`**: Link your Professional IG account to a Facebook Page, use your main **Meta App ID & App Secret** (**App settings -> Basic**) while the app is in Development Mode, and use `http://127.0.0.1:4815/api/accounts/oauth/callback/instagram` (or a custom HTTPS Redirect URI).
     - For legacy **`instagram_login`**: Run `npm run tunnel -- --mode=instagram_login`, paste the HTTPS Redirect URL into **Instagram -> API setup with Instagram login -> Redirect URL**, and save your **Instagram App ID & Instagram App Secret** in **Setup & Credentials**.
   - **Cloudflare R2 (required for Instagram Reels)**: Manually create a **private** R2 bucket (**R2 Standard** storage only; keep public access OFF; never enable paid Cloudflare Workers/Stream/Images or automatic bucket creation/plan upgrades) and paste Account ID, Bucket Name, Access Key ID, and Secret Access Key. Local cost safeguards enforce **8 GB** max stored data (fail-closed pre-upload `ListObjectsV2` check), **500 MB** max video size, **1** concurrent upload, **10** queued jobs, configurable monthly upload limits, short-lived presigned URLs (`<= 1h`), bounded retries, post-publish delete, and **24h** abandoned/multipart cleanup with **70% / 85% / 95%** warnings. *Always remind users these are local application safeguards only, not a Cloudflare billing cap.*
   - *(Optional)* External AI provider keys only needed if using headless dashboard generation outside Antigravity.

### Part 2: Connect Multiple YouTube & Instagram Accounts via Official OAuth
1. Call `connect_social_account(platform: "youtube", displayName: "AI News")` (or click **+ Connect YouTube Channel** in Dashboard -> **Accounts**).
   - User opens the returned official Google OAuth URL in Chrome, selects their Google Account + target YouTube Brand/Channel, approves permissions, and lands on `"Connected!"`.
   - Repeat for additional YouTube channels (`"Gaming News"`, `"Personal Channel"`). Each channel stores an isolated token file.
2. Ensure each target Instagram account is switched to **Professional (Business or Creator)** in the Instagram app (and linked to a Facebook Page if using legacy `facebook_login`, or assigned in Business Portfolio for `meta_unified_login`).
   - Call `connect_social_account(platform: "instagram", displayName: "AI News IG")` (or click **+ Connect Instagram Account** in Dashboard).
   - User approves official Meta OAuth permissions in browser; all linked Professional Instagram accounts register cleanly with separate tokens.
3. Verify anytime with `list_social_accounts` and `get_social_account_status(accountId, live: true)`.

