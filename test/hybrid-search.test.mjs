import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { SqliteGraphRepository } from '../vendor/memento/src/sqlite/graph-repo.js';
import { migration } from '../vendor/memento/migrations/sqlite/004-restore-fts5.js';

// The deterministic fixture replaces embeddings, so loading the model package is unnecessary.
const testLoader = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@xenova/transformers') {
        return { url: 'data:text/javascript,export%20const%20env%3D%7B%7D%3B%20export%20async%20function%20pipeline()%7B%7D', shortCircuit: true };
    }
    return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(testLoader)}`, import.meta.url);
const { KnowledgeGraphManager } = await import('../vendor/memento/src/knowledge-graph-manager.js');

const require = createRequire(import.meta.url);
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { getLoadablePath } = require('sqlite-vec');

const DIM = 384;
const QUERIES = {
    ambiguous: 'memory-test-hybrid-smoke-20261106-a7f3c9',
    semantic: 'why do satellites keep moving around earth',
    exact: 'blue whale ocean',
    mixed: 'planet orbit'
};

function unitVector(axis) {
    const vector = new Float32Array(DIM);
    vector[axis] = 1;
    return vector;
}

function scaledVector(axis, scale) {
    const vector = unitVector(axis);
    vector[axis] = scale;
    return vector;
}

function vectorWithDot(axis, dot, otherAxis) {
    const vector = new Float32Array(DIM);
    vector[axis] = dot;
    vector[otherAxis] = Math.sqrt(1 - dot ** 2);
    return vector;
}

function buffer(vector) {
    return Buffer.from(vector.buffer.slice(0));
}

async function addVector(repo, name, vector) {
    const entityId = await repo.createEntity(name, 'test');
    const { observationId } = await repo.insertObservation(entityId, name);
    await repo.insertObservationVectors([{ observationId, entityId, embedding: buffer(vector) }]);
    return entityId;
}

async function makeFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-'));
    const db = await open({ filename: path.join(dir, 'memory.db'), driver: sqlite3.Database });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await db.loadExtension(getLoadablePath());
    await db.exec(`
        CREATE TABLE entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            entityType TEXT NOT NULL
        );
        CREATE TABLE observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_accessed TEXT,
            access_count INTEGER DEFAULT 0,
            importance TEXT DEFAULT 'normal',
            UNIQUE(entity_id, content)
        );
        CREATE TABLE relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            relationType TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE obs_vec USING vec0(entity_id INT, embedding FLOAT[${DIM}]);
    `);
    await migration.up(db, true);

    const repo = new SqliteGraphRepository(db);
    const fixtures = [
        {
            name: 'ambiguous-candidate',
            content: 'A note about persistent memory graph retrieval.',
            vector: vectorWithDot(0, 0.395, 4)
        },
        {
            name: 'semantic-paraphrase',
            content: 'Orbital mechanics keep satellites traveling around Earth.',
            vector: unitVector(1)
        },
        {
            name: 'exact-fts',
            content: 'Blue whale swims in the ocean.',
            vector: vectorWithDot(2, 0.82, 5)
        },
        {
            name: 'mixed-semantic',
            content: 'A moon circles its host in a stable path.',
            vector: unitVector(3)
        },
        {
            name: 'mixed-fts',
            content: 'Planet orbit records include the measurements.',
            vector: vectorWithDot(3, 0.8, 6)
        }
    ];

    for (const fixture of fixtures) {
        const entityId = await repo.createEntity(fixture.name, 'test');
        const { observationId } = await repo.insertObservation(entityId, fixture.content);
        await repo.insertObservationVectors([{
            observationId,
            entityId,
            embedding: buffer(fixture.vector)
        }]);
    }

    const queryVectors = new Map([
        [QUERIES.ambiguous, unitVector(0)],
        [QUERIES.semantic, unitVector(1)],
        [QUERIES.exact, unitVector(2)],
        [QUERIES.mixed, unitVector(3)]
    ]);
    const manager = new KnowledgeGraphManager(repo);
    manager.embedTexts = async ([query]) => [buffer(queryVectors.get(query))];

    return { manager, repo, queryVectors, db };
}

test('hybrid search separates semantic distance from FTS5 ranking and preserves valid results', async t => {
    const { manager, repo, queryVectors } = await makeFixture(t);
    const serverSource = fs.readFileSync(new URL('../vendor/memento/src/server.js', import.meta.url), 'utf8');
    const managerSource = fs.readFileSync(new URL('../vendor/memento/src/knowledge-graph-manager.js', import.meta.url), 'utf8');
    const publicDefaultMatch = serverSource.match(/threshold:\s*z\.number\(\)\.min\(0\)\.max\(2\)[\s\S]*?\.default\((\d+(?:\.\d+)?)\)/);
    assert.ok(publicDefaultMatch, 'search_nodes must expose its public threshold default');
    const mcpDefault = Number(publicDefaultMatch[1]);
    assert.equal(mcpDefault, 0.75);
    assert.match(serverSource, /this\.#knowledgeGraphManager\.searchNodes\(args\)/, 'MCP forwards the parsed search arguments to the manager');
    assert.match(managerSource, /threshold\s*=\s*0\.75/, 'direct manager default is aligned with MCP');

    const channels = {};
    for (const [name, query] of Object.entries(QUERIES)) {
        const vectors = await repo.semanticSearch(Array.from(queryVectors.get(query)), 10);
        const fts = await repo.searchObservations(query, 10);
        channels[name] = {
            vector: vectors.map(({ entity_id, distance, cosineDistance, similarity }) => ({ entity_id, distance, cosineDistance, similarity })),
            fts: fts.map(({ entity_id, rank }) => ({ entity_id, bm25Rank: rank }))
        };
    }

    const semanticSearch = repo.semanticSearch.bind(repo);
    let managerDefaultThreshold;
    repo.semanticSearch = (...args) => {
        managerDefaultThreshold = args[2];
        return semanticSearch(...args);
    };
    await manager.searchNodes({ query: QUERIES.semantic });
    assert.equal(managerDefaultThreshold, 0.75, 'omitted manager threshold must reach the repository as 0.75');

    const cases = [
        {
            name: 'ambiguous threshold=0.1',
            query: QUERIES.ambiguous,
            threshold: 0.1,
            expected: []
        },
        {
            name: 'ambiguous MCP default',
            query: QUERIES.ambiguous,
            threshold: mcpDefault,
            expected: []
        },
        {
            name: 'legacy-compatibility threshold',
            query: QUERIES.ambiguous,
            threshold: 1.140175,
            expected: ['ambiguous-candidate']
        },
        {
            name: 'semantic paraphrase',
            query: QUERIES.semantic,
            threshold: 0.1,
            expected: ['semantic-paraphrase']
        },
        {
            name: 'exact FTS',
            query: QUERIES.exact,
            threshold: 0.1,
            expected: ['exact-fts']
        },
        {
            name: 'mixed search',
            query: QUERIES.mixed,
            threshold: 0.1,
            expected: ['mixed-semantic', 'mixed-fts']
        }
    ];
    const outcomes = [];
    for (const scenario of cases) {
        const result = await manager.searchNodes({
            query: scenario.query,
            threshold: scenario.threshold,
            topK: 8
        });
        outcomes.push({ ...scenario, actual: result.entities.map(entity => entity.name) });
    }

    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const outcome of outcomes) {
        const expected = new Set(outcome.expected);
        const actual = new Set(outcome.actual);
        for (const name of actual) {
            if (expected.has(name)) truePositives += 1;
            else falsePositives += 1;
        }
        for (const name of expected) {
            if (!actual.has(name)) falseNegatives += 1;
        }
    }
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);
    t.diagnostic(JSON.stringify({
        channels,
        outcomes,
        fixtureMetrics: { truePositives, falsePositives, falseNegatives, precision, recall }
    }));

    assert.deepEqual(outcomes[0].actual, [], 'distance above 0.1 must not pass by similarity');
    assert.deepEqual(outcomes[1].actual, [], 'distance above the public MCP default must be excluded');
    assert.deepEqual(outcomes[2].actual, ['ambiguous-candidate']);
    assert.deepEqual(outcomes[3].actual, ['semantic-paraphrase']);
    assert.deepEqual(outcomes[4].actual, ['exact-fts'], 'FTS result must survive semantic filtering');
    assert.deepEqual(new Set(outcomes[5].actual), new Set(outcomes[5].expected));
    assert.equal(precision, 1);
    assert.equal(recall, 1);
});

test('cosine distance is invariant to vector scale and enforces L2 thresholds including 0 and 2', async t => {
    const { repo } = await makeFixture(t);
    const query = unitVector(7);
    const smallScaleId = await addVector(repo, 'same-direction-small', scaledVector(7, 0.25));
    const largeScaleId = await addVector(repo, 'same-direction-large', scaledVector(7, 9));
    const atZero = await repo.semanticSearch(Array.from(query), 10, 0);
    assert.deepEqual(new Set(atZero.map(row => row.entity_id)), new Set([smallScaleId, largeScaleId]));
    assert.ok(atZero.every(row => row.cosineDistance === 0 && row.distance === 0));

    const nearId = await addVector(repo, 'distance-0.34', vectorWithDot(7, 1 - 0.34 ** 2 / 2, 8));
    const farId = await addVector(repo, 'distance-0.36', vectorWithDot(7, 1 - 0.36 ** 2 / 2, 9));
    const oppositeId = await addVector(repo, 'distance-2', vectorWithDot(7, -1, 10));
    const atDefaultThreshold = await repo.semanticSearch(Array.from(query), 10, 0.35);
    const defaultIds = new Set(atDefaultThreshold.map(row => row.entity_id));
    assert.ok(defaultIds.has(nearId), 'distance 0.34 is within threshold 0.35');
    assert.ok(!defaultIds.has(farId), 'distance 0.36 exceeds threshold 0.35');
    assert.ok(!defaultIds.has(oppositeId));

    const atZeroAfterAddingPositiveDistances = await repo.semanticSearch(Array.from(query), 20, 0);
    assert.deepEqual(new Set(atZeroAfterAddingPositiveDistances.map(row => row.entity_id)), new Set([smallScaleId, largeScaleId]));
    const atMaximum = await repo.semanticSearch(Array.from(query), 20, 2);
    assert.ok(atMaximum.some(row => row.entity_id === oppositeId && row.distance === 2));
});

test('invalid stored vectors are excluded before topK and cannot displace a valid hit', async t => {
    const { repo, db } = await makeFixture(t);
    const existingRows = await db.all('SELECT rowid, entity_id, embedding FROM obs_vec');
    // sqlite-vec rejects NULL inserts, so a scratch table models malformed legacy rows.
    await db.exec('DROP TABLE obs_vec; CREATE TABLE obs_vec(rowid INTEGER PRIMARY KEY, entity_id INTEGER, embedding BLOB)');
    for (const row of existingRows) {
        await db.run('INSERT INTO obs_vec(rowid, entity_id, embedding) VALUES(?, ?, ?)', [
            row.rowid, row.entity_id, row.embedding
        ]);
    }
    const invalidVectors = [
        buffer(new Float32Array(DIM)),
        buffer(Float32Array.from({ length: DIM }, (_, index) => index === 0 ? NaN : 1)),
        buffer(Float32Array.from({ length: DIM }, (_, index) => index === 0 ? Infinity : 1)),
        buffer(new Float32Array(DIM - 1))
    ];
    for (let index = 0; index < invalidVectors.length; index += 1) {
        const entityId = await repo.createEntity(`legacy-invalid-${index}`, 'test');
        const { observationId } = await repo.insertObservation(entityId, `legacy invalid ${index}`);
        await db.run('INSERT INTO obs_vec(rowid, entity_id, embedding) VALUES(?, ?, ?)', [
            observationId, entityId, invalidVectors[index]
        ]);
    }
    const nullEntityId = await repo.createEntity('legacy-null-vector', 'test');
    const { observationId: nullObservationId } = await repo.insertObservation(nullEntityId, 'legacy null vector');
    await db.run('INSERT INTO obs_vec(rowid, entity_id, embedding) VALUES(?, ?, NULL)', [nullObservationId, nullEntityId]);

    const rows = await repo.semanticSearch(Array.from(unitVector(1)), 1, 0.35);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entity_id, await repo.getEntityId('semantic-paraphrase'));
    assert.ok(Number.isFinite(rows[0].distance));
    assert.ok(Number.isFinite(rows[0].cosineDistance));
});

test('invalid query embeddings keep exact FTS results and are not stored as vectors', async t => {
    const { manager, repo, db } = await makeFixture(t);
    const malformed = new Float32Array(DIM - 1);
    const invalidEmbeddings = [
        buffer(new Float32Array(DIM)),
        null,
        buffer(Float32Array.from({ length: DIM }, (_, index) => index === 0 ? NaN : 1)),
        buffer(Float32Array.from({ length: DIM }, (_, index) => index === 0 ? Infinity : 1)),
        buffer(malformed)
    ];

    for (let index = 0; index < invalidEmbeddings.length; index += 1) {
        const name = `invalid-embedding-${index}`;
        const content = `invalid vector marker${index}`;
        manager.embedTexts = async () => [invalidEmbeddings[index]];
        await manager.addObservations([{ entityName: name, contents: [content] }]);
        const entityId = await repo.getEntityId(name);
        const vectorCount = await db.get('SELECT COUNT(*) AS count FROM obs_vec WHERE entity_id = ?', [entityId]);
        assert.equal(Number(vectorCount.count), 0, `${name} must remain lexical-only`);

        const result = await manager.searchNodes({ query: content, threshold: 0.35 });
        assert.deepEqual(result.entities.map(entity => entity.name), [name]);
    }
});

test('a vector-search exception does not suppress exact FTS matches', async t => {
    const { manager, repo, queryVectors } = await makeFixture(t);
    manager.embedTexts = async () => [buffer(queryVectors.get(QUERIES.exact))];
    repo.semanticSearch = async () => { throw new Error('synthetic vector failure'); };

    const result = await manager.searchNodes({ query: QUERIES.exact, threshold: 0.35 });
    assert.deepEqual(result.entities.map(entity => entity.name), ['exact-fts']);

    manager.embedTexts = async () => { throw new Error('synthetic embedding failure'); };
    const fallback = await manager.searchNodes({ query: QUERIES.exact, threshold: 0.35 });
    assert.deepEqual(fallback.entities.map(entity => entity.name), ['exact-fts']);
});
