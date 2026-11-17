import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { parseCookies, timingSafeCompareString } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export class BootstrapTokenManager {
  constructor() {
    this.tokens = new Map();
  }

  issue({ ttlMs = 15 * 60 * 1000, reusable = false } = {}) {
    const code = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(code, {
      expiresAt: Date.now() + ttlMs,
      reusable,
    });
    return code;
  }

  consume(code) {
    if (!code || typeof code !== 'string') return false;
    for (const [k, entry] of this.tokens.entries()) {
      if (entry.expiresAt <= Date.now()) {
        this.tokens.delete(k);
        continue;
      }
      if (timingSafeCompareString(code, k)) {
        if (!entry.reusable) {
          this.tokens.delete(k);
        }
        return true;
      }
    }
    return false;
  }
}

export function createAuthRouter({
  sessionsRepo,
  credentialStore,
  bootstrapManager,
  requireAuth,
  authAttemptLimiter = (_req, _res, next) => next(),
}) {
  const router = express.Router();

  function setSessionCookie(res, rawToken) {
    res.setHeader(
      'Set-Cookie',
      `smp_session=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
    );
  }

  router.get('/status', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionRow = cookies.smp_session ? sessionsRepo.verifySession(cookies.smp_session) : null;
    const dashConfig = credentialStore.loadProviderConfig('dashboard');
    const isSameOriginFetch = req.headers['sec-fetch-site'] !== 'cross-site';
    const csrfToken =
      sessionRow && isSameOriginFetch ? sessionsRepo.getCsrfTokenForSession(sessionRow) : null;

    res.json({
      success: true,
      data: {
        authenticated: Boolean(sessionRow),
        passcodeConfigured: Boolean(dashConfig.passcodeHash),
        ...(csrfToken ? { csrfToken } : {}),
      },
    });
  });

  // Mint a fresh bootstrap code (IPC-authenticated, e.g. via `npm run dashboard` or Antigravity helper)
  router.post('/bootstrap-link', requireAuth, (req, res) => {
    if (req.auth?.type !== 'ipc') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only local IPC clients can mint dashboard bootstrap links.' },
      });
    }
    const code = bootstrapManager.issue({ ttlMs: 10 * 60 * 1000, reusable: false });
    res.json({ success: true, data: { bootstrapCode: code, expiresInSeconds: 600 } });
  });

  const bootstrapSchema = z.object({
    bootstrapCode: z.string().min(12),
  });

  router.post('/bootstrap', authAttemptLimiter, validateBody(bootstrapSchema), (req, res) => {
    const ok = bootstrapManager.consume(req.validatedBody.bootstrapCode);
    if (!ok) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_BOOTSTRAP_CODE', message: 'Invalid or expired dashboard launch code.' },
      });
    }
    const session = sessionsRepo.createSession();
    setSessionCookie(res, session.rawToken);
    res.json({
      success: true,
      data: {
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      },
    });
  });

  const loginSchema = z.object({
    passcode: z.string().min(1),
  });

  router.post('/login', authAttemptLimiter, validateBody(loginSchema), (req, res) => {
    const dashConfig = credentialStore.loadProviderConfig('dashboard');
    if (!dashConfig.passcodeHash) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PASSCODE_NOT_SET',
          message: 'No dashboard passcode configured yet. Open the terminal launch URL with bootstrap token or run npm run setup.',
        },
      });
    }
    if (!credentialStore.verifyDashboardPasscode(req.validatedBody.passcode)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_PASSCODE', message: 'Incorrect dashboard passcode.' },
      });
    }
    const session = sessionsRepo.createSession();
    setSessionCookie(res, session.rawToken);
    res.json({
      success: true,
      data: {
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      },
    });
  });

  router.post('/logout', requireAuth, (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.smp_session) {
      sessionsRepo.deleteByRawToken(cookies.smp_session);
    }
    res.setHeader('Set-Cookie', 'smp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true, data: { authenticated: false } });
  });

  return router;
}

