import type { FastifyReply, FastifyRequest } from "fastify";
import { socialAuthRequired } from "../domain/social.ts";
import type { SocialSession } from "../ports/social.port.ts";

export type SessionLookup = { authenticate(token: string | undefined): Promise<SocialSession | null> };

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return match?.[1];
}

/**
 * Reads that fill `liked`/`mine` for a signed-in caller. An unknown or expired token reads as
 * signed out rather than failing the read; writes report it with 401.
 */
export async function optionalSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionLookup,
): Promise<SocialSession | null> {
  reply.header("Vary", "Authorization");
  return sessions.authenticate(bearerToken(request));
}

export async function requireSession(request: FastifyRequest, sessions: SessionLookup): Promise<SocialSession> {
  const session = await sessions.authenticate(bearerToken(request));
  if (!session) throw socialAuthRequired();
  return session;
}
