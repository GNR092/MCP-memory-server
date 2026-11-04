import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { SqliteGraphRepository } from '../vendor/memento/src/sqlite/graph-repo.js';
import { migration } from '../vendor/memento/migrations/sqlite/004-restore-fts5.js';

const require = createRequire(import.meta.url);
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

async function makeDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-search-'));
    const db = await open({ filename: path.join(dir, 'memory.db'), driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT UNIQUE, entityType TEXT);
        CREATE TABLE observations (id INTEGER PRIMARY KEY, entity_id INTEGER, content TEXT);
        INSERT INTO entities VALUES (1, 'ocean', 'place'), (2, 'forest', 'place');
        INSERT INTO observations VALUES
            (1, 1, 'Blue whale lives in the ocean'),
            (2, 1, 'Whales breathe air'),
            (3, 2, 'Red fox lives in the forest');
    `);
    return { db, repo: new SqliteGraphRepository(db), dir };
}

test('FTS5 backfill and triggers track observation insert, update and delete', async () => {
    const { db, repo, dir } = await makeDb();
    await migration.up(db, true);

    assert.equal((await repo.searchObservations('blue whale', 5))[0].content, 'Blue whale lives in the ocean');
    await db.run("INSERT INTO observations VALUES (4, 2, 'Blue whale research')");
    assert.equal((await repo.searchObservations('blue whale', 5)).length, 2);
    await db.run("UPDATE observations SET content = 'Ocean study' WHERE id = 4");
    assert.equal((await repo.searchObservations('blue whale', 5)).length, 1);
    await db.run('DELETE FROM observations WHERE id = 1');
    assert.equal((await repo.searchObservations('blue whale', 5)).length, 0);

    await migration.down(db, true);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('FTS search safely returns no hits for punctuation-only queries', async () => {
    const { db, repo, dir } = await makeDb();
    await migration.up(db, true);

    assert.deepEqual(await repo.searchObservations('!? -- ...', 5), []);

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
