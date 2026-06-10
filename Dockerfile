FROM node:20-slim

# sqlite3 CLI es opcional (solo para debugging)
RUN apt-get update && apt-get install -y \
    sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Instalar memento globalmente
RUN npm install -g @iachilles/memento@latest

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de la app
RUN npm install --omit=dev

# Copiar el c\u00f3digo de la app
COPY src ./src

# Crear directorio de datos
RUN mkdir -p /data && chown -R node:node /data

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV MCP_ENDPOINT=/mcp
ENV MEMORY_DB_PATH=/data/memory.db
ENV GRAPH_ENABLED=true
ENV AUTH_ENABLED=true

EXPOSE 3000

VOLUME ["/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/index.js"]
