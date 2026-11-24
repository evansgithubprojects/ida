import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

/** Who is calling the web-app API: the Supabase Auth user id. */
export interface User {
  id: string;
  /** From the token, when the sign-in provider shares it. Invites are matched against it. */
  email?: string;
  name?: string;
  /** The organization named on the sign-up form (Supabase `user_metadata.org_name`), created on first sign-in. */
  orgName?: string;
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
  let warned = false;
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
      if (!payload.sub) return null;
      const meta = (payload.user_metadata ?? {}) as { full_name?: unknown; name?: unknown; org_name?: unknown };
      const name = [meta.full_name, meta.name].find((n): n is string => typeof n === 'string' && n.length > 0);
      const orgName = typeof meta.org_name === 'string' && meta.org_name.trim() ? meta.org_name : undefined;
      return {
        id: payload.sub,
        ...(typeof payload.email === 'string' && { email: payload.email }),
        ...(name && { name }),
        ...(orgName && { orgName }),
      };
    } catch {
      // The usual dev mistake: the web app signs in with a different Supabase project than this server trusts.
      if (!warned) {
        const iss = tokenIssuer(token);
        if (iss && iss !== issuer) {
          warned = true;
          console.warn(`[server] rejected a token issued by ${iss}, but SUPABASE_URL makes this server trust ${issuer}. The web app and the server must use the same Supabase project.`);
        }
      }
      return null;
    }
  };
}

/** The `iss` claim of a token, read without verifying it. Only used to explain a rejection, never to trust the token. */
function tokenIssuer(token: string): string | null {
  try {
    const { iss } = decodeJwt(token);
    return typeof iss === 'string' ? iss : null;
  } catch {
    return null;
  }
}
