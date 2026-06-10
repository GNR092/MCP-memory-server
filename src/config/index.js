/**
 * Configuración del servidor MCP Memory
 * Carga variables de entorno y define defaults seguros
 */
'use strict';

require('dotenv').config();

const path = require('path');

const config = {
  // Servidor
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // MCP transport - Solo Streamable HTTP (sin SSE deprecated)
  mcp: {
    endpoint: process.env.MCP_ENDPOINT || '/mcp',
    protocolVersion: '2025-06-18',
    sessionTimeoutMs: parseInt(process.env.MCP_SESSION_TIMEOUT_MS || '3600000', 10), // 1h
  },

  // Graph Viewer
  graph: {
    enabled: process.env.GRAPH_ENABLED !== 'false',
    port: parseInt(process.env.GRAPH_PORT || '3022', 10),
    dbPath: process.env.DB_PATH || path.join(__dirname, '..', '..', 'memorydata', 'memory.db'),
    pollingInterval: parseInt(process.env.POLLING_INTERVAL || '2000', 10),
  },

  // Seguridad / OAuth 2.1
  auth: {
    enabled: process.env.AUTH_ENABLED === 'true',
    issuer: process.env.AUTH_ISSUER || 'http://localhost:3000',
    audience: process.env.AUTH_AUDIENCE || 'mcp-memory-server',
    jwtSecret: process.env.JWT_SECRET || 'change-me-in-production-please-use-32-bytes',
    jwtAlgorithm: process.env.JWT_ALGORITHM || 'HS256',
    accessTokenTtl: parseInt(process.env.ACCESS_TOKEN_TTL || '3600', 10), // 1h
    refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10), // 7d
    // Permite tokens estáticos desde env (modo simple, no OAuth completo)
    staticTokens: (process.env.STATIC_TOKENS || '').split(',').filter(Boolean),
    // CORS origins permitidos
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 min
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // 100 req/min
  },

  // Logging
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Validaciones de seguridad en producción
if (config.nodeEnv === 'production') {
  if (config.auth.jwtSecret === 'change-me-in-production-please-use-32-bytes') {
    console.error('[CONFIG] ERROR: JWT_SECRET no puede ser el default en producción');
    process.exit(1);
  }
  if (config.host === '0.0.0.0' && !config.auth.allowedOrigins.length) {
    console.warn('[CONFIG] WARN: HOST=0.0.0.0 sin ALLOWED_ORIGINS definidos');
  }
}

module.exports = config;
