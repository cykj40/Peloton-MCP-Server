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
import { loadToken, saveToken, parseJwtExpiry, parseJwtUserId, PelotonAuthToken } from './services/tokenStore.js';
import { loginWithPassword } from './services/pelotonAuth.js';
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
    'Manual override fallback: store a Peloton JWT Bearer token for live API calls when PELOTON_USERNAME/PELOTON_PASSWORD auto-login cannot be used. ' +
    'Auto-login is the normal recovery path. Token must start with "eyJ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Required: The manual override Bearer JWT token (starts with eyJ...).',
      },
    },
    required: ['token'],
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
    const parsed = args as { token?: string };
    const manualToken = parsed?.token;

    try {
      if (!manualToken || typeof manualToken !== 'string' || manualToken.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: token is required for this manual override. Normal auth should use PELOTON_USERNAME and PELOTON_PASSWORD auto-login.' }],
        };
      }

      const credential = manualToken.trim();
      if (!credential.startsWith('eyJ')) {
        return {
          content: [{ type: 'text', text: 'Invalid token: must be a JWT starting with "eyJ". This tool is only a manual override when auto-login cannot be used.' }],
        };
      }

      const jwtExp = parseJwtExpiry(credential);
      if (jwtExp !== null && jwtExp <= Date.now()) {
        return {
          content: [{ type: 'text', text: `Token is already expired (exp: ${new Date(jwtExp).toISOString()}). Use PELOTON_USERNAME and PELOTON_PASSWORD auto-login, or provide a fresh manual override token.` }],
        };
      }

      const jwtUserId = parseJwtUserId(credential);
      const existingToken = await loadToken();
      const authToken: PelotonAuthToken = {
        access_token: credential,
        ...(existingToken?.session_id ? { session_id: existingToken.session_id } : {}),
        token_type: 'Bearer',
        expires_at: jwtExp ?? Date.now() + (25 * 24 * 60 * 60 * 1000),
        user_id: jwtUserId,
      };
      await saveToken(authToken);

      pelotonClient = new PelotonClient(credential);
      authFailureReason = null;

      const expiresDate = new Date(authToken.expires_at).toLocaleString();
      return {
        content: [{
          type: 'text',
          text: `Authentication refreshed successfully!\n\n` +
            `Method: Manual override Bearer token (validated locally)\n` +
            `Token Type: ${authToken.token_type}\n` +
            `User ID: ${authToken.user_id}\n` +
            `Expires: ${expiresDate}\n\n` +
            `All Peloton tools are now available. Future auth recovery will prefer PELOTON_USERNAME/PELOTON_PASSWORD auto-login when configured.`
        }],
      };
    } catch (error: unknown) {
      return {
        content: [{ type: 'text', text: `Failed to refresh authentication: ${isError(error) ? error.message : 'Unknown error'}` }],
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
          text: `Error: Peloton auto-login is not connected. ${authFailureReason ?? 'Set PELOTON_USERNAME and PELOTON_PASSWORD, then retry.'}\n\nManual token override is available through peloton_refresh_token only when auto-login cannot be used.`,
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
  let token = await loadToken();

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
    console.error('[Init] No valid auth credential available');
    console.error('[Init] Running in degraded mode — set PELOTON_USERNAME and PELOTON_PASSWORD for auto-login');
    authFailureReason = 'No valid auth credential available. Set PELOTON_USERNAME and PELOTON_PASSWORD for auto-login.';
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
