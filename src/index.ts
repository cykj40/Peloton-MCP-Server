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
import { refreshPelotonCookie } from './services/pelotonAuth.js';
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
    'Update the Peloton auth credential when the current one is expired or invalid. ' +
    'Accepts either a Bearer token (JWT) or a legacy session cookie. ' +
    'To get a Bearer token: log into members.onepeloton.com, open DevTools > Network tab, ' +
    'refresh the page, click any api.onepeloton.com request, find the Authorization header, ' +
    'and copy the token after "Bearer ".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'The Bearer token (JWT starting with eyJ...) or legacy session cookie value',
      },
    },
    required: ['token'],
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
    const newToken = parsed?.token;
    if (!newToken || typeof newToken !== 'string' || newToken.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: Please provide a non-empty token or cookie value.' }],
      };
    }

    try {
      const credential = newToken.trim();
      const testClient = new PelotonClient(credential);
      const result = await testClient.testConnection();
      if (!result.success) {
        return {
          content: [{ type: 'text', text: `Credential is invalid: ${result.details}\n\nMake sure you copied the full Bearer token (starts with eyJ...) from the Authorization header in DevTools > Network tab.` }],
        };
      }

      await saveCookie(credential);
      pelotonClient = testClient;
      authFailureReason = null;
      const credType = credential.startsWith('eyJ') ? 'Bearer token' : 'Session cookie';
      return {
        content: [{ type: 'text', text: `${credType} updated successfully! ${result.details}\n\nAll Peloton tools are now available.` }],
      };
    } catch (error: unknown) {
      return {
        content: [{ type: 'text', text: `Failed to update credential: ${isError(error) ? error.message : 'Unknown error'}` }],
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
