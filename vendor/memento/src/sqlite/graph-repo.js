/**
 * @file sqlite/graph-repo.js
 * @description
 * SQLite implementation of the knowledge graph repository.
 */

/**
 * @implements {import('../graph-repository.js').GraphRepository}
 */
export class SqliteGraphRepository {
    /**
     * Creates a new SqliteGraphRepository.
     * @param {import('sqlite').Database} db - SQLite database instance.
     */
    constructor(db) {
        this.db = db;
    }

    /**
     * Serializes writes. SQLite has one transaction per connection, so two tools
     * running at the same time could commit or roll back each other's work.
     * @type {Promise<void>}
     * @private
     */
    #writeChain = Promise.resolve();

    /**
     * Runs a write so that no other write overlaps it.
     * @private
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    #write(fn) {
        const result = this.#writeChain.then(fn, fn);
        this.#writeChain = result.then(() => undefined, () => undefined);
        return result;
    }

    /**
     * Retrieves entity ID by name.
     * @async
     * @param {string} name - Entity name to look up.
     * @returns {Promise<number|null>}
     *   Entity ID if found, null otherwise.
     */
    async getEntityId(name) {
        const row = await this.db.get('SELECT id FROM entities WHERE name = ?', [name]);

        return row ? row.id : null;
    }

    /**
     * Creates a new entity.
     * @async
     * @param {string} name - Entity name.
     * @param {string} entityType - Entity type.
     * @returns {Promise<number>}
     *   The ID of the created entity.
     */
    async createEntity(name, entityType) {
        return this.#write(() => this.#insertEntity(name, entityType));
    }

    /**
     * Inserts an entity without queueing (call from inside a queued write).
     * @private
     */
    async #insertEntity(name, entityType) {
        const result = await this.db.run(
            'INSERT INTO entities(name, entityType) VALUES(?, ?)',
            [name, entityType]
        );

