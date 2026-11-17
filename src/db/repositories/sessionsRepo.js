import crypto from 'node:crypto';

export class SessionsRepository {
  constructor(db, { csrfHmacKey = null } = {}) {
    this.db = db;
    this.csrfHmacKey = csrfHmacKey;
  }

  deriveCsrfToken(sessionId, tokenHash) {
    if (!this.csrfHmacKey) return null;
    return crypto
      .createHmac('sha256', this.csrfHmacKey)
      .update(`csrf|${sessionId}|${tokenHash}`)
      .digest('base64url');
  }

  createSession({ ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.purgeExpired();
    const id = `sess_${crypto.randomBytes(12).toString('hex')}`;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const csrfToken = this.deriveCsrfToken(id, tokenHash) || crypto.randomBytes(24).toString('base64url');
    const csrfSecretHash = crypto.createHash('sha256').update(csrfToken).digest('hex');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, csrf_secret_hash, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, tokenHash, csrfSecretHash, expiresAt, now, now);

    return { id, rawToken, csrfToken, expiresAt };
  }

  getCsrfTokenForSession(sessionRow) {
    if (!sessionRow || !this.csrfHmacKey) return null;
    const derived = this.deriveCsrfToken(sessionRow.id, sessionRow.token_hash);
    if (!derived) return null;
    return this.verifyCsrf(sessionRow, derived) ? derived : null;
  }

  verifySession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    return row;
  }

  verifyCsrf(sessionRow, providedCsrfToken) {
    if (!sessionRow || !providedCsrfToken || typeof providedCsrfToken !== 'string') {
      return false;
    }
    const providedHash = Buffer.from(
      crypto.createHash('sha256').update(providedCsrfToken).digest('hex'),
      'hex'
    );
    const expectedHash = Buffer.from(sessionRow.csrf_secret_hash, 'hex');
    if (providedHash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(providedHash, expectedHash);
  }

  deleteByRawToken(rawToken) {
    if (!rawToken) return;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  purgeExpired() {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}

