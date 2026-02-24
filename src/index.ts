#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { loginWithPassword } from './services/pelotonAuth.js';
import { loadToken, saveToken, PelotonAuthToken } from './services/tokenStore.js';
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
    'Refresh the Peloton JWT Bearer token. If PELOTON_USERNAME and PELOTON_PASSWORD are set in env, ' +
    'automatically logs in to get a fresh JWT Bearer token. Otherwise, accepts a manually provided ' +
    'Bearer token (JWT). ' +
    'To get a Bearer token manually: log into members.onepeloton.com, open DevTools > Network tab, ' +
    'refresh the page, click any api.onepeloton.com request, find the Authorization header, ' +
    'and copy the token after "Bearer ". Token must start with "eyJ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Optional: The Bearer JWT token (starts with eyJ...). If not provided, will use PELOTON_USERNAME and PELOTON_PASSWORD from env.',
      },
    },
    required: [],
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

const server = new Server(
  {
    name: 'peloton-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'peloton_refresh_token') {
    const parsed = args as { token?: string };
    const manualToken = parsed?.token;

    try {
      let authToken: PelotonAuthToken;
      let usedMethod: 'manual' | 'auto' = 'manual';

      // If manual token provided, use it
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

        // Create token structure for display
        authToken = {
          access_token: credential,
          token_type: 'Bearer',
          expires_at: Date.now() + (2 * 24 * 60 * 60 * 1000),
          user_id: result.userId ?? 'unknown',
        };
        await saveToken(authToken);
        usedMethod = 'manual';
      } else {
        // Auto-refresh using env vars
        const username = process.env.PELOTON_USERNAME;
        const password = process.env.PELOTON_PASSWORD;

        if (!username || !password) {
          return {
            content: [{ type: 'text', text: 'Error: No token provided and PELOTON_USERNAME/PELOTON_PASSWORD not set in environment.\n\nEither:\n1. Provide a token parameter, or\n2. Set PELOTON_USERNAME and PELOTON_PASSWORD in your .env file' }],
          };
        }

        console.error('[Tool] Attempting auto-login with credentials from env...');
        authToken = await loginWithPassword(username, password);
        await saveToken(authToken);

        pelotonClient = new PelotonClient(authToken.access_token);
        authFailureReason = null;
        usedMethod = 'auto';
      }

      const expiresDate = new Date(authToken.expires_at).toLocaleString();
      const authMethod = usedMethod === 'auto' ? 'Auto-login' : 'Manual token';

      return {
        content: [{
          type: 'text',
          text: `Authentication refreshed successfully!\n\n` +
            `Method: ${authMethod}\n` +
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

async function main(): Promise<void> {
  console.error('[Init] Peloton MCP Server starting...');

  try {
    runMigrations();
  } catch (error: unknown) {
    console.error('[Init] Failed to run database migrations:', isError(error) ? error.message : error);
    console.error('[Init] Continuing without database features...');
  }

  // Try to load stored token
  let token = await loadToken();

  // If no token or token is expired, try to login with credentials
  if (!token) {
    console.error('[Init] No valid stored token found');

    const username = process.env.PELOTON_USERNAME;
    const password = process.env.PELOTON_PASSWORD;

    if (username && password) {
      try {
        console.error('[Init] Attempting automatic login...');
        token = await loginWithPassword(username, password);
        await saveToken(token);
        console.error('[Init] Token obtained and stored successfully');
      } catch (error: unknown) {
        console.error('[Init] Auto-login failed:', isError(error) ? error.message : 'Unknown error');
      }
    }

    if (!token) {
      console.error('[Init] No valid auth credential available');
      console.error('[Init] Server will start in degraded mode — use peloton_refresh_token tool to provide a Bearer token');
      authFailureReason = 'No auth credential available. Use the peloton_refresh_token tool with a Bearer token from your browser (DevTools > Network tab > Authorization header).';
    }
  }

  if (token) {
    try {
      pelotonClient = new PelotonClient(token.access_token);

      const connectionTest = await pelotonClient.testConnection();
      if (!connectionTest.success) {
        console.error(`[Init] Connection test failed: ${connectionTest.details}`);

        const username = process.env.PELOTON_USERNAME;
        const password = process.env.PELOTON_PASSWORD;

        if (username && password) {
          console.error('[Init] Attempting login due to connection failure...');
          try {
            token = await loginWithPassword(username, password);
            await saveToken(token);
            pelotonClient = new PelotonClient(token.access_token);

            const retryTest = await pelotonClient.testConnection();
            if (!retryTest.success) {
              console.error('[Init] Connection still failed after refresh');
              authFailureReason = retryTest.details;
              pelotonClient = null;
            } else {
              console.error('[Init] Connection successful after refresh');
            }
          } catch (refreshError: unknown) {
            const msg = isError(refreshError) ? refreshError.message : 'Unknown error';
            console.error('[Init] Login failed:', msg);
            authFailureReason = `Token is invalid and auto-login failed: ${msg}`;
            pelotonClient = null;
          }
        } else {
          authFailureReason = `Token is invalid and no credentials available for auto-login. Please use the peloton_refresh_token tool.`;
          pelotonClient = null;
        }
      } else {
        console.error(`[Init] ${connectionTest.details}`);
      }
    } catch (error: unknown) {
      console.error('[Init] Failed to create client:', isError(error) ? error.message : 'Unknown error');
      authFailureReason = isError(error) ? error.message : 'Unknown error';
      pelotonClient = null;
    }
  }

  if (pelotonClient) {
    console.error(`[Init] Registered ${allTools.length} tools (all active)`);
  } else {
    console.error(`[Init] Starting in degraded mode — auth failed. Use peloton_refresh_token tool to provide a valid Bearer token.`);
    console.error(`[Init] Registered ${allTools.length} tools (peloton_refresh_token active, others will return auth error)`);
  }

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[Server] Peloton MCP server running on stdio');
  } catch (error: unknown) {
    console.error(`[Init] Failed to start: ${isError(error) ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`[Init] Fatal startup error: ${isError(error) ? error.message : 'Unknown error'}`);
  process.exit(1);
});
