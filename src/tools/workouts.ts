import { PelotonClient } from '../services/pelotonClient.js';
import { WorkoutSearchSchema } from '../schemas/index.js';
import { PelotonWorkout } from '../types/index.js';

export const workoutTools = [
  {
    name: 'peloton_get_workouts',
    description:
      'Get Peloton workout history with EXACT TIMESTAMPS for glucose correlation. Returns workout details including when each workout happened, duration, calories, type, and instructor. Critical for diabetes management - timestamps allow correlation with blood glucose patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          default: 10,
          description: 'Number of workouts to fetch (1-100)',
        },
        discipline: {
          type: 'string',
          description: 'Filter by discipline (cycling, running, strength, yoga, etc.)',
        },
        instructor: {
          type: 'string',
          description: 'Filter by instructor name',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD) for glucose correlation',
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
];

export async function handleWorkoutTool(
  name: string,
  args: any,
  client: PelotonClient
): Promise<any> {
  try {
    if (name === 'peloton_get_workouts') {
      const params = WorkoutSearchSchema.parse(args);

      const searchParams: any = {
        limit: params.limit,
      };

      if (params.discipline) {
        searchParams.discipline = params.discipline;
      }

      if (params.instructor) {
        searchParams.instructor = params.instructor;
      }

      if (params.start_date) {
        searchParams.startDate = new Date(params.start_date);
      }

      if (params.end_date) {
        searchParams.endDate = new Date(params.end_date);
      }

      const workouts = await client.searchWorkouts(searchParams);

      // Format workout data with CRITICAL timestamps
      const formattedWorkouts = workouts.map((workout: PelotonWorkout) => ({
        id: workout.id,
        name: workout.name || workout.ride?.title || 'Untitled',
        discipline: workout.fitness_discipline,
        instructor: workout.ride?.instructor?.name || workout.instructor?.name || 'Unknown',
        duration_minutes: Math.round(workout.duration / 60),
        calories: workout.calories || 0,
        timestamp: workout.created_at, // Unix timestamp - CRITICAL for glucose correlation
        date: new Date(workout.created_at * 1000).toISOString(),
        human_date: new Date(workout.created_at * 1000).toLocaleString(),
      }));

      if (params.response_format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total_workouts: formattedWorkouts.length,
                  workouts: formattedWorkouts,
                },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            total_workouts: formattedWorkouts.length,
            workouts: formattedWorkouts,
          },
        };
      }

      // Markdown format
      let markdown = `# Peloton Workouts\n\n`;
      markdown += `**Total:** ${formattedWorkouts.length} workouts\n\n`;

      if (formattedWorkouts.length === 0) {
        markdown += 'No workouts found matching the criteria.\n';
      } else {
        for (const workout of formattedWorkouts) {
          markdown += `## ${workout.name}\n`;
          markdown += `- **Date/Time:** ${workout.human_date}\n`;
          markdown += `- **Timestamp:** ${workout.timestamp} (for glucose correlation)\n`;
          markdown += `- **Discipline:** ${workout.discipline}\n`;
          markdown += `- **Instructor:** ${workout.instructor}\n`;
          markdown += `- **Duration:** ${workout.duration_minutes} minutes\n`;
          markdown += `- **Calories:** ${workout.calories}\n`;
          markdown += `\n`;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: markdown,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Unknown tool',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${(error as Error).message}`,
        },
      ],
    };
  }
}
