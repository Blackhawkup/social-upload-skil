---
name: social-media-publisher
description: Use when the user asks to upload or publish a video, post to YouTube or Shorts, post to Instagram Reels, crosspost video to social accounts, write or generate video captions and hashtags, check connected social accounts, or monitor or retry video uploads.
---

# AI Social Media Publisher

Identify locally generated videos, inspect their actual frames and narration, author platform-native YouTube and Instagram metadata yourself, and publish safely across multiple authorized accounts via the `social-publisher` MCP server.

## Ground Rules

- **Never ask for or accept secrets in chat.** If OAuth or Cloudflare R2 keys are missing, send the user to the local Dashboard (`http://127.0.0.1:4815` -> **Setup & Credentials**) or `npm run setup`. Never read `.env`, `credentials/`, `secrets/`, or `.db` files directly.
- **Antigravity authors the captions, hashtags, and metadata.** Always inspect extracted keyframes (`read_file`) and `projectContext` from `analyze_video` and write tailored YouTube + Instagram copy yourself using [caption-craft.md](./references/caption-craft.md). Pass your drafts directly into `generate_social_metadata` / `publish_to_*` (`authorMode: "antigravity"`).
- **Stop at every `✋` checkpoint** (except unattended Autopilot with pre-authorized destinations) and batch all open questions (accounts, YouTube privacy, Instagram visibility, schedule) into one clear prompt.
- **Wait for every security check, validation, upload, R2 cleanup, and post confirmation.** Pass `waitForCompletion: true` and poll `get_publishing_status` until every destination reaches a terminal state (`published` or `failed`). Never claim a post is live early.

## MCP Tools

| Task | Tool |
| :--- | :--- |
| Readiness, mode & dashboard URL | `get_publishing_settings`, `update_publishing_settings` |
| Accounts & live auth check | `list_social_accounts`, `get_social_account_status`, `connect_social_account`, `refresh_social_account_token` |
| Discover & inspect video | `find_video`, `analyze_video` |
| Validate platform specs | `validate_video` |
| Validate/save Antigravity drafts | `generate_social_metadata` |
| Publish | `publish_to_youtube`, `publish_to_instagram`, `publish_to_multiple_accounts` |
| Approve Review Mode job | `approve_publishing_job` |
| Monitor, history & retry | `get_publishing_status`, `get_publishing_history`, `retry_failed_publication` |
| R2 storage usage & cleanup | `get_r2_usage_status` |

## Workflow

### Step 0: Check setup readiness & login status
Call `get_publishing_settings` and `list_social_accounts`.
- If OAuth/R2 setup is incomplete for a requested platform, follow [security-guidelines.md](./references/security-guidelines.md) and pause for local setup. ✋
- If a target account is missing, `disconnected`, or `reauth_required`, call `connect_social_account` to give the user an official OAuth link and wait until they finish signing in. ✋

### Step 1: Discover and inspect the video
1. Call `find_video` (`explicitPath`, `query`, or latest video).
2. Call `analyze_video` (`extractFrames: true`).
3. Call `read_file` on the returned `keyframes` JPEG paths so you visually understand what appears on screen, and read `projectContext` (`scriptText`, `transcriptText`, `storyboardNotes`, `titleHint`, `languageHint`). Note each keyframe's `thumbOffsetMs` for Instagram cover selection.

### Step 2: Run account security & media validation checks
1. Match requested destinations (`"AI News YouTube"`, `"Personal IG"`, etc.) to exact `accountId`s. If ambiguous or unspecified, list connected accounts cleanly.
2. Call `get_social_account_status(accountId, live: true)` for every candidate destination to verify active tokens/refresh health.
3. Call `validate_video` for each target (`youtube` with `isShort` based on vertical/square aspect ratio and `<= 180s` duration; `instagram` Reels). Never assume a short landscape video qualifies as a Short. Offer `padToVertical: true` for landscape Instagram Reels if needed.
4. Wait for all checks to finish cleanly before drafting or publishing.

