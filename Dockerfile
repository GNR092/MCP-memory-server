# ==============================================================
# STAGE 1: builder — compila módulos nativos e instala paquetes
# ==============================================================
FROM platformatic/node-caged:25-slim AS builder

RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y \
    bash \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    sqlite3 \
    && npm install -g @iachilles/memento@latest \
    && pip install --no-cache-dir --break-system-packages mcp-proxy \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Compilar dependencias del graph-viewer (necesita build-essential)
WORKDIR /app
COPY graph-viewer/ ./graph-viewer/
RUN rm -rf /app/graph-viewer/node_modules && \
    npm install --prefix /app/graph-viewer

# ==============================================================
# STAGE 2: runtime — solo lo necesario para ejecutar
# ==============================================================
FROM platformatic/node-caged:25-slim

ENV NODE_OPTIONS="--max-old-space-size=256"

# Parchear CVEs e instalar solo runtime deps
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y \
    nginx \
    python3 \
    sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Copiar binarios globales y módulos npm compilados desde builder
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

RUN chmod +x start \
    && ln -s /app/nginx.conf /etc/nginx/sites-enabled/graph-viewer

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD timeout 5 python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8945/sse', timeout=4)" || exit 1

EXPOSE 80 8945

VOLUME ["/data"]

CMD ["bash", "./start"]
