# Investigación: Migración de SSE a Streamable HTTP + Seguridad en MCP

## Contexto del Proyecto

Este proyecto es un **MCP Memory Server** que actualmente usa:

- **`mcp-proxy`** (Python) como bridge SSE→stdio en puerto 8945
- **`@iachilles/memento`** como servidor MCP real, conectado por stdio
- **Graph Viewer** en puerto 3022 con Express + SSE custom para la UI

## 1. ¿Por qué SSE está deprecado?

Fuente: [Why MCP Deprecated SSE and Went with Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

### Problemas de SSE:

| Problema | Descripción |
|----------|-------------|
| **2 endpoints** | Cliente necesita `/sse` (recibir) y `/messages` (enviar) |
| **Conexiones persistentes** | Difíciles de escalar, consumen recursos aunque estén idle |
| **No resumible** | Si la conexión cae, se pierde el estado de la sesión |
| **Serverless incompatible** | Vercel, Lambda, etc. tienen timeouts que matan SSE |
| **Load balancers problemáticos** | Requieren sticky sessions, buffers intermedios rompen SSE |
| **HTTP/2 y HTTP/3** | Incompatibilidades con protocolos modernos |

### Conclusión de la especificación oficial (2025-06-18):

> Streamable HTTP reemplaza al transporte HTTP+SSE de la versión 2024-11-05.

---

## 2. ¿Qué es Streamable HTTP?

Es el nuevo transporte estándar para MCP remoto. Usa **un solo endpoint** (`/mcp`) que maneja:

- **POST** → Cliente envía mensajes JSON-RPC al servidor
- **GET** → Cliente abre stream SSE opcional para notificaciones del servidor
- **DELETE** → Cliente termina sesión explícitamente

### Flujo básico:

```
Cliente → POST /mcp (JSON-RPC request)
Servidor → 200 + application/json (respuesta directa)
  O
Servidor → 200 + text/event-stream (streaming para respuestas largas)
```

### Manejo de sesiones:

- La sesión se identifica con header `Mcp-Session-Id` (UUID, JWT, etc.)
- No requiere conexión persistente
- Session state via header, no via connection
- Resumible via `Last-Event-Id`

---

## 3. Implementación en TypeScript/Node.js

### SDK requerido: `@modelcontextprotocol/sdk` ≥ 1.10.0

Actualmente el proyecto tiene `@modelcontextprotocol/sdk` v1.29.0 (via dependencia transitiva de `@iachilles/memento`), que YA soporta Streamable HTTP.

### Servidor Streamable HTTP:

```typescript
import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

const sessions = new Map<string, StreamableHTTPServerTransport>();

// Endpoint único /mcp para POST (mensajes del cliente)
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Sesión existente
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // Nueva sesión
  if (!sessionId) {
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionId: newSessionId,
      onsessioninitialized: () => {
        sessions.set(newSessionId, transport);
      },
    });
    transport.onclose = () => sessions.delete(newSessionId);
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // Session ID inválido
  res.status(400).json({ error: { code: -32000, message: "Invalid session" } });
});

// GET para stream de notificaciones del servidor (opcional)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = sessions.get(sessionId);
  if (!transport) return res.status(400).json({ error: "No session" });
  await transport.handleRequest(req, res);
});

// DELETE para terminar sesión
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = sessions.get(sessionId);
  if (transport) {
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(204).end();
});
```

### Cliente Streamable HTTP:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"));
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
```

### Compatibilidad hacia atrás (SSE + Streamable HTTP simultáneos):

Se pueden mantener ambos transports durante la migración:

```typescript
// Streamable HTTP (nuevo)
app.all("/mcp", /* StreamableHTTPServerTransport */);

// SSE legacy (deprecado)
app.get("/sse", /* SSEServerTransport */);
app.post("/messages", /* handler messages */);
```

---

## 4. Seguridad: OAuth 2.1 para MCP

Fuente: [MCP Authorization Spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

### La especificación MCP exige OAuth 2.1 como estándar de autenticación:

| Componente | Descripción |
|------------|-------------|
| **OAuth 2.1** | Flujo obligatorio, con PKCE para todos los clients |
| **PKCE (RFC 7636)** | Obligatorio para todos los flujos (S256) |
| **Dynamic Client Registration (RFC 7591)** | Recomendado para registro automático |
| **Authorization Server Metadata (RFC 8414)** | Para discovery de endpoints |
| **Protected Resource Metadata (RFC 9728)** | El MCP server expone metadatos de auth |
| **Resource Indicators (RFC 8707)** | Tokens vinculados a recursos específicos |
| **HTTPS obligatorio** | Todos los endpoints de auth deben ser HTTPS |

### Flujo OAuth 2.1 en MCP:

```
1. Cliente → POST /mcp (sin token)
   Servidor → 401 + WWW-Authenticate header
   
2. Cliente descubre metadatos:
   GET /.well-known/oauth-authorization-server
   → authorization_endpoint, token_endpoint, etc.

3. Dynamic Client Registration (opcional):
   POST /register → client_id

4. Authorization Request con PKCE:
   Redirect a /authorize?code_challenge=...

5. Token Exchange:
   POST /token → access_token + refresh_token

6. Request autenticado:
   POST /mcp + Authorization: Bearer <token>
```

### Implementación mínima de seguridad para el proyecto:

```typescript
// Middleware de autenticación
app.use("/mcp", async (req, res, next) => {
  // Skip auth para initialize
  if (req.body?.method === "initialize") return next();

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({
      error: { code: -32001, message: "Authentication required" }
    });
  }

  try {
    const claims = await verifyToken(token);
    req.user = claims;
    next();
  } catch {
    return res.status(401).json({
      error: { code: -32001, message: "Invalid token" }
    });
  }
});
```

El SDK ya incluye dependencias necesarias:
- `jose` (JWT)
- `pkce-challenge` (PKCE)
- `express-rate-limit` (rate limiting)
- `cors` (CORS)

---

## 5. Situación actual del proyecto y ruta de migración

### Arquitectura actual:

```
MCP Client → SSE (puerto 8945) → mcp-proxy → stdio → memento
                        ↓
