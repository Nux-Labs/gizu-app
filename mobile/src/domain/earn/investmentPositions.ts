import type { EarnOwner, EarnProfileId } from "./types";

/** Saved execution activity only; reading this list never selects a cycle or signs. */
export type EarnInvestmentPosition = {
  intentId: string;
  cycleIndex: number;
  profileId: EarnProfileId;
  investmentSlot?: number;
  activity: "invested" | "redeemed" | "returned" | "pending";
  recoveryRequired: boolean;
};
export interface EarnInvestmentPositionsService {
  list(owner: EarnOwner): Promise<EarnInvestmentPosition[]>;
}

/** Screen-local proof; never persisted as native completion or spending authority. */
export type EarnInvestmentExitProof = {
  walletId: string;
  intentId: string;
  profileId: EarnProfileId;
  investmentSlot?: number;
  expiresAtMs: number | null;
};
