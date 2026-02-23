#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PelotonClient } from './services/pelotonClient.js';
import { profileTools, handleProfileTool } from './tools/profile.js';
import { workoutTools, handleWorkoutTool } from './tools/workouts.js';
import { analyticsTools, handleAnalyticsTool } from './tools/analytics.js';
import { loadCookie, saveCookie } from './services/cookieStore.js';
import { refreshPelotonCookie } from './services/pelotonAuth.js';

// Initialize Peloton client (will be set after authentication)
let pelotonClient: PelotonClient | null = null;

// Combine all tools
const allTools = [...profileTools, ...workoutTools, ...analyticsTools];

// Create MCP server
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

// Handle tool calls
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

  try {
    // Route to appropriate handler
    if (profileTools.some((t) => t.name === name)) {
      return await handleProfileTool(name, args || {}, pelotonClient);
    }

    if (workoutTools.some((t) => t.name === name)) {
      return await handleWorkoutTool(name, args || {}, pelotonClient);
    }

    if (analyticsTools.some((t) => t.name === name)) {
      return await handleAnalyticsTool(name, args || {}, pelotonClient);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${(error as Error).message}`,
        },
      ],
    };
  }
});

// Start server
async function main() {
  console.error('[Init] Peloton MCP Server starting...');

  // Try to load stored cookie first
  let sessionCookie = await loadCookie();

  // If no valid stored cookie, try to get one
  if (!sessionCookie) {
    console.error('[Init] No valid stored cookie found');

    // Option 1: Try auto-refresh with credentials
    const username = process.env.PELOTON_USERNAME;
    const password = process.env.PELOTON_PASSWORD;

    if (username && password) {
      try {
        console.error('[Init] Attempting automatic cookie refresh...');
        sessionCookie = await refreshPelotonCookie(username, password);
        await saveCookie(sessionCookie);
        console.error('[Init] ✅ Cookie refreshed and stored successfully');
      } catch (error) {
        console.error('[Init] ⚠️  Auto-refresh failed:', (error as Error).message);
        console.error('[Init] Falling back to manual cookie from .env...');
      }
    }

    // Option 2: Fall back to manual cookie from .env
    if (!sessionCookie) {
      sessionCookie = process.env.PELOTON_SESSION_COOKIE || null;

      if (!sessionCookie) {
        console.error('[Init] ❌ Error: No valid session cookie available');
        console.error('[Init] Please provide either:');
        console.error('[Init]   1. PELOTON_USERNAME and PELOTON_PASSWORD for auto-refresh');
        console.error('[Init]   2. PELOTON_SESSION_COOKIE from browser (see AUTH_UPDATE.md)');
        process.exit(1);
      }

      console.error('[Init] Using manual cookie from .env');
      // Store it for future use
      await saveCookie(sessionCookie);
    }
  }

  try {
    // Create Peloton client
    pelotonClient = new PelotonClient(sessionCookie);

    // Test connection
    const connectionTest = await pelotonClient.testConnection();
    if (!connectionTest.success) {
      console.error(`[Init] Connection test failed: ${connectionTest.details}`);

      // If connection fails, try to refresh cookie one more time
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
          console.error('[Init] ✅ Connection successful after refresh');
        } catch (refreshError) {
          console.error('[Init] Refresh failed:', (refreshError as Error).message);
          process.exit(1);
        }
      } else {
        process.exit(1);
      }
    }

    console.error(`[Init] ${connectionTest.details}`);
    console.error(`[Init] Registered ${allTools.length} tools`);

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('[Server] Peloton MCP server running on stdio');
  } catch (error) {
    console.error(`[Init] Failed to start: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
