import crypto from 'node:crypto';

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function toPublicItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    accountId: row.account_id,
    accountName: row.account_name || undefined,
    accountUsername: row.account_username || undefined,
    platform: row.platform,
    status: row.status,
    progressPct: row.progress_pct,
    bytesUploaded: row.bytes_uploaded,
    bytesTotal: row.bytes_total,
    hasResumableSession: Boolean(row.resumable_session_uri_enc),
    metadata: safeJsonParse(row.metadata_json, {}),
    validation: safeJsonParse(row.validation_json, {}),
    platformPostId: row.platform_post_id || null,
    platformContainerId: row.platform_container_id || null,
    publishedUrl: row.published_url || null,
    attemptCount: row.attempt_count,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    retryable: Boolean(row.retryable),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
  };
}

export function toPublicJob(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    videoId: row.video_id,
    filePath: row.video_file_path || undefined,
    fileName: row.video_file_name || undefined,
    fileSha256: row.file_sha256,
    mode: row.mode,
    status: row.status,
    requestedBy: row.requested_by,
    approvedAt: row.approved_at || null,
    summary: safeJsonParse(row.summary_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    items,
  };
}

export class JobsRepository {
  constructor(db) {
    this.db = db;
  }

  createJob({ videoId, fileSha256, mode, requestedBy = 'antigravity', status, approvedAt = null, summary = {}, items = [] }) {
    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const insertTx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO publish_jobs (
            id, video_id, file_sha256, mode, status, requested_by, approved_at, summary_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          jobId,
          videoId,
          fileSha256,
          mode,
          status,
          requestedBy,
          approvedAt,
          JSON.stringify(summary),
          now,
          now
        );

      const itemStmt = this.db.prepare(
        `INSERT INTO publish_items (
          id, job_id, account_id, platform, status, metadata_json, validation_json,
          bytes_total, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of items) {
        const itemId = `item_${crypto.randomBytes(8).toString('hex')}`;
        itemStmt.run(
          itemId,
          jobId,
          item.accountId,
          item.platform,
          item.status || (status === 'awaiting_approval' ? 'awaiting_approval' : 'pending'),
          JSON.stringify(item.metadata || {}),
          JSON.stringify(item.validation || {}),
          item.bytesTotal || 0,
          now
        );
      }
    });

    insertTx();
    return this.getJobWithItems(jobId);
  }

  getJobWithItems(jobId) {
    const jobRow = this.db
      .prepare(
        `SELECT j.*, v.file_path AS video_file_path, v.file_name AS video_file_name
         FROM publish_jobs j
         LEFT JOIN videos v ON v.id = j.video_id
         WHERE j.id = ?`
      )
      .get(jobId);
    if (!jobRow) return null;

    const itemRows = this.db
      .prepare(
        `SELECT i.*, a.display_name AS account_name, a.username AS account_username
         FROM publish_items i
         LEFT JOIN accounts a ON a.id = i.account_id
         WHERE i.job_id = ?
         ORDER BY i.rowid ASC`
      )
      .all(jobId);

    return toPublicJob(jobRow, itemRows.map(toPublicItem));
  }

  getInternalItem(itemId) {
    return this.db.prepare('SELECT * FROM publish_items WHERE id = ?').get(itemId) || null;
  }

  countActiveJobs() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM publish_jobs
         WHERE status IN ('awaiting_approval', 'queued', 'running')`
      )
      .get();
    return Number(row?.cnt || 0);
  }

  listHistory({ limit = 25, offset = 0, status = null } = {}) {
    const jobRows = status
      ? this.db
          .prepare(
            `SELECT j.*, v.file_path AS video_file_path, v.file_name AS video_file_name
             FROM publish_jobs j
             LEFT JOIN videos v ON v.id = j.video_id
             WHERE j.status = ?
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(status, limit, offset)
      : this.db
          .prepare(
            `SELECT j.*, v.file_path AS video_file_path, v.file_name AS video_file_name
             FROM publish_jobs j
             LEFT JOIN videos v ON v.id = j.video_id
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(limit, offset);

    if (jobRows.length === 0) return [];

    const jobIds = jobRows.map((j) => j.id);
    const placeholders = jobIds.map(() => '?').join(',');
    const itemRows = this.db
      .prepare(
        `SELECT i.*, a.display_name AS account_name, a.username AS account_username
         FROM publish_items i
         LEFT JOIN accounts a ON a.id = i.account_id
         WHERE i.job_id IN (${placeholders})
         ORDER BY i.rowid ASC`
      )
      .all(...jobIds);

    const itemsByJob = new Map();
    for (const row of itemRows) {
      const arr = itemsByJob.get(row.job_id) || [];
      arr.push(toPublicItem(row));
      itemsByJob.set(row.job_id, arr);
    }

    return jobRows.map((row) => toPublicJob(row, itemsByJob.get(row.id) || []));
  }

  updateJob(jobId, { status, approvedAt, summary, completedAt }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE publish_jobs
         SET status = COALESCE(?, status),
             approved_at = COALESCE(?, approved_at),
             summary_json = COALESCE(?, summary_json),
             completed_at = COALESCE(?, completed_at),
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        status ?? null,
        approvedAt ?? null,
        summary ? JSON.stringify(summary) : null,
        completedAt ?? null,
        now,
        jobId
      );
  }