### Step 3: Author platform-specific metadata (Antigravity)
Compose grounded, distinct metadata directly from the frames and transcript (follow [caption-craft.md](./references/caption-craft.md), [youtube-guidelines.md](./references/youtube-guidelines.md), [instagram-guidelines.md](./references/instagram-guidelines.md)):
- **YouTube**: `title` (`<= 100` chars), SEO `description`, 2–5 `hashtags` (`#Shorts` if validated Short), 5–15 `tags`, `categoryId`, copy-ready `pinnedComment` suggestion, `defaultLanguage`, `madeForKids` (`false` unless children's content).
- **Instagram Reels**: engaging `caption` (hook + story + earned CTA, never copied from YouTube), 3–7 niche `hashtags`, 0–3 tasteful `emojis`, best cover frame `thumbOffsetMs`, optional `audioName`.
- **Optional validation/save**: If the user only asked for captions or wants saved drafts first, call `generate_social_metadata` with `customOverrides: { authorMode: "antigravity", contentSummary, detectedLanguage, detectedTone, youtube, instagram }`.

### Step 4: Ask destinations & visibility `✋`
Unless already stated cleanly in the user's request (or pre-authorized in Autopilot):
- Confirm destination `accountId`s.
- Ask YouTube **`privacyStatus`**: `public`, `private`, `unlisted`, or scheduled `publishAt`.
- Ask Instagram **`instagramVisibility`**:
  - `public` — main profile grid + Reels tab.
  - `reels_only` — Reels tab only (`share_to_feed: false`).
  - `trial_manual` — official **Meta Trial Reel** hidden from profile grid and existing followers until promoted manually.
  - `private` — **only** valid with `confirmPrivateInstagramAccount: true` after the user confirms their Instagram Creator account itself is Private in IG Settings (Meta has no per-post Private toggle or API Drafts).

### Step 5: Draft & review gate `✋`
- **Review Mode (default)**: Call `publish_to_multiple_accounts` (or single-platform publish tool) with `approved: false` and your `metadataOverrides`. Show a concise review card (file, validation & security status, destination accounts, YouTube/Instagram visibility, YT title/description/hashtags/tags/category, IG caption/hashtags/cover timestamp) and wait for explicit user approval (or edits).
- **Autopilot Mode**: Only proceed automatically if `publishMode === "autopilot"` and accounts/visibility are authorized.

### Step 6: Execute, wait for full completion & report links
1. Call `approve_publishing_job` (or publish directly in Autopilot) with **`waitForCompletion: true`** and wait for:
   - Duplicate-hash & token checks
   - Non-destructive transcoding (if needed)
   - Private Cloudflare R2 temp staging upload + deletion cleanup
   - Chunked YouTube / Meta container upload & processing completion
2. If any call returns before a terminal job status, poll `get_publishing_status(jobId)` until every destination is `published` or `failed`.
3. Return exact verified URLs (`watch?v=...`, `/shorts/...`, Instagram `permalink`), final visibility, and any copy-ready YouTube `pinnedComment`. On `partial_success`, state exactly which destination succeeded/failed and offer `retry_failed_publication(jobId, waitForCompletion: true)`.

## Common Patterns

- **"Publish my latest video to AI News YouTube."** -> Step 0–3 -> confirm YT visibility -> Step 5–6.
- **"Upload this clip to Gaming YT and Personal IG."** -> Step 0–3 -> confirm YT privacy + IG visibility -> Step 5–6.
- **"Write YouTube and Instagram captions and hashtags for my latest video."** -> `find_video` -> `analyze_video` + `read_file` keyframes -> author both drafts -> `generate_social_metadata(authorMode: "antigravity")` -> present drafts + cover timestamp without publishing.
- **"Why did Instagram fail / retry yesterday's upload?"** -> `get_publishing_history` -> inspect error -> `retry_failed_publication(jobId, waitForCompletion: true)`.

## References

- [Caption & Hashtag Craft + Metadata Extras](./references/caption-craft.md)
- [YouTube Publishing Guidelines](./references/youtube-guidelines.md)
- [Instagram Reels Guidelines](./references/instagram-guidelines.md)
- [End-to-End Publishing Workflow](./references/publishing-workflow.md)
- [Credential & Login Setup Guide](./references/security-guidelines.md)

