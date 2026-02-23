import { z } from 'zod';
import { PelotonClient } from '../services/pelotonClient.js';
import { GlucoseReading, ToolResponse } from '../types/index.js';
import {
  analyzeWorkoutGlucoseImpact,
  getInsightsByDiscipline,
  detectDelayedHypoglycemia,
} from '../services/correlationService.js';
import { getWorkoutById, getWorkoutCount } from '../db/queries.js';
import {
  CorrelationResponseSchema,
  GlucoseCorrelationAnalysisSchema,
  SyncWorkoutsSchema,
} from '../schemas/index.js';
import { isError } from '../types/errors.js';

export const correlationTools = [
  {
    name: 'peloton_analyze_glucose_correlation',
    description:
      'Analyze how a specific Peloton workout affected blood glucose levels. Requires glucose readings from Dexcom MCP (use dexcom get_glucose_range first). Critical for understanding exercise impact on diabetes management.',
    inputSchema: {
      type: 'object',
      properties: {
        workout_id: {
          type: 'string',
          description: 'Peloton workout ID to analyze',
        },
        glucose_readings: {
          type: 'array',
          description:
            'Array of glucose readings from Dexcom. Get these from dexcom get_glucose_range tool first.',
          items: {
            type: 'object',
            properties: {
              value: { type: 'number', description: 'Glucose value in mg/dL' },
              recordedAt: { type: 'string', description: 'ISO 8601 timestamp' },
            },
            required: ['value', 'recordedAt'],
          },
        },
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format',
        },
      },
      required: ['workout_id', 'glucose_readings'],
    },
  },
  {
    name: 'peloton_get_discipline_insights',
    description:
      'Get aggregated glucose impact insights by workout discipline (cycling, strength, yoga, etc.). Shows average glucose drops, recovery times, and risk levels based on stored correlations. Helps identify which workout types are safest/riskiest for your diabetes management.',
    inputSchema: {
      type: 'object',
      properties: {
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format',
        },
      },
      required: [],
    },
  },
  {
    name: 'peloton_detect_hypoglycemia_risk',
    description:
      'Scan stored glucose correlations for delayed hypoglycemia patterns after workouts. Flags workouts that caused glucose < 80 mg/dL or delayed drops > 2 hours post-exercise. CRITICAL FOR DIABETES SAFETY.',
    inputSchema: {
      type: 'object',
      properties: {
        response_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          default: 'markdown',
          description: 'Response format',
        },
      },
      required: [],
    },
  },
  {
    name: 'peloton_sync_workouts',
    description:
      'Force sync latest workouts from Peloton API to local database. Run this periodically to keep workout data fresh for correlation analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          default: 50,
          description: 'Number of recent workouts to sync (default 50)',
        },
      },
      required: [],
    },
  },
] as const;

export type CorrelationToolName = (typeof correlationTools)[number]['name'];
type CorrelationToolArgs =
  | z.infer<typeof GlucoseCorrelationAnalysisSchema>
  | z.infer<typeof CorrelationResponseSchema>
  | z.infer<typeof SyncWorkoutsSchema>;

