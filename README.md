# Peloton MCP Server

MCP server for Peloton workout data - designed for Type 1 diabetes management through exercise correlation with Dexcom CGM data.

## Purpose

This MCP server enables AI assistants (like Claude) to access your Peloton workout history and correlate it with blood glucose data from your Dexcom CGM. Together with a Dexcom MCP server, you can ask questions like:

- "How did my cycling class affect my glucose yesterday?"
- "What's my typical glucose drop during strength workouts?"
- "Should I eat before this Peloton ride based on past patterns?"
- "Which muscle groups cause the biggest glucose swings?"

## Features

- 🏋️ **Workout Data** - Fetch workouts with exact timestamps for glucose correlation
- 💪 **Muscle Analysis** - Track which muscle groups are worked (affects insulin sensitivity)
- 📊 **Statistics** - Aggregate workout data over time periods
- ⚖️ **Training Balance** - Understand upper/lower body and cardio/strength distribution
- 🩸 **Diabetes Integration** - All data optimized for correlation with glucose patterns

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill it in. The variables you need to get started:

| Variable | Purpose |
| --- | --- |
| `MCP_AUTH_TOKEN` | **Required.** Bearer token protecting `/mcp`. The server exits on boot without it. |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | **Required** for the remote connector OAuth flow. |
| `ALLOWED_REDIRECT_URIS` | **Required** for the OAuth flow. Comma-separated, exact-match redirect URIs, e.g. `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | libSQL/Turso database for workouts, glucose correlations, and the persisted Peloton token. For local dev, `TURSO_DATABASE_URL=file:./data/peloton.db` works and needs no auth token. |
| `PELOTON_USERNAME`, `PELOTON_PASSWORD` | Peloton login used for auto-login and by `npm run capture-oauth`. |
| `PELOTON_TOKEN_UPDATE_SECRET` | Secret for the private admin listener (see [Refreshing the Peloton token](#refreshing-the-peloton-token)). Must differ from `MCP_AUTH_TOKEN`. |

Optional: `PORT` (default `8080`), `ADMIN_PORT` (default `9091`), `ADMIN_HOST`, `PELOTON_TOKEN_UPDATE_URL`, `PELOTON_AUTH_CLIENT_ID`, `PELOTON_BEARER_TOKEN`, `PELOTON_SESSION_COOKIE`. See `.env.example` for details on each.

## Usage

```bash
npm start
```

This starts an **HTTP-only** server (default port `8080`) exposing:

- `/mcp` - MCP endpoint (Streamable HTTP), protected by `MCP_AUTH_TOKEN`
- `/health` - health check
- `/.well-known/oauth-authorization-server`, `/authorize`, `/token` - OAuth endpoints used by the remote connector

There is no stdio transport, so this server **cannot** be added to Claude Desktop's local `claude_desktop_config.json` command/stdio config. Instead, deploy it somewhere reachable over HTTPS (it's set up for Fly.io via `fly.toml`) and add it as a remote MCP connector in Claude, pointing at `https://<your-host>/mcp` and using `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` as the connector's OAuth credentials.

## Refreshing the Peloton token

Once bootstrapped, the server refreshes its Peloton OAuth token automatically. If you ever need to push a fresh token manually, use the private admin listener, which is not exposed publicly:

```bash
# Terminal 1: tunnel to the private admin port on the Fly app
fly proxy 9091:9091 -a peloton-mcp-server

# Terminal 2: log in to Peloton in a headless browser, capture the OAuth tokens,
# and POST them to the admin listener through the tunnel
npm run setup:playwright   # first time only (installs Chromium)
npm run capture-oauth
```

`capture-oauth` reads `PELOTON_USERNAME`, `PELOTON_PASSWORD`, and `PELOTON_TOKEN_UPDATE_SECRET` from your local `.env`; the same `PELOTON_TOKEN_UPDATE_SECRET` must be set on the server (e.g. `fly secrets set`). If it isn't set on the server, the admin listener doesn't start. As a fallback, the `peloton_refresh_token` MCP tool can also store an access + refresh token pair copied from the browser.

## Available Tools

The server registers **12 tools** (logged as `Registered 12 tools` on boot).

### Profile
- `peloton_test_connection` - Verify API connection
- `peloton_get_profile` - Get user profile

### Workouts (Critical for Diabetes)
- `peloton_get_workouts` - Fetch workouts with exact timestamps, duration, intensity
- `peloton_sync_workouts` - Force a sync of the latest workouts from Peloton into the database

### Analytics
- `peloton_muscle_activity` - Muscle engagement percentages
- `peloton_muscle_impact` - Detailed muscle impact scores
- `peloton_workout_stats` - Aggregate statistics
- `peloton_training_balance` - Training balance analysis

### Glucose Correlation
- `peloton_analyze_glucose_correlation` - Analyze how a specific workout affected glucose (takes readings from the Dexcom MCP)
- `peloton_get_discipline_insights` - Aggregated glucose impact by workout discipline, from stored correlations
- `peloton_detect_hypoglycemia_risk` - Flag workouts followed by low or delayed-low glucose

### Auth
- `peloton_refresh_token` - Manual override: store a Peloton access + refresh token pair copied from the browser

## Diabetes Use Cases

With both Dexcom and Peloton MCP servers running:

```
User: "How did my 30-minute cycling class affect my glucose?"

Claude:
[Peloton MCP] → 30-min cycling at 2:00 PM, 250 calories
[Dexcom MCP] → Glucose 140→85 during workout, stable after

Response: "Your cycling class caused a 55 mg/dL drop. Based on 10 similar
workouts, you typically drop 50-60 mg/dL during cycling. Your glucose
stabilized well afterward."
```

## License

MIT
