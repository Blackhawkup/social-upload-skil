# YouTube Publishing Guidelines (Data API v3)

## Authentication & Channels

- Uses official Google OAuth 2.0 with PKCE (`S256`) and cryptographic `state`.
- Least-privilege scopes: `youtube.upload` and `youtube.readonly`.
- Each connected YouTube channel has its own isolated encrypted token file and `accountId`.
- Automatic token refresh runs before upload when an access token is expired or within 5 minutes of expiration. If a refresh token is revoked (`invalid_grant`), the account transitions to `reauth_required` — call `connect_social_account` with `accountId` to generate an official reauthorization link.

## Standard Video vs. YouTube Shorts

Do **not** assume every short video qualifies as a Short. Always check `validate_video`:

- **YouTube Shorts requirements**:
  - **Aspect Ratio**: Vertical (`9:16` recommended, e.g., `1080x1920`) or Square (`1:1`). Landscape (`16:9`) videos do **not** qualify as Shorts.
  - **Duration**: Up to **180 seconds (3 minutes)**. (Note: Shorts over 60 seconds with active copyright claims may be blocked globally.)
  - **Codecs**: H.264 video + AAC audio inside `.mp4` or `.mov` preferred.
- **Standard YouTube Videos**:
  - Any standard aspect ratio (`16:9` recommended), up to 12 hours / 256 GB.

## Upload, Scheduling & Extra Metadata Rules

- Uploads use YouTube's official **resumable upload protocol** (`videos.insert?uploadType=resumable`) in 8 MiB chunks with persistent session URI tracking so interrupted uploads can resume cleanly.
- **Privacy status**: `public`, `private`, or `unlisted`.
- **Scheduled publishing (`publishAt`)**: YouTube Data API v3 requires `privacyStatus: "private"` whenever `publishAt` is provided (future ISO-8601 UTC timestamp). The backend enforces this automatically.
- **Language & Audience**: Pass `defaultLanguage` (BCP-47, e.g. `"en"`) and `madeForKids` (`false` unless children's content) accurately on upload.
- **Hashtags**: Passing `hashtags: [...]` automatically strips spam tags and appends missing hashtags cleanly to `description` (up to 5).
- **Pinned comment suggestion**: Save `pinnedComment` in metadata — because OAuth uses least-privilege scopes (`youtube.upload`, `youtube.readonly`) without broad moderation scope (`youtube.force-ssl`), surface the `pinnedComment` suggestion to the user after upload so they can pin it manually if desired.
- **Quota & Failure handling**: `quotaExceeded` or `uploadLimitExceeded` errors are non-retryable and reported transparently.

