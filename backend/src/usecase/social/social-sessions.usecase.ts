import { createHash, randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import {
  SOCIAL_CHALLENGE_SECONDS,
  SOCIAL_SESSION_DAYS,
  ownerLinkSigner,
  signInSigner,
  socialNickname,
  socialSignatureInvalid,
} from "../../domain/social.ts";
import type { StrategyRegistryChainId } from "../../domain/strategy.ts";
import type { SocialSession, SocialStore } from "../../ports/social.port.ts";
import type { StrategyStore } from "../../ports/strategies.port.ts";

export type SignInInput = {
  account: Address;
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
  ownerLink?: { strategyId: number; signature: Hex };
};

export type SignInResult = { token: Hex; expiresAt: string; name: string; ownerOf: number | null };

export function socialTokenHash(token: string): Hex {
  return `0x${createHash("sha256").update(token.toLowerCase()).digest("hex")}`;
}

const TOKEN_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Sign-in with the social key: a single-use challenge signed as EIP-712 `SignIn`, optionally
 * with an `OwnerLink` from a strategy key so the session comments as that strategy's owner.
 */
export class SocialSessions {
  constructor(
    private readonly store: Pick<
      SocialStore,
      "addChallenge" | "consumeChallenge" | "addSession" | "session"
    >,
    private readonly strategies: Pick<StrategyStore, "strategy">,
    private readonly chainId: StrategyRegistryChainId,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async challenge(): Promise<{ nonce: Hex; issuedAt: number }> {
    const now = this.now();
    const nonce: Hex = `0x${randomBytes(32).toString("hex")}`;
    const issuedAt = Math.floor(now.getTime() / 1000);
    await this.store.addChallenge(nonce, issuedAt, new Date(now.getTime() + SOCIAL_CHALLENGE_SECONDS * 1000));
    return { nonce, issuedAt };
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    const account = getAddress(input.account.toLowerCase());
    const signer = await signInSigner({
      chainId: this.chainId,
      account,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      signature: input.signature,
    });
    if (signer !== account) throw socialSignatureInvalid();

    let ownerOf: number | null = null;
    if (input.ownerLink) {
      const { strategyId } = input.ownerLink;
      const strategy = await this.strategies.strategy(strategyId);
      const owner = await ownerLinkSigner({
        chainId: this.chainId,
        account,
        strategyId,
        nonce: input.nonce,
        signature: input.ownerLink.signature,
      });
      if (!strategy || owner.toLowerCase() !== strategy.signer.toLowerCase())
        throw new DomainError("SOCIAL_OWNER_LINK_INVALID", "The owner link does not match the strategy key.");
      ownerOf = strategyId;
    }

    // Consumed only after both signatures check out, so a malformed attempt can be retried.
    const now = this.now();
    if (!(await this.store.consumeChallenge(input.nonce, input.issuedAt, now)))
      throw new DomainError("SOCIAL_CHALLENGE_INVALID", "The sign-in challenge is unknown, used or expired.");

    const token: Hex = `0x${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(now.getTime() + SOCIAL_SESSION_DAYS * 86_400_000);
    await this.store.addSession(socialTokenHash(token), { account, ownerOf, expiresAt });
    return { token, expiresAt: expiresAt.toISOString(), name: socialNickname(account), ownerOf };
  }

  /** The session behind a bearer token, or null when it is malformed, unknown or expired. */
  async authenticate(token: string | undefined): Promise<SocialSession | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    return this.store.session(socialTokenHash(token), this.now());
  }
}