  updateItem(itemId, patch) {
    const now = new Date().toISOString();
    const sets = ['updated_at = ?'];
    const params = [now];

    const map = {
      status: 'status',
      progressPct: 'progress_pct',
      bytesUploaded: 'bytes_uploaded',
      bytesTotal: 'bytes_total',
      resumableSessionUriEnc: 'resumable_session_uri_enc',
      tempUploadPath: 'temp_upload_path',
      platformPostId: 'platform_post_id',
      platformContainerId: 'platform_container_id',
      publishedUrl: 'published_url',
      attemptCount: 'attempt_count',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      startedAt: 'started_at',
      completedAt: 'completed_at',
    };

    for (const [jsKey, col] of Object.entries(map)) {
      if (patch[jsKey] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(patch[jsKey]);
      }
    }
    if (patch.retryable !== undefined) {
      sets.push('retryable = ?');
      params.push(patch.retryable ? 1 : 0);
    }
    if (patch.metadata !== undefined) {
      sets.push('metadata_json = ?');
      params.push(JSON.stringify(patch.metadata));
    }
    if (patch.validation !== undefined) {
      sets.push('validation_json = ?');
      params.push(JSON.stringify(patch.validation));
    }

    params.push(itemId);
    this.db.prepare(`UPDATE publish_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  findDuplicateFingerprint(fileSha256, accountId) {
    return (
      this.db
        .prepare(
          `SELECT * FROM published_fingerprints
           WHERE file_sha256 = ? AND account_id = ?
           ORDER BY published_at DESC LIMIT 1`
        )
        .get(fileSha256, accountId) || null
    );
  }

  recordFingerprint({ fileSha256, accountId, platform, platformPostId, publishedUrl, jobItemId }) {
    const id = `fp_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO published_fingerprints (
          id, file_sha256, account_id, platform, platform_post_id, published_url, job_item_id, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, fileSha256, accountId, platform, platformPostId, publishedUrl || null, jobItemId || null, now);
  }

  recoverInterruptedOnBoot() {
    const now = new Date().toISOString();
    const activeStatuses = ['pending', 'validating', 'transcoding', 'staging', 'uploading', 'processing'];
    const placeholders = activeStatuses.map(() => '?').join(',');

    const affectedItems = this.db
      .prepare(`SELECT id, job_id FROM publish_items WHERE status IN (${placeholders})`)
      .all(...activeStatuses);

    if (affectedItems.length === 0) return { recoveredJobs: 0, recoveredItems: 0 };

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE publish_items
           SET status = 'failed',
               error_code = 'INTERRUPTED_BY_RESTART',
               error_message = 'Upload interrupted by backend restart; safe to retry.',
               retryable = 1,
               updated_at = ?
           WHERE status IN (${placeholders})`
        )
        .run(now, ...activeStatuses);

      const jobIds = [...new Set(affectedItems.map((i) => i.job_id))];
      for (const jobId of jobIds) {
        this.recomputeJobStatus(jobId);
      }
      return jobIds.length;
    });

    const recoveredJobs = tx();
    return { recoveredJobs, recoveredItems: affectedItems.length };
  }

  recomputeJobStatus(jobId) {
    const items = this.db.prepare('SELECT status FROM publish_items WHERE job_id = ?').all(jobId);
    if (items.length === 0) return 'failed';

    const statuses = items.map((i) => i.status);
    let nextStatus = 'running';
    let completedAt = null;
    const now = new Date().toISOString();

    if (statuses.every((s) => s === 'awaiting_approval')) {
      nextStatus = 'awaiting_approval';
    } else if (statuses.every((s) => s === 'cancelled')) {
      nextStatus = 'cancelled';
      completedAt = now;
    } else if (statuses.some((s) => ['pending', 'validating', 'transcoding', 'staging', 'uploading', 'processing'].includes(s))) {
      nextStatus = 'running';
    } else if (statuses.every((s) => s === 'published' || s === 'skipped_duplicate')) {
      nextStatus = 'completed';
      completedAt = now;
    } else if (statuses.some((s) => s === 'published') && statuses.some((s) => s === 'failed')) {
      nextStatus = 'partial_success';
      completedAt = now;
    } else if (statuses.every((s) => s === 'failed' || s === 'cancelled')) {
      nextStatus = 'failed';
      completedAt = now;
    } else {
      nextStatus = 'partial_success';
      completedAt = now;
    }

    this.updateJob(jobId, { status: nextStatus, completedAt });
    return nextStatus;
  }
}

