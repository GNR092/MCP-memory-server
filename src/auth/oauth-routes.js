/**
 * OAuth 2.1 endpoints:
 * - /.well-known/oauth-authorization-server (metadata discovery)
 * - /.well-known/oauth-protected-resource (protected resource metadata, RFC 9728)
 * - /oauth/authorize (authorization endpoint con PKCE)
 * - /oauth/token (token endpoint)
 * - /oauth/register (dynamic client registration, RFC 7591)
 * - /oauth/revoke (token revocation)
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const logger = require('../config/logger');
const tokenService = require('./token-service');

const router = express.Router();

// Almacén in-memory de clientes y authorization codes
const clients = new Map(); // client_id -> { client_secret, redirect_uris, ... }
const authCodes = new Map(); // code -> { client_id, redirect_uri, code_challenge, scope, expires_at }

// ==================== Metadata Discovery ====================

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = config.auth.issuer;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['mcp:read', 'mcp:write'],
  });
});

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: config.auth.audience,
    authorization_servers: [config.auth.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:read', 'mcp:write'],
  });
});

// ==================== Dynamic Client Registration (RFC 7591) ====================

router.post('/oauth/register', express.json(), (req, res) => {
  const { client_name, redirect_uris, grant_types, token_endpoint_auth_method } = req.body || {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris required' });
  }

  // Validar redirect URIs (deben ser localhost o HTTPS)
  for (const uri of redirect_uris) {
    try {
      const u = new URL(uri);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: `redirect_uri must be HTTPS or localhost: ${uri}`,
        });
      }
    } catch (e) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'invalid redirect_uri' });
    }
  }

  const clientId = `client_${crypto.randomBytes(16).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('hex');

  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client_name || 'MCP Client',
    redirect_uris,
    grant_types: grant_types || ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
  };

  clients.set(clientId, client);
  logger.info('OAuth client registered', { clientId, clientName: client.client_name });

  res.status(201).json(client);
});

// ==================== Authorization Endpoint (con PKCE) ====================

router.get('/oauth/authorize', (req, res) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
    resource,
  } = req.query;

  // Validaciones básicas
  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }

  const client = clients.get(client_id);
  if (!client) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  if (code_challenge_method !== 'S256') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
  }

  if (!code_challenge) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge required (PKCE)' });
  }

  // Generar authorization code
  const code = crypto.randomBytes(32).toString('hex');
  authCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    scope: scope || 'mcp:read mcp:write',
    resource,
    expires_at: Date.now() + 600000, // 10 min
  });

  // En una implementación completa, aquí se renderizaría una página de consentimiento.
  // Para simplificar (servidor headless), auto-aprobamos y devolvemos el code vía redirect.
  // En producción: redirigir a una página de login/consentimiento del usuario.
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  logger.info('OAuth authorization code issued', { clientId: client_id, scope });
  res.redirect(302, redirectUrl.toString());
});

// ==================== Token Endpoint ====================

router.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body || {};

  if (grant_type === 'authorization_code') {
    return handleAuthorizationCode(req, res, { code, redirect_uri, client_id, client_secret, code_verifier });
  }

  if (grant_type === 'refresh_token') {
    return handleRefreshToken(req, res, { refresh_token, client_id, client_secret });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

async function handleAuthorizationCode(req, res, params) {
  const { code, redirect_uri, client_id, client_secret, code_verifier } = params;

  const authCode = authCodes.get(code);
  if (!authCode) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown code' });
  }
  if (authCode.expires_at < Date.now()) {
    authCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
  }
  if (authCode.client_id !== client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
  }
  if (authCode.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  // Verificar PKCE: SHA256(code_verifier) base64url === code_challenge
  const verifierHash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
  if (verifierHash !== authCode.code_challenge) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  // Verificar client secret
  const client = clients.get(client_id);
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  // Emitir tokens
  const tokens = await tokenService.issueAccessToken({
    subject: client_id,
    scope: authCode.scope,
  });

  // Limpiar el code (one-time use)
  authCodes.delete(code);

  logger.info('Access token issued', { clientId: client_id });
  res.json(tokens);
}

async function handleRefreshToken(req, res, params) {
  const { refresh_token, client_id, client_secret } = params;

  // Verificar client
  const client = clients.get(client_id);
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  const result = await tokenService.refresh(refresh_token);
  if (!result.valid) {
    return res.status(400).json({ error: 'invalid_grant', error_description: result.reason });
  }
  res.json(result);
}

// ==================== Token Revocation (RFC 7009) ====================

router.post('/oauth/revoke', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  const { token, token_type_hint, client_id, client_secret } = req.body || {};

  const client = clients.get(client_id);
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  tokenService.revoke(token);
  logger.info('Token revoked', { clientId: client_id, hint: token_type_hint });

  // RFC 7009: responder 200 siempre
  res.status(200).end();
});

module.exports = router;
