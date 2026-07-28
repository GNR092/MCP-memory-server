FROM node:20-slim

RUN apt-get update && apt-get install -y \
    bash \
    nginx \
    python3 \
    python3-pip \
    sqlite3 \
    && npm install -g @iachilles/memento@latest \
    && pip install --no-cache-dir --break-system-packages mcp-proxy \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY graph-viewer/ ./graph-viewer/
COPY start nginx.conf ./

RUN chmod +x start \
    && rm -f /etc/nginx/sites-enabled/default \
    && ln -s /app/nginx.conf /etc/nginx/sites-enabled/graph-viewer \
    && rm -rf /app/graph-viewer/node_modules \
    && npm install --prefix /app/graph-viewer

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD timeout 5 python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8945/sse', timeout=4)" || exit 1

EXPOSE 80 8945

VOLUME ["/data"]

CMD ["bash", "./start"]