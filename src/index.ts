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

const allTools = [...profileTools, ...workoutTools, ...analyticsTools, ...correlationTools];
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

  if (!pelotonClient) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Peloton client not initialized. Please check your credentials.',
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
      sessionCookie = process.env.PELOTON_SESSION_COOKIE || null;

      if (!sessionCookie) {
        console.error('[Init] Error: No valid session cookie available');
        console.error('[Init] Please provide either:');
        console.error('[Init]   1. PELOTON_USERNAME and PELOTON_PASSWORD for auto-refresh');
        console.error('[Init]   2. PELOTON_SESSION_COOKIE from browser (see AUTH_UPDATE.md)');
        process.exit(1);
      }

      console.error('[Init] Using manual cookie from .env');
      await saveCookie(sessionCookie);
    }
  }

  try {
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
            process.exit(1);
          }
          console.error('[Init] Connection successful after refresh');
        } catch (refreshError: unknown) {
          console.error('[Init] Refresh failed:', isError(refreshError) ? refreshError.message : 'Unknown error');
          process.exit(1);
        }
      } else {
        process.exit(1);
      }
    }

    console.error(`[Init] ${connectionTest.details}`);
    console.error(`[Init] Registered ${allTools.length} tools`);

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
