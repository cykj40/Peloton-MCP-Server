# Peloton MCP Server

A remote **Model Context Protocol (MCP)** server that gives an MCP host read access to your Peloton workout history and training analytics. It adds a muscle-balance chart and planner, plus assistive helpers that correlate workouts with glucose readings you provide. It reads data only. It does not control Peloton equipment or change any account settings.

> **Transport:** The server uses **Streamable HTTP** only, and it has no stdio mode. Run it somewhere your MCP host can reach over HTTPS, then add it as a remote connector. A local `command`/`args` (stdio) entry in a desktop MCP config will not work with it.

## Features

- **Account and workouts.** Check the connection, read your profile, and search workouts by discipline, instructor, or date range.
- **Training analytics.** Get muscle activity percentages, muscle impact scores, workout statistics, and an upper/lower-body balance summary.
- **Muscle activity chart and planner.** Renders a PNG heat-map of muscle regions over a rolling 1–90 day window, with a text breakdown and muscle-balance suggestions drawn from your own past classes.
- **Glucose correlation helpers (assistive only).** Analyze one workout against glucose readings you supply, aggregate insights by discipline, and flag stored workouts that were followed by low or delayed-low glucose.
- **Workout sync.** Stores recent workouts in a libSQL/Turso database for correlation analysis.
- **Peloton auth handling.** Refreshes Auth0 tokens automatically, can log in with a username and password, and offers a one-time bootstrap from an access + refresh token pair.

## Requirements

