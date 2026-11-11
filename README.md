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

### Autenticación opcional del visor

El graph-viewer no requiere autenticación por defecto. Para habilitar HTTP Basic, define ambas
variables antes de iniciar Compose:

```bash
export GRAPH_VIEWER_USER=viewer
export GRAPH_VIEWER_PASSWORD='sustituye-por-una-clave-segura'
docker compose up --build
```

Si solo se define una variable, el visor no arranca. Usa un gestor de secretos adecuado para
tu despliegue; las variables de entorno son visibles para usuarios con acceso a inspeccionar
el contenedor.

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

## Búsqueda de memoria

`search_nodes` combina similitud semántica con coincidencias de texto completo
(FTS5) y devuelve fragmentos breves. `open_nodes` devuelve hasta 10 observaciones
por entidad; usa `observationOffset` para pedir la página siguiente y
`observationLimit` para ajustar el tamaño (máximo 100).

### `threshold` (cambio incompatible en beta)

`threshold` es la distancia L2 máxima entre las **direcciones unitarias** de los
embeddings semánticos; su rango MCP es `[0, 2]`. Para vectores finitos, no nulos y de
dimensión compatible, se calcula `c = vec_distance_cosine(query, stored)`,
`d_unit = sqrt(2*c)` y se acepta cuando `c <= threshold^2/2`. Así, distintas normas
con la misma dirección tienen distancia 0. La búsqueda exacta FTS5 no se filtra por
este umbral y permanece disponible si falla el canal vectorial.

Es un cambio incompatible en beta: el default público MCP cambia de `0.35` a `0.75`,
y `threshold` ahora es una distancia máxima, no una similitud mínima. Para vectores
unitarios, `0.75` equivale a `cosine_min = 1 - 0.75^2/2 = 0.71875`. El default interno
de `KnowledgeGraphManager.searchNodes` también es `0.75`; el schema MCP acepta `[0, 2]`.
La alternativa de compatibilidad para aproximarse a una similitud coseno mínima de
`0.35` es `threshold ≈ 1.140175`.

#### Calibración sintética (no corpus lingüístico)

`npm run benchmark:hybrid-search` ejecuta el benchmark determinista de 54 pares con
similitudes alrededor de `0.3/0.5/0.7/0.9` y casos próximos a ambos cortes. Las
etiquetas semánticas consideran positivos los grupos `0.7/0.9` y negativos `0.3/0.5`;
cuatro pares adicionales modelan coincidencias FTS exactas positivas para el cálculo
híbrido. Resultados:

| L2 threshold | Canal | TP | FP | FN | Precision | Recall |
|---:|---|---:|---:|---:|---:|---:|
| `0.35` | Vectorial | 2 | 0 | 30 | 1.000 | 0.063 |
| `0.35` | Híbrido | 6 | 0 | 26 | 1.000 | 0.188 |
| `0.75` | Vectorial | 16 | 0 | 16 | 1.000 | 0.500 |
| `0.75` | Híbrido | 20 | 0 | 12 | 1.000 | 0.625 |
| `1.140175` | Vectorial | 30 | 11 | 2 | 0.732 | 0.938 |
| `1.140175` | Híbrido | 32 | 11 | 0 | 0.744 | 1.000 |

Es una ilustración geométrica reproducible y limitada, no un corpus lingüístico real ni
evidencia de mejora neta; los pares FTS son etiquetas sintéticas, no una medición de
BM25 real. Recalibra el umbral con un corpus lingüístico real antes de extraer
conclusiones de calidad o rendimiento.

## Autor

- **Gener Can Dzul** - [GNR092](https://github.com/GNR092)
- Email: genercan092@gmail.com
