import { z } from 'zod';
import { PelotonClient } from '../services/pelotonClient.js';
import { MuscleAnalysisSchema, WorkoutStatsSchema } from '../schemas/index.js';
import {
  calculateMuscleActivity,
  calculateMuscleImpact,
  calculateWorkoutStats,
  analyzeTrainingBalance,
  formatMuscleName,
} from '../services/analytics.js';
import { isError } from '../types/errors.js';
import { ToolResponse } from '../types/index.js';

export const analyticsTools = [
  {
    name: 'peloton_muscle_activity',
    description:
      'Get muscle group activity percentages for charting and visualization. Shows which muscle groups were worked over a time period. Useful for glycogen tracking in diabetes management.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['7_days', '30_days', '90_days'],
          default: '7_days',
          description: 'Time period to analyze',
        },
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format (markdown or json)',
        },
      },
      required: [],
    },
  },
  {
    name: 'peloton_muscle_impact',
    description:
      'Get detailed muscle impact scores showing engagement level and workout frequency per muscle group. Helps understand which muscles need recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['7_days', '30_days', '90_days'],
          default: '7_days',
          description: 'Time period to analyze',
        },
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format (markdown or json)',
        },
      },
      required: [],
    },
  },
  {
    name: 'peloton_workout_stats',
    description:
      'Get comprehensive workout statistics including totals, averages, and discipline breakdown for a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD)',
        },
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format (markdown or json)',
        },
      },
      required: [],
    },
  },
  {
    name: 'peloton_training_balance',
    description:
      'Analyze training balance between upper body, lower body, cardio, and strength. Helps identify training imbalances.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['7_days', '30_days', '90_days'],
          default: '7_days',
          description: 'Time period to analyze',
        },
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format (markdown or json)',
        },
      },
      required: [],
    },
  },
] as const;

export type AnalyticsToolName = (typeof analyticsTools)[number]['name'];
type AnalyticsToolArgs = z.infer<typeof MuscleAnalysisSchema> | z.infer<typeof WorkoutStatsSchema>;

export async function handleAnalyticsTool(
  name: AnalyticsToolName,
  args: AnalyticsToolArgs,
  client: PelotonClient
): Promise<ToolResponse> {
  try {
    if (name === 'peloton_muscle_activity') {
      const params = MuscleAnalysisSchema.parse(args);
      const workouts = await client.getRecentWorkouts(100);
      const muscleActivity = calculateMuscleActivity(workouts, params.period);

      if (params.response_format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ period: params.period, muscle_activity: muscleActivity }, null, 2),
            },
          ],
          structuredContent: { period: params.period, muscle_activity: muscleActivity },
        };
      }

      let markdown = `# Muscle Activity (${params.period.replace('_', ' ')})\n\n`;
      if (Object.keys(muscleActivity).length === 0) {
        markdown += 'No workout data available for this period.\n';
      } else {
        const sorted = Object.entries(muscleActivity).sort((a, b) => b[1] - a[1]);
        for (const [muscle, percentage] of sorted) {
          const bar = '#'.repeat(Math.round(percentage / 5));
          markdown += `**${muscle}:** ${percentage}% ${bar}\n`;
        }
      }

      return { content: [{ type: 'text', text: markdown }] };
    }

    if (name === 'peloton_muscle_impact') {
      const params = MuscleAnalysisSchema.parse(args);
      const workouts = await client.getRecentWorkouts(100);
      const days = params.period === '7_days' ? 7 : params.period === '30_days' ? 30 : 90;
      const startTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
      const filtered = workouts.filter((workout) => workout.created_at >= startTimestamp);
      const muscleImpact = calculateMuscleImpact(filtered);

      if (params.response_format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ period: params.period, muscle_impact: muscleImpact }, null, 2),
            },
          ],
          structuredContent: { period: params.period, muscle_impact: muscleImpact },
        };
      }

      let markdown = `# Muscle Impact (${params.period.replace('_', ' ')})\n\n`;
      if (Object.keys(muscleImpact).length === 0) {
        markdown += 'No workout data available for this period.\n';
      } else {
        const sorted = Object.entries(muscleImpact).sort((a, b) => b[1].score - a[1].score);
        for (const [muscle, data] of sorted) {
          markdown += `**${formatMuscleName(muscle)}:**\n`;
          markdown += `  - Impact Score: ${Math.round(data.score)}\n`;
          markdown += `  - Workouts: ${data.workouts}\n\n`;
        }
      }

      return { content: [{ type: 'text', text: markdown }] };
    }

    if (name === 'peloton_workout_stats') {
      const params = WorkoutStatsSchema.parse(args);
      const workouts = await client.getRecentWorkouts(100);
      const startDate = params.start_date ? new Date(params.start_date) : undefined;
      const endDate = params.end_date ? new Date(params.end_date) : undefined;
      const stats = calculateWorkoutStats(workouts, startDate, endDate);

      if (params.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
          structuredContent: stats,
        };
      }

      let markdown = `# Workout Statistics\n\n`;
      markdown += `**Period:** ${stats.period_start.split('T')[0]} to ${stats.period_end.split('T')[0]}\n\n`;
      markdown += `## Totals\n`;
      markdown += `- **Total Workouts:** ${stats.total_workouts}\n`;
      markdown += `- **Total Duration:** ${Math.round(stats.total_duration / 60)} minutes\n`;
      markdown += `- **Total Calories:** ${stats.total_calories}\n\n`;
      markdown += `## Averages\n`;
      markdown += `- **Avg Duration:** ${Math.round(stats.avg_duration / 60)} minutes\n`;
      markdown += `- **Avg Calories:** ${stats.avg_calories}\n\n`;
      markdown += `## Disciplines\n`;

      const sortedDisciplines = Object.entries(stats.disciplines).sort((a, b) => b[1] - a[1]);
      for (const [discipline, count] of sortedDisciplines) {
        markdown += `- **${discipline}:** ${count} workouts\n`;
      }

      return { content: [{ type: 'text', text: markdown }] };
    }

    const params = MuscleAnalysisSchema.parse(args);
    const workouts = await client.getRecentWorkouts(100);
    const days = params.period === '7_days' ? 7 : params.period === '30_days' ? 30 : 90;
    const startTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
    const filtered = workouts.filter((workout) => workout.created_at >= startTimestamp);
    const muscleImpact = calculateMuscleImpact(filtered);
    const balance = analyzeTrainingBalance(muscleImpact);

    if (params.response_format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ period: params.period, balance }, null, 2) }],
        structuredContent: { period: params.period, balance },
      };
    }

    let markdown = `# Training Balance (${params.period.replace('_', ' ')})\n\n`;
    markdown += `## Body Balance\n`;
    markdown += `- **Upper Body:** ${balance.upperBody}%\n`;
    markdown += `- **Lower Body:** ${balance.lowerBody}%\n`;
    markdown += `- **Status:** ${balance.balanced ? 'Balanced' : 'Imbalanced'}\n\n`;
    markdown += `## Training Type\n`;
    markdown += `- **Cardio Score:** ${balance.cardioScore}\n`;
    markdown += `- **Strength Score:** ${balance.strengthScore}\n`;

    return { content: [{ type: 'text', text: markdown }] };
  } catch (error: unknown) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${isError(error) ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}
