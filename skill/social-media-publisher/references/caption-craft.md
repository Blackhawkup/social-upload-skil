# Caption, Hashtag & Metadata Craft (Antigravity Authoring)

Antigravity is the primary creative and visual analyst. Before authoring metadata, always call `analyze_video` and inspect the extracted JPEG `keyframes` with `read_file` alongside `projectContext` (`scriptText`, `transcriptText`, `storyboardNotes`, `titleHint`, `languageHint`).

## 1. Visual + Audio Grounding Rules

- Read at least 2–3 keyframes visually so you notice on-screen diagrams, UI demos, code, characters, text overlays, and visual tone.
- Every claim, number, or hook must come strictly from the frames, transcript, script, or project notes — never invent stats, benchmarks, or plot points.
- Match the video's spoken language (`detectedLanguage`) and register (educational, technical, casual creator, news breakdown).

## 2. Hard Bans (Delete & Rewrite Immediately)

Never include any of the following:
- **Spam / irrelevant viral hashtags**: `#fyp`, `#foryou`, `#foryoupage`, `#viral`, `#viralshorts`, `#trending`, `#explore`, `#explorepage`, `#followme`, `#sub4sub`, `#like4like`. (The backend strips these automatically.)
- **AI cliché filler**: `"In today's rapidly evolving landscape"`, `"game-changer"`, `"revolutionary"`, `"cutting-edge"`, `"mind-blowing"` unless literally spoken in the video.
- **Fake engagement bait**: `"Comment YES if you agree!"` or `"Link in bio"` unless the video/project literally references a bio link.
- **Cross-platform copy-paste**: YouTube descriptions and Instagram captions must read like native writing for two different feeds.

## 3. Useful Metadata Beyond Captions & Hashtags

Whenever calling `generate_social_metadata` or `publish_to_*`, populate every helpful field supported for the destination:

| Field | Platform | How Antigravity Chooses It |
| :--- | :--- | :--- |
| `categoryId` | YouTube | Match content: `28` Science & Tech, `27` Education, `20` Gaming, `25` News & Politics, `26` Howto & Style, `1` Film & Animation, `22` People & Blogs. |
| `tags` | YouTube | 5–15 concrete multi-word search phrases covering topic, entities shown in frames, and tools mentioned. |
| `pinnedComment` | YouTube | 1 sharp question or discussion prompt inviting viewer perspective (saved as a copy-ready suggestion; least-privilege OAuth never posts comments silently). |
| `defaultLanguage` | YouTube | BCP-47 language code from transcript/audio (e.g., `en`, `es`, `hi`). |
| `madeForKids` | YouTube | Default `false`; set `true` only if directed specifically at children under 13. |
| `publishAt` | YouTube | Optional future ISO-8601 UTC timestamp for scheduled release (automatically keeps video `private` until scheduled publish time). |
| `thumbOffsetMs` | Instagram | Inspect keyframes from `analyze_video` via `read_file` and pick the clearest non-blurry focal frame's `thumbOffsetMs` as the Reel cover image. |
| `audioName` | Instagram | Optional clean attribution name if the video uses custom narration/original track (e.g., `"Original Lab Breakdown"`). |

## 4. Platform Format Contract

### YouTube (Standard Video & Shorts)
1. **Title** (`<= 100` chars; aim `45–75` chars): Clear promise or curiosity gap backed by the video content.
2. **Description**:
   - Line 1–2: Strong summary matching what viewers see in the opening seconds.
   - Body: Key takeaways, steps, or context (add short timestamps only for multi-minute structured videos).
   - Footer hashtags: 2–5 specific hashtags (append `#Shorts` only when `validate_video` confirms vertical/square `<= 180s`).
3. **Tags**: 5–15 searchable terms without `#`.

### Instagram Reels
1. **Hook** (first ~90 characters before `"more"` fold): Visual observation, sharp tension, or unexpected contrast.
2. **Body**: 1–3 tight lines adding context viewers won't catch on mute alone.
3. **Earned CTA**: Natural save/share/question prompt tied directly to the topic.
4. **Emojis**: 0–3 purposeful visual anchors (never emoji spam).
5. **Hashtags**: 3–7 specific community/niche tags placed cleanly at the bottom.

## 5. Contrast Example (Good Grounded Authoring)

**Video**: 38s vertical explainer showing why potatoes and tomatoes share the Solanaceae family.

- **YouTube (`youtube`)**:
  - `title`: `"Why Potatoes and Tomatoes Are Actually in the Same Family"`
  - `description`: `"Potatoes hide starch underground while tomatoes grow bright red fruit for birds — yet both belong to the Solanaceae nightshade family and can even be grafted onto one plant stem.\n\n#botany #plantscience #Shorts"`
  - `hashtags`: `["#botany", "#plantscience", "#Shorts"]`
  - `tags`: `["potato vs tomato", "solanaceae plant family", "pomato grafting", "plant biology explained", "botany shorts"]`
  - `categoryId`: `"27"`
  - `pinnedComment`: `"Would you grow a grafted potato-tomato plant at home?"`
- **Instagram (`instagram`)**:
  - `caption`: `"Same plant family, completely opposite survival strategies.\n\nPut a potato and tomato side by side and you're looking at two cousins from the Solanaceae family — one stores energy underground, the other advertises bright fruit for birds.\n\nWhich botany fact caught you off guard most?\n\n#botany #plantbiology #sciencefacts #urbangardening"`
  - `hashtags`: `["#botany", "#plantbiology", "#sciencefacts", "#urbangardening"]`
  - `callToAction`: `"Which botany fact caught you off guard most?"`
  - `emojis`: `["🥔", "🍅"]`
  - `thumbOffsetMs`: `12400` *(selected after viewing frame #2 showing the split diagram)*

