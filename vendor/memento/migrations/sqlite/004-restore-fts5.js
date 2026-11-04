/**
 * @file 004-restore-fts5.js
 * @description Restore full-text search over observations.
 */

export const migration = {
    version: 4,
    description: 'Restore FTS5 index for observation search',

    async up(db, silent = false) {
        await db.exec(`
            CREATE VIRTUAL TABLE obs_fts USING fts5(
                content, entity_id UNINDEXED,
                content='observations', content_rowid='id'
            );
            CREATE TRIGGER obs_fts_insert AFTER INSERT ON observations BEGIN
                INSERT INTO obs_fts(rowid, content, entity_id)
                VALUES (new.id, new.content, new.entity_id);
            END;
            CREATE TRIGGER obs_fts_delete AFTER DELETE ON observations BEGIN
                INSERT INTO obs_fts(obs_fts, rowid, content, entity_id)
                VALUES ('delete', old.id, old.content, old.entity_id);
            END;
            CREATE TRIGGER obs_fts_update AFTER UPDATE OF content, entity_id ON observations BEGIN
                INSERT INTO obs_fts(obs_fts, rowid, content, entity_id)
                VALUES ('delete', old.id, old.content, old.entity_id);
                INSERT INTO obs_fts(rowid, content, entity_id)
                VALUES (new.id, new.content, new.entity_id);
            END;
            INSERT INTO obs_fts(obs_fts) VALUES ('rebuild');
        `);
        if (!silent) console.error('Restored FTS5 index for observations');
    },

    async down(db, silent = false) {
        await db.exec(`
            DROP TRIGGER IF EXISTS obs_fts_insert;
            DROP TRIGGER IF EXISTS obs_fts_delete;
            DROP TRIGGER IF EXISTS obs_fts_update;
            DROP TABLE IF EXISTS obs_fts;
        `);
        if (!silent) console.error('Removed FTS5 index for observations');
    }
};
