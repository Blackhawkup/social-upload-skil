import { buildApplication } from './api/app.js';

export function startBackendServer(options = {}) {
  const ctx = buildApplication({
    ...options,
    enforcePort: options.enforcePort ?? (options.configOverrides?.port !== 0),
  });
  const { app, config, logger, bootstrapManager, cleanupTempStorage, db } = ctx;

  // Bind strictly to 127.0.0.1 (loopback only)
  const server = app.listen(config.port, '127.0.0.1', () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
    const launchCode = bootstrapManager.issue({ ttlMs: 30 * 60 * 1000, reusable: false });
    const dashboardLaunchUrl = `http://127.0.0.1:${actualPort}/?bootstrap=${launchCode}`;

    logger.info('Social Media Publisher backend started (loopback only)', {
      host: '127.0.0.1',
      port: actualPort,
      keyStore: ctx.masterKeyStore.getStorageBackendInfo(),
    });

    process.stderr.write(`\n[Social Media Publisher] Running on http://127.0.0.1:${actualPort}\n`);
    if (process.env.SUPPRESS_BOOTSTRAP_LOG !== '1') {
      process.stderr.write(`[Dashboard Launch URL] ${dashboardLaunchUrl}\n\n`);
    } else {
      process.stderr.write('\n');
    }
  });

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      logger.warn('Port already in use on 127.0.0.1; exiting cleanly', { port: config.port });
      try {
        db.close();
      } catch {
        // ignore
      }
      if (options.attachSignals !== false) {
        process.exit(0);
      }
      return;
    }
    logger.error('HTTP server failed', { error: err?.message, code: err?.code });
    if (options.attachSignals !== false) {
      process.exit(1);
    }
  });

  // Run startup cleanup once immediately (non-blocking), then periodically every 10 minutes
  cleanupTempStorage().catch((err) => {
    logger.warn('Startup temp media cleanup failed', { error: err?.message });
  });

  const cleanupTimer = setInterval(() => {
    cleanupTempStorage().catch((err) => {
      logger.warn('Periodic temp media cleanup failed', { error: err?.message });
    });
  }, 10 * 60 * 1000);
  cleanupTimer.unref();

  const shutdown = () => {
    clearInterval(cleanupTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  if (options.attachSignals !== false) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  return { ...ctx, server, shutdown, cleanupTimer };
}

// Run when executed directly as main script
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBackendServer();
}
