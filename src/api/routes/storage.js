import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';

export function createStorageRouter({ tempHosting, credentialStore, config }) {
  const router = express.Router();

  router.get('/usage', async (req, res, next) => {
    try {
      const live = String(req.query.live || '').toLowerCase() === 'true';
      const creds = credentialStore.resolveEffectiveCredentials(config);
      const usage = await tempHosting.getUsageStatus(creds.storage, { live });
      res.json({ success: true, data: usage });
    } catch (err) {
      next(err);
    }
  });

  const cleanupSchema = z.object({
    force: z.boolean().optional(),
  });

  router.post('/cleanup', validateBody(cleanupSchema), async (req, res, next) => {
    try {
      const creds = credentialStore.resolveEffectiveCredentials(config);
      const cleanup = await tempHosting.runRetentionCleanup(creds.storage, {
        force: Boolean(req.validatedBody?.force),
      });
      const usage = await tempHosting.getUsageStatus(creds.storage, { live: false });
      res.json({ success: true, data: { cleanup, usage } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

