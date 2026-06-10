/**
 * Middleware de autenticación Bearer token
 * - Lee el header Authorization: Bearer <token>
 * - Valida vía TokenService
 * - Adjunta req.user con los claims
 */
'use strict';

const config = require('../config');
const tokenService = require('../auth/token-service');
const logger = require('../config/logger');

/**
 * Devuelve el header WWW-Authenticate según RFC 6750
 */
function buildWwwAuthenticate(errorCode, errorDescription) {
  const parts = [
    'Bearer',
    `realm="mcp"`,
    `resource_metadata="${config.auth.issuer}/.well-known/oauth-protected-resource"`,
  ];
  if (errorCode) parts.push(`error="${errorCode}"`);
  if (errorDescription) parts.push(`error_description="${errorDescription}"`);
  return parts.join(', ');
}

/**
 * Middleware Express que requiere un Bearer token válido
 * - SKIP_AUTH=true en env desactiva auth (solo dev)
 * - Permite methods initialize sin token (handshake MCP)
 */
function authMiddleware(options = {}) {
  const { allowInitialize = true } = options;

  return async function (req, res, next) {
    // Modo sin auth (solo dev)
    if (!config.auth.enabled) {
      req.user = { sub: 'anonymous', scope: 'mcp:*' };
      return next();
    }

    // Permitir handshake initialize sin token
    if (allowInitialize && req.method === 'POST' && req.body && req.body.method === 'initialize') {
      return next();
    }

    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.set('WWW-Authenticate', buildWwwAuthenticate('invalid_token', 'Bearer token required'));
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required' },
        id: null,
      });
    }

    const token = match[1].trim();
    const result = await tokenService.verify(token);

    if (!result.valid) {
      logger.debug('Auth rejected', { reason: result.reason, path: req.path });
      res.set('WWW-Authenticate', buildWwwAuthenticate(result.reason));
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or expired token' },
        id: null,
      });
    }

    req.user = result.claims;
    req.token = token;
    next();
  };
}

module.exports = { authMiddleware, buildWwwAuthenticate };
