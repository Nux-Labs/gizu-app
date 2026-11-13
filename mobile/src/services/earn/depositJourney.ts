import {
  parseDepositSnapshot,
  parseDepositFundingBalance,
  type EarnDepositService,
  type DepositSnapshot,
} from "@/domain/earn/depositJourney";
import type { EarnOwner } from "@/domain/earn/types";
import { getStoredEarnDepositSigner } from "@/services/wallet/nativeBridge";
type DepositBridge = Omit<
  NonNullable<ReturnType<typeof getStoredEarnDepositSigner>>,
  "readEarnDepositFundingBalance" | "findEarnDeposit"
> & {
  findEarnDeposit?: (walletId: string, profileId: string) => Promise<unknown>;
  readEarnDepositFundingBalance?: (request: { walletId: string }) => Promise<unknown>;
};
export function createEarnDepositService(
  bridgeFactory: () => DepositBridge | null = getStoredEarnDepositSigner,
): EarnDepositService {
  const occupied = new Set<string>(),
    uncertain = new Map<string, string>();
  const bridge = () => {
    const native = bridgeFactory();
    if (!native) throw new Error("This deposit needs the updated Android native signer.");
    return native;
  };
  async function status(owner: EarnOwner, id: string) {
    const saved = parseDepositSnapshot(
      await bridge().getEarnDepositStatus(owner.walletId, id),
      owner,
    );
    if (
      (id.startsWith("intent:") && saved.intentId !== id.slice(7)) ||
      (!id.startsWith("intent:") && id !== "current-deposit" && saved.journeyId !== id)
    )
      throw new Error("Native deposit identity changed.");
    return saved;
  }
  async function mutation(
    owner: EarnOwner,
    task: () => Promise<unknown>,
  ): Promise<DepositSnapshot> {
    if (occupied.has(owner.walletId)) throw new Error("A deposit action is already running.");
    occupied.add(owner.walletId);
    try {
      return parseDepositSnapshot(await task(), owner);
    } finally {
      occupied.delete(owner.walletId);
    }
  }
  async function statusResult(owner: EarnOwner, id: string, task: Promise<unknown>) {
    const saved = parseDepositSnapshot(await task, owner);
    if (saved.journeyId !== id) throw new Error("Native deposit identity changed.");
    return saved;
  }
  return {
    async available() {
      return bridgeFactory() !== null;
    },
    async pending(owner, profileId) {
      const native = bridge();
      if (!native.findEarnDeposit)
        throw new Error("Checking saved deposits requires the updated native app.");
      const raw = await native.findEarnDeposit(owner.walletId, profileId);
      if (raw === null) return null;
      const saved = parseDepositSnapshot(raw, owner);
      if (saved.profileId !== profileId || saved.phase === "invested")
        throw new Error("Native pending deposit identity changed.");
      return saved;
    },
    async fundingBalance(owner) {
      const native = bridge();
      if (!native.readEarnDepositFundingBalance) return null;
      const result = await native.readEarnDepositFundingBalance({ walletId: owner.walletId });
      return result === null ? null : parseDepositFundingBalance(result);
    },
    prepare: (owner, profile, budget, draftId) =>
      mutation(owner, async () => {
        let id = draftId;
        const unresolved = uncertain.get(owner.walletId);
        if (unresolved) {
          const saved = await status(owner, unresolved);
          if (
            !["draft", "preparing", "review"].includes(saved.phase) &&
            !(
              saved.phase === "paused" &&
              saved.completedSteps.length === 0 &&
              saved.creditedAtoms === "0" &&
              [
                "previewUnavailable",
                "quoteUnavailable",
                "insufficientFunds",
                "uneconomicAmount",
                "savedDepositOpen",
              ].includes(saved.pauseReason ?? "")
            )
          )
            return saved;
          id = saved.journeyId;
          uncertain.delete(owner.walletId);
        }
        try {
          const saved = parseDepositSnapshot(
            await bridge().prepareEarnDeposit(owner.walletId, profile, budget, id ?? null),
            owner,
          );
          if (
            saved.profileId !== profile ||
            (id && saved.journeyId !== id) ||
            (["draft", "preparing", "review"].includes(saved.phase) && saved.budgetAtoms !== budget)
          )
            throw new Error("Native deposit identity changed.");
          return saved;
        } catch (error) {
          uncertain.set(owner.walletId, id ?? "current-deposit");
          try {
            uncertain.set(owner.walletId, (await status(owner, id ?? "current-deposit")).journeyId);
          } catch {
            /* preserve unresolved identity */
          }
          throw error;
        }
      }),
    confirm: (owner, id, revision) =>
      mutation(owner, async () => {
        const saved = await statusResult(
          owner,
          id,
          bridge().confirmEarnDeposit(owner.walletId, id, revision),
        );
        return saved;
      }),
    resume: (owner, id, revision) =>
      mutation(owner, () =>
        statusResult(owner, id, bridge().resumeEarnDeposit(owner.walletId, id, revision)),
      ),
    status,
    async discardDraft(owner, id) {
      if (occupied.has(owner.walletId)) throw new Error("A deposit action is already running.");
      const native = bridge();
      if (!native.discardEarnDepositDraft)
        throw new Error("Changing this draft requires the updated native build.");
      occupied.add(owner.walletId);
      try {
        await native.discardEarnDepositDraft(owner.walletId, id);
        uncertain.delete(owner.walletId);
      } finally {
        occupied.delete(owner.walletId);
      }
    },
    async cancel(owner, id, revision) {
      const saved = parseDepositSnapshot(
        await bridge().cancelEarnDeposit(owner.walletId, id, revision),
        owner,
      );
      if (saved.journeyId !== id) throw new Error("Native deposit identity changed.");
      return saved;
    },
  };
}
