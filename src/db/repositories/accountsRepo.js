import crypto from 'node:crypto';

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function toPublicAccount(row) {
  if (!row) return null;
  const now = Date.now();
  const expiresMs = row.token_expires_at ? new Date(row.token_expires_at).getTime() : null;
  const tokenExpired = expiresMs !== null && !Number.isNaN(expiresMs) ? expiresMs <= now : false;

  return {
    id: row.id,
    platform: row.platform,
    displayName: row.display_name,
    username: row.username || null,
    platformAccountId: row.platform_account_id,
    connectionStatus: row.connection_status,
    tokenExpiresAt: row.token_expires_at || null,
    refreshTokenExpiresAt: row.refresh_token_expires_at || null,
    tokenExpired,
    scopes: safeJsonParse(row.scopes_json, []),
    preferences: safeJsonParse(row.preferences_json, {}),
    metadata: safeJsonParse(row.metadata_json, {}),
    lastCheckedAt: row.last_checked_at || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountsRepository {
  constructor(db) {
    this.db = db;
  }

  listAll({ platform = null } = {}) {
    const rows = platform
      ? this.db
          .prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY created_at ASC')
          .all(platform)
      : this.db.prepare('SELECT * FROM accounts ORDER BY platform ASC, created_at ASC').all();
    return rows.map(toPublicAccount);
  }

  findPublicById(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return toPublicAccount(row);
  }

  findInternalById(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...toPublicAccount(row),
      credentialRef: row.credential_ref,
    };
  }

  findInternalByPlatformAccountId(platform, platformAccountId) {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE platform = ? AND platform_account_id = ?')
      .get(platform, platformAccountId);
    if (!row) return null;
    return {
      ...toPublicAccount(row),
      credentialRef: row.credential_ref,
    };
  }

  findByNameOrId(query, platform = null) {
    const all = this.listAll({ platform });
    if (!query) return all;
    const q = String(query).trim().toLowerCase();
    return all.filter(
      (acc) =>
        acc.id.toLowerCase() === q ||
        acc.displayName.toLowerCase() === q ||
        (acc.username && acc.username.toLowerCase() === q) ||
        acc.displayName.toLowerCase().includes(q) ||
        (acc.username && acc.username.toLowerCase().includes(q))
    );
  }

  upsertAccount({
    id,
    platform,
    displayName,
    username,
    platformAccountId,
    connectionStatus,
    credentialRef,
    tokenExpiresAt,
    refreshTokenExpiresAt,
    scopes = [],
    preferences = {},
    metadata = {},
  }) {
    const now = new Date().toISOString();
    const existing = this.findInternalByPlatformAccountId(platform, platformAccountId);

    if (existing) {
      const mergedPrefs = { ...existing.preferences, ...preferences };
      const mergedMeta = { ...existing.metadata, ...metadata };
      this.db
        .prepare(
          `UPDATE accounts
           SET display_name = ?,
               username = ?,
               connection_status = ?,
               credential_ref = ?,
               token_expires_at = ?,
               refresh_token_expires_at = ?,
               scopes_json = ?,
               preferences_json = ?,
               metadata_json = ?,
               last_checked_at = ?,
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          displayName || existing.displayName,
          username ?? existing.username,
          connectionStatus,
          credentialRef || existing.credentialRef,
          tokenExpiresAt === undefined ? existing.tokenExpiresAt : tokenExpiresAt,
          refreshTokenExpiresAt === undefined ? existing.refreshTokenExpiresAt : refreshTokenExpiresAt,
          JSON.stringify(scopes),
          JSON.stringify(mergedPrefs),
          JSON.stringify(mergedMeta),
          now,
          now,
          existing.id
        );
      return this.findInternalById(existing.id);
    }

    const newId = id || `acc_${crypto.randomBytes(8).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, platform, display_name, username, platform_account_id,
          connection_status, credential_ref, token_expires_at, refresh_token_expires_at,
          scopes_json, preferences_json, metadata_json, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId,
        platform,
        displayName,
        username || null,
        platformAccountId,
        connectionStatus,
        credentialRef,
        tokenExpiresAt || null,
        refreshTokenExpiresAt || null,
        JSON.stringify(scopes),
        JSON.stringify(preferences),
        JSON.stringify(metadata),
        now,
        now,
        now
      );
    return this.findInternalById(newId);
  }

  updatePreferences(id, { displayName, preferences }) {
    const existing = this.findInternalById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const mergedPrefs = preferences ? { ...existing.preferences, ...preferences } : existing.preferences;
    this.db
      .prepare(
        `UPDATE accounts
         SET display_name = ?, preferences_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(displayName || existing.displayName, JSON.stringify(mergedPrefs), now, id);
    return this.findPublicById(id);
  }

  updateTokenStatus(id, { connectionStatus, tokenExpiresAt = undefined, refreshTokenExpiresAt = undefined, lastErrorCode = null, lastErrorMessage = null }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE accounts
         SET connection_status = ?,
             token_expires_at = CASE WHEN ? = 1 THEN ? ELSE token_expires_at END,
             refresh_token_expires_at = CASE WHEN ? = 1 THEN ? ELSE refresh_token_expires_at END,
             last_checked_at = ?,
             last_error_code = ?,
             last_error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        connectionStatus,
        tokenExpiresAt !== undefined ? 1 : 0,
        tokenExpiresAt ?? null,
        refreshTokenExpiresAt !== undefined ? 1 : 0,
        refreshTokenExpiresAt ?? null,
        now,
        lastErrorCode,
        lastErrorMessage,
        now,
        id
      );
    return this.findPublicById(id);
  }

  deleteById(id) {
    const info = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return info.changes > 0;
  }
}

