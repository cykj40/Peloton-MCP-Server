export const PELOTON_API_URL = 'https://api.onepeloton.com';

// Rate limiting
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY = 1000;
export const MAX_RETRY_DELAY = 60000;

// Cache settings
export const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Response limits
export const CHARACTER_LIMIT = 50000;
export const MAX_WORKOUTS_LIMIT = 100;

// Muscle intensity mapping for different disciplines
// Used to calculate which muscle groups are worked during each workout type
export const MUSCLE_INTENSITY_MAP = {
  cycling: {
    quadriceps: 9,
    hamstrings: 7,
    calves: 8,
    glutes: 8,
    core: 5,
    lower_back: 4,
  },
  running: {
    quadriceps: 8,
    hamstrings: 9,
    calves: 10,
    glutes: 7,
    core: 6,
  },
  walking: {
    quadriceps: 6,
    hamstrings: 7,
    calves: 8,
    glutes: 6,
    core: 4,
  },
  strength: {
    // Base values, adjusted by workout title
    core: 6,
  },
  yoga: {
    core: 7,
    lower_back: 6,
    upper_back: 5,
    shoulders: 4,
    hamstrings: 7,
    glutes: 4,
  },
  meditation: {},
  cardio: {
    core: 6,
    quadriceps: 7,
    hamstrings: 6,
    calves: 5,
  },
  stretching: {
    hamstrings: 6,
    calves: 5,
    shoulders: 5,
    back: 6,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number>>>>;

export type Discipline = keyof typeof MUSCLE_INTENSITY_MAP;
export type MuscleKey = keyof (typeof MUSCLE_INTENSITY_MAP)[Discipline];
