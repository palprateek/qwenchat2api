/**
 * Qwen OpenAI-Compatible Proxy Server
 *
 * A production-grade proxy that translates OpenAI API requests
 * into chat.qwen.ai backend calls, supporting SSE streaming,
 * tool calling, and conversation persistence.
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createLogger } from './utils/logger';
import { AuthManager } from './auth/auth-manager';
import { QwenClient } from './client/qwen-client';
import { ProxyRouter } from './proxy/router';
import { SessionManager } from './session/session-manager';
import { errorHandler } from './utils/error-handler';
import { RateLimiter } from './utils/rate-limiter';

const logger = createLogger('server');

async function main() {
  const PORT = parseInt(process.env.PORT || '5000', 10);
  const HOST = process.env.HOST || '0.0.0.0';

  // Initialize auth manager
  const authManager = new AuthManager();
  await authManager.initialize();

  // Initialize session manager
  const sessionManager = new SessionManager();

  // Initialize Qwen API client
  const qwenClient = new QwenClient(authManager, sessionManager);
  await qwenClient.initialize();

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(
    parseInt(process.env.RATE_LIMIT || '30', 10)
  );

  // Create Express app
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`, {
      headers: req.headers,
      body: req.body ? Object.keys(req.body) : [],
    });
    next();
  });

  // Health check
  app.get('/health', (_req, res) => {
    const authStatus = authManager.getStatus();
    res.json({
      status: 'ok',
      auth: authStatus,
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });

  // API routes
  const proxyRouter = new ProxyRouter(qwenClient, authManager, rateLimiter, sessionManager);
  app.use('/', proxyRouter.getRouter());

  // Error handler (must be last)
  app.use(errorHandler);

  // Start server
  const server = app.listen(PORT, HOST, () => {
    logger.info(`Qwen OpenAI Proxy running on http://${HOST}:${PORT}`);
    logger.info(`OpenAI-compatible endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
    logger.info(`Models endpoint: http://${HOST}:${PORT}/v1/models`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    server.close();
    await sessionManager.flush();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
