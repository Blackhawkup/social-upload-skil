import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';

export function createVideosRouter({ videoService }) {
  const router = express.Router();

  const findSchema = z.object({
    explicitPath: z.string().max(1000).optional(),
    query: z.string().max(300).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  });

  router.post('/find', validateBody(findSchema), (req, res, next) => {
    try {
      const videos = videoService.findVideos(req.validatedBody);
      res.json({ success: true, data: { videos } });
    } catch (err) {
      next(err);
    }
  });

  const analyzeSchema = z.object({
    videoPath: z.string().max(1000).optional(),
    query: z.string().max(300).optional(),
    extractFrames: z.boolean().optional(),
  });

  router.post('/analyze', validateBody(analyzeSchema), async (req, res, next) => {
    try {
      const video = await videoService.analyzeVideo(req.validatedBody);
      res.json({ success: true, data: { video } });
    } catch (err) {
      next(err);
    }
  });

  const validateSchema = z.object({
    videoId: z.string().max(100).optional(),
    videoPath: z.string().max(1000).optional(),
    targets: z
      .array(
        z.object({
          accountId: z.string().max(100).optional(),
          platform: z.enum(['youtube', 'instagram']),
          isShort: z.boolean().optional(),
        })
      )
      .min(1),
  });

  router.post('/validate', validateBody(validateSchema), async (req, res, next) => {
    try {
      const result = await videoService.validateVideo(req.validatedBody);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

