export class PelotonAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PelotonAuthError';
  }
}

export class PelotonApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string
  ) {
    super(message);
    this.name = 'PelotonApiError';
  }
}

export class PelotonRateLimitError extends PelotonApiError {
  constructor(endpoint: string, public readonly retryAfterMs: number) {
    super('Rate limited', 429, endpoint);
    this.name = 'PelotonRateLimitError';
  }
}

export class CookieStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CookieStoreError';
  }
}

export function isError(e: unknown): e is Error {
  return e instanceof Error;
}
