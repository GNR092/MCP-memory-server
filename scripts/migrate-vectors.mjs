#!/usr/bin/env node
/**
 * Verifica que obs_vec use la dimensión del modelo de embeddings activo.
 * - Si obs_vec no existe: la crea con la dimensión configurada.
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
const DB_PATH = process.env.MEMORY_DB_PATH || '/data/memory.db';
// Debe coincidir con el modelo (Xenova/all-MiniLM-L6-v2 -> 384) y con
// EMBEDDING_DIM que usa el paquete de memento para crear la tabla.
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '384', 10);
const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const CACHE = process.env.TRANSFORMERS_CACHE || '/data/.cache/transformers';

const log = (...args) => console.log('[migrate-vectors]', ...args);

/**
 * Lee la dimensión declarada por la tabla obs_vec.
 * @param {import('sqlite').Database} db
 * @returns {Promise<number|null>}
 */
export async function currentDim(db) {
    const row = await db.get(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'obs_vec'"
    );
    if (!row) {
        return null;
    }
    const match = /FLOAT\[(\d+)\]/i.exec(row.sql || '');
    return match ? Number(match[1]) : null;
}

/**
 * Borra los vectores de entidades que ya no existen. vec0 no tiene cascada, así
 * que un delete deja vectores sueltos que ocupan los huecos del LIMIT en la
 * busqueda y devuelven observaciones borradas.
 * @param {import('sqlite').Database} db
 * @returns {Promise<number>} Cuántos vectores huerfanos se borraron.
 */
export async function cleanOrphanVectors(db) {
    // En una base nueva memento aún no creó el esquema: no hay contra qué comparar.
    const schema = await db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'"
    );
    if (!schema) {
        return 0;
    }
    const vectors = await db.all('SELECT entity_id FROM obs_vec');
    const entities = await db.all('SELECT id FROM entities');
    const live = new Set(entities.map(entity => Number(entity.id)));
    const orphans = [
        ...new Set(vectors.map(vector => Number(vector.entity_id)).filter(id => !live.has(id)))
    ];
    if (!orphans.length) {
        return 0;
    }
    const placeholders = orphans.map(() => '?').join(',');
    const result = await db.run(`DELETE FROM obs_vec WHERE entity_id IN (${placeholders})`, orphans);
    // changes = filas borradas (varias por entidad huérfana); el fallback es por si el driver no lo reporta.
    return Number(result.changes ?? orphans.length);
}

/**
 * Reconstruye obs_vec con la dimensión esperada.
 * @param {object} options
 * @param {import('sqlite').Database} options.db Conexión SQLite abierta.
 * @param {number} options.expectedDim Dimensión wanted.
 * @param {(text: string) => Promise<Float32Array>} options.embed Genera el vector de un texto.
 * @param {string} options.dbPath Ruta de la base (para el backup).
 * @returns {Promise<{action: string, backupPath?: string, count?: number}>}
 */
export async function migrateVectors({ db, expectedDim, embed, dbPath }) {
    const fromDim = await currentDim(db);

    if (fromDim === expectedDim) {
        return { action: 'none' };
    }

    if (fromDim === null) {
        await db.exec(
            `CREATE VIRTUAL TABLE obs_vec USING vec0(entity_id INT, embedding FLOAT[${expectedDim}])`
        );
        return { action: 'created' };
    }

    const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = `${dbPath}.bak-${stamp}-${fromDim}d`;
    await db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    const observations = await db.all('SELECT id, entity_id, content FROM observations ORDER BY id');

    await db.exec('DROP TABLE IF EXISTS obs_vec_new');
    await db.exec(
        `CREATE VIRTUAL TABLE obs_vec_new USING vec0(entity_id INT, embedding FLOAT[${expectedDim}])`
    );

    const insert = await db.prepare(
        'INSERT INTO obs_vec_new(rowid, entity_id, embedding) VALUES (?, ?, ?)'
    );
    const BATCH = 100;
    for (let i = 0; i < observations.length; i += BATCH) {
        const rows = [];
        for (const observation of observations.slice(i, i + BATCH)) {
            const vector = await embed(observation.content);
            rows.push([
                observation.id,
                observation.entity_id,
                Buffer.from(Float32Array.from(vector).buffer)
            ]);
        }
        await db.exec('BEGIN TRANSACTION');
        try {
            for (const row of rows) {
                await insert.run(row[0], row[1], row[2]);
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    }
    await insert.finalize();

    // El intercambio va en una transaccion: si el proceso muere a mitad,
    // obs_vec queda como estaba.
    await db.exec('BEGIN TRANSACTION');
    try {
        await db.exec('DROP TABLE obs_vec');
        await db.exec(
            `CREATE VIRTUAL TABLE obs_vec USING vec0(entity_id INT, embedding FLOAT[${expectedDim}])`
        );
        await db.exec(
            'INSERT INTO obs_vec(rowid, entity_id, embedding) SELECT rowid, entity_id, embedding FROM obs_vec_new'
        );
        await db.exec('DROP TABLE obs_vec_new');
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    const count = await db.get('SELECT COUNT(*) AS c FROM obs_vec');
    return { action: 'migrated', backupPath, count: Number(count.c) };
}

/**
 * Carga el modelo y devuelve la función de embedding.
 * @returns {Promise<(text: string) => Promise<Float32Array>>}
 */
async function loadEmbedder() {
    const requireMemento = createRequire(path.join(MEMENTO_DIR, 'package.json'));
    const { pipeline, env } = await import(
        pathToFileURL(requireMemento.resolve('@xenova/transformers')).href
    );
    env.cacheDir = CACHE;
    const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
    return async (text) => {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return Float32Array.from(output.data);
    };
}

/**
 * Abre la base con el driver que usa memento y ejecuta la migración.
 * @returns {Promise<void>}
 */
async function main() {
    const requireMemento = createRequire(path.join(MEMENTO_DIR, 'package.json'));
    const { open } = requireMemento('sqlite');
    const sqlite3 = requireMemento('sqlite3');
    const { getLoadablePath } = requireMemento('sqlite-vec');

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout=5000;');
    await db.loadExtension(getLoadablePath());

    log(`modelo=${MODEL} dim=${EMBEDDING_DIM}`);
    const fromDim = await currentDim(db);
    log(`obs_vec=${fromDim === null ? 'no existe' : fromDim + ' dims'}`);

    if (fromDim === EMBEDDING_DIM) {
        const cleaned = await cleanOrphanVectors(db);
        if (cleaned) {
            log(`limpiados ${cleaned} vectores huerfanos`);
        }
        log('sin cambios');
        await db.close();
        return;
    }

    const embed = await loadEmbedder();
    const probe = await embed('dimension probe');
    if (probe.length !== EMBEDDING_DIM) {
        log(`[WARN] el modelo produce ${probe.length} dims y EMBEDDING_DIM dice ${EMBEDDING_DIM}`);
    }

    const result = await migrateVectors({
        db,
        expectedDim: probe.length,
        embed,
        dbPath: DB_PATH
    });

    if (result.action === 'created') {
        log(`obs_vec creada con ${probe.length} dims`);
    } else if (result.action === 'migrated') {
        log(`backup: ${result.backupPath}`);
        log(`migración OK: ${result.count} vectores de ${probe.length} dims`);
    }
    const cleaned = await cleanOrphanVectors(db);
    if (cleaned) {
        log(`limpiados ${cleaned} vectores huerfanos`);
    }
    await db.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((error) => {
        console.error('[migrate-vectors] ERROR:', error.message);
        process.exit(1);
    });
}
