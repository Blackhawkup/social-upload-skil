import { sanitizeErrorMessage } from '../../security/redact.js';

export function securityHeadersMiddleware() {
  return (req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self';"
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
    next();
  };
}

export function isLoopbackHostHeader(hostHeader, { allowedPort = null } = {}) {
  if (!hostHeader) return false;
  const normalized = String(hostHeader).trim().toLowerCase();
  const match = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(normalized);
  if (!match) return false;
  if (allowedPort && Number(match[2] || 80) !== Number(allowedPort)) {
    return false;
  }
  return true;
}

export function loopbackHostAndCorsMiddleware({ allowedPort = null, allowExternalOAuthCallback = null } = {}) {
  return (req, res, next) => {
    const isLoopback = isLoopbackHostHeader(req.headers.host, { allowedPort });
    const isAllowedExternalCallback =
      !isLoopback &&
      typeof allowExternalOAuthCallback === 'function' &&
      allowExternalOAuthCallback(req) === true;

    if (!isLoopback && !isAllowedExternalCallback) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN_HOST', message: 'Requests must target loopback 127.0.0.1.' },
      });
    }

    const origin = req.headers.origin;
    if (origin) {
      let originOk = false;
      try {
        const parsed = new URL(origin);
        originOk =
          (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
          parsed.protocol === 'http:' &&
          (!allowedPort || Number(parsed.port || 80) === Number(allowedPort));
      } catch {
        originOk = false;
      }

      if (!originOk) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin access is blocked.' },
        });
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
    }

    next();
  };
}

export function createRateLimiter({ windowMs = 60_000, maxRequests = 120 } = {}) {
  const buckets = new Map();

  return (req, res, next) => {
    const key = `${req.ip || '127.0.0.1'}:${req.baseUrl || ''}`;
    const now = Date.now();
    const timestamps = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many local requests. Please slow down.' },
      });
    }
    timestamps.push(now);
    buckets.set(key, timestamps);
    next();
  };
}

export function errorHandlerMiddleware(logger = null) {
  return (err, req, res, _next) => {
    const status = Number(err?.statusCode) || 500;
    const code = err?.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
    const message = sanitizeErrorMessage(err, 'An unexpected error occurred.');

    if (status >= 500) {
      logger?.error('Unhandled API error', { path: req.path, method: req.method, code, error: message });
    }

    res.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(err?.details ? { details: err.details } : {}),
      },
    });
  };
}