- Node.js 20+ (the Docker image uses `node:20-alpine`)
- A Peloton account
- A [Turso](https://turso.tech/)/libSQL database. Local development can use a `file:` URL instead.
- A host that serves HTTPS, if you will connect from a remote MCP client

## Quick start

### 1. Install

```bash
git clone https://github.com/cykj40/Peloton-MCP-Server.git
cd Peloton-MCP-Server
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in your own values. Never commit `.env`.

**Core**

| Variable | Required | Purpose |
|----------|----------|---------|
| `MCP_AUTH_TOKEN` | **Yes** | Bearer token that protects `/mcp`. The server will not start without it. The OAuth `/token` endpoint also returns it as the access token. Use a long random value. |
| `OAUTH_CLIENT_ID` | For OAuth | Client ID that `/authorize` and `/token` expect. Enter the same value in your MCP host's connector settings. |
| `OAUTH_CLIENT_SECRET` | For OAuth | Client secret that `/token` checks. |
| `ALLOWED_REDIRECT_URIS` | For OAuth | Comma-separated list of redirect URIs, matched exactly (no wildcards or prefixes). If it is empty, `/authorize` rejects every request. |
| `TURSO_DATABASE_URL` | Recommended | libSQL/Turso URL. Without it, database features are off and the Peloton token is held in memory only. |
| `TURSO_AUTH_TOKEN` | Remote Turso | Auth token for a remote Turso database. Not needed for `file:` URLs. |
| `PORT` | No | Public HTTP port. Defaults to `8080`. |
| `APP_TIMEZONE` | No | IANA time zone for calendar-date inputs and displayed workout dates. Defaults to `America/New_York`. |

**Peloton authentication**

| Variable | Required | Purpose |
|----------|----------|---------|
| `PELOTON_USERNAME` / `PELOTON_PASSWORD` | Optional | Used for auto-login and by `npm run capture-oauth`. Peloton may block password login, so the token bootstrap below is the more reliable option. |
| `PELOTON_AUTH_CLIENT_ID` | Optional | Overrides Peloton's public Auth0 client ID. Only needed if your tokens were issued to a different client. |
| `PELOTON_BEARER_TOKEN` | Optional | Fallback access token (a JWT). |
| `PELOTON_SESSION_COOKIE` | Optional | Fallback Peloton session ID. |

**Private admin listener (optional)**

| Variable | Required | Purpose |
|----------|----------|---------|
| `PELOTON_TOKEN_UPDATE_SECRET` | Optional | Enables the private admin listener. Must be different from `MCP_AUTH_TOKEN`; the server refuses to start if they match. `npm run capture-oauth` reads it too. |
| `ADMIN_PORT` | No | Admin listener port. Defaults to `9091`. |
| `ADMIN_HOST` | No | Admin bind address. Defaults to the Fly private network address when running on Fly, and to `127.0.0.1` everywhere else. |
| `PELOTON_TOKEN_UPDATE_URL` | No | Admin URL that `capture-oauth` posts to. Defaults to `http://localhost:9091/update-peloton-token`. |

For local development, `TURSO_DATABASE_URL=file:./data/peloton.db` works without a Turso account. `data/` and `*.db*` are gitignored.

### 3. Build, run, test

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js (HTTP server on PORT, default 8080)
npm test           # vitest run
```

On startup the server runs database migrations, starts listening right away so health checks pass, and then sets up Peloton auth in the background.

### 4. Connect an MCP host

- **Endpoint:** `https://<your-host>/mcp`
- **Auth:** either send `Authorization: Bearer <MCP_AUTH_TOKEN>` directly, or let a connector-style client go through the OAuth flow below. The OAuth flow ends with the client receiving the same bearer token.

## Peloton authentication

The server finds a Peloton credential in this order:

1. A stored token: first Turso, then the in-memory token, then the fallbacks `PELOTON_BEARER_TOKEN` / `PELOTON_SESSION_COOKIE`. A stored token that is close to expiring and has a refresh token is refreshed through Auth0 first.
2. If no usable token turns up, auto-login with `PELOTON_USERNAME` / `PELOTON_PASSWORD`.

If none of these work, the tools return a "not authenticated" message until you bootstrap. There are two ways to bootstrap:

- **MCP tool:** call `peloton_refresh_token` with an access token (`eyJ…`) and a refresh token copied from a signed-in Peloton web session. Once they are stored, refresh happens automatically.
- **Private admin listener:** see below.

## HTTP endpoints

### Public listener (`PORT`, default `8080`)

| Route | Auth | Notes |
|-------|------|-------|
| `GET /health` | None | Liveness: `{ "status": "ok" }` |
| `POST`/`GET`/`DELETE /mcp` | `Bearer MCP_AUTH_TOKEN` | MCP Streamable HTTP in stateless mode (a new transport for each request) |
| `GET /.well-known/oauth-authorization-server` | None | OAuth metadata: `authorization_code` grant, `client_secret_post`, PKCE `S256` |
| `GET /authorize` | `client_id` must match `OAUTH_CLIENT_ID` | Requires `response_type=code`, a `redirect_uri` from the allowlist, and PKCE `S256`. Redirects with a random, single-use code that expires after 60 seconds. It never returns the bearer token. |
| `POST /token` | `client_id` + `client_secret` | Exchanges the code. Checks the client, the redirect URI, and the PKCE verifier, then returns `MCP_AUTH_TOKEN` as `access_token`. |
| `POST /refresh-token` | None | Retired. Always returns `410`. |

The public listener has **no** token-update route.

### Private admin listener (`ADMIN_PORT`, default `9091`)

This listener starts only when `PELOTON_TOKEN_UPDATE_SECRET` is set, and it binds to a private address. Do not expose this port publicly.

| Route | Auth | Notes |
|-------|------|-------|
| `POST /update-peloton-token` | `Bearer PELOTON_TOKEN_UPDATE_SECRET` | Body: `{ "token": "eyJ…", "refresh_token": "…" }`. Stores a manual Peloton token override. |

To push a fresh token from your machine to a Fly deployment:

```bash
# Terminal 1: tunnel to the private admin port
fly proxy 9091:9091 -a <your-fly-app>

# Terminal 2: headless browser login -> capture OAuth tokens -> POST to the admin listener
npm run setup:playwright   # first time only (installs Chromium)
npm run capture-oauth
```

`capture-oauth` reads `PELOTON_USERNAME`, `PELOTON_PASSWORD`, and `PELOTON_TOKEN_UPDATE_SECRET` from your local `.env`. It never logs token values.

## Available MCP tools (13)

| Tool | What it does |
|------|--------------|
| `peloton_test_connection` | Checks that the Peloton API is reachable and authentication works |
| `peloton_get_profile` | Profile summary, including total workouts and followers |
| `peloton_get_workouts` | Workout list (`limit` 1–100), with optional `discipline`, `instructor`, `start_date`, and `end_date` filters |
| `peloton_workout_stats` | Totals, averages, and a discipline breakdown for a date range |
| `peloton_muscle_activity` | Muscle activity percentages over 7, 30, or 90 days (raw JSON available) |
| `peloton_muscle_impact` | Estimated muscle impact scores and workout counts |
| `peloton_training_balance` | Older upper/lower-body balance summary |
| `peloton_muscle_activity_chart` | PNG heat-map chart plus text breakdown over a rolling `days` window (1–90). Weighting is `raw` or `per_minute`. Includes muscle-balance suggestions drawn from your own past classes. |
| `peloton_sync_workouts` | Syncs recent workouts (`limit` 1–100, default 50) into the database |
| `peloton_analyze_glucose_correlation` | Analyzes how one workout affected glucose. You supply the `glucose_readings` (mg/dL plus ISO timestamps), for example from a separate CGM MCP server. |
| `peloton_get_discipline_insights` | Aggregated glucose impact by discipline, based on stored correlations |
| `peloton_detect_hypoglycemia_risk` | Flags stored workouts followed by glucose below 80 mg/dL, or by a low point more than 2 hours after the workout |
| `peloton_refresh_token` | One-time bootstrap: stores a Peloton access + refresh token pair |

Most tools accept `response_format` (`markdown` or `json`). Date inputs accept `YYYY-MM-DD` (read in `APP_TIMEZONE`) or an ISO timestamp with an offset.

## Example prompts

```
Test my Peloton connection and summarize my profile.
```

```
Show my muscle activity chart for the last 7 days. Which muscles am I neglecting?
```

```
Plan a balanced week of workouts based on classes I've already taken.
```

```
Give me workout stats for last month, broken down by discipline.
```

```
Sync my latest workouts, then analyze how today's ride affected my glucose using these readings.
```

## Data storage

The server stores data in **Turso/libSQL** through `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`:

- `auth_tokens`: the current Peloton access token, refresh token, and user ID
- `workouts`: synced workout records
- `glucose_correlations`: glucose values and analysis results you have submitted
- `muscle_snapshots` and `ride_muscle_cache`: cached muscle data for analytics and charts

Treat the database and its credentials as sensitive. They hold live Peloton credentials and health-related data.

## Deployment

The repo includes a `Dockerfile` (multi-stage build on `node:20-alpine`, with DejaVu fonts for chart text), a sample `fly.toml`, and a GitHub Actions workflow (`.github/workflows/fly-deploy.yml`) that runs `flyctl deploy` on every push to `main` using a `FLY_API_TOKEN` repository secret.

To deploy your own copy:

1. Change `app` in `fly.toml` to your own app name. Keep `internal_port = 8080`.
2. Set secrets with `fly secrets set` (`MCP_AUTH_TOKEN`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `ALLOWED_REDIRECT_URIS`, `TURSO_*`, and the others you need).
3. Keep `ADMIN_PORT` out of `fly.toml` services so the admin listener stays private.
4. Point your MCP host at `https://<your-app>.fly.dev/mcp`, or at whatever host you use.

There is no default public endpoint. Run your own instance.

## Security notes

- **Bearer token.** `MCP_AUTH_TOKEN` grants full tool access, including `peloton_refresh_token`, which can replace the stored Peloton credentials. Use a long random value and rotate it if it may have leaked.
- **OAuth.** Redirect URIs must match the allowlist exactly. PKCE `S256` is required, and codes are random, single-use, and expire after 60 seconds. `/authorize` has no user login or consent screen, so the protection comes from keeping `OAUTH_CLIENT_SECRET` secret. The access token returned is the static `MCP_AUTH_TOKEN`. The `expires_in` value is advisory, and rotation is manual.
- **Admin listener.** It uses its own secret, which must differ from the MCP token, binds privately, and has no public route.
- **Logs.** Peloton user IDs are truncated, user IDs in API paths are redacted, the database URL appears only as a short hash, and credentials are never printed.
- **Data at rest.** Turso stores Peloton tokens and glucose data in plaintext columns. Protect the database credentials and limit who can access the database.
- **Git history.** Older commits contain files that have since been removed. Clone `main` for current code.

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the HTTP server (`node dist/index.js`) |
| `npm run dev` | `tsc --watch` (compiles only; run `npm start` separately) |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with v8 coverage and thresholds |
| `npm run capture-oauth` | Operator helper: log in to Peloton in a headless browser and post the tokens to the private admin listener |
| `npm run setup:playwright` | Install Chromium for `capture-oauth` |

## Project structure

```
Peloton-MCP-Server/
├── src/
│   ├── index.ts          # Entrypoint, MCP server and tool routing, Peloton auth setup
│   ├── http-server.ts    # Public HTTP app (/mcp, /health, OAuth) and private admin listener
│   ├── constants.ts
│   ├── charts/           # Muscle chart SVG/PNG rendering
│   ├── db/               # libSQL client, migrations, queries, caches
│   ├── services/         # Peloton client and auth, token store, OAuth codes, analytics
│   ├── tools/            # MCP tool definitions and handlers
│   ├── schemas/          # Zod schemas
│   ├── utils/            # Log redaction, workout date handling
│   ├── types/
│   └── __tests__/
├── scripts/              # capture-oauth helper, production chart verification
├── Dockerfile
├── fly.toml
└── package.json
```

## Medical disclaimer

**This is an assistive tool only. It is not medical advice and not a medical device.**
The glucose tools only summarize readings you supply and compare them with workout timing. They do not diagnose anything, predict hypoglycemia reliably, or recommend insulin, food, or exercise changes. Make diabetes management decisions with your own monitoring and your clinician. Never rely on this software for dosing or other safety-critical decisions.

Muscle scores describe Peloton classes, or estimates when class data is unavailable. They do not measure individual muscle effort.

## License

MIT. See [`LICENSE`](LICENSE).
