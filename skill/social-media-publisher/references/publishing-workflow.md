# End-to-End Publishing Workflow

## Complete Pipeline

1. **Readiness & Login Verification (`get_publishing_settings`, `list_social_accounts`)**:
   - Confirm OAuth credentials (YouTube / Meta / R2 staging for IG) and connected accounts exist. If any needed credentials or accounts are missing/disconnected, walk the user through local Dashboard setup (`http://127.0.0.1:4815`) or `connect_social_account` OAuth links and pause cleanly (`✋`).
2. **Discover Video (`find_video`)**:
   - Locate explicit path, query-matched project folder, or latest rendered video in watched dirs (`~/flow-mcp-out`, `~/WhiteboardFilms/films`, `~/StickFilms/films`, `~/Videos`, Remotion output dirs).
3. **Inspect Video & Frames (`analyze_video` + `read_file`)**:
   - Extract `ffprobe` metadata, SHA-256 hash, sidecar context (`film.json`, `script.md`, `script.json`, `storyboard.md`, `voice/words.json`, `.srt`/`.vtt`), and keyframes.
   - Read extracted keyframe JPEGs with `read_file` so Antigravity understands visuals directly and chooses the sharpest `thumbOffsetMs` cover frame.
4. **Security & Account Health Checks (`get_social_account_status`)**:
   - Call `get_social_account_status(accountId, live: true)` for every destination account so token freshness and live API health are verified before upload. Wait for all checks to finish.
5. **Media Validation & Duplicate Checks (`validate_video`)**:
   - Validate codecs, resolution, aspect ratio, duration, and file size per destination (`youtube` Shorts vs standard; `instagram` Reels). Duplicate SHA-256 + `accountId` checks run automatically during publish creation and block silent re-uploads (`DUPLICATE_PUBLICATION`) unless `allowDuplicate: true` is explicitly confirmed.
6. **Antigravity Authors Captions, Hashtags & Extras**:
   - Draft distinct YouTube (`title`, `description`, `hashtags`, `tags`, `categoryId`, `pinnedComment`, `defaultLanguage`, `madeForKids`) and Instagram (`caption`, `hashtags`, `callToAction`, `emojis`, `thumbOffsetMs`, `audioName`) metadata grounded in frames + transcript.
   - Optionally call `generate_social_metadata` with `customOverrides: { authorMode: "antigravity", contentSummary, detectedLanguage, detectedTone, youtube, instagram }` to validate, strip banned spam hashtags, and save drafts cleanly.
7. **Confirm Destinations & Visibility (`✋`)**:
   - Confirm selected `accountId`s, YouTube `privacyStatus` (`public`/`private`/`unlisted`/scheduled `publishAt`), and Instagram `instagramVisibility` (`public`/`reels_only`/`trial_manual`/`private` with Creator-account confirmation).
8. **Review Gate (`✋` in Review Mode)**:
   - Call `publish_to_multiple_accounts` (or single-platform tool) with `approved: false` and your authored `metadataOverrides`. Present a concise summary card showing checks passed, accounts, visibility, and full captions/tags. Wait for explicit approval or edits.
9. **Execute & Wait for FULL Completion (`waitForCompletion: true`)**:
   - Call `approve_publishing_job` (or publish directly in Autopilot) with **`waitForCompletion: true`**.
   - **Never report completion prematurely.** Wait for every stage — token check, duplicate check, transcode (if needed), private R2 staging upload, chunked upload, YouTube processing (`succeeded`), Instagram container (`FINISHED` -> `media_publish` -> `permalink`), and R2 temp object deletion. If an HTTP call returns while any item is `queued`, `validating`, `staging`, `transcoding`, `uploading`, or `processing`, keep polling `get_publishing_status(jobId)` until `job.status` reaches `completed`, `partial_success`, `failed`, or `cancelled`.
10. **Verify Final Output & Partial Failure Recovery**:
    - Return exact published URLs, final visibility, and YouTube `pinnedComment` suggestion if composed.
    - If `partial_success` occurs, report which platform succeeded with its live URL and exact failure details for the failed destination, then offer `retry_failed_publication(jobId, waitForCompletion: true)` so only the failed item retries.

