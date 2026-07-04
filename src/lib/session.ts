// Session-token helpers, kept free of node:crypto imports so the request
// proxy (which may run in the Edge runtime) can use them.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "kw_session";
const SESSION_TTL_DAYS = 30;

/** Max-Age for the session cookie, in seconds. */
export const SESSION_MAX_AGE = SESSION_TTL_DAYS * 24 * 60 * 60;

function getAuthSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is not set (or too short). Add a long random string to .env and restart.",
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  sub: string; // user id
  email: string;
  role: string;
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(getAuthSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getAuthSecret());
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: (payload.email as string) ?? "",
      role: (payload.role as string) ?? "admin",
    };
  } catch {
    return null;
  }
}
