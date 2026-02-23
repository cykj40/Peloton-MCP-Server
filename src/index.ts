#!/usr/bin/env node

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

  // Get credentials from environment
  const username = process.env.PELOTON_USERNAME;
  const password = process.env.PELOTON_PASSWORD;

  if (!username || !password) {
    console.error('[Init] Error: PELOTON_USERNAME and PELOTON_PASSWORD must be set');
    process.exit(1);
  }

  try {
    // Authenticate with Peloton
    console.error('[Init] Authenticating...');
    const sessionId = await PelotonClient.authenticate(username, password);
    pelotonClient = new PelotonClient(sessionId);

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
