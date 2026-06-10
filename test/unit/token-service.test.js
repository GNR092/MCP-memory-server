/**
 * Unit tests para TokenService
 */
'use strict';

const { test, before, afterEach } = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');

// Resetear m\u00f3dulo cache para tests aislados
delete require.cache[require.resolve('../../src/auth/token-service')];
const tokenService = require('../../src/auth/token-service');

afterEach(() => {
  // Limpiar tokens emitidos
  tokenService.issuedTokens.clear();
  tokenService.refreshTokens.clear();
});

test('TokenService is a singleton', () => {
  const instance2 = require('../../src/auth/token-service');
  assert.strictEqual(tokenService, instance2);
});

test('issueAccessToken returns valid JWT', async () => {
  const tokens = await tokenService.issueAccessToken({
    subject: 'user123',
    scope: 'mcp:read',
  });

  assert.ok(tokens.access_token, 'access_token present');
  assert.ok(tokens.refresh_token, 'refresh_token present');
  assert.strictEqual(tokens.token_type, 'Bearer');
  assert.ok(tokens.expires_in > 0);

  // Verificar el access token
  const result = await tokenService.verify(tokens.access_token);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.claims.sub, 'user123');
  assert.strictEqual(result.claims.scope, 'mcp:read');
  assert.strictEqual(result.claims.mode, 'jwt');
});

test('verify rejects null/empty token', async () => {
  const result1 = await tokenService.verify(null);
  assert.strictEqual(result1.valid, false);
  assert.strictEqual(result1.reason, 'missing_token');

  const result2 = await tokenService.verify('');
  assert.strictEqual(result2.valid, false);
});

test('verify rejects malformed JWT', async () => {
  const result = await tokenService.verify('not-a-valid-jwt');
  assert.strictEqual(result.valid, false);
});

test('verify accepts static tokens', async () => {
  // Configurar un static token
  const originalStatic = config.auth.staticTokens;
  config.auth.staticTokens = ['test-static-token-123'];

  // Recargar servicio para que tome el nuevo config
  delete require.cache[require.resolve('../../src/auth/token-service')];
  const svc = require('../../src/auth/token-service');

  const result = await svc.verify('test-static-token-123');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.claims.mode, 'static');

  // Restaurar
  config.auth.staticTokens = originalStatic;
});

test('refresh issues new tokens and invalidates old', async () => {
  const tokens1 = await tokenService.issueAccessToken({
    subject: 'user1',
    scope: 'mcp:read',
  });

  // El access token 1 debe ser v\u00e1lido
  const verify1 = await tokenService.verify(tokens1.access_token);
  assert.strictEqual(verify1.valid, true);

  // Refrescar
  const tokens2 = await tokenService.refresh(tokens1.refresh_token);
  assert.ok(tokens2.access_token, 'new access_token issued');
  assert.notStrictEqual(tokens2.access_token, tokens1.access_token, 'new access_token is different');

  // El viejo access token debe haber sido revocado
  const verifyOld = await tokenService.verify(tokens1.access_token);
  assert.strictEqual(verifyOld.valid, false, 'old access_token invalidated');

  // El nuevo access token debe ser v\u00e1lido
  const verifyNew = await tokenService.verify(tokens2.access_token);
  assert.strictEqual(verifyNew.valid, true);
});

test('refresh rejects unknown refresh token', async () => {
  const result = await tokenService.refresh('not-a-real-refresh-token');
  assert.strictEqual(result.valid, false);
});

test('refresh rejects access token used as refresh', async () => {
  const tokens = await tokenService.issueAccessToken({ subject: 'user' });
  // Intentar usar el access token como refresh
  const result = await tokenService.refresh(tokens.access_token);
  assert.strictEqual(result.valid, false);
});

test('revoke removes issued token', async () => {
  const tokens = await tokenService.issueAccessToken({ subject: 'user' });

  // V\u00e1lido antes de revocar
  assert.strictEqual((await tokenService.verify(tokens.access_token)).valid, true);

  // Revocar
  const revoked = tokenService.revoke(tokens.access_token);
  assert.strictEqual(revoked, true);

  // Inv\u00e1lido despu\u00e9s de revocar
  const result = await tokenService.verify(tokens.access_token);
  assert.strictEqual(result.valid, false);
});

test('revoke does not affect static tokens', () => {
  const result = tokenService.revoke('any-token-string');
  // No debe lanzar error; static tokens simplemente no se revocan
  assert.strictEqual(typeof result, 'boolean');
});

test('stats returns current state', async () => {
  const stats1 = tokenService.stats();
  assert.ok(typeof stats1.issuedTokens === 'number');
  assert.ok(typeof stats1.refreshTokens === 'number');

  await tokenService.issueAccessToken({ subject: 'u1' });
  await tokenService.issueAccessToken({ subject: 'u2' });

  const stats2 = tokenService.stats();
  assert.ok(stats2.issuedTokens > stats1.issuedTokens, 'issuedTokens incremented');
  assert.ok(stats2.refreshTokens > stats1.refreshTokens, 'refreshTokens incremented');
});
