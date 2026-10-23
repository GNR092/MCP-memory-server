# @gener/memento-minilm

Servidor MCP de memoria: entidades, observaciones y relaciones en SQLite, con
vectores MiniLM-L6-v2 (384 dims) para buscar por significado.

Es un fork de [iAchilles/memento](https://github.com/iAchilles/memento) recortado a lo
que usa este proyecto: **solo SQLite** y **solo MiniLM** (se quitó el soporte de
PostgreSQL y el motor BGE-M3 de 1024 dims).

## Variables de entorno

| Variable | Por defecto | Para qué |
|----------|-------------|----------|
| `MEMORY_DB_PATH` | junto al módulo | Ruta de la base de datos. |
| `SQLITE_VEC_PATH` | el de `sqlite-vec` | Ruta de la extensión `vec0`. |
| `EMBEDDING_DIM` | `384` | Dimensión de la tabla `obs_vec`. Debe coincidir con el modelo. |
| `TRANSFORMERS_CACHE` | caché por defecto | Dónde se guarda el modelo. |

Si la base viene de otro modelo, la tabla `obs_vec` tiene otra dimensión y las
escrituras fallan. `scripts/migrate-vectors.mjs` (en el repo que lo empaqueta) hace
el backup y la reconstrucción al arrancar.

## Herramientas MCP

`create_entities`, `create_relations`, `add_observations`, `delete_entities`,
`delete_relations`, `delete_observations`, `read_graph`, `search_nodes`, `open_nodes`,
`set_importance`.

## Licencia

MIT (heredada del proyecto original).
