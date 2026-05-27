const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3022;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'memorydata', 'memory.db');
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL || '2000');
const SSE_HEARTBEAT_INTERVAL = 25000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let db;
let graphCache = {
  checksum: null,
  version: 0,
  generatedAt: null,
  data: null
};

try {
  db = new Database(DB_PATH, { fileMustExist: true });

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    console.log('[OK] WAL mode enabled');
  } catch (walErr) {
    console.warn('[WARN] WAL not available: ' + walErr.message);
  }

  try {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);' +
      'CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);' +
      'CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);'
    );
    console.log('[OK] Indices verified/created');
  } catch (idxErr) {
    console.warn('[WARN] Could not create indices: ' + idxErr.message);
  }

  console.log('[OK] Connected to: ' + DB_PATH);

  buildGraphSnapshot();
} catch (err) {
  console.error('[ERROR] Cannot open DB: ' + err.message);
  process.exit(1);
}

function getChecksum() {
  if (!db || !db.open) {
    return null;
  }
  const result = db.prepare((
    "SELECT COUNT(*) as entity_count, " +
    "(SELECT COUNT(*) FROM relations) as relation_count, " +
    "(SELECT COUNT(*) FROM observations) as observation_count " +
    "FROM entities"
  )).get();
  return result.entity_count + '-' + result.relation_count + '-' + result.observation_count;
}

function buildGraphSnapshot() {
  if (!db || !db.open) {
    return { nodes: [], links: [] };
  }
  const t0 = Date.now();
  const entities = db.prepare('SELECT id, name, entityType FROM entities').all();
  const relations = db.prepare('SELECT from_id, to_id, relationType FROM relations').all();
  const data = {
    nodes: entities.map(function(e) { return { id: e.id, name: e.name, group: e.entityType || 'unknown' }; }),
    links: relations.map(function(r) { return { source: r.from_id, target: r.to_id, type: r.relationType }; })
  };
  const ms = Date.now() - t0;
  graphCache.version++;
  graphCache.checksum = getChecksum();
  graphCache.generatedAt = Date.now();
  graphCache.data = data;
  console.log('[GraphCache] rebuilt v' + graphCache.version + ' in ' + ms + 'ms | nodes=' + data.nodes.length + ' links=' + data.links.length);
  return data;
}

function getGraphData() {
  if (!db || !db.open) {
    return { nodes: [], links: [] };
  }
  return structuredClone(graphCache.data);
}

app.get('/api/graph', function(req, res) {
  try {
    res.json(getGraphData());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/entity/:id', function(req, res) {
  try {
    var entityId = parseInt(req.params.id);
    if (isNaN(entityId)) {
      return res.status(400).json({ error: 'Invalid entity ID' });
    }
    var entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }
    var observations = db.prepare(
      'SELECT content, created_at, importance FROM observations WHERE entity_id = ? ORDER BY created_at DESC'
    ).all(entityId);
    var relations = db.prepare(
      'SELECT r.*, e.name as to_name FROM relations r JOIN entities e ON r.to_id = e.id WHERE r.from_id = ?'
    ).all(entityId);
    var incoming = db.prepare(
      'SELECT r.*, e.name as from_name FROM relations r JOIN entities e ON r.from_id = e.id WHERE r.to_id = ?'
    ).all(entityId);

    res.json({
      entity: entity,
      observations: observations,
      outgoing: relations,
      incoming: incoming
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

var broadcastInterval;
var heartbeatInterval;
var clients = [];

function broadcastIfChanged() {
  try {
    if (!db || !db.open) {
      return;
    }
    var checksum = getChecksum();
    if (checksum === graphCache.checksum) {
      return;
    }
    console.log('[GraphCache] checksum changed: ' + graphCache.checksum + ' -> ' + checksum);
    buildGraphSnapshot();
    var payload = JSON.stringify({ type: 'update', data: graphCache.data, checksum: checksum, version: graphCache.version });
    for (var i = 0; i < clients.length; i++) {
      clients[i].write('data: ' + payload + '\n\n');
    }
    console.log('[UPDATE] Changes detected, broadcasting v' + graphCache.version + ' to ' + clients.length + ' client(s)');
  } catch (err) {
    console.error('[ERROR] Broadcast: ' + err.message);
  }
}

app.get('/api/events', function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  var initialData = getGraphData();
  var checksum = graphCache.checksum;
  res.write('data: ' + JSON.stringify({ type: 'init', data: initialData, checksum: checksum, version: graphCache.version }) + '\n\n');
  clients.push(res);
  console.log('[SSE] Client connected. Total: ' + clients.length);

  req.on('close', function() {
    var filtered = [];
    for (var i = 0; i < clients.length; i++) {
      if (clients[i] !== res) filtered.push(clients[i]);
    }
    clients = filtered;
    console.log('[SSE] Client disconnected. Total: ' + clients.length);
  });
});

broadcastInterval = setInterval(broadcastIfChanged, POLLING_INTERVAL);

heartbeatInterval = setInterval(function() {
  for (var i = 0; i < clients.length; i++) {
    clients[i].write(':event ping\ndata: heartbeat\n\n');
  }
  if (clients.length > 0) {
    console.log('[SSE] heartbeat sent to ' + clients.length + ' client(s)');
  }
}, SSE_HEARTBEAT_INTERVAL);

app.get('/health', function(req, res) { res.json({ status: 'ok', clients: clients.length, polling_ms: POLLING_INTERVAL }); });

app.get('/api/force-refresh', function(req, res) {
  try {
    graphCache.checksum = null;
    broadcastIfChanged();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

var server = app.listen(PORT, '0.0.0.0', function() {
  console.log('[SERVER] Running on http://0.0.0.0:' + PORT);
  console.log('[SERVER] DB: ' + DB_PATH);
  console.log('[SERVER] Polling interval: ' + POLLING_INTERVAL + 'ms');
});

var shuttingDown = false;

process.on('SIGINT', function() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[SERVER] Shutting down...');
  clearInterval(broadcastInterval);
  clearInterval(heartbeatInterval);

  while (clients.length > 0) {
    var c = clients.pop();
    c.removeAllListeners('close');
    c.end();
  }

  if (db) db.close();
  server.close(function() { process.exit(0); });
});