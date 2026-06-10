/**
 * MCP Memory Server - Entry point
 *
 * Arquitectura:
 *   Cliente MCP \u2192 Express principal (auth, rate limit, CORS) \u2192 /mcp \u2192 Streamable HTTP \u2192 memento (stdio)
 *
 * Stack:
 *  - Express 5
 *  - @modelcontextprotocol/sdk v1.29 (Streamable HTTP transport)
 *  - memento (CLI externo, v\u00eda stdio)
 *  - better-sqlite3 (para el graph viewer)
 *  - jose (JWT/OAuth 2.1)
 */
'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./config/logger');
const { authMiddleware } = require('./middleware/auth');
const { originMiddleware, isOriginAllowed } = require('./middleware/origin');
const { buildMcpRouter } = require('./mcp/router');
const { buildGraphRouter } = require('./graph/router');
const oauthRoutes = require('./auth/oauth-routes');
const tokenService = require('./auth/token-service');

/**
 * Crea la aplicaci\u00f3n Express (sin iniciar el servidor).
 * @returns {express.Express}
 */
function createApp() {
  const app = express();

  // ==================== Middleware global ====================

  // CORS
  const corsOptions = {
    origin: (origin, callback) => {
      // Permitir requests sin Origin (server-to-server, curl, etc.)
      if (!origin) return callback(null, true);
      // En dev, permitir todo
      if (config.nodeEnv === 'development') return callback(null, true);
      // En prod, validar contra la lista
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-Id'],
    exposedHeaders: ['Mcp-Session-Id'],
    maxAge: 86400,
  };
  app.use(cors(corsOptions));

  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      return req.path === '/health' ||
             req.path === '/.well-known/oauth-authorization-server' ||
             req.path === '/.well-known/oauth-protected-resource';
    },
    handler: (req, res) => {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Rate limit exceeded' },
        id: null,
      });
    },
  });
  app.use(limiter);

  // ==================== Rutas p\u00fablicas ====================

  // Health (p\u00fablico, no auth)
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      auth: config.auth.enabled,
      sessions: tokenService.stats(),
    });
  });

  // OAuth 2.1 endpoints (p\u00fablicos)
  app.use(oauthRoutes);

  // ==================== Rutas MCP (con auth) ====================

  const mcpRouter = buildMcpRouter();
  app.use('/', originMiddleware());
  app.use('/', authMiddleware({ allowInitialize: true }));
  app.use('/', mcpRouter);

  // ==================== Graph Viewer (con auth) ====================

  if (config.graph.enabled) {
    const graphRouter = buildGraphRouter();
    app.use('/', originMiddleware());
    app.use('/', authMiddleware({ allowInitialize: false }));
    app.use('/', graphRouter);
  }

  // ==================== 404 y errores ====================

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Inicia el servidor HTTP y configura graceful shutdown.
 * @param {express.Express} app
 * @param {object} [options]
 * @param {boolean} [options.gracefulShutdown=true] - Si true, registra handlers para SIGTERM/SIGINT
 * @returns {http.Server}
 */
function start(app, options = {}) {
  const { gracefulShutdown = true } = options;
  if (!app) app = createApp();

  logger.info('Starting MCP Memory Server', {
    env: config.nodeEnv,
    port: config.port,
    authEnabled: config.auth.enabled,
    graphEnabled: config.graph.enabled,
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info(`HTTP server listening on http://${config.host}:${config.port}`);
    logger.info(`MCP endpoint: ${config.mcp.endpoint}`);
    logger.info(`Auth: ${config.auth.enabled ? 'enabled' : 'DISABLED (set AUTH_ENABLED=true)'}`);
    if (config.auth.enabled && config.auth.staticTokens.length > 0) {
      logger.info(`Static tokens configured: ${config.auth.staticTokens.length}`);
    }
    if (config.graph.enabled) {
      logger.info(`Graph viewer at / (UI) and /api/* (data)`);
    }
  });

  if (gracefulShutdown) {
    // Graceful shutdown
    let shuttingDown = false;
    function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} received, shutting down gracefully`);
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      // Forzar cierre de conexiones keep-alive
      if (typeof server.closeAllConnections === 'function') {
        setTimeout(() => server.closeAllConnections(), 2000);
      }
      setTimeout(() => {
        logger.warn('Forced shutdown after 10s');
        process.exit(1);
      }, 10000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  return server;
}

// Si se ejecuta directamente, iniciar el servidor
if (require.main === module) {
  const app = createApp();
  start(app);
}

module.exports = { createApp, start };