Graph Viewer (Express, puerto 3022) ← SQLite ←┘
```

### Opciones de migración:

#### Opción A: Reemplazar mcp-proxy con servidor Node.js directo

**Ventajas:** Control total, más simple, elimina dependencia Python
**Desventajas:** Requiere reescribir el bridge, perderíamos mcp-proxy features

#### Opción B: Usar mcp-proxy en modo Streamable HTTP (si lo soporta)

**Ventajas:** Mínimos cambios
**Desventajas:** Dependemos de que mcp-proxy implemente Streamable HTTP

#### Opción C: Servidor Express propio con StreamableHTTPTransport + graph-viewer integrado

**Ventajas:** Todo unificado, control total, seguridad integrada
**Desventajas:** Mayor reescritura inicial

### Plan recomendado (Opción C):

1. **Fase 1** - Servidor Streamable HTTP:
   - Crear nuevo servidor Express con endpoint `/mcp` usando `StreamableHTTPServerTransport`
   - Conectar al backend `memento` via stdio (reemplazando mcp-proxy)
   - Mantener compatibilidad SSE para clients legacy

2. **Fase 2** - Seguridad:
   - Implementar middleware de autenticación Bearer token
   - Exponer `.well-known/oauth-authorization-server`
   - Implementar endpoint `/register` para Dynamic Client Registration
   - Rate limiting con `express-rate-limit`
   - Validación de Origin header contra DNS rebinding

3. **Fase 3** - Integración con Graph Viewer:
   - Unificar en un mismo proceso Express
   - Migrar SSE custom del graph viewer a Streamable HTTP
   - Endpoints REST en el mismo servidor

4. **Fase 4** - Producción:
   - TLS/SSL (HTTPS)
   - Integración con identity provider existente (Auth0, Okta, etc.)
   - Session store externo (Redis) para escalado horizontal

---

## 6. Referencias

- [MCP Transports Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Authorization Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Why MCP Deprecated SSE (fka.dev)](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [Streamable HTTP Enterprise Guide (WebMCPGuide)](https://webmcpguide.com/articles/mcp-streamable-http-transport-enterprise-guide)
- [MCP OAuth 2.1 Guide (Prefect)](https://www.prefect.io/resources/mcp-oauth)
- [MCP Authentication Guide (Stytch)](https://stytch.com/blog/MCP-authentication-and-authorization-guide)
- [@modelcontextprotocol/sdk - StreamableHTTP](https://github.com/modelcontextprotocol/typescript-sdk)
