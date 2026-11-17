import crypto from 'node:crypto';

export const DEFAULT_MAX_CLEANUP_ATTEMPTS = 5;

export class TempObjectsRepository {
  constructor(db) {
    this.db = db;
  }

  recordUpload({
    jobItemId,
    provider,
    bucket,
    objectKey,
    fileSizeBytes = 0,
    multipartUploadId = null,
    uploadPhase = 'completed',
    expiresAt,
  }) {
    const id = `tmpobj_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO temp_cloud_objects (
          id, job_item_id, provider, bucket, object_key, file_size_bytes,
          multipart_upload_id, upload_phase, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`
      )
      .run(
        id,
        jobItemId || null,
        provider,
        bucket,
        objectKey,
        Math.max(0, Number(fileSizeBytes) || 0),
        multipartUploadId || null,
        uploadPhase,
        expiresAt,
        now
      );
    return id;
  }

  recordUploadIntent({
    jobItemId,
    provider,
    bucket,
    objectKey,
    fileSizeBytes = 0,
    multipartUploadId = null,
    expiresAt,
  }) {
    return this.recordUpload({
      jobItemId,
      provider,
      bucket,
      objectKey,
      fileSizeBytes,
      multipartUploadId,
      uploadPhase: multipartUploadId ? 'multipart_uploading' : 'uploading',
      expiresAt,
    });
  }

  markUploadCompleted(id, { fileSizeBytes = null } = {}) {
    if (!id) return;
    if (fileSizeBytes !== null && fileSizeBytes !== undefined) {
      this.db
        .prepare("UPDATE temp_cloud_objects SET upload_phase = 'completed', file_size_bytes = ? WHERE id = ?")
        .run(Math.max(0, Number(fileSizeBytes) || 0), id);
    } else {
      this.db.prepare("UPDATE temp_cloud_objects SET upload_phase = 'completed' WHERE id = ?").run(id);
    }
  }

  markUploadAborted(id, reason = null) {
    if (!id) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE temp_cloud_objects
         SET status = 'expired_cleaned',
             upload_phase = 'aborted',
             aborted_at = ?,
             deleted_at = COALESCE(deleted_at, ?),
             last_error = ?
         WHERE id = ?`
      )
      .run(now, now, reason ? String(reason).slice(0, 400) : null, id);
  }

  markDeleted(id, status = 'deleted') {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE temp_cloud_objects SET status = ?, deleted_at = ?, last_error = NULL WHERE id = ?')
      .run(status, now, id);
  }

  markDeleteFailed(id, errorMessage) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE temp_cloud_objects
         SET status = 'delete_failed',
             cleanup_attempts = cleanup_attempts + 1,
             last_cleanup_attempt_at = ?,
             last_error = ?
         WHERE id = ?`
      )
      .run(now, String(errorMessage || 'Delete failed').slice(0, 400), id);
    return this.db.prepare('SELECT * FROM temp_cloud_objects WHERE id = ?').get(id) || null;
  }

  findById(id) {
    return this.db.prepare('SELECT * FROM temp_cloud_objects WHERE id = ?').get(id) || null;
  }

  findByObjectKey(objectKey, bucket = null) {
    if (bucket) {
      return (
        this.db
          .prepare('SELECT * FROM temp_cloud_objects WHERE object_key = ? AND bucket = ? ORDER BY created_at DESC LIMIT 1')
          .get(objectKey, bucket) || null
      );
    }
    return (
      this.db
        .prepare('SELECT * FROM temp_cloud_objects WHERE object_key = ? ORDER BY created_at DESC LIMIT 1')
        .get(objectKey) || null
    );
  }

  markDeletedByKey({ objectKey, bucket = null, status = 'expired_cleaned' }) {
    const row = this.findByObjectKey(objectKey, bucket);
    if (!row) return null;
    this.markDeleted(row.id, status);
    return row.id;
  }

  sumActiveTrackedBytes() {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(file_size_bytes), 0) AS total_bytes, COUNT(*) AS object_count
         FROM temp_cloud_objects
         WHERE status IN ('uploaded', 'delete_failed')`
      )
      .get();
    return {
      totalBytes: Number(row?.total_bytes || 0),
      objectCount: Number(row?.object_count || 0),
    };
  }

  listDueForCleanup(
    nowIso = new Date().toISOString(),
    { abandonedHours = 24, maxAttempts = DEFAULT_MAX_CLEANUP_ATTEMPTS, force = false } = {}
  ) {
    const nowMs = new Date(nowIso).getTime();
    const validNowMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
    const abandonedCutoffIso = new Date(validNowMs - abandonedHours * 3600_000).toISOString();

    return this.db
      .prepare(
        `SELECT * FROM temp_cloud_objects
         WHERE status IN ('uploaded', 'delete_failed')
           AND (expires_at <= ? OR created_at <= ?)
           AND (? = 1 OR cleanup_attempts < ?)
         ORDER BY expires_at ASC`
      )
      .all(nowIso, abandonedCutoffIso, force ? 1 : 0, maxAttempts);
  }
}

