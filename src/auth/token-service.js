/**
 * Servicio de tokens: validación y emisión
 * - Soporta tokens estáticos (modo simple)
 * - Soporta JWT firmados (modo OAuth 2.1)
 * - Almacén in-memory de tokens emitidos (producción: usar Redis)
 */
'use strict';

const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const config = require('../config');
const logger = require('../config/logger');

class TokenService {
  constructor() {
    this.secret = new TextEncoder().encode(config.auth.jwtSecret);
    this.algorithm = config.auth.jwtAlgorithm;
    this.staticTokens = new Set(config.auth.staticTokens);
    this.issuedTokens = new Map(); // jti -> { expiresAt, scope }
    this.refreshTokens = new Map(); // refreshToken -> { accessTokenJti, expiresAt }
  }

  /**
   * Verifica si un token es válido y devuelve los claims
   */
  async verify(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'missing_token' };
    }

    // Modo simple: token estático
    if (this.staticTokens.has(token)) {
      return {
        valid: true,
        claims: {
          sub: 'static-user',
          scope: 'mcp:*',
          mode: 'static',
        },
      };
    }

    // Modo JWT
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: [this.algorithm],
        issuer: config.auth.issuer,
        audience: config.auth.audience,
      });

      // Verificar tracking interno: si el jti está tracked, OK.
      // Si NO está tracked, fue revocado.
      if (payload.jti) {
        if (!this.issuedTokens.has(payload.jti)) {
          return { valid: false, reason: 'revoked' };
        }
        const meta = this.issuedTokens.get(payload.jti);
        if (meta.expiresAt < Date.now()) {
          this.issuedTokens.delete(payload.jti);
          return { valid: false, reason: 'expired' };
        }
      }

      return {
        valid: true,
        claims: {
          sub: payload.sub,
          scope: payload.scope,
          jti: payload.jti,
          mode: 'jwt',
        },
      };
    } catch (err) {
      logger.debug('Token verification failed', { error: err.message });
      return { valid: false, reason: err.code || 'invalid_token' };
    }
  }

  /**
   * Emite un nuevo access token + refresh token
   */
  async issueAccessToken({ subject, scope = 'mcp:read mcp:write' }) {
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.auth.accessTokenTtl;

    const accessToken = await new SignJWT({
      scope,
      jti,
      token_type: 'access',
    })
      .setProtectedHeader({ alg: this.algorithm, typ: 'JWT' })
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(this.secret);

    // Emitir refresh token
    const refreshJti = crypto.randomUUID();
    const refreshExp = now + config.auth.refreshTokenTtl;
    const refreshToken = await new SignJWT({
      token_type: 'refresh',
      access_jti: jti,
      jti: refreshJti,
    })
      .setProtectedHeader({ alg: this.algorithm, typ: 'JWT' })
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(refreshExp)
      .setJti(refreshJti)
      .sign(this.secret);

    // Tracking
    this.issuedTokens.set(jti, {
      expiresAt: exp * 1000,
      scope,
      subject,
    });
    this.refreshTokens.set(refreshToken, {
      accessTokenJti: jti,
      expiresAt: refreshExp * 1000,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: config.auth.accessTokenTtl,
      scope,
    };
  }

  /**
   * Refresca un access token usando un refresh token válido
   */
  async refresh(refreshToken) {
    const meta = this.refreshTokens.get(refreshToken);
    if (!meta) {
      return { valid: false, reason: 'unknown_refresh_token' };
    }
    if (meta.expiresAt < Date.now()) {
      this.refreshTokens.delete(refreshToken);
      return { valid: false, reason: 'expired_refresh_token' };
    }

    try {
      const { payload } = await jwtVerify(refreshToken, this.secret, {
        algorithms: [this.algorithm],
        issuer: config.auth.issuer,
        audience: config.auth.audience,
      });

      if (payload.token_type !== 'refresh') {
        return { valid: false, reason: 'wrong_token_type' };
      }

      // Revocar el access token anterior
      if (meta.accessTokenJti) {
        this.issuedTokens.delete(meta.accessTokenJti);
      }
      this.refreshTokens.delete(refreshToken);

      // Emitir nuevos tokens
      return await this.issueAccessToken({
        subject: payload.sub,
        scope: 'mcp:read mcp:write',
      });
    } catch (err) {
      return { valid: false, reason: err.code || 'invalid_token' };
    }
  }

  /**
   * Revoca un access token
   */
  revoke(token) {
    try {
      // Para tokens estáticos, no se pueden revocar individualmente
      if (this.staticTokens.has(token)) {
        return false;
      }
      // Decodificar sin verificar (puede que ya esté expirado)
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      if (payload.jti) {
        this.issuedTokens.delete(payload.jti);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Stats para health/monitoring
   */
  stats() {
    return {
      issuedTokens: this.issuedTokens.size,
      refreshTokens: this.refreshTokens.size,
      staticTokens: this.staticTokens.size,
    };
  }
}

module.exports = new TokenService();
