import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';

function isSafeEndpointOrRedirectUrl(val, { allowEmpty = false } = {}) {
  if (allowEmpty && val === '') return true;
  try {
    const parsed = new URL(val);
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isHttpOrHttpsUrlOrEmpty(val) {
  if (val === '') return true;
  try {
    const parsed = new URL(val);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const redirectUriSchema = z
  .string()
  .refine((v) => isSafeEndpointOrRedirectUrl(v, { allowEmpty: true }), {
    message: 'Redirect URI must use https:// or loopback http:// (127.0.0.1 / localhost).',
  });

const configIdSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[A-Za-z0-9_-]{4,64}$/.test(v), {
    message: 'Meta Unified Login Configuration ID (config_id) must be 4-64 alphanumeric/digit characters (or blank to clear).',
  });

function isNotMetaAccessToken(val) {
  const trimmed = String(val || '').trim();
  if (!trimmed) return true;
  return !/^(?:EAA|EAAB|EAAG|IGAA|IGAAR|IGQ)[A-Za-z0-9._-]{20,}$/.test(trimmed);
}

const secureStorageEndpointSchema = z
  .string()
  .refine((v) => isSafeEndpointOrRedirectUrl(v, { allowEmpty: true }), {
    message: 'Storage endpoint must use https:// (or loopback http:// for local tests).',
  });

export function createSetupRouter({ credentialStore, config, tempHosting = null }) {
  const router = express.Router();

  async function buildStatusResponse() {
    const masked = credentialStore.getMaskedProviderStatus(config);
    if (!tempHosting) return masked;
    const creds = credentialStore.resolveEffectiveCredentials(config);
    const r2Usage = await tempHosting.getUsageStatus(creds.storage, { live: false });
    return {
      ...masked,
      r2Usage,
    };
  }

  // Returns ONLY masked indicators / booleans — never raw credentials!
  router.get('/status', async (_req, res, next) => {
    try {
      res.json({
        success: true,
        data: await buildStatusResponse(),
      });
    } catch (err) {
      next(err);
    }
  });

  const updateCredsSchema = z.object({
    youtube: z
      .object({
        clientId: z.string().max(500).optional(),
        clientSecret: z.string().max(500).optional(),
        redirectUri: redirectUriSchema.optional(),
      })
      .optional(),
    instagram: z
      .object({
        appId: z
          .string()
          .trim()
          .max(500)
          .refine(isNotMetaAccessToken, {
            message: 'Enter your Meta App ID from App settings -> Basic, not a generated EAA/IGAA access token.',
          })
          .optional(),
        appSecret: z
          .string()
          .trim()
          .max(500)
          .refine(isNotMetaAccessToken, {
            message: 'Enter your Meta App Secret from App settings -> Basic, not a generated EAA/IGAA access token.',
          })
          .optional(),
        configId: configIdSchema.optional(),
        loginMode: z.enum(['meta_unified_login', 'facebook_login', 'instagram_login']).optional(),
        redirectUri: redirectUriSchema.optional(),
      })
      .optional(),
    storage: z
      .object({
        provider: z.enum(['r2', 's3']).optional(),
        accountId: z.string().max(200).optional(),
        bucket: z.string().max(200).optional(),
        endpoint: secureStorageEndpointSchema.optional(),
        accessKeyId: z.string().max(500).optional(),
        secretAccessKey: z.string().max(500).optional(),
        region: z.string().max(64).optional(),
        urlTtlSeconds: z.number().int().min(60).max(3600).optional(),
        retentionMinutes: z.number().int().min(5).max(1440).optional(),
        monthlyUploadLimitCount: z.number().int().min(1).max(10000).optional(),
        monthlyUploadLimitMb: z.number().int().min(1).max(102400).optional(),
        monthlyUploadLimitBytes: z.number().int().min(1024).max(107374182400).optional(),
      })
      .optional(),
    ai: z
      .object({
        provider: z.enum(['auto', 'gemini', 'openai', 'anthropic', 'ollama', 'deterministic']).optional(),
        geminiApiKey: z.string().max(500).optional(),
        geminiModel: z.string().max(100).optional(),
        openaiApiKey: z.string().max(500).optional(),
        openaiModel: z.string().max(100).optional(),
        anthropicApiKey: z.string().max(500).optional(),
        anthropicModel: z.string().max(100).optional(),
        ollamaBaseUrl: z
          .string()
          .refine(isHttpOrHttpsUrlOrEmpty, { message: 'Ollama URL must use http:// or https://.' })
          .optional(),
        ollamaModel: z.string().max(100).optional(),
      })
      .optional(),
    dashboardPasscode: z.string().min(8).max(200).optional(),
  });

  router.post('/credentials', validateBody(updateCredsSchema), async (req, res, next) => {
    try {
      const body = req.validatedBody;
      if (body.youtube) credentialStore.saveProviderConfig('youtube', body.youtube);
      if (body.instagram) credentialStore.saveProviderConfig('instagram', body.instagram);
      if (body.storage) {
        const storagePatch = { ...body.storage };
        if (
          storagePatch.monthlyUploadLimitMb !== undefined &&
          storagePatch.monthlyUploadLimitBytes === undefined
        ) {
          storagePatch.monthlyUploadLimitBytes = storagePatch.monthlyUploadLimitMb * 1024 * 1024;
        }
        credentialStore.saveProviderConfig('storage', storagePatch);
      }
      if (body.ai) credentialStore.saveProviderConfig('ai', body.ai);
      if (body.dashboardPasscode) credentialStore.setDashboardPasscode(body.dashboardPasscode);

      res.json({
        success: true,
        data: await buildStatusResponse(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

