# Peloton MCP Server

MCP (Model Context Protocol) server for accessing Peloton workout data and generating analytics. Built with TypeScript and the official MCP SDK.

## Features

- 🏋️ **Workout Retrieval**: Fetch recent workouts with filtering by discipline, instructor, and date range
- 💪 **Muscle Analysis**: Analyze which muscle groups are being worked and their engagement percentages
- 📊 **Workout Statistics**: Track total workouts, calories burned, duration, and averages over time
- ⚖️ **Training Balance**: Understand upper vs lower body balance and cardio vs strength distribution
- 🎯 **Personalized Insights**: Get recommendations based on your workout patterns

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Create a `.env` file in the root directory:

```env
PELOTON_USERNAME=your_username
PELOTON_PASSWORD=your_password
TRANSPORT=stdio
PORT=3000
```

## Usage

### Stdio Transport (Default)

For use with Claude Desktop, Cursor, or other MCP clients:

```bash
npm start
```

### HTTP Transport

For remote access or web-based clients:

```bash
TRANSPORT=http npm start
```

The server will be available at `http://localhost:3000/mcp`

## Available Tools

### Workouts
- **peloton_get_recent_workouts**: Fetch recent workouts with optional filters
- **peloton_search_workouts**: Advanced search by discipline, instructor, and date range
- **peloton_get_workout_details**: Get detailed information for a specific workout

### Analytics
- **peloton_muscle_activity**: Calculate muscle engagement percentages (perfect for charts)
- **peloton_muscle_impact**: Analyze muscle impact scores over a time period
- **peloton_workout_stats**: Get comprehensive workout statistics
- **peloton_training_balance**: Analyze training balance (upper/lower body, cardio/strength)

### Profile
- **peloton_test_connection**: Verify API connection and authentication
- **peloton_get_profile**: Get user profile information

## Response Formats

All tools support two response formats:

- **markdown** (default): Human-readable formatted text
- **json**: Machine-readable structured data

Specify the format using the `response_format` parameter:

```json
{
  "response_format": "json"
}
```

## Example Queries

Once integrated with an LLM client, you can ask questions like:

- "What workouts have I done in the last 7 days?"
- "Show me my muscle engagement breakdown for the past month"
- "Am I balancing upper and lower body workouts?"
- "What's my average workout duration this week?"
- "Which muscle groups am I neglecting?"
- "How many cycling workouts have I done with instructor Robin Arzón?"

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Build
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## Architecture

```
peloton-mcp-server/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── constants.ts          # API URLs, rate limits, muscle mappings
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   ├── services/
│   │   ├── pelotonClient.ts  # API client with auth & caching
│   │   └── analytics.ts      # Workout analytics calculations
│   ├── schemas/
│   │   └── index.ts          # Zod validation schemas
│   └── tools/
│       ├── workouts.ts       # Workout retrieval tools
│       ├── analytics.ts      # Analytics tools
│       └── profile.ts        # Profile tools
└── dist/                     # Compiled JavaScript
```

## Technical Details

- **Authentication**: Session-based authentication with automatic token management
- **Rate Limiting**: Built-in exponential backoff for API rate limits
- **Caching**: In-memory caching with configurable TTL (default 5 minutes)
- **Error Handling**: Comprehensive error handling with actionable error messages
- **Type Safety**: Full TypeScript with strict mode enabled

## Security Notes

- **Never commit** your `.env` file
- Store credentials securely
- Use environment variables for sensitive data
- Consider using a secrets manager for production deployments

## License

MIT

## Contributing

This is a personal project, but feel free to fork and adapt it for your own use!

## Author

Built by Cyrus - A self-taught developer focused on building real, useful tools.
