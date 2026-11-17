import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';

export function createCaptionsRouter({ metadataService }) {
  const router = express.Router();

  const generateSchema = z.object({
    videoId: z.string().max(100).optional(),
    videoPath: z.string().max(1000).optional(),
    accountIds: z.array(z.string().max(100)).optional(),
    customOverrides: z
      .object({
        authorMode: z.enum(['auto', 'antigravity', 'ai', 'deterministic']).optional(),
        contentSummary: z.string().max(1000).optional(),
        detectedLanguage: z.string().max(16).optional(),
        detectedTone: z.string().max(64).optional(),
        youtube: z
          .object({
            title: z.string().max(100).optional(),
            description: z.string().max(5000).optional(),
            hashtags: z.array(z.string().max(60)).max(10).optional(),
            tags: z.array(z.string().max(60)).max(30).optional(),
            categoryId: z.string().max(16).optional(),
            pinnedComment: z.string().max(1000).optional(),
            defaultLanguage: z.string().max(16).optional(),
            madeForKids: z.boolean().optional(),
          })
          .optional(),
        instagram: z
          .object({
            caption: z.string().max(2200).optional(),
            hashtags: z.array(z.string().max(60)).max(15).optional(),
            callToAction: z.string().max(300).optional(),
            emojis: z.array(z.string().max(16)).max(8).optional(),
            thumbOffsetMs: z.number().int().min(0).optional(),
            audioName: z.string().max(120).optional(),
          })
          .optional(),
      })
      .optional(),
  });

  router.post('/generate', validateBody(generateSchema), async (req, res, next) => {
    try {
      const generated = await metadataService.generateForVideo(req.validatedBody);
      res.json({ success: true, data: generated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

