import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { migrateVectors } from '../scripts/migrate-vectors.mjs';

const require = createRequire(import.meta.url);
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { getLoadablePath } = require('sqlite-vec');

const NEW_DIM = 384;
const OLD_DIM = 1024;

function fakeEmbed(dimension) {
    return async () => new Float32Array(dimension).fill(0.1);
}

async function makeDb(dim) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-vectors-'));
    const dbPath = path.join(dir, 'memory.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout=5000;');
    await db.loadExtension(getLoadablePath());
    await db.exec(`CREATE VIRTUAL TABLE obs_vec USING vec0(entity_id INT, embedding FLOAT[${dim}])`);
    await db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT)');
    await db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, entity_id INTEGER, content TEXT)');
    await db.exec("INSERT INTO entities VALUES (1, 'e1')");
    await db.exec("INSERT INTO observations VALUES (1, 1, 'uno'), (2, 1, 'dos'), (3, 1, 'tres')");
    return { db, dbPath, dir };
}

test('migra obs_vec de 1024 a 384 dims y deja un backup', async () => {
    const { db, dbPath, dir } = await makeDb(OLD_DIM);

    const result = await migrateVectors({
        db,
        expectedDim: NEW_DIM,
        embed: fakeEmbed(NEW_DIM),
        dbPath
    });

    assert.equal(result.action, 'migrated');
    assert.ok(fs.existsSync(result.backupPath), 'el backup debe existir');
    assert.match(result.backupPath, /\.bak-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-1024d$/);

    const row = await db.get("SELECT sql FROM sqlite_master WHERE name = 'obs_vec'");
    assert.match(row.sql, /FLOAT\[384\]/);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM obs_vec')).c), 3);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM observations')).c), 3);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('no hace nada si la dimension ya es la correcta', async () => {
    const { db, dbPath, dir } = await makeDb(NEW_DIM);

    const result = await migrateVectors({
        db,
        expectedDim: NEW_DIM,
        embed: fakeEmbed(NEW_DIM),
        dbPath
    });

    assert.equal(result.action, 'none');
    assert.deepEqual(fs.readdirSync(dir), ['memory.db']);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('crea obs_vec si no existe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-vectors-'));
    const dbPath = path.join(dir, 'memory.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout=5000;');
    await db.loadExtension(getLoadablePath());

    const result = await migrateVectors({
        db,
        expectedDim: NEW_DIM,
        embed: fakeEmbed(NEW_DIM),
        dbPath
    });

    assert.equal(result.action, 'created');
    const row = await db.get("SELECT sql FROM sqlite_master WHERE name = 'obs_vec'");
    assert.match(row.sql, /FLOAT\[384\]/);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
