import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { parseCookies, timingSafeCompareString } from '../middleware/auth.js';
import { isLoopbackHostHeader } from '../middleware/security.js';
import { validateBody } from '../middleware/validate.js';
import { sanitizeErrorMessage } from '../../security/redact.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderOAuthCallbackHtml({ ok, platform, accounts = [], errorMessage = '' }) {
  const title = ok ? `${platform} Connected` : `${platform} Authorization Failed`;
  const summary = ok
    ? `Connected ${accounts.map((a) => escapeHtml(a.displayName)).join(', ')}. You can close this window and return to Antigravity or the Dashboard.`
    : `Authorization error: ${escapeHtml(errorMessage)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .card { max-width: 480px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { margin-top: 0; font-size: 1.35rem; color: ${ok ? '#4ade80' : '#f87171'}; }
    p { line-height: 1.5; color: #cbd5e1; }
    a { display: inline-block; margin-top: 14px; color: #38bdf8; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${summary}</p>
    <a href="/">Return to Dashboard</a>
  </div>
</body>
</html>`;
}

export function createAccountsRouter({ accountService, sessionsRepo, requireAuth, oauthCookieSecret = null, defaultPort = 4815 }) {
  const router = express.Router();
  const bindSecret = oauthCookieSecret || crypto.randomBytes(32);

  function signOAuthBindSession(sessionId) {
    const exp = Date.now() + 10 * 60 * 1000;
    const payload = `${sessionId}.${exp}`;
    const sig = crypto.createHmac('sha256', bindSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  function verifyOAuthBindCookie(rawCookie) {
    if (!rawCookie || typeof rawCookie !== 'string') return null;
    const parts = rawCookie.split('.');
    if (parts.length !== 3) return null;
    const [sessionId, expStr, providedSig] = parts;
    const exp = Number(expStr);
    if (!sessionId || !Number.isFinite(exp) || exp <= Date.now()) return null;
    const expectedSig = crypto
      .createHmac('sha256', bindSecret)
      .update(`${sessionId}.${expStr}`)
      .digest('base64url');
    return timingSafeCompareString(providedSig, expectedSig) ? sessionId : null;
  }

  function setOAuthBindCookieIfSession(req, res) {
    if (req.auth?.type === 'session' && req.auth.sessionId) {
      const signed = signOAuthBindSession(req.auth.sessionId);
      res.setHeader(
        'Set-Cookie',
        `smp_oauth_session=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/api/accounts/oauth/callback; Max-Age=600`
      );
    }
  }

  // OAuth Callbacks (authenticated via cryptographic single-use state + PKCE/session binding)
  router.get('/oauth/callback/:platform', async (req, res) => {
    const platform = req.params.platform;
    if (platform !== 'youtube' && platform !== 'instagram') {
      return res.status(404).send('Unsupported OAuth platform');
    }

    // If Meta/Google redirected to a configured HTTPS tunnel/domain callback, bounce the browser
    // back onto local loopback 127.0.0.1 so cookies and token exchange stay strictly local.
    if (!isLoopbackHostHeader(req.headers.host)) {
      const localPort = req.socket?.localPort || defaultPort || 4815;
      const qIdx = req.originalUrl.indexOf('?');
      const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
      return res.redirect(302, `http://127.0.0.1:${localPort}/api/accounts/oauth/callback/${platform}${qs}`);
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionRow = cookies.smp_session ? sessionsRepo.verifySession(cookies.smp_session) : null;
    const boundFromOAuthCookie = cookies.smp_oauth_session
      ? verifyOAuthBindCookie(cookies.smp_oauth_session)
      : null;

    if (cookies.smp_oauth_session) {
      res.setHeader(
        'Set-Cookie',
        'smp_oauth_session=; HttpOnly; SameSite=Lax; Path=/api/accounts/oauth/callback; Max-Age=0'
      );
    }

    try {
      const accounts = await accountService.handleOAuthCallback({
        platform,
        code: typeof req.query.code === 'string' ? req.query.code : null,
        state: typeof req.query.state === 'string' ? req.query.state : null,
        error: typeof req.query.error === 'string' ? req.query.error : null,
        errorDescription:
          typeof req.query.error_description === 'string' ? req.query.error_description : null,
        expectedSessionBinding: sessionRow?.id || boundFromOAuthCookie || 'anonymous-browser',
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderOAuthCallbackHtml({ ok: true, platform, accounts }));
    } catch (err) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(err?.statusCode || 400).send(
        renderOAuthCallbackHtml({
          ok: false,
          platform,
          errorMessage: sanitizeErrorMessage(err),
        })
      );
    }
  });

  // All management routes below require IPC Bearer token or authenticated Dashboard session + CSRF
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const platform =
      req.query.platform === 'youtube' || req.query.platform === 'instagram'
        ? req.query.platform
        : null;
    const accounts = accountService.listAccounts({ platform });
    res.json({ success: true, data: { accounts } });
  });

  const connectSchema = z.object({
    displayName: z.string().min(1).max(120).optional(),
    igLoginMode: z.enum(['meta_unified_login', 'facebook_login', 'instagram_login']).optional(),
  });

  router.post('/connect/youtube', validateBody(connectSchema), (req, res) => {
    setOAuthBindCookieIfSession(req, res);
    const result = accountService.startOAuthConnect({
      platform: 'youtube',
      displayName: req.validatedBody.displayName || null,
      sessionBinding: req.auth.sessionBinding,
    });
    res.json({ success: true, data: result });
  });

  router.post('/connect/instagram', validateBody(connectSchema), (req, res) => {
    setOAuthBindCookieIfSession(req, res);
    const result = accountService.startOAuthConnect({
      platform: 'instagram',
      displayName: req.validatedBody.displayName || null,
      igLoginMode: req.validatedBody.igLoginMode || null,
      sessionBinding: req.auth.sessionBinding,
    });
    res.json({ success: true, data: result });
  });

  router.get('/:id/status', async (req, res, next) => {
    try {
      const verifyLive = req.query.live !== 'false';
      const account = await accountService.checkAccountStatus(req.params.id, { verifyLive });
      res.json({ success: true, data: { account } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/refresh', async (req, res, next) => {
    try {
      const account = await accountService.refreshAccountToken(req.params.id);
      res.json({ success: true, data: { account } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/reauthorize', validateBody(connectSchema), (req, res, next) => {
    try {
      const existing = accountService.getAccount(req.params.id);
      setOAuthBindCookieIfSession(req, res);
      const result = accountService.startOAuthConnect({
        platform: existing.platform,
        displayName: existing.displayName,
        igLoginMode: req.validatedBody?.igLoginMode || existing.metadata?.loginMode || null,
        sessionBinding: req.auth.sessionBinding,
        accountIdToReauth: existing.id,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  const updatePrefsSchema = z.object({
    displayName: z.string().min(1).max(120).optional(),
    preferences: z
      .object({
        defaultPrivacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
        defaultCategoryId: z.string().max(16).optional(),
        defaultTags: z.array(z.string().max(60)).max(30).optional(),
        autoDetectShorts: z.boolean().optional(),
        shareToFeed: z.boolean().optional(),
        defaultInstagramVisibility: z
          .enum(['public', 'reels_only', 'trial_manual', 'trial_performance', 'private'])
          .optional(),
        tone: z.string().max(80).optional(),
      })
      .optional(),
  });

  router.patch('/:id', validateBody(updatePrefsSchema), (req, res, next) => {
    try {
      const account = accountService.updatePreferences(req.params.id, req.validatedBody);
      res.json({ success: true, data: { account } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/disconnect', (req, res, next) => {
    try {
      const account = accountService.disconnectAccount(req.params.id);
      res.json({ success: true, data: { account } });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', (req, res, next) => {
    try {
      const result = accountService.deleteAccount(req.params.id);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

