# ==============================================================
# STAGE 1: builder — compila módulos nativos e instala paquetes
# ==============================================================
FROM platformatic/node-caged:25-slim AS builder

WORKDIR /build

# El motor de embeddings vive en el repo (vendor/memento), no en un .tgz opaco.
COPY vendor/memento/ ./vendor/memento/

RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    sqlite3 \
    && npm pack --pack-destination /build ./vendor/memento \
    && npm install -g /build/gener-memento-minilm-*.tgz \
    && pip install --no-cache-dir --break-system-packages "mcp<2.0.0" "mcp-proxy==0.12.0"

# Compilar dependencias del graph-viewer (necesita build-essential para better-sqlite3)
WORKDIR /app
COPY graph-viewer/ ./graph-viewer/
RUN rm -rf /app/graph-viewer/node_modules && \
    npm install --prefix /app/graph-viewer

# Limpiar dependencias de compilación (ya no se necesitan)
RUN apt-get purge -y --auto-remove python3-dev build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ==============================================================
# STAGE 2: runtime — solo lo necesario para ejecutar
# ==============================================================
FROM platformatic/node-caged:25-slim

ENV NODE_OPTIONS="--max-old-space-size=256" \
    NODE_ENV=production \
    MEMORY_DB_PATH=/data/memory.db \
    TRANSFORMERS_CACHE=/data/.cache/transformers \
    EMBEDDING_DIM=384

# Parchear CVEs e instalar solo runtime deps
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    nginx \
    python3 \
    sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default \
    && sed -i \
        -e 's|^user www-data;|# user www-data;|' \
        -e 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' \
        -e 's|error_log /var/log/nginx/error.log;|error_log /tmp/nginx-error.log warn;|' \
        -e 's|access_log /var/log/nginx/access.log;|access_log /tmp/nginx-access.log;|' \
        /etc/nginx/nginx.conf

# Copiar binarios desde builder (COPY de directorio preserva symlinks)
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# Copiar paquetes pip (mcp-proxy y dependencias)
COPY --from=builder /usr/local/lib/python3.11/dist-packages /usr/local/lib/python3.11/dist-packages

# Copiar graph-viewer compilado desde builder
COPY --from=builder /app/graph-viewer /app/graph-viewer

# Versión de la aplicación (inyectar con --build-arg VERSION=x.y.z)
ARG VERSION=0.0.0
ENV APP_VERSION=$VERSION

WORKDIR /app

COPY start nginx.conf ./
COPY scripts/ ./scripts/

RUN chmod +x start \
    && ln -s /app/nginx.conf /etc/nginx/sites-enabled/graph-viewer

# Crear usuario no-root con UID/GID coincidentes con el host (1000:1000 por defecto).
# Esto evita problemas de permisos con bind mounts como ./memorydata:/data.
ARG USER_ID=1000
ARG GROUP_ID=1000
RUN groupadd -g ${GROUP_ID} appgroup \
    && useradd -u ${USER_ID} -g appgroup -d /app -s /sbin/nologin appuser \
    && mkdir -p /data \
    && mkdir -p /data/.cache/transformers \
    && mkdir -p /var/lib/nginx/body /var/lib/nginx/proxy /var/lib/nginx/fastcgi \
    && mkdir -p /var/lib/nginx/uwsgi /var/lib/nginx/scgi \
    && chown -R appuser:appgroup /app /data /var/lib/nginx /var/log/nginx /tmp

USER appuser

HEALTHCHECK --interval=30s --timeout=6s --start-period=60s --retries=3 \
  CMD timeout 5 python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/status', timeout=4)" || exit 1

# Solo nginx se publica (8080). El MCP (8945) y el visor (3022) son internos.
EXPOSE 8080

VOLUME ["/data"]

CMD ["bash", "./start"]
