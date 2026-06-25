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
    && npm install --prefix /app/graph-viewer

RUN mkdir -p /data

EXPOSE 80 8945

VOLUME ["/data"]

CMD ["bash", "./start"]