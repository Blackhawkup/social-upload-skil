import express from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../middleware/validate.js';

const publishOptionsSchema = z
  .object({
    privacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
    publishAt: z.string().datetime().optional(),
    asShort: z.boolean().optional(),
    defaultLanguage: z.string().max(16).optional(),
    madeForKids: z.boolean().optional(),
    shareToFeed: z.boolean().optional(),
    instagramVisibility: z
      .enum(['public', 'reels_only', 'trial_manual', 'trial_performance', 'private'])
      .optional(),
    confirmPrivateInstagramAccount: z.boolean().optional(),
    thumbOffsetMs: z.number().int().min(0).optional(),
    audioName: z.string().max(120).optional(),
    padToVertical: z.boolean().optional(),
  })
  .optional();

const metadataOverridesSchema = z
  .object({
    authorMode: z.enum(['auto', 'antigravity', 'ai', 'deterministic']).optional(),
    contentSummary: z.string().max(1000).optional(),
    detectedLanguage: z.string().max(16).optional(),
    detectedTone: z.string().max(64).optional(),
    youtube: z.record(z.unknown()).optional(),
    instagram: z.record(z.unknown()).optional(),
    perAccount: z.record(z.record(z.unknown())).optional(),
  })
  .optional();

export function createPublishRouter({ publishService }) {
  const router = express.Router();

  const singleSchema = z.object({
    accountId: z.string().min(1).max(100),
    videoId: z.string().max(100).optional(),
    videoPath: z.string().max(1000).optional(),
    metadataOverrides: metadataOverridesSchema,
    options: publishOptionsSchema,
    approved: z.boolean().optional(),
    allowDuplicate: z.boolean().optional(),
    waitForCompletion: z.boolean().optional(),
  });

  router.post('/youtube', validateBody(singleSchema), async (req, res, next) => {
    try {
      const b = req.validatedBody;
      const result = await publishService.createAndMaybePublish({
        videoId: b.videoId,
        videoPath: b.videoPath,
        accountIds: [b.accountId],
        metadataOverrides: b.metadataOverrides,
        options: b.options || {},
        requestedBy: req.auth?.type || 'api',
        approved: Boolean(b.approved),
        allowDuplicate: Boolean(b.allowDuplicate),
        waitForCompletion: b.waitForCompletion ?? false,
      });
      res.status(result.requiresApproval ? 200 : 202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post('/instagram', validateBody(singleSchema), async (req, res, next) => {
    try {
      const b = req.validatedBody;
      const result = await publishService.createAndMaybePublish({
        videoId: b.videoId,
        videoPath: b.videoPath,
        accountIds: [b.accountId],
        metadataOverrides: b.metadataOverrides,
        options: b.options || {},
        requestedBy: req.auth?.type || 'api',
        approved: Boolean(b.approved),
        allowDuplicate: Boolean(b.allowDuplicate),
        waitForCompletion: b.waitForCompletion ?? false,
      });
      res.status(result.requiresApproval ? 200 : 202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  const multipleSchema = z.object({
    accountIds: z.array(z.string().min(1).max(100)).optional(),
    videoId: z.string().max(100).optional(),
    videoPath: z.string().max(1000).optional(),
    metadataOverrides: metadataOverridesSchema,
    options: publishOptionsSchema,
    approved: z.boolean().optional(),
    allowDuplicate: z.boolean().optional(),
    waitForCompletion: z.boolean().optional(),
  });

  router.post('/multiple', validateBody(multipleSchema), async (req, res, next) => {
    try {
      const b = req.validatedBody;
      const result = await publishService.createAndMaybePublish({
        videoId: b.videoId,
        videoPath: b.videoPath,
        accountIds: b.accountIds || [],
        metadataOverrides: b.metadataOverrides,
        options: b.options || {},
        requestedBy: req.auth?.type || 'api',
        approved: Boolean(b.approved),
        allowDuplicate: Boolean(b.allowDuplicate),
        waitForCompletion: b.waitForCompletion ?? false,
      });
      res.status(result.requiresApproval ? 200 : 202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  const historyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    status: z
      .enum([
        'awaiting_approval',
        'queued',
        'running',
        'completed',
        'partial_success',
        'failed',
        'cancelled',
      ])
      .optional(),
  });

  router.get('/history', validateQuery(historyQuerySchema), (req, res) => {
    const jobs = publishService.listHistory(req.validatedQuery);
    res.json({ success: true, data: { jobs } });
  });

  router.get('/:id/status', (req, res, next) => {
    try {
      const job = publishService.getJobStatus(req.params.id);
      res.json({ success: true, data: { job } });
    } catch (err) {
      next(err);
    }
  });

  const approveSchema = z.object({
    itemOverrides: z.record(z.record(z.unknown())).optional(),
    waitForCompletion: z.boolean().optional(),
  });

  router.post('/:id/approve', validateBody(approveSchema), async (req, res, next) => {
    try {
      const job = await publishService.approveAndPublish(req.params.id, {
        itemOverrides: req.validatedBody.itemOverrides || {},
        waitForCompletion: req.validatedBody.waitForCompletion ?? false,
      });
      res.json({ success: true, data: { job } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/cancel', (req, res, next) => {
    try {
      const job = publishService.cancelJob(req.params.id);
      res.json({ success: true, data: { job } });
    } catch (err) {
      next(err);
    }
  });

  const retrySchema = z.object({
    itemIds: z.array(z.string().max(100)).optional(),
    waitForCompletion: z.boolean().optional(),
  });

  router.post('/:id/retry', validateBody(retrySchema), async (req, res, next) => {
    try {
      const job = await publishService.retryFailed(req.params.id, {
        itemIds: req.validatedBody.itemIds || null,
        waitForCompletion: req.validatedBody.waitForCompletion ?? false,
      });
      res.json({ success: true, data: { job } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

