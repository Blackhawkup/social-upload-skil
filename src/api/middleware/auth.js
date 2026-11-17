import crypto from 'node:crypto';

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function timingSafeCompareString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createAuthMiddleware({ masterKeyStore, sessionsRepo }) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const provided = authHeader.slice(7).trim();
      const expected = masterKeyStore.getIpcSecret();
      if (timingSafeCompareString(provided, expected)) {
        req.auth = { type: 'ipc', sessionBinding: 'ipc' };
        return next();
      }
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid IPC authorization token.' },
      });
    }

    const cookies = parseCookies(req.headers.cookie);
    const rawSession = cookies.smp_session;
    if (!rawSession) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    const sessionRow = sessionsRepo.verifySession(rawSession);
    if (!sessionRow) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Dashboard session expired. Please authenticate again.' },
      });
    }

    if (MUTATING_METHODS.has(req.method)) {
      const csrfHeader = req.headers['x-csrf-token'];
      if (!sessionsRepo.verifyCsrf(sessionRow, csrfHeader)) {
        return res.status(403).json({
          success: false,
          error: { code: 'INVALID_CSRF_TOKEN', message: 'Missing or invalid CSRF token.' },
        });
      }
    }

    req.auth = { type: 'session', sessionId: sessionRow.id, sessionBinding: sessionRow.id };
    next();
  };
}

