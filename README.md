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

Create a `.env` file:

```env
PELOTON_USERNAME=your_username
PELOTON_PASSWORD=your_password
```

## Usage

```bash
npm start
```

## Available Tools

### Profile
- `peloton_test_connection` - Verify API connection
- `peloton_get_profile` - Get user profile

### Workouts (Critical for Diabetes)
- `peloton_get_workouts` - Fetch workouts with exact timestamps, duration, intensity

### Analytics
- `peloton_muscle_activity` - Muscle engagement percentages
- `peloton_muscle_impact` - Detailed muscle impact scores
- `peloton_workout_stats` - Aggregate statistics
- `peloton_training_balance` - Training balance analysis

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
