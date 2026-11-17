# Instagram Reels Guidelines (Graph API)

## Account Eligibility & Public vs. Private Visibility

- Official Instagram Graph API publishing supports **Instagram Professional accounts (Business and Creator)** only. Personal Instagram accounts are rejected by Meta's API.
- Supports Meta's **Instagram API with Unified Login** (`meta_unified_login`, Facebook Login for Business with `config_id`) as well as independently supported legacy **Facebook Login for Business** (`facebook_login`) and **Instagram Login for Business** (`instagram_login`).
- **Public vs. Private rules (Graph API reality):**
  - Meta's official Graph API (`POST /{ig-user-id}/media` + `media_publish`) has **no per-post "Private / Only Me" flag** and **no API Draft endpoint** (unpublished containers expire after 24 hours).
  - Always let the user choose their desired Instagram visibility (`instagramVisibility`) explicitly before publishing:
    - **`public`**: Publishes normally to main profile grid + Reels tab (`share_to_feed: true`). Follows the IG account's own Public/Private status (Public on Business/public Creator accounts; followers-only if the Creator account itself is set to Private in Instagram Settings).
    - **`reels_only`**: Publishes to the Reels tab while keeping it off the main profile grid (`share_to_feed: false`).
    - **`trial_manual`**: Publishes as an official **Meta Trial Reel** (`trial_params: { graduation_strategy: "MANUAL" }`, `application/json`). Keeps the Reel hidden from the main profile grid and existing followers until the user manually promotes it in the Instagram app.
    - **`private` (Fail-Closed Safety Guard):** If the user asks for Instagram `private`, the backend blocks accidental public posting (`INSTAGRAM_VISIBILITY_CONFIRMATION_REQUIRED`) unless `confirmPrivateInstagramAccount: true` is passed after the user confirms their Creator account itself is set to Private in Instagram Settings (or selects `trial_manual` / decides to skip Instagram).

## Cover Frame (`thumbOffsetMs`), Audio Name & Staging

- **Cover selection (`thumbOffsetMs`)**: Every keyframe returned by `analyze_video` includes `thumbOffsetMs`. After inspecting the extracted JPEGs with `read_file`, pass the best keyframe's `thumbOffsetMs` into `publish_to_instagram` / `publish_to_multiple_accounts` so Meta picks that sharp frame as the Reel cover!
- **Custom audio attribution (`audioName`)**: Optionally pass a clean `audioName` when the Reel features original commentary/soundtrack.
- **Private Temporary Cloud Staging (Cloudflare R2 / S3)**:
  - Meta's Graph API (`POST /{ig-user-id}/media`) fetches the video from a remote HTTPS `video_url`.
  - The backend uploads the video to an existing **private** Cloudflare R2 bucket (**R2 Standard** storage only), generates a **short-lived SigV4 presigned GET URL** (`TEMP_MEDIA_URL_TTL_SECONDS`, default 30 minutes, max 1 hour), publishes the Reel, and **immediately deletes** the temporary object afterwards (plus cleans abandoned objects after 24 hours and aborts incomplete multipart uploads).
  - Cost safeguards enforce **8 GB** max bucket storage (measured before upload, failing closed if unreadable), **500 MB** max individual video size, **1** concurrent upload, **10** queued jobs, configurable monthly upload limits, bounded retries, and **70% / 85% / 95%** local warnings. These are application safeguards only, **not** a Cloudflare billing cap.
  - Never make the storage bucket permanently public.

## Technical Requirements for Reels

- **Container**: `.mp4` or `.mov` (if source is `.webm`/`.mkv` or non-H.264/AAC, the backend creates a temporary non-destructive transcoded MP4 copy without touching the original file).
- **Video Codec**: H.264 or HEVC (`yuv420p`).
- **Audio Codec**: AAC (`<= 48 kHz`).
- **Aspect Ratio**: `9:16` vertical recommended (`1080x1920`). If a landscape video must be posted as a Reel, pass `padToVertical: true` to create a temporary non-destructive 9:16 padded copy rather than letting Meta crop the sides.
- **Duration**: Minimum **3 seconds**. Reels tab eligibility is optimal between **5s and 90s** (API accepts up to 15 minutes depending on account).
- **Container Processing**: After creation, the backend polls `GET /{container-id}?fields=status_code` until `FINISHED` before calling `media_publish`, then fetches the official `permalink`. Wait for `waitForCompletion: true` / `get_publishing_status` so processing and temporary R2 deletion complete cleanly before reporting success.

