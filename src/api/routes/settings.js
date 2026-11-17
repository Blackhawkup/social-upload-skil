import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { expandHome } from '../../config/paths.js';
import { isPathInsideAnyDir } from '../../media/discovery.js';

export function createSettingsRouter({ settingsRepo, config }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        settings: settingsRepo.getAllSettings(config),
      },
    });
  });

  const updateSchema = z.object({
    publishMode: z.enum(['review', 'autopilot']).optional(),
    defaultAccountIds: z.array(z.string().max(100)).max(50).optional(),
    videoWatchDirs: z.array(z.string().min(1).max(500)).max(30).optional(),
    autoDetectShorts: z.boolean().optional(),
    autoCleanupTempMedia: z.boolean().optional(),
    defaultPrivacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
  });

  router.post('/', validateBody(updateSchema), (req, res) => {
    const patch = { ...req.validatedBody };
    if (Array.isArray(patch.videoWatchDirs)) {
      const p = config?.paths || {};
      const blocked = [p.credentialsDir, p.secretsDir, p.dataDir, p.logsDir].filter(Boolean);
      const dirs = patch.videoWatchDirs.map((d) => expandHome(d.trim())).filter(Boolean);
      for (const dir of dirs) {
        if (isPathInsideAnyDir(dir, blocked)) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'FORBIDDEN_WATCH_DIR',
              message: 'Watched video directory cannot point inside credentials, secrets, data, or logs.',
            },
          });
        }
      }
      patch.videoWatchDirs = dirs;
    }
    const updated = settingsRepo.updateSettings(patch, config);
    res.json({
      success: true,
      data: {
        settings: updated,
      },
    });
  });

  return router;
}

