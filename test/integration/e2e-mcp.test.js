/**
 * Test E2E: Conectar un cliente MCP real (Streamable HTTP)
 * a nuestro servidor y verificar que listar/ejecutar tools funciona.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const config = require('../../src/config');
const { createApp, start } = require('../../src/index');

// Crear una DB temporal para el test
const tempDb = path.join(os.tmpdir(), `mcp-test-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = tempDb;
process.env.MEMENTO_PATH = process.env.MEMENTO_PATH || 'memento';

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  process.env.AUTH_ENABLED = 'false'; // Simplificar test E2E

  const app = createApp();
  server = start(app, { gracefulShutdown: false });
  baseUrl = `http://127.0.0.1:${config.port}`;

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
  // Limpiar DB temporal
  try {
    if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
    if (fs.existsSync(tempDb + '-wal')) fs.unlinkSync(tempDb + '-wal');
    if (fs.existsSync(tempDb + '-shm')) fs.unlinkSync(tempDb + '-shm');
  } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 100).unref();
});

test('E2E: Client can connect via Streamable HTTP and list tools', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });

  await client.connect(transport);
  const { tools } = await client.listTools();

  // memento expone varias herramientas; debe haber al menos una
  assert.ok(Array.isArray(tools), 'tools is an array');
  assert.ok(tools.length > 0, 'tools list not empty');

  // Herramientas esperadas de memento
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes('create_entities'), 'create_entities tool available');
  assert.ok(toolNames.includes('search_nodes'), 'search_nodes tool available');
  assert.ok(toolNames.includes('read_graph'), 'read_graph tool available');

  await client.close();
});

test('E2E: Client can call a tool (create_entities + read_graph)', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });

  await client.connect(transport);

  // Crear una entidad
  const createResult = await client.callTool({
    name: 'create_entities',
    arguments: {
      entities: [
        { name: 'TestEntity', entityType: 'test', observations: ['Created in E2E test'] },
      ],
    },
  });
  assert.ok(createResult, 'create result received');
  assert.ok(!createResult.isError, 'create_entities did not error');

  // Leer el grafo
  const readResult = await client.callTool({
    name: 'read_graph',
    arguments: {},
  });
  assert.ok(readResult, 'read_graph result received');

  // El grafo debe contener TestEntity
  const text = readResult.content?.[0]?.text || JSON.stringify(readResult);
  assert.ok(text.includes('TestEntity'), `graph contains TestEntity: ${text.substring(0, 200)}`);

  await client.close();
});

test('E2E: Session lifecycle works (init -> use -> close)', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });

  // Connect establece la sesión
  await client.connect(transport);

  // Verificar que la sesión está activa
  const stats1 = await fetch(`${baseUrl}/mcp-stats`).then((r) => r.json());
  assert.ok(stats1.activeSessions >= 1, 'at least 1 active session');

  // Hacer algo
  await client.listTools();

  // Cerrar cliente. SDK Client.close() no siempre termina la sesión HTTP
  // (depende del flujo), pero no debe tirar errores.
  await client.close();

  // Verificar que el server sigue respondiendo (no se cayó)
  const health = await fetch(`${baseUrl}/health`);
  assert.strictEqual(health.status, 200);
});

test('E2E: Multiple concurrent sessions work', async () => {
  const clients = [];
  try {
    // Crear 3 clientes concurrentes
    for (let i = 0; i < 3; i++) {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      const client = new Client({ name: `concurrent-${i}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);
    }

    // Cada uno lista tools
    const results = await Promise.all(clients.map((c) => c.listTools()));
    assert.strictEqual(results.length, 3);
    for (const r of results) {
      assert.ok(Array.isArray(r.tools));
      assert.ok(r.tools.length > 0);
    }

    // Verificar 3 sesiones activas
    const stats = await fetch(`${baseUrl}/mcp-stats`).then((r) => r.json());
    assert.ok(stats.activeSessions >= 3, `at least 3 sessions active, got ${stats.activeSessions}`);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});
