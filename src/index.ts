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
import { loadCookie, saveCookie } from './services/cookieStore.js';
import { refreshPelotonCookie, loginWithPassword } from './services/pelotonAuth.js';
import { saveToken, PelotonAuthToken } from './services/tokenStore.js';
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

const refreshCookieTool = {
  name: 'peloton_refresh_cookie' as const,
  description:
    'Refresh the Peloton auth credential. If PELOTON_USERNAME and PELOTON_PASSWORD are set in env, ' +
    'automatically logs in to get a fresh JWT Bearer token. Otherwise, accepts a manually provided ' +
    'Bearer token (JWT) or legacy session cookie. ' +
    'To get a Bearer token manually: log into members.onepeloton.com, open DevTools > Network tab, ' +
    'refresh the page, click any api.onepeloton.com request, find the Authorization header, ' +
    'and copy the token after "Bearer ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Optional: The Bearer token (JWT starting with eyJ...) or legacy session cookie value. If not provided, will use PELOTON_USERNAME and PELOTON_PASSWORD from env.',
      },
    },
    required: [],
  },
};

const allTools = [...profileTools, ...workoutTools, ...analyticsTools, ...correlationTools, refreshCookieTool];
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

  if (name === 'peloton_refresh_cookie') {
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
            content: [{ type: 'text', text: `Credential is invalid: ${result.details}\n\nMake sure you copied the full Bearer token (starts with eyJ...) from the Authorization header in DevTools > Network tab.` }],
          };
        }

        // Save as legacy cookie format for backward compatibility
        await saveCookie(credential);
        pelotonClient = testClient;
        authFailureReason = null;

        // Create token structure for display
        const isBearer = credential.startsWith('eyJ');
        authToken = {
          access_token: credential,
          token_type: isBearer ? 'Bearer' : 'Cookie',
          expires_at: Date.now() + (isBearer ? 2 * 24 * 60 * 60 * 1000 : 25 * 24 * 60 * 60 * 1000),
          user_id: result.userId ?? 'unknown',
        };
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

        // Also save to legacy cookie store for backward compatibility
        await saveCookie(authToken.access_token);

        pelotonClient = new PelotonClient(authToken.access_token);
        authFailureReason = null;
        usedMethod = 'auto';
      }

      const expiresDate = new Date(authToken.expires_at).toLocaleString();
      const authMethod = usedMethod === 'auto' ? 'Auto-login (JWT)' : authToken.token_type;
      const fallbackNote = authToken.token_type === 'Cookie' ? ' (cookie fallback)' : '';

      return {
        content: [{
          type: 'text',
          text: `Authentication refreshed successfully!\n\n` +
            `Method: ${authMethod}${fallbackNote}\n` +
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
          text: `Error: Peloton client not connected. ${authFailureReason ?? 'Please check your credentials.'}\n\nTo fix this, use the peloton_refresh_cookie tool with a fresh session cookie from your browser.`,
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

  let sessionCookie = await loadCookie();

  if (!sessionCookie) {
    console.error('[Init] No valid stored cookie found');

    const username = process.env.PELOTON_USERNAME;
    const password = process.env.PELOTON_PASSWORD;

    if (username && password) {
      try {
        console.error('[Init] Attempting automatic cookie refresh...');
        sessionCookie = await refreshPelotonCookie(username, password);
        await saveCookie(sessionCookie);
        console.error('[Init] Cookie refreshed and stored successfully');
      } catch (error: unknown) {
        console.error('[Init] Auto-refresh failed:', isError(error) ? error.message : 'Unknown error');
        console.error('[Init] Falling back to manual cookie from .env...');
      }
    }

    if (!sessionCookie) {
      sessionCookie = process.env.PELOTON_BEARER_TOKEN || process.env.PELOTON_SESSION_COOKIE || null;

      if (!sessionCookie) {
        console.error('[Init] No valid auth credential available');
        console.error('[Init] Server will start in degraded mode — use peloton_refresh_cookie tool to provide a Bearer token');
        authFailureReason = 'No auth credential available. Use the peloton_refresh_cookie tool with a Bearer token from your browser (DevTools > Network tab > Authorization header).';
      } else {
        const credType = sessionCookie.startsWith('eyJ') ? 'Bearer token' : 'session cookie';
        console.error(`[Init] Using manual ${credType} from .env`);
        await saveCookie(sessionCookie);
      }
    }
  }

  if (sessionCookie) {
    pelotonClient = new PelotonClient(sessionCookie);

    const connectionTest = await pelotonClient.testConnection();
    if (!connectionTest.success) {
      console.error(`[Init] Connection test failed: ${connectionTest.details}`);

      const username = process.env.PELOTON_USERNAME;
      const password = process.env.PELOTON_PASSWORD;

      if (username && password) {
        console.error('[Init] Attempting cookie refresh due to connection failure...');
        try {
          sessionCookie = await refreshPelotonCookie(username, password);
          await saveCookie(sessionCookie);
          pelotonClient = new PelotonClient(sessionCookie);

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
          console.error('[Init] Refresh failed:', msg);
          authFailureReason = `Session cookie is invalid and auto-refresh failed: ${msg}`;
          pelotonClient = null;
        }
      } else {
        authFailureReason = `Session cookie is invalid (401). Peloton's /auth/login endpoint is blocked, so auto-refresh won't work. Please provide a fresh cookie using the peloton_refresh_cookie tool.`;
        pelotonClient = null;
      }
    } else {
      console.error(`[Init] ${connectionTest.details}`);
    }
  }

  if (pelotonClient) {
    console.error(`[Init] Registered ${allTools.length} tools (all active)`);
  } else {
    console.error(`[Init] Starting in degraded mode — auth failed. Use peloton_refresh_cookie tool to provide a valid session cookie.`);
    console.error(`[Init] Registered ${allTools.length} tools (peloton_refresh_cookie active, others will return auth error)`);
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