export async function handleCorrelationTool(
  name: CorrelationToolName,
  args: CorrelationToolArgs,
  client: PelotonClient
): Promise<ToolResponse> {
  try {
    switch (name) {
      case 'peloton_analyze_glucose_correlation': {
        const params = GlucoseCorrelationAnalysisSchema.parse(args);
        const responseFormat = params.response_format;

        const workout = getWorkoutById(params.workout_id);
        if (!workout) {
          return {
            content: [
              {
                type: 'text',
                text: `ERROR: Workout ${params.workout_id} not found in database. Run peloton_sync_workouts first.`,
              },
            ],
          };
        }

        const readings: GlucoseReading[] = params.glucose_readings.map((reading) => ({
          value: reading.value,
          recordedAt: reading.recordedAt ?? reading.recorded_at ?? '',
        }));

        const correlation = analyzeWorkoutGlucoseImpact(workout, readings);

        if (responseFormat === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(correlation, null, 2),
              },
            ],
          };
        }

        const workoutDate = new Date(workout.created_at * 1000).toLocaleString();
        let output = `# Glucose Correlation Analysis\n\n`;
        output += `**Workout:** ${workout.name}\n`;
        output += `**Discipline:** ${workout.fitness_discipline}\n`;
        output += `**Date:** ${workoutDate}\n`;
        output += `**Duration:** ${Math.round(workout.duration / 60)} minutes\n\n`;
        output += `## Glucose Impact\n\n`;
        output += `- **Pre-workout glucose:** ${correlation.pre_workout_glucose || 'N/A'} mg/dL\n`;
        output += `- **Glucose at start:** ${correlation.glucose_at_start || 'N/A'} mg/dL\n`;
        output += `- **Glucose nadir (lowest):** ${correlation.glucose_nadir || 'N/A'} mg/dL\n`;
        output += `- **Time to nadir:** ${correlation.glucose_nadir_time || 'N/A'} minutes after start\n`;
        output += `- **Glucose 4h post:** ${correlation.glucose_4h_post || 'N/A'} mg/dL\n`;
        output += `- **Average drop:** ${correlation.avg_drop || 'N/A'} mg/dL\n`;
        output += `- **Recovery time:** ${correlation.recovery_time_minutes || 'N/A'} minutes\n\n`;

        if (correlation.notes) {
          output += `## Alerts\n\n${correlation.notes}\n\n`;
        }

        output += `## Interpretation\n\n`;
        if (correlation.avg_drop && correlation.avg_drop > 50) {
          output += `HIGH RISK: This workout caused a significant glucose decrease (${correlation.avg_drop} mg/dL). Consider having a snack before similar workouts.\n\n`;
        } else if (correlation.avg_drop && correlation.avg_drop > 30) {
          output += `MODERATE RISK: Monitor your glucose during similar workouts.\n\n`;
        } else if (correlation.avg_drop) {
          output += `LOW RISK: This workout had a manageable impact on your glucose levels.\n\n`;
        }

        if (correlation.glucose_nadir_time && correlation.glucose_nadir_time > 120) {
          output += `DELAYED DROP: The lowest glucose occurred ${Math.round(correlation.glucose_nadir_time / 60)} hours after the workout. Be aware of delayed hypoglycemia risk.\n\n`;
        }

        output += `*Correlation saved to database (ID: ${correlation.id})*`;
        return { content: [{ type: 'text', text: output }] };
      }

      case 'peloton_get_discipline_insights': {
        const params = CorrelationResponseSchema.parse(args);
        const insights = getInsightsByDiscipline();

        if (insights.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No correlation data available yet. Use peloton_analyze_glucose_correlation to create correlations first.',
              },
            ],
          };
        }

        if (params.response_format === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(insights, null, 2),
              },
            ],
          };
        }

        let output = `# Glucose Impact by Workout Discipline\n\n`;
        output += `Based on ${insights.reduce((sum, item) => sum + item.sample_count, 0)} analyzed workout correlations:\n\n`;

        for (const insight of insights) {
          const riskLabel = insight.risk_level.toUpperCase();
          output += `## [${riskLabel}] ${insight.discipline.charAt(0).toUpperCase() + insight.discipline.slice(1)}\n\n`;
          output += `- **Risk Level:** ${insight.risk_level.toUpperCase()}\n`;
          output += `- **Average glucose drop:** ${insight.avg_drop} mg/dL\n`;
          output += `- **Average nadir time:** ${Math.round(insight.avg_nadir_time / 60)}h ${insight.avg_nadir_time % 60}m after start\n`;
          output += `- **Average recovery time:** ${insight.avg_recovery_time} minutes\n`;
          output += `- **Average pre-workout glucose:** ${insight.avg_pre_workout} mg/dL\n`;
          output += `- **Average glucose nadir:** ${insight.avg_nadir} mg/dL\n`;
          output += `- **Sample size:** ${insight.sample_count} workouts\n\n`;
        }

        output += `## Recommendations\n\n`;
        const highRisk = insights.filter((item) => item.risk_level === 'high');
        if (highRisk.length > 0) {
          output += `HIGH-RISK disciplines: ${highRisk.map((item) => item.discipline).join(', ')}\n`;
          output += `- Consider having a snack before these workouts\n`;
          output += `- Monitor glucose more frequently during and after\n`;
          output += `- May need to reduce insulin before exercise\n\n`;
        }

        const lowRisk = insights.filter((item) => item.risk_level === 'low');
        if (lowRisk.length > 0) {
          output += `LOW-RISK disciplines: ${lowRisk.map((item) => item.discipline).join(', ')}\n`;
          output += `- These workouts have minimal glucose impact\n`;
          output += `- Safe for most times of day\n\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'peloton_detect_hypoglycemia_risk': {
        const params = CorrelationResponseSchema.parse(args);
        const alerts = detectDelayedHypoglycemia();

        if (alerts.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No hypoglycemia patterns detected in stored correlations.',
              },
            ],
          };
        }

        if (params.response_format === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(alerts, null, 2),
              },
            ],
          };
        }

        let output = `# Hypoglycemia Risk Alert\n\n`;
        output += `Found ${alerts.length} workout(s) with concerning glucose patterns:\n\n`;

        for (const alert of alerts) {
          const severityLabel = alert.severity.toUpperCase();
          const workoutDate = new Date(alert.workout_timestamp * 1000).toLocaleString();

          output += `## [${severityLabel}] ${alert.discipline.charAt(0).toUpperCase() + alert.discipline.slice(1)} Workout\n\n`;
          output += `- **Date:** ${workoutDate}\n`;
          output += `- **Severity:** ${alert.severity.toUpperCase()}\n`;
          output += `- **Glucose nadir:** ${alert.glucose_nadir} mg/dL\n`;
          output += `- **Time to nadir:** ${Math.round(alert.nadir_time_minutes / 60)}h ${alert.nadir_time_minutes % 60}m\n`;
          if (alert.is_delayed) {
            output += `- Delayed drop: Yes (> 2 hours post-workout)\n`;
          }
          output += `- **Notes:** ${alert.notes}\n`;
          output += `- **Workout ID:** ${alert.workout_id}\n\n`;
        }

        output += `## Safety Recommendations\n\n`;
        const severeAlerts = alerts.filter((item) => item.severity === 'severe');
        const delayedAlerts = alerts.filter((item) => item.is_delayed);

        if (severeAlerts.length > 0) {
          output += `SEVERE HYPOGLYCEMIA DETECTED\n`;
          output += `- ${severeAlerts.length} workout(s) caused glucose < 54 mg/dL\n`;
          output += `- Consult your diabetes care team about adjusting pre-workout routine\n`;
          output += `- Consider reducing insulin doses before similar workouts\n\n`;
        }

        if (delayedAlerts.length > 0) {
          output += `DELAYED HYPOGLYCEMIA PATTERN\n`;
          output += `- ${delayedAlerts.length} workout(s) showed delayed glucose drops\n`;
          output += `- Monitor glucose for 4+ hours after exercise\n`;
          output += `- Be especially careful with evening workouts (overnight risk)\n\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'peloton_sync_workouts': {
        const params = SyncWorkoutsSchema.parse(args);
        const workouts = await client.getRecentWorkouts(params.limit);
        const dbCount = getWorkoutCount();

        return {
          content: [
            {
              type: 'text',
              text: `Synced ${workouts.length} workouts from Peloton API.\n\nDatabase now contains ${dbCount} total workouts.\n\nYou can now analyze glucose correlations using peloton_analyze_glucose_correlation.`,
            },
          ],
        };
      }
    }
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
