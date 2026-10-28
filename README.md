# MCP Memory Server

Servidor MCP de memoria persistente. Guarda entidades, observaciones y relaciones en un
archivo SQLite, con vectores para buscar por significado usando **MiniLM-L6-v2** (384 dims).

## Requisitos

- Node.js 18+ (para los tests)
- Docker y Docker Compose

## Estructura

| Ruta | Qué es |
|------|--------|
| `vendor/memento/` | Código del servidor MCP de memoria (MiniLM). Se empaqueta en la imagen. |
| `scripts/migrate-vectors.mjs` | Se ejecuta al arrancar: si el índice de vectores es de otra dimensión, hace backup con fecha/hora y lo reconstruye. |
| `graph-viewer/` | Visor del grafo en Express (interfaz web). |
| `memorydata/` | Datos: `memory.db` y la caché del modelo. Montado como `/data`. |

## Uso con Docker

```bash
docker compose up --build
```

El MCP queda en `http://localhost:8888/sse` y el visor del grafo en `http://localhost:8888/graph/`.

El puerto **no tiene autenticación** y por eso solo escucha en `127.0.0.1`. Para entrar
desde otro equipo usa un túnel SSH:

```bash
ssh -L 8888:localhost:8888 usuario@servidor
```

## Tests

```bash
npm install
npm test
```

## Configuración

| Variable | Por defecto | Para qué |
|----------|-------------|----------|
| `MEMORY_DB_PATH` | `/data/memory.db` | Ruta de la base de datos. |
| `TRANSFORMERS_CACHE` | `/data/.cache/transformers` | Dónde se guarda el modelo. |
| `EMBEDDING_DIM` | `384` | Dimensión de los vectores. Debe coincidir con el modelo. |
| `VERSION` | `2.0.1` | Versión que se graba en la imagen. |

La base de datos se guarda en `/data/memory.db` dentro del contenedor (`./memorydata` en el host).

## Migración del índice de vectores

Al arrancar, `scripts/migrate-vectors.mjs` compara la dimensión de la tabla `obs_vec` con
la del modelo. Si no coinciden (por ejemplo, una base creada con BGE-M3 de 1024 dims),
hace un backup `memory.db.bak-<fecha-hora>-<dim>d` y reconstruye el índice re-embebiendo
las observaciones. Si la migración falla, el contenedor no arranca.

## Autor

- **Gener Can Dzul** - [GNR092](https://github.com/GNR092)
- Email: genercan092@gmail.com
