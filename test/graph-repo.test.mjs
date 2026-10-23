import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { SqliteGraphRepository } from '../vendor/memento/src/sqlite/graph-repo.js';

const require = createRequire(import.meta.url);
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { getLoadablePath } = require('sqlite-vec');

const DIM = 384;
const embedding = () => Buffer.from(new Float32Array(DIM).fill(0.1).buffer);

async function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-repo-'));
    const db = await open({ filename: path.join(dir, 'memory.db'), driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout=5000;');
    await db.loadExtension(getLoadablePath());
    await db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, entityType TEXT NOT NULL)');
    await db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, content TEXT NOT NULL, UNIQUE(entity_id, content))');
    await db.exec('CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, relationType TEXT NOT NULL)');
    await db.exec(`CREATE VIRTUAL TABLE obs_vec USING vec0(entity_id INT, embedding FLOAT[${DIM}])`);
    return { db, repo: new SqliteGraphRepository(db), dir };
}

async function withVector(repo, entityId, observationId) {
    await repo.insertObservationVectors([
        { observationId, entityId, embedding: embedding() }
    ]);
}

test('deleteEntities borra tambien los vectores de la entidad', async () => {
    const { db, repo, dir } = await makeRepo();
    const entityId = await repo.createEntity('a', 'tipo');
    const observation = await repo.insertObservation(entityId, 'texto');
    await withVector(repo, entityId, observation.observationId);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM obs_vec')).c), 1);

    await repo.deleteEntities(['a']);

    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM obs_vec')).c), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM entities')).c), 0);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('deleteObservations borra tambien sus vectores', async () => {
    const { db, repo, dir } = await makeRepo();
    const entityId = await repo.createEntity('a', 'tipo');
    const observation = await repo.insertObservation(entityId, 'texto');
    await withVector(repo, entityId, observation.observationId);

    await repo.deleteObservations(entityId, ['texto']);

    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM obs_vec')).c), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM observations')).c), 0);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('dos escrituras de vectores a la vez no se pisan', async () => {
    const { db, repo, dir } = await makeRepo();
    const entityId = await repo.createEntity('a', 'tipo');
    const first = await repo.insertObservation(entityId, 'uno');
    const second = await repo.insertObservation(entityId, 'dos');

    // Sin serializar, el segundo BEGIN TRANSACTION falla con
    // "cannot start a transaction within a transaction" y el ROLLBACK del
    // primero borra lo que el segundo habia escrito.
    await Promise.all([
        withVector(repo, entityId, first.observationId),
        withVector(repo, entityId, second.observationId)
    ]);

    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM obs_vec')).c), 2);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('openNodes devuelve las entidades en el orden pedido', async () => {
    const { db, repo, dir } = await makeRepo();
    await repo.createEntity('primero', 'tipo');
    await repo.createEntity('segundo', 'tipo');
    await repo.createEntity('tercero', 'tipo');

    const result = await repo.openNodes(['tercero', 'primero']);

    assert.deepEqual(result.entities.map(entity => entity.name), ['tercero', 'primero']);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
