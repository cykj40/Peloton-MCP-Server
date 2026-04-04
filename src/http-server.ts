import { Hono } from 'hono';
import { serve, type HttpBindings } from '@hono/node-server';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { loginWithPassword } from './services/pelotonAuth.js';
import { saveToken } from './services/tokenStore.js';
import { isError } from './types/errors.js';

type Env = { Bindings: HttpBindings };

const transports = new Map<string, SSEServerTransport>();

export function createHttpApp(mcpServer: Server): Hono<Env> {
  const app = new Hono<Env>();

  // Health check for Fly.io
  app.get('/health', (c) => c.json({ status: 'ok', app: 'peloton-mcp-server' }));

  // Token refresh endpoint (useful when Peloton token expires on Fly.io)
  app.post('/refresh-token', async (c) => {
    const username = process.env.PELOTON_USERNAME;
    const password = process.env.PELOTON_PASSWORD;

    if (!username || !password) {
      return c.json({ success: false, error: 'PELOTON_USERNAME and PELOTON_PASSWORD not set' }, 400);
    }

    try {
      const token = await loginWithPassword(username, password);
      await saveToken(token);
      return c.json({
        success: true,
        expires_at: new Date(token.expires_at).toISOString(),
        user_id: token.user_id,
      });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: isError(error) ? error.message : 'Unknown error' },
        500
      );
    }
  });

  // MCP SSE endpoint
  app.get('/sse', async (c) => {
    const res = c.env.outgoing;
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);

    // Keep the handler alive until the connection closes
    await new Promise<void>((resolve) => {
      res.on('close', resolve);
      res.on('finish', resolve);
    });

    return new Response(null);
  });

  // MCP POST messages endpoint
  app.post('/messages', async (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) {
      return c.json({ error: 'Missing sessionId query parameter' }, 400);
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const req = c.env.incoming;
    const res = c.env.outgoing;
    await transport.handlePostMessage(req, res);

    return new Response(null);
  });

  return app;
}

export function startHttpServer(mcpServer: Server): void {
  const PORT = Number(process.env.PORT ?? 8080);
  const app = createHttpApp(mcpServer);

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.error(`[Server] Peloton MCP HTTP server running on port ${PORT}`);
    console.error(`[Server] SSE endpoint: http://localhost:${PORT}/sse`);
    console.error(`[Server] Health check: http://localhost:${PORT}/health`);
  });
}
