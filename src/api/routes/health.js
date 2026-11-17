import express from 'express';

export function createHealthRouter() {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        service: 'social-media-publisher',
        loopbackOnly: true,
        timestamp: new Date().toISOString(),
      },
    });
  });

  return router;
}

