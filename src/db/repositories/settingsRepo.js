export class SettingsRepository {
  constructor(db) {
    this.db = db;
  }

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now);
    return value;
  }

  getAllSettings(config) {
    return {
      publishMode: this.get('publishMode', config.defaultPublishMode),
      defaultAccountIds: this.get('defaultAccountIds', []),
      videoWatchDirs: this.get('videoWatchDirs', config.videoWatchDirs),
      autoDetectShorts: this.get('autoDetectShorts', true),
      autoCleanupTempMedia: this.get('autoCleanupTempMedia', true),
      defaultPrivacyStatus: this.get('defaultPrivacyStatus', 'private'),
    };
  }

  updateSettings(patch, config) {
    const current = this.getAllSettings(config);
    if (patch.publishMode && ['review', 'autopilot'].includes(patch.publishMode)) {
      this.set('publishMode', patch.publishMode);
    }
    if (Array.isArray(patch.defaultAccountIds)) {
      this.set('defaultAccountIds', patch.defaultAccountIds);
    }
    if (Array.isArray(patch.videoWatchDirs)) {
      this.set('videoWatchDirs', patch.videoWatchDirs);
    }
    if (typeof patch.autoDetectShorts === 'boolean') {
      this.set('autoDetectShorts', patch.autoDetectShorts);
    }
    if (typeof patch.autoCleanupTempMedia === 'boolean') {
      this.set('autoCleanupTempMedia', patch.autoCleanupTempMedia);
    }
    if (patch.defaultPrivacyStatus && ['public', 'private', 'unlisted'].includes(patch.defaultPrivacyStatus)) {
      this.set('defaultPrivacyStatus', patch.defaultPrivacyStatus);
    }
    return this.getAllSettings(config) || current;
  }
}

