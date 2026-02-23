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

  // Get session cookie from environment
  const sessionCookie = process.env.PELOTON_SESSION_COOKIE;

  if (!sessionCookie) {
    console.error('[Init] Error: PELOTON_SESSION_COOKIE must be set in .env file');
    console.error('[Init] See AUTH_UPDATE.md for instructions on getting your session cookie');
    process.exit(1);
  }

  try {
    console.error('[Init] Using session cookie from environment');
    pelotonClient = new PelotonClient(sessionCookie);

    // Test connection
    const connectionTest = await pelotonClient.testConnection();
    if (!connectionTest.success) {
      console.error(`[Init] Connection test failed: ${connectionTest.details}`);
      process.exit(1);
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
