import http from 'node:http';
import { Hono } from 'hono';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loginWithPassword } from './services/pelotonAuth.js';
import { saveToken, setRuntimeToken } from './services/tokenStore.js';
import { isError } from './types/errors.js';

type Env = { Bindings: HttpBindings };

export function createHttpApp(): Hono<Env> {
  const app = new Hono<Env>();

  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  const oauthClientId = process.env.OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;

  const isAuthorized = (authHeader: string | undefined): boolean => {
    if (!mcpAuthToken) return true;
    return authHeader === `Bearer ${mcpAuthToken}`;
  };

  // Health check — no auth required (Fly.io uses this)
  app.get('/health', (c) => c.json({ status: 'ok', app: 'peloton-mcp-server' }));

  // Token refresh endpoint
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

  // Update Peloton Bearer token at runtime — no secret redeploy needed
  app.post('/update-peloton-token', async (c) => {
    if (!isAuthorized(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null || !('token' in body)) {
      return c.json({ error: 'Missing required field: token' }, 400);
    }

    const token = String((body as { token: unknown }).token).trim();
    if (!token.startsWith('eyJ')) {
      return c.json({ error: 'Invalid token: must be a JWT (starts with eyJ)' }, 400);
    }

    // Parse expiry and user_id from the JWT payload
    let expiresAt: number;
    let userId: string = 'unknown';
    try {
      const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString());
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>;
        expiresAt = typeof p['exp'] === 'number'
          ? p['exp'] * 1000
          : Date.now() + 2 * 24 * 60 * 60 * 1000;
        const uid = p['http://onepeloton.com/user_id'] ?? p['sub'];
        if (typeof uid === 'string') userId = uid;
      } else {
        expiresAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
      }
    } catch {
      expiresAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
    }

    const authToken = { access_token: token, token_type: 'Bearer', expires_at: expiresAt, user_id: userId };
    setRuntimeToken(authToken);
    await saveToken(authToken);

    return c.json({
      success: true,
      user_id: userId,
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  // OAuth 2.0 discovery — required by claude.ai remote MCP connectors
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const base = `${proto}://${url.host}`;
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
  });

  // OAuth authorize — redirects back with code = MCP_AUTH_TOKEN
  app.get('/authorize', (c) => {
    const responseType = c.req.query('response_type');
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state');

    if (!oauthClientId || clientId !== oauthClientId) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    if (responseType !== 'code') {
      return c.json({ error: 'unsupported_response_type' }, 400);
    }
    if (!redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri required' }, 400);
    }

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', mcpAuthToken ?? '');
    if (state) redirectUrl.searchParams.set('state', state);
    return c.redirect(redirectUrl.toString());
  });

  // OAuth token — exchanges code for access_token
  app.post('/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = String(body['grant_type'] ?? '');
    const code = String(body['code'] ?? '');
    const clientId = String(body['client_id'] ?? '');
    const clientSecret = String(body['client_secret'] ?? '');

    if (!oauthClientId || !oauthClientSecret) {
      return c.json({ error: 'server_error', error_description: 'OAuth not configured' }, 503);
    }
    if (clientId !== oauthClientId || clientSecret !== oauthClientSecret) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    if (grantType !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (code !== mcpAuthToken) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    return c.json({ access_token: mcpAuthToken, token_type: 'bearer', expires_in: 3600 });
  });

  return app;
}

export async function startHttpServer(createMcpServer: () => Server): Promise<void> {
  const PORT = Number(process.env.PORT ?? 8080);
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;

  const app = createHttpApp();
  const honoListener = getRequestListener(app.fetch);

  const server = http.createServer(async (req, res) => {
    const urlPath = new URL(req.url ?? '/', `http://localhost`).pathname;

    // /mcp: create a fresh transport + server per request (SDK v1.27+ stateless requirement)
    if (urlPath === '/mcp') {
      if (mcpAuthToken && req.headers['authorization'] !== `Bearer ${mcpAuthToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // New transport + server per request — stateless mode requires this
      const transport = new StreamableHTTPServerTransport({});
      const mcpServer = createMcpServer();
      // Cast needed: SDK's exactOptionalPropertyTypes on onclose differs from Transport interface
      await mcpServer.connect(transport as unknown as Transport);

      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
              await transport.handleRequest(req, res, body);
            } catch {
              if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
              }
            }
          })();
        });
      } else {
        // GET (SSE notifications) or DELETE (session termination)
        await transport.handleRequest(req, res);
      }
      return;
    }

    // All other routes go through Hono
    await honoListener(req, res);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.error(`[Server] Peloton MCP HTTP server running on port ${PORT}`);
    console.error(`[Server] MCP endpoint: http://localhost:${PORT}/mcp`);
    console.error(`[Server] Health check: http://localhost:${PORT}/health`);
  });
}
