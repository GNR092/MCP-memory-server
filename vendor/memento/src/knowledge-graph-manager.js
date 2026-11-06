/**
 * @file knowledge-graph-manager.js
 * @description
 * Backend-agnostic knowledge graph manager that coordinates CRUD and search
 * operations through a repository abstraction.
 */

import { pipeline, env } from '@xenova/transformers';
import { SearchContextManager } from './search-context-manager.js';

const EMBEDDING_DIM = Number.parseInt(process.env.EMBEDDING_DIM || '384', 10);

// Redirect model cache to a writable volume when running as non-root.
if (process.env.TRANSFORMERS_CACHE) {
    env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

function vectorFromBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0 ||
        !Number.isInteger(EMBEDDING_DIM) || EMBEDDING_DIM <= 0 ||
        buffer.byteLength !== EMBEDDING_DIM * Float32Array.BYTES_PER_ELEMENT) return null;

    const vector = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, EMBEDDING_DIM));
    let normSquared = 0;
    for (const value of vector) {
        if (!Number.isFinite(value)) return null;
        normSquared += value * value;
    }
    return Number.isFinite(normSquared) && normSquared > 0 ? vector : null;
}

function normalizeVector(vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return vector.map(value => value / norm);
}

export class KnowledgeGraphManager {
    /**
     * @type {import('./graph-repository.js').GraphRepository}
     */
    #repository;

    /** @type {any} */
    #embedder = null;

    /** @type {SearchContextManager} */
    #searchContextManager;

    /**
     * Creates a new KnowledgeGraphManager.
     * @param {import('./graph-repository.js').GraphRepository} repository
     *   Graph repository implementation for data persistence.
     */
    constructor(repository) {
        this.#repository = repository;
        this.#searchContextManager = new SearchContextManager(repository);
    }

    /**
     * Creates multiple entities in the knowledge graph.
     * @async
     * @param {Array<{name: string, entityType: string, observations?: string[]}>} entities
     *   Array of entities to create with optional observations.
     * @returns {Promise<Array<{name: string, entityType: string}>>}
     *   Array of successfully created entities.
     */
    async createEntities(entities) {
        const created = [];
        for (const entity of entities) {
            const existingId = await this.#repository.getEntityId(entity.name);
            if (!existingId) {
                await this.#repository.createEntity(entity.name, entity.entityType);
                created.push(entity);
            }
            if (entity.observations?.length) {
                await this.addObservations([{ entityName: entity.name, contents: entity.observations }]);
            }
        }
        return created;
    }

    /**
     * Adds observations to entities and generates embeddings for them.
     * @async
     * @param {Array<{entityName: string, contents: string[]}>} list
     *   Array of objects containing entity names and their observations.
     * @returns {Promise<Array<{entityName: string, addedObservations: string[]}>>}
     *   Array of results showing which observations were added to each entity.
     */
    async addObservations(list) {
        const results = [];
        for (const { entityName, contents } of list) {
            const entityId = await this.#repository.getOrCreateEntityId(entityName, 'Unknown');
            const inserted = [];
            for (const content of contents) {
                const { inserted: wasInserted, observationId } = await this.#repository.insertObservation(entityId, content);
                if (wasInserted && observationId !== null && observationId !== undefined) {
                    inserted.push({ observationId, content });
                }
            }
            if (inserted.length) {
                const embeddings = await this.embedTexts(inserted.map(row => row.content));
                const vectorRows = inserted.flatMap((row, index) => vectorFromBuffer(embeddings[index])
                    ? [{ observationId: row.observationId, entityId, embedding: embeddings[index] }]
                    : []);
                await this.#repository.insertObservationVectors(vectorRows);
            }
            results.push({ entityName, addedObservations: inserted.map(item => item.content) });
        }
        return results;
    }

    /**
     * Creates relations between entities in the knowledge graph.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to create.
     * @returns {Promise<Array<{from: string, to: string, relationType: string}>>}
     *   Array of successfully created relations.
     */
    async createRelations(relations) {
        const created = [];
        for (const relation of relations) {
            const fromId = await this.#repository.getOrCreateEntityId(relation.from, 'Unknown');
            const toId = await this.#repository.getOrCreateEntityId(relation.to, 'Unknown');
            const inserted = await this.#repository.createRelation(fromId, toId, relation.relationType);
            if (inserted) {
                created.push(relation);
            }
        }
        return created;
    }

    /**
     * Deletes entities from the knowledge graph by their names.
     * @async
     * @param {string[]} names - Array of entity names to delete.
     * @returns {Promise<void>}
     */
    async deleteEntities(names) {
        await this.#repository.deleteEntities(names);
    }

