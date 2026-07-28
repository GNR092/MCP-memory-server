# ==============================================================
# STAGE 1: builder — compila módulos nativos e instala paquetes
# ==============================================================
FROM platformatic/node-caged:25-slim AS builder

RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    sqlite3 \
    && npm install -g @gener/memento-minilm@0.6.1-minilm.1 \
    && pip install --no-cache-dir --break-system-packages mcp-proxy

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
    NODE_ENV=production

# Parchear CVEs e instalar solo runtime deps
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    nginx \
    python3 \
    sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Copiar solo binarios necesarios desde builder
COPY --from=builder /usr/local/bin/memento /usr/local/bin/memento
COPY --from=builder /usr/local/bin/mcp-proxy /usr/local/bin/mcp-proxy
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

RUN chmod +x start \
    && ln -s /app/nginx.conf /etc/nginx/sites-enabled/graph-viewer

# Crear usuario no-root y volume
RUN groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser \
    && mkdir -p /data \
    && chown -R appuser:appgroup /app /data

USER appuser

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD timeout 5 python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8945/sse', timeout=4)" || exit 1

EXPOSE 80 8945

VOLUME ["/data"]

CMD ["bash", "./start"]
