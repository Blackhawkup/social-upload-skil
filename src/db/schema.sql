PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  display_name TEXT NOT NULL,
  username TEXT,
  platform_account_id TEXT NOT NULL,
  connection_status TEXT NOT NULL CHECK (connection_status IN ('connected', 'expired', 'disconnected', 'reauth_required', 'error')),
  credential_ref TEXT NOT NULL UNIQUE,
  token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, platform_account_id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_platform_status ON accounts(platform, connection_status);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'reauthorize')),
  account_id TEXT,
  display_name TEXT,
  ig_login_mode TEXT,
  code_verifier_enc TEXT,
  session_binding_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  source_workflow TEXT NOT NULL DEFAULT 'unknown',
  project_dir TEXT,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  aspect_ratio TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  fps REAL,
  has_audio INTEGER NOT NULL DEFAULT 1,
  probe_json TEXT NOT NULL DEFAULT '{}',
  analysis_json TEXT NOT NULL DEFAULT '{}',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (file_sha256, file_path)
);

CREATE INDEX IF NOT EXISTS idx_videos_sha256 ON videos(file_sha256);
CREATE INDEX IF NOT EXISTS idx_videos_path ON videos(file_path);

CREATE TABLE IF NOT EXISTS metadata_drafts (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  provider_used TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metadata_drafts_video ON metadata_drafts(video_id, created_at DESC);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  file_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('review', 'autopilot')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'queued', 'running', 'completed', 'partial_success', 'failed', 'cancelled')),
  requested_by TEXT NOT NULL DEFAULT 'antigravity',
  approved_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS publish_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'pending', 'validating', 'transcoding', 'staging', 'uploading', 'processing', 'published', 'failed', 'skipped_duplicate', 'cancelled')),
  progress_pct REAL NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  resumable_session_uri_enc TEXT,
  temp_upload_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  platform_post_id TEXT,
  platform_container_id TEXT,
  published_url TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_items_job ON publish_items(job_id);
CREATE INDEX IF NOT EXISTS idx_publish_items_account ON publish_items(account_id, status);

CREATE TABLE IF NOT EXISTS published_fingerprints (
  id TEXT PRIMARY KEY,
  file_sha256 TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  platform_post_id TEXT NOT NULL,
  published_url TEXT,
  job_item_id TEXT REFERENCES publish_items(id) ON DELETE SET NULL,
  published_at TEXT NOT NULL,
  UNIQUE (file_sha256, account_id, platform_post_id)
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_lookup ON published_fingerprints(file_sha256, account_id);

CREATE TABLE IF NOT EXISTS temp_cloud_objects (
  id TEXT PRIMARY KEY,
  job_item_id TEXT REFERENCES publish_items(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  multipart_upload_id TEXT,
  upload_phase TEXT NOT NULL DEFAULT 'completed',
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'deleted', 'delete_failed', 'expired_cleaned')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  last_cleanup_attempt_at TEXT,
  aborted_at TEXT,
  expires_at TEXT NOT NULL,
  deleted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_temp_cloud_cleanup ON temp_cloud_objects(status, expires_at);

CREATE TABLE IF NOT EXISTS r2_usage_logs (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  op_class TEXT NOT NULL CHECK (op_class IN ('A', 'B', 'FREE', 'GUARD')),
  operation TEXT NOT NULL,
  bucket TEXT,
  object_key TEXT,
  bytes_delta INTEGER NOT NULL DEFAULT 0,
  measured_bytes INTEGER,
  utilization_pct REAL,
  warning_level TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'blocked', 'error')),
  job_item_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_r2_usage_logs_month ON r2_usage_logs(month_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_r2_usage_logs_warning ON r2_usage_logs(warning_level, created_at DESC);

CREATE TABLE IF NOT EXISTS r2_monthly_counters (
  month_key TEXT PRIMARY KEY,
  upload_count INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  delete_count INTEGER NOT NULL DEFAULT 0,
  abort_multipart_count INTEGER NOT NULL DEFAULT 0,
  class_a_ops INTEGER NOT NULL DEFAULT 0,
  class_b_ops INTEGER NOT NULL DEFAULT 0,
  last_measured_bytes INTEGER,
  last_measured_objects INTEGER,
  last_measured_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

