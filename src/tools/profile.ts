import { PelotonClient } from '../services/pelotonClient.js';
import { ConnectionTestSchema, ProfileSchema } from '../schemas/index.js';

export const profileTools = [
  {
    name: 'peloton_test_connection',
    description: 'Test connection to Peloton API and verify authentication',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'peloton_get_profile',
    description: 'Get Peloton user profile information including total workouts, followers, and account details',
    inputSchema: {
      type: 'object',
      properties: {
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

export async function handleProfileTool(
  name: string,
  args: any,
  client: PelotonClient
): Promise<any> {
  try {
    if (name === 'peloton_test_connection') {
      ConnectionTestSchema.parse(args);
      const result = await client.testConnection();

      if (result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `✅ ${result.details}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `❌ ${result.details}`,
            },
          ],
        };
      }
    }

    if (name === 'peloton_get_profile') {
      const params = ProfileSchema.parse(args);
      const profile = await client.getUserProfile();

      const profileData = {
        username: profile.username,
        user_id: profile.id,
        total_workouts: profile.total_workouts || 0,
        total_followers: profile.total_followers || 0,
        total_following: profile.total_following || 0,
        member_since: profile.created_at
          ? new Date(profile.created_at * 1000).toISOString().split('T')[0]
          : 'Unknown',
      };

      if (params.response_format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(profileData, null, 2),
            },
          ],
          structuredContent: profileData,
        };
      }

      // Markdown format
      const markdown = `# Peloton Profile

**Username:** ${profileData.username}
**User ID:** ${profileData.user_id}

## Stats
- **Total Workouts:** ${profileData.total_workouts}
- **Followers:** ${profileData.total_followers}
- **Following:** ${profileData.total_following}
- **Member Since:** ${profileData.member_since}
`;

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
