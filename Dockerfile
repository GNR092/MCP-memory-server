FROM node:20-slim

RUN apt-get update && apt-get install -y \
    bash \
    python3 \
    python3-pip \
    sqlite3 \
    && npm install -g @iachilles/memento@latest \
    && pip install --no-cache-dir --break-system-packages mcp-proxy \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY start .

RUN chmod +x start

RUN mkdir -p /data && chown -R node:node /data

EXPOSE 8945

VOLUME ["/data"]

CMD ["bash", "./start"]