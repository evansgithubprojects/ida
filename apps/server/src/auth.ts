import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Who is calling the web-app API: the Supabase Auth user id. */
export interface User {
  id: string;
}

/** Turns a bearer token into a user, or null when it isn't valid. Swappable so tests don't need Supabase. */
export type VerifyUser = (token: string) => Promise<User | null>;

/**
 * Verifies Supabase Auth access tokens against the project's published signing keys.
 * @param supabaseUrl e.g. `https://abcd.supabase.co`
 */
export function supabaseVerifier(supabaseUrl: string): VerifyUser {
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
      return payload.sub ? { id: payload.sub } : null;
    } catch {
      return null;
    }
  };
}
