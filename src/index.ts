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
    'Store a Peloton JWT Bearer token for live API calls. ' +
    'To get a Bearer token manually: log into members.onepeloton.com, open DevTools > Network tab, ' +
    'refresh the page, click any api.onepeloton.com request, find the Authorization header, ' +
    'and copy the token after "Bearer ". Token must start with "eyJ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Required: The Bearer JWT token (starts with eyJ...) copied from members.onepeloton.com.',
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
      let authToken: PelotonAuthToken;

      if (manualToken && typeof manualToken === 'string' && manualToken.trim().length > 0) {
        const credential = manualToken.trim();
        const testClient = new PelotonClient(credential);
        const result = await testClient.testConnection();
        if (!result.success) {
          return {
            content: [{ type: 'text', text: `Bearer token is invalid: ${result.details}\n\nMake sure you copied the full Bearer token (starts with eyJ...) from the Authorization header in DevTools > Network tab.` }],
          };
        }

        pelotonClient = testClient;
        authFailureReason = null;

        const existingToken = await loadToken();
        const jwtExp = parseJwtExpiry(credential);
        const jwtUserId = parseJwtUserId(credential);
        authToken = {
          access_token: credential,
          ...(existingToken?.session_id ? { session_id: existingToken.session_id } : {}),
          token_type: 'Bearer',
          expires_at: jwtExp ?? Date.now() + (25 * 24 * 60 * 60 * 1000),
          user_id: result.userId ?? jwtUserId,
        };
        await saveToken(authToken);
      } else {
        return {
          content: [{ type: 'text', text: 'Error: token is required. Copy the Authorization Bearer token from members.onepeloton.com and pass it to peloton_refresh_token.' }],
        };
      }

      const expiresDate = new Date(authToken.expires_at).toLocaleString();

      return {
        content: [{
          type: 'text',
          text: `Authentication refreshed successfully!\n\n` +
            `Method: Manual Bearer token\n` +
            `Token Type: ${authToken.token_type}\n` +
            `User ID: ${authToken.user_id}\n` +
            `Expires: ${expiresDate}\n\n` +
            `All Peloton tools are now available.`
        }],
      };
    } catch (error: unknown) {
      return {
        content: [{ type: 'text', text: `Failed to refresh authentication: ${isError(error) ? error.message : 'Unknown error'}` }],
      };
    }
  }

  if (!pelotonClient) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Peloton client not connected. ${authFailureReason ?? 'Please check your credentials.'}\n\nTo fix this, use the peloton_refresh_token tool with a fresh JWT Bearer token from your browser.`,
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
    console.error('[Init] Running in degraded mode — use peloton_refresh_token tool to provide a Bearer token');
    authFailureReason = 'No valid auth credential available. Use the peloton_refresh_token tool with a Bearer token from your browser (DevTools > Network tab > Authorization header).';
    console.error(`[Init] Registered ${allTools.length} tools (peloton_refresh_token active, others will return auth error)`);
    return;
  }

  try {
    pelotonClient = new PelotonClient(token.access_token);
    const connectionTest = await pelotonClient.testConnection();
    if (!connectionTest.success) {
      console.error(`[Init] Connection test failed: ${connectionTest.details}`);
      authFailureReason = `${connectionTest.details} Refresh the token with peloton_refresh_token.`;
      pelotonClient = null;
    } else {
      console.error(`[Init] ${connectionTest.details}`);
    }
  } catch (error: unknown) {
    console.error('[Init] Failed to create client:', isError(error) ? error.message : 'Unknown error');
    authFailureReason = isError(error) ? error.message : 'Unknown error';
    pelotonClient = null;
  }

  if (pelotonClient) {
    console.error(`[Init] Registered ${allTools.length} tools (all active)`);
  } else {
    console.error(`[Init] Auth failed — running in degraded mode. Use peloton_refresh_token tool to provide a valid Bearer token.`);
    console.error(`[Init] Registered ${allTools.length} tools (peloton_refresh_token active, others will return auth error)`);
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
