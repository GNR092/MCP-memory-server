/**
 * MCP Memory Server - Streamable HTTP transport (protocol 2025-06-18)
 *
 * Endpoints:
 *  - POST /mcp   : Cliente envía mensajes JSON-RPC
 *  - GET /mcp    : Cliente abre stream SSE para notificaciones del servidor
 *  - DELETE /mcp : Cliente termina la sesión
 *
 * Patrón de proxy:
 *  Por cada sesión HTTP, creamos un par Server/Client:
 *  - Server MCP low-level conectado a StreamableHTTPServerTransport
 *  - Client MCP conectado a memento vía stdio
 *  - El Server registra handlers que delegan al Client (proxy puro)
 *
 * Sin SSE legacy (deprecado en spec 2025-06-18).
 */
'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const path = require('path');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  PingRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const config = require('../config');
const logger = require('../config/logger');

/**
 * Crea un Client MCP que se conecta a memento v\u00eda stdio.
 */
async function createMementoClient() {
  const mementoCommand = process.env.MEMENTO_PATH || 'memento';
  const dbPath = process.env.MEMORY_DB_PATH || path.join('/data', 'memory.db');

  logger.info('Spawning memento', { mementoCommand, dbPath });

  const transport = new StdioClientTransport({
    command: mementoCommand,
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
    },
  });

  const client = new Client(
    { name: 'mcp-memory-proxy', version: '2.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  logger.info('memento client connected');
  return client;
}

/**
 * Registra handlers de proxy en el server MCP.
 * Cada handler recibe un request del cliente HTTP y lo reenv\u00eda al client (memento).
 */
function registerProxyHandlers(server, client) {
  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await client.callTool(request.params);
  });

  // Resources
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return await client.listResources(request.params);
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    return await client.listResourceTemplates(request.params);
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await client.readResource(request.params);
  });
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    return await client.subscribeResource(request.params);
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    return await client.unsubscribeResource(request.params);
  });

  // Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return await client.listPrompts(request.params);
  });
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await client.getPrompt(request.params);
  });

  // Completion
  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    return await client.complete(request.params);
  });

  // Logging
  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    return await client.setLoggingLevel(request.params);
  });

  // Ping
  server.setRequestHandler(PingRequestSchema, async () => {
    return await client.ping();
  });

  // Reenviar notificaciones del client (memento) al server (cliente HTTP)
  // Esto es importante para mensajes server-initiated como resource updates
  client.setNotificationHandler = client.setNotificationHandler || (() => {});
  // El Client del SDK no expone setNotificationHandler directamente, pero
  // los notifications del client se reenv\u00edan autom\u00e1ticamente via transport.

  // Reenviar notificaciones del server al client (memento)
  // Ej: notifications/initialized del cliente HTTP
  // El server autom\u00e1ticamente las recibe, necesitamos hook para reenviarlas
  // al client. Esto se hace a nivel de transport.
}

/**
 * Construye el router Express para MCP Streamable HTTP.
 */
function buildMcpRouter() {
  const router = express.Router();
  // Las rutas MCP necesitan el body parseado como JSON crudo
  router.use(express.json({ limit: '10mb', type: '*/*' }));

  // Sesiones activas
  const sessions = new Map();

  // Limpieza peri\u00f3dica de sesiones inactivas
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.lastActivityAt && (now - session.lastActivityAt) > config.mcp.sessionTimeoutMs) {
        logger.info('Closing idle session', { sessionId, idleMs: now - session.lastActivityAt });
        closeSession(sessionId, session).catch((err) => {
          logger.warn('Error closing idle session', { error: err.message });
        });
      }
    }
  }, 60000).unref();

  async function closeSession(sessionId, session) {
    sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch (e) { /* ignore */ }
    try {
      await session.mementoClient.close();
    } catch (e) { /* ignore */ }
  }

  // ==================== Streamable HTTP ====================

  // POST /mcp
  router.post(config.mcp.endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    try {
      // Sesi\u00f3n existente
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.lastActivityAt = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // Sesi\u00f3n nueva (sin session ID en headers)
      if (!sessionId) {
        const newSessionId = randomUUID();
        logger.info('New MCP session', { sessionId: newSessionId });

        // Crear el par server/client
        const mementoClient = await createMementoClient();

        const server = new Server(
          { name: 'mcp-memory-server', version: '2.0.0' },
          {
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              logging: {},
              completions: {},
            },
          }
        );

        // Registrar handlers de proxy
        registerProxyHandlers(server, mementoClient);

        // Crear transport streamable
        const transport = new StreamableHTTPServerTransport({
          sessionId: newSessionId,
          onsessioninitialized: () => {
            // Sesi\u00f3n ya inicializada por el cliente
            logger.info('MCP session initialized', { sessionId: newSessionId });
          },
        });

        transport.onclose = () => {
          logger.info('Transport closed', { sessionId: newSessionId });
          closeSession(newSessionId, sessions.get(newSessionId)).catch(() => {});
        };

        // Conectar server al transport
        await server.connect(transport);

        // Guardar sesi\u00f3n
        const session = {
          server,
          transport,
          mementoClient,
          lastActivityAt: Date.now(),
        };
        sessions.set(newSessionId, session);

        // Manejar el request
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Session ID inv\u00e1lido
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or expired session' },
        id: null,
      });
    } catch (err) {
      logger.error('POST /mcp error', { error: err.message, stack: err.stack });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp - Stream para notificaciones del servidor
  router.get(config.mcp.endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessions.get(sessionId);

    if (!sessionId || !session) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No active session' },
        id: null,
      });
    }

    try {
      session.lastActivityAt = Date.now();
      await session.transport.handleRequest(req, res);
    } catch (err) {
      logger.error('GET /mcp error', { error: err.message });
      if (!res.headersSent) res.status(500).end();
    }
  });

  // DELETE /mcp - Terminar sesi\u00f3n
  router.delete(config.mcp.endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessions.get(sessionId);

    if (session) {
      await closeSession(sessionId, session);
      logger.info('Session terminated by client', { sessionId });
    }

    res.status(204).end();
  });

  // Stats
  router.get('/mcp-stats', (req, res) => {
    res.json({
      activeSessions: sessions.size,
      protocolVersion: config.mcp.protocolVersion,
      sessions: Array.from(sessions.keys()).map((id) => ({
        sessionId: id,
        lastActivityAt: sessions.get(id).lastActivityAt,
      })),
    });
  });

  return router;
}

module.exports = { buildMcpRouter, createMementoClient, registerProxyHandlers };
