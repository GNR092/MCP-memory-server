#!/usr/bin/env node
/**
 * Verifica que obs_vec use la dimensión del modelo de embeddings activo.
 * - Si obs_vec no existe: la crea con la dimensión del modelo.
 * - Si la dimensión difiere: backup con fecha/hora y reconstruye obs_vec
 *   re-embebiendo las observaciones. No toca entities/observations/relations.
 * - Si coincide: no hace nada.
 *
 * Se ejecuta desde `start` antes de levantar memento. Si falla, el arranque aborta.
 */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const MEMENTO_DIR = process.env.MEMENTO_DIR || '/usr/local/lib/node_modules/@gener/memento-minilm';
const VIEWER_DIR = process.env.VIEWER_DIR || '/app/graph-viewer';
const DB_PATH = process.env.MEMORY_DB_PATH || '/data/memory.db';
// Debe coincidir con el modelo que usa src/knowledge-graph-manager.js de memento.
const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const CACHE = process.env.TRANSFORMERS_CACHE || '/data/.cache/transformers';

const log = (...args) => console.log('[migrate-vectors]', ...args);

const requireMemento = createRequire(path.join(MEMENTO_DIR, 'package.json'));
const requireViewer = createRequire(path.join(VIEWER_DIR, 'package.json'));
const Database = requireViewer('better-sqlite3');
const { getLoadablePath } = requireMemento('sqlite-vec');

// Dimensiones conocidas para no cargar el modelo (ni descargarlo) en cada arranque.
// Si el modelo no está en la tabla, se detecta ejecutándolo.
const KNOWN_DIMS = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/bge-m3': 1024
};

let extractor = null;
async function probeDim() {
    if (!extractor) {
        const { pipeline, env } = await import(
            pathToFileURL(requireMemento.resolve('@xenova/transformers')).href
        );
        env.cacheDir = CACHE;
        extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
    }
    const output = await extractor('dimension probe', { pooling: 'mean', normalize: true });
    return output.data.length;
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
db.loadExtension(getLoadablePath());

const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'obs_vec'")
    .get();
const currentDim = schema ? Number((/FLOAT\[(\d+)\]/i.exec(schema.sql) || [])[1]) : null;

log(`modelo=${MODEL} cache=${CACHE}`);
log(`obs_vec=${currentDim === null ? 'no existe' : currentDim + ' dims'}`);

let expectedDim = KNOWN_DIMS[MODEL];
if (expectedDim === undefined) {
    expectedDim = await probeDim();
}
log(`modelo=${expectedDim} dims`);

const createSql = (table) =>
    `CREATE VIRTUAL TABLE ${table} USING vec0(entity_id INT, embedding FLOAT[${expectedDim}])`;

if (currentDim === expectedDim) {
    log('sin cambios');
    db.close();
    process.exit(0);
}

if (currentDim === null) {
    db.exec(createSql('obs_vec'));
    log(`obs_vec creada con ${expectedDim} dims`);
    db.close();
    process.exit(0);
}

// El modelo es la fuente de verdad: si la tabla de dimensiones conocidas
// está desactualizada, manda lo que devuelve el modelo.
expectedDim = await probeDim();
if (expectedDim === currentDim) {
    log('sin cambios');
    db.close();
    process.exit(0);
}

if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get()) {
    throw new Error('obs_vec existe pero falta la tabla observations');
}

const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
const backupPath = `${DB_PATH}.bak-${stamp}-${currentDim}d`;
await db.backup(backupPath);
log(`backup: ${backupPath}`);

const observations = db.prepare('SELECT id, entity_id, content FROM observations ORDER BY id').all();
log(`re-embebiendo ${observations.length} observaciones de ${currentDim} a ${expectedDim} dims...`);

db.exec('DROP TABLE IF EXISTS obs_vec_new');
db.exec(createSql('obs_vec_new'));
const insert = db.prepare(
    'INSERT INTO obs_vec_new(rowid, entity_id, embedding) VALUES (CAST(? AS INTEGER), CAST(? AS INTEGER), ?)'
);
const insertBatch = db.transaction((rows) => {
    for (const row of rows) insert.run(row.id, row.entity_id, row.embedding);
});

const BATCH = 100;
for (let i = 0; i < observations.length; i += BATCH) {
    const chunk = observations.slice(i, i + BATCH);
    const rows = [];
    for (const observation of chunk) {
        const output = await extractor(observation.content, { pooling: 'mean', normalize: true });
        rows.push({
            id: observation.id,
            entity_id: observation.entity_id,
            embedding: Buffer.from(Float32Array.from(output.data).buffer)
        });
    }
    insertBatch(rows);
    const done = Math.min(i + BATCH, observations.length);
    if (done % 1000 === 0 || done === observations.length) log(`${done}/${observations.length}`);
}

// Swap atómico: si el proceso muere a mitad, SQLite deja obs_vec intacta.
db.transaction(() => {
    db.exec('DROP TABLE obs_vec');
    db.exec(createSql('obs_vec'));
    db.exec('INSERT INTO obs_vec(rowid, entity_id, embedding) SELECT rowid, entity_id, embedding FROM obs_vec_new');
    db.exec('DROP TABLE obs_vec_new');
})();

const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const count = db.prepare('SELECT COUNT(*) AS c FROM obs_vec').get().c;
db.close();

if (integrity !== 'ok') {
    fs.copyFileSync(backupPath, DB_PATH);
    fs.rmSync(`${DB_PATH}-wal`, { force: true });
    fs.rmSync(`${DB_PATH}-shm`, { force: true });
    throw new Error(`integrity_check falló (${integrity}); restaurado ${backupPath}`);
}

log(`migración OK: ${count} vectores de ${expectedDim} dims`);
