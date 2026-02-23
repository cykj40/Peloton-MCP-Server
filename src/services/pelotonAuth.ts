import axios, { AxiosError } from 'axios';
import { z } from 'zod';
import { PELOTON_API_URL } from '../constants.js';
import { isError, PelotonAuthError } from '../types/errors.js';

const AuthLoginResponseSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().optional(),
});

type AuthLoginResponse = z.infer<typeof AuthLoginResponseSchema>;

/**
 * Refresh Peloton session cookie using the official login endpoint.
 */
export async function refreshPelotonCookie(
  username: string,
  password: string
): Promise<string> {
  try {
    const response = await axios.post<unknown>(
      `${PELOTON_API_URL}/auth/login`,
      {
        username_or_email: username,
        password,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'peloton-platform': 'web',
          'User-Agent': 'PelotonMCP/1.0',
        },
      }
    );

    const parsed = AuthLoginResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new PelotonAuthError(`Invalid auth response: ${parsed.error.message}`);
    }

    const authResponse: AuthLoginResponse = parsed.data;
    console.error('[Auth] Successfully authenticated via /auth/login');
    return authResponse.session_id;
  } catch (error: unknown) {
    const axiosError = error instanceof AxiosError ? error : null;
    if (axiosError?.response) {
      throw new PelotonAuthError(
        `Auth login failed (${axiosError.response.status}): ${
          typeof axiosError.response.data === 'string'
            ? axiosError.response.data
            : JSON.stringify(axiosError.response.data)
        }`,
        error
      );
    }

    throw new PelotonAuthError(
      `Failed to refresh Peloton cookie: ${isError(error) ? error.message : 'Unknown error'}`,
      error
    );
  }
}
