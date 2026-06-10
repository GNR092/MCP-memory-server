/**
 * Test: Verificar que el servidor arranca y los endpoints b\u00e1sicos responden
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { createApp, start } = require('../../src/index');

let server;
let baseUrl;

before(async () => {
  // Asegurar que NODE_ENV sea development para tests
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  const app = createApp();
  server = start(app, { gracefulShutdown: false });
  baseUrl = `http://127.0.0.1:${config.port}`;

  // Esperar a que el server est\u00e9 listo
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
  // Forzar salida para evitar warnings del test runner
  // (algunos sockets internos de node-fetch pueden quedar abiertos)
  setTimeout(() => process.exit(0), 100).unref();
});

test('GET /health returns ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.strictEqual(data.status, 'ok');
  assert.ok(typeof data.uptime === 'number');
});

test('OAuth authorization server metadata is exposed', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.ok(data.authorization_endpoint);
  assert.ok(data.token_endpoint);
  assert.ok(data.response_types_supported.includes('code'));
  assert.ok(data.code_challenge_methods_supported.includes('S256'));
});

test('OAuth protected resource metadata is exposed', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.ok(data.authorization_servers);
  assert.ok(data.bearer_methods_supported.includes('header'));
});

test('OAuth 2.1 with PKCE full flow issues access token', async () => {
  // 1. Dynamic Client Registration
  const regResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: ['http://localhost:8400/callback'],
    }),
  });
  assert.strictEqual(regResponse.status, 201);
  const client = await regResponse.json();
  assert.ok(client.client_id, 'client_id issued');
  assert.ok(client.client_secret, 'client_secret issued');

  // 2. Authorization Request with PKCE
  const crypto = require('node:crypto');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authUrl = new URL(`${baseUrl}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', 'http://localhost:8400/callback');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', 'mcp:read mcp:write');

  const authResponse = await fetch(authUrl.toString(), { redirect: 'manual' });
  assert.strictEqual(authResponse.status, 302);
  const location = authResponse.headers.get('location');
  assert.ok(location, 'redirect location present');
  const code = new URL(location).searchParams.get('code');
  assert.ok(code, 'authorization code issued');

  // 3. Token Exchange
  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:8400/callback',
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
    }),
  });
  assert.strictEqual(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token, 'access_token issued');
  assert.ok(tokens.refresh_token, 'refresh_token issued');
  assert.strictEqual(tokens.token_type, 'Bearer');
  assert.ok(tokens.expires_in > 0);
});

test('Authorization request rejects non-S256 PKCE', async () => {
  // Register a client
  const regResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Bad Client',
      redirect_uris: ['http://localhost:8400/callback'],
    }),
  });
  const client = await regResponse.json();

  // Try plain PKCE (should be rejected)
  const authUrl = new URL(`${baseUrl}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', 'http://localhost:8400/callback');
  authUrl.searchParams.set('code_challenge', 'somechallenge');
  authUrl.searchParams.set('code_challenge_method', 'plain');

  const response = await fetch(authUrl.toString());
  assert.strictEqual(response.status, 400);
});

test('Dynamic client registration validates redirect URIs', async () => {
  // HTTP non-localhost should be rejected
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Bad Client',
      redirect_uris: ['http://example.com/callback'], // Not localhost, not HTTPS
    }),
  });
  assert.strictEqual(response.status, 400);
});

test('HTTPS redirect URIs are accepted', async () => {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'HTTPS Client',
      redirect_uris: ['https://app.example.com/callback'],
    }),
  });
  assert.strictEqual(response.status, 201);
  const client = await response.json();
  assert.ok(client.client_id);
});

test('MCP stats endpoint requires auth when enabled', async () => {
  if (!config.auth.enabled) {
    return; // Skip if auth disabled
  }
  const response = await fetch(`${baseUrl}/mcp-stats`);
  assert.strictEqual(response.status, 401);
  const wwwAuth = response.headers.get('www-authenticate');
  assert.ok(wwwAuth, 'WWW-Authenticate header present');
  assert.ok(wwwAuth.toLowerCase().includes('bearer'), 'Bearer scheme');
});

test('MCP stats endpoint accessible with valid token', async () => {
  if (!config.auth.enabled) {
    return; // Skip if auth disabled
  }
  // Generate a token via TokenService
  const tokenService = require('../../src/auth/token-service');
  const tokens = await tokenService.issueAccessToken({
    subject: 'test-user',
    scope: 'mcp:read mcp:write',
  });

  const response = await fetch(`${baseUrl}/mcp-stats`, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  });
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.strictEqual(typeof data.activeSessions, 'number');
  assert.strictEqual(data.protocolVersion, config.mcp.protocolVersion);
});

test('CORS preflight is handled', async () => {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  });
  // OPTIONS should return 204 or 200
  assert.ok([200, 204].includes(response.status));
});
