export class OAuthStatesRepository {
  constructor(db) {
    this.db = db;
  }

  insert(row) {
    this.db
      .prepare(
        `INSERT INTO oauth_states (
          state_hash, platform, mode, account_id, display_name, ig_login_mode,
          code_verifier_enc, session_binding_hash, redirect_uri, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.stateHash,
        row.platform,
        row.mode,
        row.accountId || null,
        row.displayName || null,
        row.igLoginMode || null,
        row.codeVerifierEnc || null,
        row.sessionBindingHash,
        row.redirectUri,
        row.expiresAt,
        row.createdAt
      );
  }

  findByHash(stateHash) {
    return this.db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(stateHash) || null;
  }

  markConsumed(stateHash) {
    const now = new Date().toISOString();
    const res = this.db
      .prepare('UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL')
      .run(now, stateHash);
    return res.changes === 1;
  }

  purgeExpired() {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
  }
}

