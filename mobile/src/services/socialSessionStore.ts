import * as SecureStore from "expo-secure-store";
import type { SocialSession } from "@/domain/strategies";

/** A social session saved for one wallet; another wallet on the phone signs in on its own. */
export type StoredSocialSession = SocialSession & { walletId: string };

export interface SocialSessionStore {
  load(walletId: string): Promise<SocialSession | null>;
  save(walletId: string, session: SocialSession): Promise<void>;
  clear(): Promise<void>;
}

const SESSION_KEY = "gizu.social.session.v1";

function isSession(value: unknown): value is StoredSocialSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.walletId === "string" &&
    typeof session.token === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(session.token) &&
    typeof session.expiresAt === "string" &&
    typeof session.name === "string" &&
    (session.ownerOf === null || Number.isSafeInteger(session.ownerOf))
  );
}

/** The token is a bearer credential for likes and comments, so it lives in the keystore. */
export const secureSocialSessionStore: SocialSessionStore = {
  async load(walletId) {
    try {
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!isSession(parsed) || parsed.walletId !== walletId) return null;
      if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
      const { walletId: _wallet, ...session } = parsed;
      return session;
    } catch {
      return null;
    }
  },
  async save(walletId, session) {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({ ...session, walletId }));
  },
  async clear() {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};

/** In-memory sessions for tests and previews. */
export function createMemorySocialSessionStore(initial?: StoredSocialSession): SocialSessionStore {
  let stored: StoredSocialSession | null = initial ?? null;
  return {
    async load(walletId) {
      if (!stored || stored.walletId !== walletId) return null;
      const { walletId: _wallet, ...session } = stored;
      return session;
    },
    async save(walletId, session) {
      stored = { ...session, walletId };
    },
    async clear() {
      stored = null;
    },
  };
}
