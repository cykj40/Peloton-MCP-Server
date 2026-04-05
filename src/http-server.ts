import { Hono } from 'hono';
import { serve, type HttpBindings } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loginWithPassword } from './services/pelotonAuth.js';
import { saveToken } from './services/tokenStore.js';
import { isError } from './types/errors.js';

type Env = { Bindings: HttpBindings };

export function createHttpApp(
  _mcpServer: Server,
  httpTransport: StreamableHTTPServerTransport
): Hono<Env> {
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

  // Streamable HTTP MCP endpoint — POST (tool calls, requests)
  app.post('/mcp', async (c) => {
    if (!isAuthorized(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const body: unknown = await c.req.json();
    await httpTransport.handleRequest(req, res, body);
    return new Response(null);
  });

  // Streamable HTTP MCP endpoint — GET (SSE stream for server-sent notifications)
  app.get('/mcp', async (c) => {
    if (!isAuthorized(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const req = c.env.incoming;
    const res = c.env.outgoing;
    await httpTransport.handleRequest(req, res);
    return new Response(null);
  });

  // Streamable HTTP MCP endpoint — DELETE (session termination)
  app.delete('/mcp', async (c) => {
    if (!isAuthorized(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const req = c.env.incoming;
    const res = c.env.outgoing;
    await httpTransport.handleRequest(req, res);
    return new Response(null);
  });

  return app;
}

export async function startHttpServer(mcpServer: Server): Promise<void> {
  const PORT = Number(process.env.PORT ?? 8080);

  // Stateless mode: omit sessionIdGenerator so each request is independent
  const httpTransport = new StreamableHTTPServerTransport({});

  // Cast needed: SDK's exactOptionalPropertyTypes on onclose differs from Transport interface
  await mcpServer.connect(httpTransport as unknown as Transport);

  const app = createHttpApp(mcpServer, httpTransport);

  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
    console.error(`[Server] Peloton MCP HTTP server running on port ${PORT}`);
    console.error(`[Server] MCP endpoint: http://localhost:${PORT}/mcp`);
    console.error(`[Server] Health check: http://localhost:${PORT}/health`);
  });
}
