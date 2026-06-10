/**
 * Graph Viewer - Visualizador de grafos en tiempo real
 * Lee la base de datos SQLite de memento directamente.
 * Reemplaza el SSE custom con Streamable HTTP (solo GET para eventos).
 */
'use strict';

const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const config = require('../config');
const logger = require('../config/logger');
const { authMiddleware } = require('../middleware/auth');
const { originMiddleware } = require('../middleware/origin');

/**
 * Construye el router del graph viewer.
 */
function buildGraphRouter() {
  const router = express.Router();

  let db;
  let graphCache = {
    checksum: null,
    version: 0,
    generatedAt: null,
    data: null,
  };

  // Inicializar DB
  try {
    db = new Database(config.graph.dbPath, { fileMustExist: true, readonly: false });
    try {
      db.pragma('journal_mode = WAL');
    } catch (e) {
      // Si la DB es read-only o no se puede escribir, continuar sin WAL
      logger.warn('WAL mode not available, using default journal', { error: e.message });
    }
    try {
      db.pragma('synchronous = NORMAL');
    } catch (e) { /* ignore */ }
    logger.info('Graph DB connected', { path: config.graph.dbPath });
  } catch (err) {
    logger.warn('Cannot open graph DB, graph viewer will be limited', { error: err.message, path: config.graph.dbPath });
    // Continuar sin DB - los endpoints devolverán errores
    db = null;
  }

  // Crear índices si la DB existe
  if (db) {
    try {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);' +
        'CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);' +
        'CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);'
      );
    } catch (idxErr) {
      logger.warn('Could not create indices', { error: idxErr.message });
    }
    try {
      buildGraphSnapshot();
    } catch (e) {
      logger.warn('Could not build initial graph snapshot', { error: e.message });
    }
  }

  // ==================== Cache management ====================

  function getChecksum() {
    if (!db || !db.open) return null;
    const result = db.prepare(
      "SELECT COUNT(*) as entity_count, " +
      "(SELECT COUNT(*) FROM relations) as relation_count, " +
      "(SELECT COUNT(*) FROM observations) as observation_count " +
      "FROM entities"
    ).get();
    return `${result.entity_count}-${result.relation_count}-${result.observation_count}`;
  }

  function buildGraphSnapshot() {
    if (!db || !db.open) return { nodes: [], links: [] };
    const t0 = Date.now();
    const entities = db.prepare('SELECT id, name, entityType FROM entities').all();
    const relations = db.prepare('SELECT from_id, to_id, relationType FROM relations').all();
    const data = {
      nodes: entities.map((e) => ({
        id: e.id,
        name: e.name,
        group: (typeof e.entityType === 'string' ? e.entityType.trim().toLowerCase() : '') || 'unknown',
      })),
      links: relations.map((r) => ({ source: r.from_id, target: r.to_id, type: r.relationType })),
    };
    graphCache.version++;
    graphCache.checksum = getChecksum();
    graphCache.generatedAt = Date.now();
    graphCache.data = data;
    logger.debug('Graph cache rebuilt', { version: graphCache.version, ms: Date.now() - t0 });
    return data;
  }

  function getGraphData() {
    if (!db || !db.open) return { nodes: [], links: [] };
    return JSON.parse(JSON.stringify(graphCache.data));
  }

  // ==================== Polling ====================

  let broadcastInterval;
  let clients = new Set();

  function broadcastIfChanged() {
    if (!db || !db.open) return;
    const checksum = getChecksum();
    if (checksum === graphCache.checksum) return;
    logger.debug('Graph changed', { old: graphCache.checksum, new: checksum });
    buildGraphSnapshot();
    const payload = JSON.stringify({
      type: 'update',
      data: graphCache.data,
      checksum,
      version: graphCache.version,
    });
    for (const client of clients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch (e) {
        // ignore
      }
    }
  }

  broadcastInterval = setInterval(broadcastIfChanged, config.graph.pollingInterval);

  // ==================== Endpoints ====================

  // Snapshot completo del grafo
  router.get('/api/graph', (req, res) => {
    try {
      res.json(getGraphData());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Detalle de una entidad
  router.get('/api/entity/:id', (req, res) => {
    try {
      const entityId = parseInt(req.params.id, 10);
      if (isNaN(entityId)) return res.status(400).json({ error: 'Invalid entity ID' });
      if (!db || !db.open) return res.status(503).json({ error: 'DB not available' });

      const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
      if (!entity) return res.status(404).json({ error: 'Entity not found' });

      const observations = db.prepare(
        'SELECT content, created_at, importance FROM observations WHERE entity_id = ? ORDER BY created_at DESC'
      ).all(entityId);
      const relations = db.prepare(
        'SELECT r.*, e.name as to_name FROM relations r JOIN entities e ON r.to_id = e.id WHERE r.from_id = ?'
      ).all(entityId);
      const incoming = db.prepare(
        'SELECT r.*, e.name as from_name FROM relations r JOIN entities e ON r.from_id = e.id WHERE r.to_id = ?'
      ).all(entityId);

      res.json({ entity, observations, outgoing: relations, incoming });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE stream de eventos del grafo (no es MCP, es para la UI web)
  // El spec MCP NO considera esto SSE "deprecated" porque es funcionalidad
  // de aplicación, no el transporte MCP.
  router.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Enviar estado inicial
    const initialData = getGraphData();
    res.write(`data: ${JSON.stringify({ type: 'init', data: initialData, checksum: graphCache.checksum, version: graphCache.version })}\n\n`);

    clients.add(res);
    logger.debug('SSE client connected', { total: clients.size });

    const heartbeat = setInterval(() => {
      res.write(':event ping\ndata: heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      logger.debug('SSE client disconnected', { total: clients.size });
    });
  });

  // Forzar rebuild del cache
  router.post('/api/force-refresh', (req, res) => {
    try {
      graphCache.checksum = null;
      broadcastIfChanged();
      res.json({ status: 'ok', version: graphCache.version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Health
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      dbAvailable: !!(db && db.open),
      clients: clients.size,
      graphVersion: graphCache.version,
    });
  });

  // Static files (UI)
  router.use(express.static(path.join(__dirname, '..', '..', 'graph-viewer', 'public')));

  return router;
}

module.exports = { buildGraphRouter };
