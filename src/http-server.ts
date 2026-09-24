import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Hono } from 'hono';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildBootstrapToken, serializeManualTokenOverride } from './services/pelotonAuth.js';
import {
  createAuthCodeStore,
  isValidCodeChallenge,
  parseAllowedRedirectUris,
  verifyPkce,
} from './services/oauthCodes.js';
import {
  loadToken,
  saveTokenWithRetry,
  setRuntimeToken,
  type PelotonAuthToken,
} from './services/tokenStore.js';

type Env = { Bindings: HttpBindings };

export function createHttpApp(): Hono<Env> {
  const app = new Hono<Env>();

  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  const oauthClientId = process.env.OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;
  const allowedRedirectUris = parseAllowedRedirectUris(process.env.ALLOWED_REDIRECT_URIS);
  const authCodes = createAuthCodeStore();

  // Health check — no auth required (Fly.io uses this)
  app.get('/health', (c) => c.json({ status: 'ok', app: 'peloton-mcp-server' }));

  // Token refresh endpoint
  app.post('/refresh-token', async (c) => {
    return c.json(
      {
        success: false,
        error: 'No manual refresh endpoint is required. Auto-login with PELOTON_USERNAME and PELOTON_PASSWORD runs before API calls and after read auth failures. Use /update-peloton-token only as an explicit manual override.',
      },
      410
    );
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
      code_challenge_methods_supported: ['S256'],
    });
  });

  // OAuth authorize — issues a single-use, PKCE-bound code; never the bearer itself
  app.get('/authorize', (c) => {
    const responseType = c.req.query('response_type');
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state');
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method');

    if (!oauthClientId || clientId !== oauthClientId) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    // Never redirect to an unregistered URI, even to report an error (RFC 6749 §4.1.2.1).
    if (!redirectUri || !allowedRedirectUris.has(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri not allowed' }, 400);
    }
    if (responseType !== 'code') {
      return c.json({ error: 'unsupported_response_type' }, 400);
    }
    if (codeChallengeMethod !== 'S256' || !codeChallenge || !isValidCodeChallenge(codeChallenge)) {
      return c.json({ error: 'invalid_request', error_description: 'PKCE S256 code_challenge required' }, 400);
    }

    const code = authCodes.issue({ clientId, redirectUri, codeChallenge });
    if (!code) {
      return c.json({ error: 'temporarily_unavailable' }, 503);
    }

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return c.redirect(redirectUrl.toString());
  });

  // OAuth token — the only place the bearer is ever returned
  app.post('/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = String(body['grant_type'] ?? '');
    const code = String(body['code'] ?? '');
    const clientId = String(body['client_id'] ?? '');
    const clientSecret = String(body['client_secret'] ?? '');
    const redirectUri = String(body['redirect_uri'] ?? '');
    const codeVerifier = String(body['code_verifier'] ?? '');

    if (!oauthClientId || !oauthClientSecret || !mcpAuthToken) {
      return c.json({ error: 'server_error', error_description: 'OAuth not configured' }, 503);
    }
    const expectedSecret = Buffer.from(oauthClientSecret);
    const actualSecret = Buffer.from(clientSecret);
    if (
      clientId !== oauthClientId ||
      expectedSecret.length !== actualSecret.length ||
      !timingSafeEqual(expectedSecret, actualSecret)
    ) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    if (grantType !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    const grant = authCodes.consume(code);
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.redirectUri !== redirectUri ||
      !verifyPkce(codeVerifier, grant.codeChallenge)
    ) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    return c.json({ access_token: mcpAuthToken, token_type: 'bearer', expires_in: 3600 });
  });

  return app;
}

export const ADMIN_PORT_DEFAULT = 9091;

function bearerMatches(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Served only on the private admin listener; the public app has no route for this.
export function createAdminApp(): Hono<Env> {
  const app = new Hono<Env>();
  const configuredSecret = process.env.PELOTON_TOKEN_UPDATE_SECRET;
  // A stolen MCP bearer must never unlock this route, even if misconfigured.
  const updateSecret = configuredSecret !== process.env.MCP_AUTH_TOKEN ? configuredSecret : undefined;

  // Manual override for updating a Peloton Bearer token at runtime.
  app.post('/update-peloton-token', async (c) => {
    if (!bearerMatches(c.req.header('authorization'), updateSecret)) {
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

    const accessToken = String((body as { token: unknown }).token).trim();
    if (!accessToken.startsWith('eyJ')) {
      return c.json({ error: 'Invalid token: must be a JWT (starts with eyJ)' }, 400);
    }

    const refreshTokenValue =
      'refresh_token' in body && typeof (body as { refresh_token?: unknown }).refresh_token === 'string'
        ? (body as { refresh_token: string }).refresh_token.trim()
        : undefined;

    // Bootstrap is a deliberate manual override, so it must not adopt a different Turso token.
    const authToken = await serializeManualTokenOverride(async (): Promise<PelotonAuthToken> => {
      const existingToken = await loadToken();
      const nextToken = buildBootstrapToken(accessToken, refreshTokenValue, existingToken);
      setRuntimeToken(nextToken);
      await saveTokenWithRetry(nextToken);
      return nextToken;
    });

    return c.json({
      success: true,
      user_id: authToken.user_id,
      expires_at: new Date(authToken.expires_at).toISOString(),
      has_refresh_token: Boolean(authToken.refresh_token),
    });
  });

  return app;
}

export async function startHttpServer(createMcpServer: () => Server): Promise<void> {
  const PORT = Number(process.env.PORT ?? 8080);
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  const updateSecret = process.env.PELOTON_TOKEN_UPDATE_SECRET;

  // Auth is mandatory: the HTTP server exposes /mcp publicly. Without a bearer
  // secret it would serve unauthenticated, so refuse to start rather than
  // silently failing open.
  if (!mcpAuthToken) {
    console.error('❌ MCP_AUTH_TOKEN must be set when running the HTTP server');
    process.exit(1);
  }
  if (updateSecret && updateSecret === mcpAuthToken) {
    console.error('❌ PELOTON_TOKEN_UPDATE_SECRET must differ from MCP_AUTH_TOKEN');
    process.exit(1);
  }
  if (parseAllowedRedirectUris(process.env.ALLOWED_REDIRECT_URIS).size === 0) {
    console.error('⚠️ ALLOWED_REDIRECT_URIS is empty — /authorize will reject every request');
  }

  const app = createHttpApp();
  const honoListener = getRequestListener(app.fetch);

  const server = http.createServer(async (req, res) => {
    const urlPath = new URL(req.url ?? '/', `http://localhost`).pathname;

    // /mcp: create a fresh transport + server per request (SDK v1.27+ stateless requirement)
    if (urlPath === '/mcp') {
      if (req.headers['authorization'] !== `Bearer ${mcpAuthToken}`) {
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

  if (!updateSecret) {
    console.error('[Server] PELOTON_TOKEN_UPDATE_SECRET not set — admin listener disabled');
    return;
  }
  const adminPort = Number(process.env.ADMIN_PORT ?? ADMIN_PORT_DEFAULT);
  // fly-local-6pn is this machine's private IPv6; the port must stay out of fly.toml services.
  const adminHost = process.env.ADMIN_HOST ?? (process.env.FLY_APP_NAME ? 'fly-local-6pn' : '127.0.0.1');
  http
    .createServer(getRequestListener(createAdminApp().fetch))
    .on('error', (error: Error) => {
      console.error(`[Server] Admin listener failed: ${error.message}`);
    })
    .listen(adminPort, adminHost, () => {
      console.error(`[Server] Admin listener on ${adminHost}:${adminPort} (private network only)`);
    });
}
