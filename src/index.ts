#!/usr/bin/env node

try { await import('dotenv/config'); } catch {}
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { startHttpServer } from './http-server.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PelotonClient } from './services/pelotonClient.js';
import {
  profileTools,
  handleProfileTool,
  ProfileToolName,
} from './tools/profile.js';
import {
  workoutTools,
  handleWorkoutTool,
  WorkoutToolName,
} from './tools/workouts.js';
import {
  analyticsTools,
  handleAnalyticsTool,
  AnalyticsToolName,
} from './tools/analytics.js';
import {
  correlationTools,
  handleCorrelationTool,
  CorrelationToolName,
} from './tools/correlations.js';
import {
  loadToken,
  loadTokenIncludingExpired,
  saveToken,
  parseJwtExpiry,
  isTokenExpiring,
  PROACTIVE_EXPIRY_BUFFER_MS,
} from './services/tokenStore.js';
import { buildBootstrapToken, loginWithPassword, refreshOAuthTokenAndPersist } from './services/pelotonAuth.js';
import { runMigrations } from './db/migrations.js';
import {
  ConnectionTestSchema,
  CorrelationResponseSchema,
  GlucoseCorrelationAnalysisSchema,
  MuscleAnalysisSchema,
  ProfileSchema,
  SyncWorkoutsSchema,
  WorkoutSearchSchema,
  WorkoutStatsSchema,
} from './schemas/index.js';
import { isError } from './types/errors.js';
import { ToolResponse } from './types/index.js';

let pelotonClient: PelotonClient | null = null;
let authFailureReason: string | null = null;

const refreshTokenTool = {
  name: 'peloton_refresh_token' as const,
  description:
    'One-time bootstrap: store Peloton OAuth access + refresh tokens extracted from the browser (Network tab on members.onepeloton.com, auth/session or oauth/token response). ' +
    'After bootstrap, Auth0 refresh keeps tokens alive automatically. Access token must start with "eyJ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Required: access_token JWT from browser (starts with eyJ...).',
      },
      refresh_token: {
        type: 'string',
        description: 'Required for long-lived auth: refresh_token from the same OAuth response.',
      },
    },
    required: ['token', 'refresh_token'],
  },
};

const allTools = [...profileTools, ...workoutTools, ...analyticsTools, ...correlationTools, refreshTokenTool];
type ToolName = ProfileToolName | WorkoutToolName | AnalyticsToolName | CorrelationToolName;
type ToolHandler = (args: unknown, client: PelotonClient) => Promise<ToolResponse>;

const toolHandlers = {
  peloton_test_connection: (args, client) =>
    handleProfileTool('peloton_test_connection', ConnectionTestSchema.parse(args), client),
  peloton_get_profile: (args, client) =>
    handleProfileTool('peloton_get_profile', ProfileSchema.parse(args), client),
  peloton_get_workouts: (args, client) =>
    handleWorkoutTool('peloton_get_workouts', WorkoutSearchSchema.parse(args), client),
  peloton_muscle_activity: (args, client) =>
    handleAnalyticsTool('peloton_muscle_activity', MuscleAnalysisSchema.parse(args), client),
  peloton_muscle_impact: (args, client) =>
    handleAnalyticsTool('peloton_muscle_impact', MuscleAnalysisSchema.parse(args), client),
  peloton_workout_stats: (args, client) =>
    handleAnalyticsTool('peloton_workout_stats', WorkoutStatsSchema.parse(args), client),
  peloton_training_balance: (args, client) =>
    handleAnalyticsTool('peloton_training_balance', MuscleAnalysisSchema.parse(args), client),
  peloton_analyze_glucose_correlation: (args, client) =>
    handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      GlucoseCorrelationAnalysisSchema.parse(args),
      client
    ),
  peloton_get_discipline_insights: (args, client) =>
    handleCorrelationTool(
      'peloton_get_discipline_insights',
      CorrelationResponseSchema.parse(args),
      client
    ),
  peloton_detect_hypoglycemia_risk: (args, client) =>
    handleCorrelationTool(
      'peloton_detect_hypoglycemia_risk',
      CorrelationResponseSchema.parse(args),
      client
    ),
  peloton_sync_workouts: (args, client) =>
    handleCorrelationTool('peloton_sync_workouts', SyncWorkoutsSchema.parse(args), client),
} satisfies Record<ToolName, ToolHandler>;

type UnusedToolNameCheck =
  | Exclude<keyof typeof toolHandlers, ProfileToolName | WorkoutToolName | AnalyticsToolName | CorrelationToolName>
  | Exclude<ProfileToolName | WorkoutToolName | AnalyticsToolName | CorrelationToolName, keyof typeof toolHandlers>;
const _unusedToolNameCheck: UnusedToolNameCheck | undefined = undefined;
void _unusedToolNameCheck;

function isToolName(name: string): name is ToolName {
  return name in toolHandlers;
}