        return result.lastID;
    }

    /**
     * Gets or creates an entity ID.
     * @async
     * @param {string} name - Entity name.
     * @param {string} entityType - Entity type.
     * @returns {Promise<number>}
     *   Existing or newly created entity ID.
     */
    async getOrCreateEntityId(name, entityType) {
        return this.#write(async () => {
            const existing = await this.getEntityId(name);
            if (existing !== null) {
                return existing;
            }

            return this.#insertEntity(name, entityType);
        });
    }

    /**
     * Inserts an observation for an entity.
     * @async
     * @param {number} entityId - Entity ID.
     * @param {string} content - Observation content.
     * @returns {Promise<{inserted: boolean, observationId: number|null}>}
     *   Object indicating if observation was inserted and its ID.
     */
    async insertObservation(entityId, content) {
        return this.#write(async () => {
            const result = await this.db.run(
                'INSERT OR IGNORE INTO observations(entity_id, content) VALUES(?, ?)',
                [entityId, content]
            );

            if (!result.changes) {
                const existing = await this.db.get(
                    'SELECT id FROM observations WHERE entity_id = ? AND content = ?',
                    [entityId, content]
                );
                return { inserted: false, observationId: existing ? existing.id : null };
            }

            return { inserted: true, observationId: result.lastID };
        });
    }

    /**
     * Inserts or updates observation embeddings in the vector table.
     * @async
     * @param {Array<{observationId: number, entityId: number, embedding: Buffer}>} rows
     *   Array of observation vectors to insert.
     * @returns {Promise<void>}
     */
    async insertObservationVectors(rows) {
        if (!rows.length) {
            return;
        }

        await this.#write(async () => {
            await this.db.exec('BEGIN TRANSACTION');
            try {
                for (const { observationId, entityId, embedding } of rows) {
                    await this.db.run(
                        'INSERT OR REPLACE INTO obs_vec(rowid, entity_id, embedding) VALUES(?, ?, ?)',
                        [observationId, entityId, embedding]
                    );
                }
                await this.db.exec('COMMIT');
            } catch (error) {
                await this.db.exec('ROLLBACK');
                throw error;
            }
        });
    }

    /**
     * Creates a relation between two entities.
     * @async
     * @param {number} fromId - Source entity ID.
     * @param {number} toId - Target entity ID.
     * @param {string} relationType - Type of relation.
     * @returns {Promise<boolean>}
     *   True if relation was created, false if it already exists.
     */
    async createRelation(fromId, toId, relationType) {
        return this.#write(async () => {
            const result = await this.db.run(
                'INSERT OR IGNORE INTO relations(from_id, to_id, relationType) VALUES(?, ?, ?)',
                [fromId, toId, relationType]
            );

            return Boolean(result.changes);
        });
    }

    /**
     * Deletes entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to delete.
     * @returns {Promise<void>}
     */
    async deleteEntities(names) {
        if (!names.length) {
            return;
        }

        const placeholders = names.map(() => '?').join(',');
        await this.#write(async () => {
            // obs_vec no tiene cascada: sus vectores se borran a mano o quedan
            // huerfanos y ocupan los huecos del LIMIT en la busqueda.
            const entities = await this.db.all(
                `SELECT id FROM entities WHERE name IN (${placeholders})`,
                names
            );
            const ids = entities.map(entity => entity.id);
            if (ids.length) {
                const idPlaceholders = ids.map(() => '?').join(',');
                await this.db.run(
                    `DELETE FROM obs_vec WHERE entity_id IN (${idPlaceholders})`,
                    ids
                );
            }
            await this.db.run(`DELETE FROM entities WHERE name IN (${placeholders})`, names);
        });
    }

    /**
     * Deletes relations between entities.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to delete with entity names and relation type.
     * @returns {Promise<void>}
     */
    async deleteRelations(relations) {
        await this.#write(async () => {
            for (const relation of relations) {
                const fromId = await this.getEntityId(relation.from);
                const toId = await this.getEntityId(relation.to);
                if (!fromId || !toId) continue;
                await this.db.run(
                    `DELETE FROM relations WHERE from_id = ? AND to_id = ? AND relationType = ?`,
                    [fromId, toId, relation.relationType]
                );
            }
        });
    }

    /**
     * Deletes specific observations from an entity.
     * @async
     * @param {number} entityId - Entity ID from which to delete observations.
     * @param {string[]} observations - Array of observation content strings to delete.
     * @returns {Promise<void>}
     */
    async deleteObservations(entityId, observations) {
        if (!observations.length) {
            return;
        }

        const placeholders = observations.map(() => '?').join(',');
        await this.#write(async () => {
            // El rowid de obs_vec es el id de la observacion.
            const rows = await this.db.all(
                `SELECT id FROM observations WHERE entity_id = ? AND content IN (${placeholders})`,
                [entityId, ...observations]
            );
            if (rows.length) {
                const idPlaceholders = rows.map(() => '?').join(',');
                await this.db.run(
                    `DELETE FROM obs_vec WHERE rowid IN (${idPlaceholders})`,
                    rows.map(row => row.id)
                );
            }
            await this.db.run(
                `DELETE FROM observations WHERE entity_id = ? AND content IN (${placeholders})`,
                [entityId, ...observations]
            );
        });
    }

    /**
     * Retrieves the complete knowledge graph including all entities and relations.
     * @async
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing all entities with their observations and all relations.
     */
    async readGraph() {
        const entities = await this.db.all('SELECT * FROM entities');
        const observations = await this.db.all('SELECT entity_id, content FROM observations');
        /**
         *
         * @type {[{from_name, to_name, relationType}]}
         */
        const relations = await this.db.all(`
            SELECT r.from_id, r.to_id, r.relationType, ef.name AS from_name, et.name AS to_name
            FROM relations r
                     JOIN entities ef ON ef.id = r.from_id
                     JOIN entities et ON et.id = r.to_id
        `);

        const observationsByEntity = new Map();
        for (const obs of observations) {
            const list = observationsByEntity.get(obs.entity_id);
            if (list) {
                list.push(obs.content);
            } else {
                observationsByEntity.set(obs.entity_id, [obs.content]);
            }
        }

        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entityType,
                observations: observationsByEntity.get(entity.id) || []
            })),
            relations: relations.map(rel => ({
                from: rel.from_name,
                to: rel.to_name,
                relationType: rel.relationType
            }))
        };
    }

    /**
     * Performs semantic search using vector similarity.
     * @async
     * @param {number[]} unitVector - Embedding vector as Buffer.
     * @param {number} topK - Maximum number of results to return.
     * @returns {Promise<Array<{entity_id: number, distance: number}>>}
     *   Array of entity IDs with their L2 distances.
     */
    // shortcut: sqlite-vec 0.1.7 no tiene indice aproximado, asi que cada
    // busqueda calcula la distancia de todos los vectores (O(n)). Con menos de
    // ~50.000 observaciones es instantaneo; si se pasa de ahi, cambiar a una
    // version de sqlite-vec con particiones o filtrar antes por texto.
    async semanticSearch(unitVector, topK) {
        const bufVec = this.#float32BufferFromArray(unitVector);

        const rows = await this.db.all(
            `SELECT entity_id, vec_distance_L2(embedding, ?) AS distance
                 FROM obs_vec
                 WHERE embedding IS NOT NULL
                 ORDER BY distance
                 LIMIT ?`,
            [ bufVec, topK ]
        );

        return rows.map(r => {
            const d = Number(r.distance)
            const similarity = 1 - (d * d) / 2

            return {
                entity_id: Number(r.entity_id),
                distance: d,
                similarity
            }
        });
    }

    /**
     * Fetches detailed metadata for specified entities including access statistics.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to fetch details for.
     * @returns {Promise<Array<{entity_id: number, name: string, entityType: string, created_at: string, last_accessed: string, access_count: number, importance: string}>>}
     *   Array of entities with their metadata and access statistics.
     */
    async fetchEntitiesWithDetails(entityIds) {
        if (!entityIds.length) {
            return [];
        }

        const placeholders = entityIds.map(() => '?').join(',');
        /**
         *
         * @type {{entity_id, name, entityType, created_at, last_accessed, access_count, importance}[]}
         */
        return this.db.all(
            `SELECT
                 e.id AS entity_id,
                 e.name,
                 e.entityType,
                 MIN(o.created_at) AS created_at,
                 MAX(o.last_accessed) AS last_accessed,
                 SUM(o.access_count) AS access_count,
                 COALESCE(
                     (SELECT o2.importance
                      FROM observations o2
                      WHERE o2.entity_id = e.id
                      ORDER BY o2.last_accessed DESC
                      LIMIT 1),
                     'normal'
                 ) AS importance
             FROM entities e
                      LEFT JOIN observations o ON o.entity_id = e.id
             WHERE e.id IN (${placeholders})
             GROUP BY e.id, e.name, e.entityType`,
            entityIds
        );
    }

    /**
     * Retrieves detailed information for specified entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to retrieve.
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing specified entities with observations and relations between them.
     */
    async openNodes(names) {
        if (!names.length) {
            return { entities: [], relations: [] };
        }

        const wanted = [...new Set(names)];
        const placeholders = wanted.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT * FROM entities WHERE name IN (${placeholders})`,
            wanted
        );

        if (!rows.length) {
            return { entities: [], relations: [] };
        }

        // El orden de entrada es el que pide el llamante (el buscador espera
        // que la entidad i del array sea la que tiene el score i).
        const byName = new Map(rows.map(entity => [entity.name, entity]));
        const entities = wanted.map(name => byName.get(name)).filter(Boolean);

        const ids = entities.map(e => e.id);
        const idPlaceholders = ids.map(() => '?').join(',');
        const observations = await this.db.all(
            `SELECT entity_id, content FROM observations WHERE entity_id IN (${idPlaceholders})`,
            ids
        );
        /**
         *
         * @type {[{from_name, to_name, relationType}]}
         */
        const relations = await this.db.all(
            `SELECT r.from_id, r.to_id, r.relationType, ef.name AS from_name, et.name AS to_name
             FROM relations r
                      JOIN entities ef ON ef.id = r.from_id
                      JOIN entities et ON et.id = r.to_id
             WHERE r.from_id IN (${idPlaceholders}) AND r.to_id IN (${idPlaceholders})`,
            [...ids, ...ids]
        );

        const observationsByEntity = new Map();
        for (const obs of observations) {
            const list = observationsByEntity.get(obs.entity_id);
            if (list) {
                list.push(obs.content);
            } else {
                observationsByEntity.set(obs.entity_id, [obs.content]);
            }
        }

        return {
            entities: entities.map(entity => ({
                name: entity.name,
                entityType: entity.entityType,
                observations: observationsByEntity.get(entity.id) || []
            })),
            relations: relations.map(relation => ({
                from: relation.from_name,
                to: relation.to_name,
                relationType: relation.relationType
            }))
        };
    }

    /**
     * Retrieves entity IDs for a list of entity names.
     * @async
     * @param {string[]} names - Array of entity names to look up.
     * @returns {Promise<Map<string, string>>}
     *   Map of entity names to their IDs as strings.
     */
    async getEntityIdsByNames(names) {
        if (!names.length) return new Map();
        const placeholders = names.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT name, id FROM entities WHERE name IN (${placeholders})`,
            names
        );
        const map = new Map();

        for (const row of rows) {
            map.set(row.name, row.id.toString());
        }

        return map;
    }

    /**
     * Retrieves entity names for a list of entity IDs.
     * @async
     * @param {number[]} ids - Array of entity IDs to look up.
     * @returns {Promise<Map<string, string>>}
     *   Map of entity IDs (as strings) to their names.
     */
    async getEntityNamesByIds(ids) {
        if (!ids.length) return new Map();
        const placeholders = ids.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT id, name FROM entities WHERE id IN (${placeholders})`,
            ids
        );
        const map = new Map();

        for (const row of rows) {
            map.set(row.id.toString(), row.name);
        }

        return map;
    }

    /**
     * Retrieves all relations involving specified entities.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to get relations for.
     * @returns {Promise<Array<{from_id: number, to_id: number}>>}
     *   Array of relations where entity is either source or target.
     */
    async getRelationsForEntityIds(entityIds) {
        if (!entityIds.length) {
            return [];
        }
        const placeholders = entityIds.map(() => '?').join(',');

        return this.db.all(
            `SELECT from_id, to_id
             FROM relations
             WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
            [...entityIds, ...entityIds]
        );
    }

    /**
     * Retrieves entity IDs that were recently accessed, sorted by last access time.
     * @async
     * @param {number} limit - Maximum number of entity IDs to return.
     * @returns {Promise<number[]>}
     *   Array of recently accessed entity IDs, most recent first.
     */
    async getRecentlyAccessedEntities(limit) {
        const rows = await this.db.all(
            `SELECT entity_id,
                    MAX(last_accessed) AS max_accessed
             FROM observations
             WHERE last_accessed IS NOT NULL
             GROUP BY entity_id
             ORDER BY max_accessed DESC
             LIMIT ?`,
            [limit]
        );

        return rows.map(row => row.entity_id);
    }

    /**
     * Updates access statistics for specified entities.
     * @async
     * @param {number[]} entityIds - Array of entity IDs to update.
     * @returns {Promise<void>}
     */
    async updateAccessStats(entityIds) {
        if (!entityIds.length) {
            return;
        }

        const placeholders = entityIds.map(() => '?').join(',');
        await this.#write(() =>
            this.db.run(
                `UPDATE observations
                 SET access_count = COALESCE(access_count, 0) + 1,
                     last_accessed = datetime('now')
                 WHERE entity_id IN (${placeholders})`,
                entityIds
            )
        );
    }

    /**
     * Sets the importance level for all observations of an entity.
     * @async
     * @param {number} entityId - Entity ID to update importance for.
     * @param {string} importance - Importance level (e.g., 'critical', 'important', 'normal').
     * @returns {Promise<boolean>}
     *   True if any observations were updated, false otherwise.
     */
    async setImportance(entityId, importance) {
        return this.#write(async () => {
            const result = await this.db.run(
                'UPDATE observations SET importance = ? WHERE entity_id = ?',
                [importance, entityId]
            );

            return result.changes > 0;
        });
    }

    /**
     * Converts a numeric embedding array into a Float32 binary buffer.
     *
     * This helper is used to transform a JavaScript number array (`number[]`)
     * into a `Buffer` that stores the same values as a contiguous `Float32Array`.
     * It is useful when passing embedding vectors to SQLite vector functions,
     * which expect a binary blob rather than a JSON array.
     *
     * @private
     * @param {number[]} values - The embedding values as a numeric array.
     * @returns {Buffer} A Buffer containing the same data encoded as Float32.
     */
    #float32BufferFromArray(values) {
        const fa = new Float32Array(values);

        return Buffer.from(fa.buffer);
    }
}