    /**
     * Deletes relations between entities.
     * @async
     * @param {Array<{from: string, to: string, relationType: string}>} relations
     *   Array of relations to delete.
     * @returns {Promise<void>}
     */
    async deleteRelations(relations) {
        await this.#repository.deleteRelations(relations);
    }

    /**
     * Deletes specific observations from entities.
     * @async
     * @param {Array<{entityName: string, observations: string[]}>} list
     *   Array of objects containing entity names and observations to delete.
     * @returns {Promise<void>}
     */
    async deleteObservations(list) {
        for (const { entityName, observations } of list) {
            const entityId = await this.#repository.getEntityId(entityName);
            if (!entityId) continue;
            await this.#repository.deleteObservations(entityId, observations);
        }
    }

    /**
     * Retrieves the complete knowledge graph.
     * @async
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing all entities and relations in the graph.
     */
    readGraph() {
        return this.#repository.readGraph();
    }

    /**
     * Searches the knowledge graph using semantic search.
     * @async
     * @param {object} options - Search configuration options.
     * @param {string} options.query - Search query string.
     * @param {number} [options.topK=10] - Maximum number of results to return.
     * @param {number} [options.threshold=0.75] - Maximum L2 distance for semantic results.
     * @param {boolean} [options.includeScoreDetails=false] - Include score components in results.
     * @param {string} [options.scoringProfile='balanced'] - Scoring profile to use.
     * @returns {Promise<{entities: Array, relations: Array}>}
     *   Search results with entities and their relations.
     */
    async searchNodes({
                          query,
                          topK = 10,
                          threshold = 0.75,
                          includeScoreDetails = false,
                          scoringProfile = 'balanced'
                      }) {

        try {
            const lexicalRows = await this.#repository.searchObservations(query, topK);
            let semanticRows = [];
            const limit = Math.max(topK * 2, topK + 5);
            if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 2) {
                try {
                    const [rawVectorBuf] = await this.embedTexts([query]);
                    const rawVector = vectorFromBuffer(rawVectorBuf);
                    if (rawVector) {
                        const rows = await this.#repository.semanticSearch(normalizeVector(rawVector), limit, threshold);
                        const maxCosineDistance = threshold ** 2 / 2;
                        semanticRows = rows
                            .filter(row => row?.cosineDistance !== null && row?.cosineDistance !== undefined &&
                                row?.distance !== null && row?.distance !== undefined)
                            .filter(row => {
                                const cosineDistance = Number(row.cosineDistance);
                                const distance = Number(row.distance);
                                return Number.isFinite(cosineDistance) && cosineDistance >= 0 &&
                                    cosineDistance <= maxCosineDistance && Number.isFinite(distance);
                            })
                            .filter((row, index, all) => all.findIndex(other => other.entity_id === row.entity_id) === index)
                            .slice(0, topK);
                    }
                } catch {
                    // Keep exact-text matches when embedding or vector search is unavailable.
                }
            }
            const semanticIds = semanticRows.map(row => row.entity_id);
            const lexicalIds = lexicalRows.map(row => Number(row.entity_id));
            const lexicalOnly = [...new Set(lexicalIds)].filter(id => !semanticIds.includes(id));
            const ids = [...semanticIds.slice(0, Math.max(0, topK - lexicalOnly.length)), ...lexicalOnly.slice(0, topK)];

            const matchedByEntity = new Map(lexicalRows.map(row => [Number(row.entity_id), row.content]));
            const selectedSemanticIds = semanticRows
                .filter(row => ids.includes(row.entity_id))
                .map(row => row.observation_id);
            const semanticObservations = await this.#repository.getObservationsByIds(selectedSemanticIds);
            for (const row of semanticObservations) {
                if (!matchedByEntity.has(Number(row.entity_id))) matchedByEntity.set(Number(row.entity_id), row.content);
            }

            if (!ids.length) {
                return { entities: [], relations: [] }
            }

            return this.#applyScoring(ids, query, includeScoreDetails, scoringProfile, matchedByEntity, new Set(semanticIds));

        } catch (error) {
            console.error(`Search error:`, error?.message ?? error);

            throw error;
        }
    }

    /**
     * Retrieves detailed information for specified entities by their names.
     * @async
     * @param {string[]} names - Array of entity names to retrieve.
     * @returns {Promise<{entities: Array<{name: string, entityType: string, observations: string[]}>, relations: Array<{from: string, to: string, relationType: string}>}>}
     *   Object containing specified entities with observations and their relations.
     */
    async openNodes(names, options) {
        return this.#repository.openNodes(names, options);
    }

    /**
     * Generates embeddings for an array of text strings using the configured model.
     * @async
     * @param {string[]} textArr - Array of text strings to embed.
     * @returns {Promise<Buffer[]>}
     *   Array of embedding vectors as Buffers.
     */
    async embedTexts(textArr) {
        if (!this.#embedder) {
            this.#embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
        }
        const outputs = [];
        for (const text of textArr) {
            const result = await this.#embedder(text, { pooling: 'mean', normalize: true });
            outputs.push(Buffer.from(Float32Array.from(result.data).buffer));
        }

        return outputs;
    }

    /**
     * Applies relevance scoring to search results using context and access patterns.
     * @async
     * @private
     * @param {number[]} entityIds - Array of entity IDs from search results.
     * @param {string} query - Original search query for context.
     * @param {boolean} includeScoreDetails - Whether to include score components.
     * @param {string} scoringProfile - Scoring profile to use.
     * @returns {Promise<{entities: Array, relations: Array}>}
     *   Scored and sorted results with entities and relations.
     */
    async #applyScoring(entityIds, query, includeScoreDetails, scoringProfile, matchedByEntity, semanticIds) {
        if (!entityIds?.length) {
            return { entities: [], relations: [] };
        }
        const entityData = await this.#repository.fetchEntitiesWithDetails(entityIds);
        const normalized = entityData.map(row => ({ ...row, entity_id: String(row.entity_id) }));
        const searchContext = await this.#searchContextManager.prepareSearchContext(query, {
            contextSize: 5,
            preloadDepth: 2
        });
        const scored = await this.#searchContextManager.scoreSearchResults(normalized, searchContext, {
            includeComponents: includeScoreDetails,
            scoringProfile
        });
        scored.sort((a, b) => (b.score || 0) - (a.score || 0));
        const lexicalOrder = entityIds.filter(id => !semanticIds.has(Number(id)));
        const byId = new Map(scored.map(row => [Number(row.entity_id), row]));
        const semanticOrder = scored.filter(row => semanticIds.has(Number(row.entity_id)));
        const ordered = semanticOrder.concat(lexicalOrder.map(id => byId.get(Number(id))).filter(Boolean));
        const foundIds = ordered.map(row => Number(row.entity_id));

        if (foundIds.length) {
            await this.#searchContextManager.updateAccessStats(foundIds);
        }

        const entityNames = ordered.map(row => row.name);
        const fullDetails = await this.openNodes(entityNames, { observationLimit: 1, observationOffset: 0 });
        const detailsByName = new Map(fullDetails.entities.map(entity => [entity.name, entity]));
        const compactEntities = ordered.map(row => {
            const details = detailsByName.get(row.name);
            const content = matchedByEntity.get(Number(row.entity_id)) || details?.observations[0] || '';
            return {
                name: row.name,
                entityType: row.entityType,
                observations: content ? [content.length > 280 ? `${content.slice(0, 277)}...` : content] : [],
                observationCount: details?.observationCount || 0,
                nextObservationOffset: details?.nextObservationOffset ?? null
            };
        });

        if (includeScoreDetails) {
            const scoreByName = new Map(ordered.map(row => [row.name, row]));
            const withScores = compactEntities.map(entity => ({
                ...entity,
                score: scoreByName.get(entity.name)?.score,
                scoreComponents: scoreByName.get(entity.name)?.scoreComponents
            }));
            return { entities: withScores, relations: fullDetails.relations };
        }

        return { entities: compactEntities, relations: fullDetails.relations };
    }

    /**
     * Retrieves or optionally creates an entity ID by name.
     * @async
     * @param {string} name - Entity name to look up.
     * @param {string} [type='Unknown'] - Entity type to use if creating.
     * @param {boolean} [create=false] - Whether to create the entity if not found.
     * @returns {Promise<number|null>}
     *   Entity ID if found or created, null if not found and create is false.
     */
    async getEntityId(name, type = 'Unknown', create = false) {
        const existing = await this.#repository.getEntityId(name);
        if (existing !== null) {
            return existing;
        }
        if (!create) {
            return null;
        }

        return this.#repository.getOrCreateEntityId(name, type);
    }

    /**
     * Sets the importance level for an entity.
     * @async
     * @param {string} entityName - Name of the entity to update.
     * @param {string} importance - Importance level (e.g., 'critical', 'important', 'normal').
     * @returns {Promise<{success: boolean, entityName?: string, importance?: string, message?: string, error?: string}>}
     *   Object indicating operation success and details or error message.
     */
    async setImportance(entityName, importance) {
        try {
            const entityId = await this.getEntityId(entityName);

            if (!entityId) {
                return { success: false, error: `Entity "${entityName}" not found` };
            }

            const success = await this.#searchContextManager.setImportance(entityId, importance);

            return {
                success,
                entityName,
                importance,
                message: success
                    ? `Importance set to '${importance}' for entity '${entityName}'`
                    : `Failed to set importance for entity '${entityName}'`
            };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}
