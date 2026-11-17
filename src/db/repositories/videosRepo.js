import crypto from 'node:crypto';

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function toVideoRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    fileSizeBytes: row.file_size_bytes,
    sourceWorkflow: row.source_workflow,
    projectDir: row.project_dir || null,
    durationSec: row.duration_sec,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspect_ratio,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    fps: row.fps,
    hasAudio: Boolean(row.has_audio),
    probe: safeJsonParse(row.probe_json, {}),
    analysis: safeJsonParse(row.analysis_json, {}),
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

export class VideosRepository {
  constructor(db) {
    this.db = db;
  }

  upsertVideo(video) {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT * FROM videos WHERE file_sha256 = ? AND file_path = ?')
      .get(video.fileSha256, video.filePath);

    if (existing) {
      this.db
        .prepare(
          `UPDATE videos
           SET file_name = ?,
               file_size_bytes = ?,
               source_workflow = ?,
               project_dir = ?,
               duration_sec = COALESCE(?, duration_sec),
               width = COALESCE(?, width),
               height = COALESCE(?, height),
               aspect_ratio = COALESCE(?, aspect_ratio),
               video_codec = COALESCE(?, video_codec),
               audio_codec = COALESCE(?, audio_codec),
               fps = COALESCE(?, fps),
               has_audio = COALESCE(?, has_audio),
               probe_json = COALESCE(?, probe_json),
               analysis_json = COALESCE(?, analysis_json),
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          video.fileName,
          video.fileSizeBytes,
          video.sourceWorkflow || existing.source_workflow,
          video.projectDir ?? existing.project_dir,
          video.durationSec ?? null,
          video.width ?? null,
          video.height ?? null,
          video.aspectRatio ?? null,
          video.videoCodec ?? null,
          video.audioCodec ?? null,
          video.fps ?? null,
          video.hasAudio === undefined ? null : video.hasAudio ? 1 : 0,
          video.probe ? JSON.stringify(video.probe) : null,
          video.analysis ? JSON.stringify(video.analysis) : null,
          now,
          existing.id
        );
      return this.findById(existing.id);
    }

    const id = `vid_${crypto.randomBytes(8).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO videos (
          id, file_path, file_name, file_sha256, file_size_bytes, source_workflow,
          project_dir, duration_sec, width, height, aspect_ratio, video_codec,
          audio_codec, fps, has_audio, probe_json, analysis_json, discovered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        video.filePath,
        video.fileName,
        video.fileSha256,
        video.fileSizeBytes,
        video.sourceWorkflow || 'unknown',
        video.projectDir || null,
        video.durationSec ?? null,
        video.width ?? null,
        video.height ?? null,
        video.aspectRatio ?? null,
        video.videoCodec ?? null,
        video.audioCodec ?? null,
        video.fps ?? null,
        video.hasAudio === false ? 0 : 1,
        JSON.stringify(video.probe || {}),
        JSON.stringify(video.analysis || {}),
        now,
        now
      );
    return this.findById(id);
  }

  findById(id) {
    const row = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    return toVideoRecord(row);
  }

  findLatestByPath(filePath) {
    const row = this.db
      .prepare('SELECT * FROM videos WHERE file_path = ? ORDER BY updated_at DESC LIMIT 1')
      .get(filePath);
    return toVideoRecord(row);
  }

  updateAnalysis(id, analysisObj) {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE videos SET analysis_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(analysisObj || {}), now, id);
    return this.findById(id);
  }

  saveMetadataDraft({ videoId, platform, accountId = null, providerUsed, payload }) {
    const id = `meta_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO metadata_drafts (id, video_id, platform, account_id, provider_used, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, videoId, platform, accountId, providerUsed, JSON.stringify(payload), now);
    return { id, videoId, platform, accountId, providerUsed, payload, createdAt: now };
  }

  listMetadataDrafts(videoId) {
    const rows = this.db
      .prepare('SELECT * FROM metadata_drafts WHERE video_id = ? ORDER BY created_at DESC')
      .all(videoId);
    return rows.map((r) => ({
      id: r.id,
      videoId: r.video_id,
      platform: r.platform,
      accountId: r.account_id,
      providerUsed: r.provider_used,
      payload: safeJsonParse(r.payload_json, {}),
      createdAt: r.created_at,
    }));
  }
}

