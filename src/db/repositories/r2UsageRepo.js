import crypto from 'node:crypto';

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export class R2UsageRepository {
  constructor(db) {
    this.db = db;
  }

  getMonthKey(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    const valid = Number.isNaN(d.getTime()) ? new Date() : d;
    return valid.toISOString().slice(0, 7);
  }

  #ensureMonthRow(monthKey, nowIso = new Date().toISOString()) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO r2_monthly_counters (
          month_key, upload_count, upload_bytes, delete_count, abort_multipart_count,
          class_a_ops, class_b_ops, updated_at
        ) VALUES (?, 0, 0, 0, 0, 0, 0, ?)`
      )
      .run(monthKey, nowIso);
  }

  getMonthlyCounters(monthKey = this.getMonthKey()) {
    const nowIso = new Date().toISOString();
    this.#ensureMonthRow(monthKey, nowIso);
    const row = this.db
      .prepare('SELECT * FROM r2_monthly_counters WHERE month_key = ?')
      .get(monthKey);

    return {
      monthKey: row.month_key,
      uploadCount: Number(row.upload_count || 0),
      uploadBytes: Number(row.upload_bytes || 0),
      deleteCount: Number(row.delete_count || 0),
      abortMultipartCount: Number(row.abort_multipart_count || 0),
      classAOps: Number(row.class_a_ops || 0),
      classBOps: Number(row.class_b_ops || 0),
      lastMeasuredBytes:
        row.last_measured_bytes === null || row.last_measured_bytes === undefined
          ? null
          : Number(row.last_measured_bytes),
      lastMeasuredObjects:
        row.last_measured_objects === null || row.last_measured_objects === undefined
          ? null
          : Number(row.last_measured_objects),
      lastMeasuredAt: row.last_measured_at || null,
      updatedAt: row.updated_at,
    };
  }

  updateMeasurementSnapshot({
    monthKey = this.getMonthKey(),
    measuredBytes,
    objectCount = null,
    measuredAt = new Date().toISOString(),
  }) {
    const tx = this.db.transaction(() => {
      this.#ensureMonthRow(monthKey, measuredAt);
      this.db
        .prepare(
          `UPDATE r2_monthly_counters
           SET last_measured_bytes = ?,
               last_measured_objects = COALESCE(?, last_measured_objects),
               last_measured_at = ?,
               updated_at = ?
           WHERE month_key = ?`
        )
        .run(
          Math.max(0, Number(measuredBytes) || 0),
          objectCount === null || objectCount === undefined ? null : Math.max(0, Number(objectCount) || 0),
          measuredAt,
          measuredAt,
          monthKey
        );
    });
    tx();
  }

  recordEvent({
    monthKey = this.getMonthKey(),
    eventType,
    opClass = 'GUARD',
    operation,
    bucket = null,
    objectKey = null,
    bytesDelta = 0,
    measuredBytes = null,
    utilizationPct = null,
    warningLevel = null,
    status = 'ok',
    jobItemId = null,
    details = {},
    countUpload = false,
    uploadBytesDelta = 0,
    countDelete = false,
    countAbortMultipart = false,
    classAOpsDelta = 0,
    classBOpsDelta = 0,
  }) {
    const id = `r2log_${crypto.randomBytes(8).toString('hex')}`;
    const nowIso = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.#ensureMonthRow(monthKey, nowIso);

      this.db
        .prepare(
          `INSERT INTO r2_usage_logs (
            id, month_key, event_type, op_class, operation, bucket, object_key,
            bytes_delta, measured_bytes, utilization_pct, warning_level, status,
            job_item_id, details_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          monthKey,
          String(eventType || 'event'),
          opClass,
          String(operation || eventType || 'operation'),
          bucket || null,
          objectKey || null,
          Math.trunc(Number(bytesDelta) || 0),
          measuredBytes === null || measuredBytes === undefined ? null : Math.max(0, Number(measuredBytes) || 0),
          utilizationPct === null || utilizationPct === undefined ? null : Number(utilizationPct),
          warningLevel || null,
          status,
          jobItemId || null,
          JSON.stringify(details || {}),
          nowIso
        );

      const uploadInc = countUpload ? 1 : 0;
      const uploadBytesInc = Math.max(0, Math.trunc(Number(uploadBytesDelta) || 0));
      const deleteInc = countDelete ? 1 : 0;
      const abortInc = countAbortMultipart ? 1 : 0;
      const classAInc = Math.max(0, Math.trunc(Number(classAOpsDelta) || 0));
      const classBInc = Math.max(0, Math.trunc(Number(classBOpsDelta) || 0));

      if (
        uploadInc ||
        uploadBytesInc ||
        deleteInc ||
        abortInc ||
        classAInc ||
        classBInc ||
        measuredBytes !== null
      ) {
        this.db
          .prepare(
            `UPDATE r2_monthly_counters
             SET upload_count = upload_count + ?,
                 upload_bytes = upload_bytes + ?,
                 delete_count = delete_count + ?,
                 abort_multipart_count = abort_multipart_count + ?,
                 class_a_ops = class_a_ops + ?,
                 class_b_ops = class_b_ops + ?,
                 last_measured_bytes = COALESCE(?, last_measured_bytes),
                 last_measured_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_measured_at END,
                 updated_at = ?
             WHERE month_key = ?`
          )
          .run(
            uploadInc,
            uploadBytesInc,
            deleteInc,
            abortInc,
            classAInc,
            classBInc,
            measuredBytes === null || measuredBytes === undefined ? null : Math.max(0, Number(measuredBytes) || 0),
            measuredBytes === null || measuredBytes === undefined ? null : 1,
            nowIso,
            nowIso,
            monthKey
          );
      }
    });

    tx();
    return id;
  }

  getRecentLogs({ limit = 40, monthKey = null } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 40));
    const rows = monthKey
      ? this.db
          .prepare('SELECT * FROM r2_usage_logs WHERE month_key = ? ORDER BY created_at DESC LIMIT ?')
          .all(monthKey, safeLimit)
      : this.db
          .prepare('SELECT * FROM r2_usage_logs ORDER BY created_at DESC LIMIT ?')
          .all(safeLimit);

    return rows.map((row) => ({
      id: row.id,
      monthKey: row.month_key,
      eventType: row.event_type,
      opClass: row.op_class,
      operation: row.operation,
      bucket: row.bucket || null,
      objectKey: row.object_key || null,
      bytesDelta: Number(row.bytes_delta || 0),
      measuredBytes:
        row.measured_bytes === null || row.measured_bytes === undefined
          ? null
          : Number(row.measured_bytes),
      utilizationPct:
        row.utilization_pct === null || row.utilization_pct === undefined
          ? null
          : Number(row.utilization_pct),
      warningLevel: row.warning_level || null,
      status: row.status,
      jobItemId: row.job_item_id || null,
      details: safeJsonParse(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }
}

