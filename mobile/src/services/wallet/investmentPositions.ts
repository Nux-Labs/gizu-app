import type { EarnOwner } from "@/domain/earn/types";
import type {
  EarnInvestmentPosition,
  EarnInvestmentPositionsService,
} from "@/domain/earn/investmentPositions";
import { getStoredEarnSigner } from "./nativeBridge";
import { completedExitsStore } from "@/storage/completedExits";

type Bridge = { listEarnInvestmentPositions?(walletId: string): Promise<unknown> };
export function createEarnInvestmentPositionsService(
  getBridge: () => Bridge | null = getStoredEarnSigner,
): EarnInvestmentPositionsService {
  return {
    async list(owner: EarnOwner) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.walletId))
        throw new Error("Verified source wallet required.");
      const bridge = getBridge();
      if (!bridge?.listEarnInvestmentPositions)
        throw new Error("Saved vault withdrawal activity requires the updated native build.");
      const result = await bridge.listEarnInvestmentPositions(owner.walletId);
      if (!Array.isArray(result) || result.length > 1280)
        throw new Error("Invalid saved vault activity.");
      const seen = new Set<string>();
      const positions = result.map((value): EarnInvestmentPosition => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid saved vault activity.");
        const row = value as Record<string, unknown>;
        if (
          (row.profileId !== "ethereum-usdc" && row.profileId !== "robinhood-usdg") ||
          typeof row.cycleIndex !== "number" ||
          !Number.isSafeInteger(row.cycleIndex) ||
          row.cycleIndex < 0 ||
          (row.investmentSlot !== undefined &&
            (typeof row.investmentSlot !== "number" ||
              !Number.isSafeInteger(row.investmentSlot) ||
              row.investmentSlot < 0 ||
              row.investmentSlot > 4)) ||
          !["invested", "redeemed", "returned", "pending"].includes(String(row.activity)) ||
          typeof row.recoveryRequired !== "boolean" ||
          (row.withdrawalComplete !== undefined && typeof row.withdrawalComplete !== "boolean") ||
          (row.lastReturnOperationId !== undefined &&
            (typeof row.lastReturnOperationId !== "string" ||
              !/^[-a-zA-Z0-9_]{1,128}$/.test(row.lastReturnOperationId))) ||
          (row.withdrawalAttention !== undefined &&
            !["confirming", "unfinished", "returning", "checking"].includes(
              String(row.withdrawalAttention),
            ))
        )
          throw new Error("Invalid saved vault activity.");
        const expected =
          row.cycleIndex === 0
            ? `earn-v1:${owner.walletId.toLowerCase()}:${row.profileId}`
            : `earn-v2:${owner.walletId.toLowerCase()}:${row.profileId}:${row.cycleIndex}`;
        const key = `${expected}:${row.investmentSlot ?? "legacy"}`;
        if (row.intentId !== expected || seen.has(key))
          throw new Error("Saved vault activity identity changed.");
        seen.add(key);
        return {
          intentId: expected,
          cycleIndex: row.cycleIndex,
          profileId: row.profileId,
          ...(row.investmentSlot !== undefined
            ? { investmentSlot: row.investmentSlot as number }
            : {}),
          activity: row.activity as EarnInvestmentPosition["activity"],
          recoveryRequired: row.recoveryRequired,
          ...(row.withdrawalComplete === true ? { withdrawalComplete: true } : {}),
          ...(Array.isArray(row.completedWithdrawalRequestIds) &&
          row.completedWithdrawalRequestIds.length <= 256 &&
          row.completedWithdrawalRequestIds.every(
            (id: unknown) => typeof id === "string" && /^[-a-zA-Z0-9_]{1,128}$/.test(id),
          )
            ? { completedWithdrawalRequestIds: row.completedWithdrawalRequestIds as string[] }
            : {}),
          ...(typeof row.lastWithdrawalRequestId === "string" &&
          /^[-a-zA-Z0-9_]{1,128}$/.test(row.lastWithdrawalRequestId)
            ? { lastWithdrawalRequestId: row.lastWithdrawalRequestId }
            : {}),
          ...(typeof row.lastReturnOperationId === "string"
            ? { lastReturnOperationId: row.lastReturnOperationId }
            : {}),
          ...(row.withdrawalAttention === "confirming" ||
          row.withdrawalAttention === "unfinished" ||
          row.withdrawalAttention === "returning" ||
          row.withdrawalAttention === "checking"
            ? { withdrawalAttention: row.withdrawalAttention }
            : {}),
        };
      });
      return Promise.all(
        positions.map(async (row) => {
          if (
            !row.recoveryRequired &&
            row.activity === "redeemed" &&
            row.withdrawalAttention === "checking" &&
            row.lastReturnOperationId &&
            (await completedExitsStore.hasReturn(
              { ...row, walletId: owner.walletId },
              row.lastReturnOperationId,
            ))
          )
            return { ...row, activity: "returned" as const, withdrawalAttention: undefined };
          return row;
        }),
      );
    },
  };
}