function createMcpServer(): Server {
  const srv = new Server(
    { name: 'peloton-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'peloton_refresh_token') {
    const parsed = args as { token?: string; refresh_token?: string };
    const manualToken = parsed?.token;
    const manualRefresh = parsed?.refresh_token;

    try {
      if (!manualToken || typeof manualToken !== 'string' || manualToken.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: token (access_token JWT) is required for OAuth bootstrap.' }],
        };
      }

      if (!manualRefresh || typeof manualRefresh !== 'string' || manualRefresh.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: refresh_token is required for OAuth bootstrap (extract both from browser Network tab).' }],
        };
      }

      const credential = manualToken.trim();
      const refreshCredential = manualRefresh.trim();
      if (!credential.startsWith('eyJ')) {
        return {
          content: [{ type: 'text', text: 'Invalid token: access token must be a JWT starting with "eyJ".' }],
        };
      }

      const jwtExp = parseJwtExpiry(credential);
      if (jwtExp !== null && jwtExp <= Date.now()) {
        return {
          content: [{ type: 'text', text: `Access token is already expired (exp: ${new Date(jwtExp).toISOString()}). Provide a fresh token pair from the browser.` }],
        };
      }

      const existingToken = await loadToken();
      const authToken = buildBootstrapToken(credential, refreshCredential, existingToken);
      await saveToken(authToken);

      pelotonClient = new PelotonClient(credential);
      authFailureReason = null;

      const expiresDate = new Date(authToken.expires_at).toLocaleString();
      return {
        content: [{
          type: 'text',
          text: `Peloton OAuth credentials stored.\n\n` +
            `Method: Browser bootstrap (access + refresh token)\n` +
            `Token Type: ${authToken.token_type}\n` +
            `User ID: ${authToken.user_id}\n` +
            `Expires: ${expiresDate}\n\n` +
            `All Peloton tools are now available. Auth0 refresh will renew tokens automatically before expiry.`
        }],
      };
    } catch (error: unknown) {
      return {
        content: [{ type: 'text', text: `Failed to store authentication: ${isError(error) ? error.message : 'Unknown error'}` }],
      };
    }
  }

  if (!pelotonClient) {
    await setupPelotonAuth();
  }

  if (!pelotonClient) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Peloton is not authenticated. ${authFailureReason ?? 'Bootstrap once with peloton_refresh_token (browser access + refresh token).'}`,
        },
      ],
    };
  }

  if (!isToolName(name)) {
    return {
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`,
        },
      ],
    };
  }

  try {
    return await toolHandlers[name](args ?? {}, pelotonClient);
  } catch (error: unknown) {
    return {
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${isError(error) ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
  });

  return srv;
}

async function setupPelotonAuth(): Promise<void> {
  let token = await loadTokenIncludingExpired();

  if (token?.refresh_token && isTokenExpiring(token, PROACTIVE_EXPIRY_BUFFER_MS)) {
    try {
      console.error('[Init] Proactive OAuth refresh for stored credentials...');
      token = await refreshOAuthTokenAndPersist(token);
      console.error(`[Init] OAuth refresh successful for user ${token.user_id}`);
    } catch (error: unknown) {
      console.error('[Init] OAuth refresh failed:', isError(error) ? error.message : 'Unknown error');
      token = await loadToken();
    }
  }

  if (!token) {
    const username = process.env.PELOTON_USERNAME;
    const password = process.env.PELOTON_PASSWORD;
    if (username && password) {
      try {
        console.error(`[Init] Auto-login with ${username}...`);
        token = await loginWithPassword(username, password);
        await saveToken(token);
        console.error(`[Init] Auto-login successful for user: ${username}`);
      } catch (error: unknown) {
        console.error('[Init] Auto-login failed:', isError(error) ? error.message : 'Unknown error');
      }
    }
  }

  if (!token) {
    token = await loadToken();
  }

  if (!token) {
    console.error('[Init] No valid auth credential available');
    console.error('[Init] Running in degraded mode — bootstrap with peloton_refresh_token (access + refresh) or PELOTON_USERNAME/PELOTON_PASSWORD');
    authFailureReason =
      'No valid auth credential available. Bootstrap once with peloton_refresh_token (browser access + refresh token), or set PELOTON_USERNAME and PELOTON_PASSWORD.';
    console.error(`[Init] Registered ${allTools.length} tools (auto-login will be retried on tool calls; peloton_refresh_token is manual override only)`);
    return;
  }

  try {
    pelotonClient = new PelotonClient(token.access_token);
    console.error(`[Init] PelotonClient created for user ${token.user_id} (expires ${new Date(token.expires_at).toISOString()})`);
    console.error(`[Init] Skipping live testConnection() — auth errors will surface on the first real API call`);
    console.error(`[Init] Registered ${allTools.length} tools (all active)`);
  } catch (error: unknown) {
    console.error('[Init] Failed to create client:', isError(error) ? error.message : 'Unknown error');
    authFailureReason = isError(error) ? error.message : 'Unknown error';
    pelotonClient = null;
    console.error(`[Init] Running in degraded mode. Auto-login will be retried on tool calls.`);
    console.error(`[Init] Registered ${allTools.length} tools (peloton_refresh_token is manual override only)`);
  }
}

async function main(): Promise<void> {
  console.error('[Init] Peloton MCP Server starting...');

  try {
    await runMigrations();
  } catch (error: unknown) {
    console.error('[Init] Failed to run database migrations:', isError(error) ? error.message : error);
    console.error('[Init] Continuing without database features...');
  }

  // Bind port 8080 immediately so Fly.io health checks pass before auth completes
  try {
    await startHttpServer(createMcpServer);
  } catch (error: unknown) {
    console.error(`[Init] Failed to start: ${isError(error) ? error.message : 'Unknown error'}`);
    process.exit(1);
  }

  // Auth setup runs after server is listening — updates pelotonClient in the background
  setupPelotonAuth().catch((error: unknown) => {
    console.error('[Init] Auth setup error:', isError(error) ? error.message : 'Unknown error');
  });
}

main().catch((error: unknown) => {
  console.error(`[Init] Fatal startup error: ${isError(error) ? error.message : 'Unknown error'}`);
  process.exit(1);
});
