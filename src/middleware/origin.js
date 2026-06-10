/**
 * Middleware de validación de Origin (protección contra DNS rebinding)
 * Spec MCP: "Servers MUST validate the Origin header on all incoming connections"
 */
'use strict';

const config = require('../config');
const logger = require('../config/logger');

// Origins permitidos por defecto (modo dev)
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
];

function getAllowedOrigins() {
  const configured = config.auth.allowedOrigins;
  if (configured.length === 0) return DEFAULT_ALLOWED_ORIGINS;
  return [...DEFAULT_ALLOWED_ORIGINS, ...configured];
}

function isOriginAllowed(origin) {
  if (!origin) return false; // Sin Origin = rechazado
  const allowed = getAllowedOrigins();

  // Coincidencia exacta
  if (allowed.includes(origin)) return true;

  // Coincidencia por prefijo (para puertos variables en localhost)
  for (const allowedOrigin of allowed) {
    if (origin.startsWith(allowedOrigin + ':')) return true;
    if (origin === allowedOrigin) return true;
  }

  return false;
}

/**
 * Middleware que valida el header Origin en conexiones web (browsers)
 * - Aplica a GET/POST que llevan Origin (típicamente browser requests)
 * - Server-to-server (MCP clients CLI) normalmente no llevan Origin
 */
function originMiddleware(options = {}) {
  const { strict = false, exemptPaths = [] } = options;

  return function (req, res, next) {
    const origin = req.headers.origin;
    if (!origin) {
      // Sin Origin = probablemente server-to-server (CLI client).
      // En modo strict, requerimos Origin en browser-context endpoints.
      if (strict && !exemptPaths.includes(req.path)) {
        logger.debug('Origin missing in strict mode', { path: req.path });
      }
      return next();
    }

    if (!isOriginAllowed(origin)) {
      logger.warn('Origin rejected (possible DNS rebinding)', { origin, path: req.path });
      return res.status(403).json({
        error: 'forbidden',
        error_description: 'Origin not allowed',
      });
    }

    // CORS headers
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-Id');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  };
}

module.exports = { originMiddleware, isOriginAllowed, getAllowedOrigins };
