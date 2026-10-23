/**
 * @file db-manager.js
 * @description
 * Creates the SQLite database manager. This fork only supports SQLite.
 */
import { SqliteDbManager } from './sqlite/db-manager.js';

/**
 * Factory helper for creating a database manager based on configuration.
 * @param {{
 *   sqlite?: { dbPath?: string|null, sqliteVecPath?: string|null }
 * }} [options]
 * @returns {SqliteDbManager}
 */
export function createDbManager(options = {}) {
    return new SqliteDbManager(
        options.sqlite?.dbPath ?? process.env.MEMORY_DB_PATH ?? null,
        options.sqlite?.sqliteVecPath ?? process.env.SQLITE_VEC_PATH ?? null
    );
}
