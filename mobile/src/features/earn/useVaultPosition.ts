import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import type { EarnIntent, EarnProfileId } from "@/domain/earn/types";
import type {
  EarnInvestmentPosition,
  EarnInvestmentExitProof,
} from "@/domain/earn/investmentPositions";
import {
  investmentPositionKey,
  openWithdrawalAttention,
  vaultWithdrawalAvailable,
} from "@/domain/earn/investmentPositions";
import {
  latestPrivateReturn,
  privateReturnConfirmed,
  type SponsoredOperation,
} from "@/domain/earn/sourceFunding";
import { portfolioVaultPosition, portfolioAssetAmount } from "@/domain/wallet/portfolioValue";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { useEarn, useOptionalEarn } from "./EarnProvider";
import { createEarnExitCompletionService } from "@/services/earn/exitCompletion";
import { earnWithdrawalService } from "@/services/earn/withdrawal";
import {
  InvestmentExitPendingError,
  assertReturnCredits,
  exitActivityRevision,
  exitHistoryRevision,
  isCompleteInvestmentExit,
} from "@/domain/earn/exitCompletion";
import { completedExitsStore } from "@/storage/completedExits";

function positionKey(row: Pick<EarnInvestmentPosition, "intentId" | "investmentSlot">) {
  return `${row.intentId}:${row.investmentSlot ?? "legacy"}`;
}
/** Local native journal only: an older public payout remains separate unfinished work. */
async function legacyPayoutsFinished(intent: EarnIntent): Promise<boolean> {
  if (!(await earnWithdrawalService.available())) return false;
  const payouts = await earnWithdrawalService.list(intent);
  return payouts.every((row) => !row.blocked && ["paid", "cancelled"].includes(row.status));
}
export function useVaultPosition(profileId: EarnProfileId, historyOnly = false) {
  const {
    investmentPositions,
    selectPosition,
    liquidity,
    robinhood,
    loading: earnLoading,
  } = useEarn();
  const exitChecker = useMemo(
    () =>
      createEarnExitCompletionService(
        process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
        { liquidity, robinhood },
      ),
    [liquidity, robinhood],
  );
  const { session } = useFundingWallet();
  const [rows, setRows] = useState<EarnInvestmentPosition[]>([]);
  const [intent, setIntent] = useState<EarnIntent | null>(null);
  const [proofs, setProofs] = useState<Record<string, number | "accepted">>({});
  const proofsRef = useRef<Record<string, number | "accepted">>({});
  const rowsRef = useRef<EarnInvestmentPosition[]>([]);
  const currentIntent = useRef<EarnIntent | null>(null);
  const completing = useRef(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const selected = useRef<string | null>(null);
  const occupied = useRef(false);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const recordCompletion = useCallback(
    (proof: EarnInvestmentExitProof) => {
      const current = currentIntent.current;
      if (
        !current ||
        proof.walletId !== session.walletId ||
        proof.profileId !== profileId ||
        proof.intentId !== current.intentId ||
        proof.investmentSlot !== current.investmentSlot ||
        selected.current !== positionKey(proof)
      )
        return;
      const key = positionKey(proof);
      if (proofsRef.current[key] === "accepted") return;
      if (proof.settled) {
        if (completing.current.has(key)) return;
        completing.current.add(key);
        const attempt = generation.current;
        void (async () => {
          try {
            if (
              !(await legacyPayoutsFinished(current)) ||
              attempt !== generation.current ||
              selected.current !== key
            )
              return;
            // The private receipt is saved. This completes the remaining local step bookkeeping.
            proofsRef.current = { ...proofsRef.current, [key]: "accepted" };
            setProofs(proofsRef.current);
            if (
              !rowsRef.current.some(
                (row) =>
                  row.activity !== "returned" && proofsRef.current[positionKey(row)] !== "accepted",
              )
            ) {
              selected.current = null;
              currentIntent.current = null;
              setIntent(null);
            }
          } catch {
            // Retain recovery for unreadable local legacy journals without repeating a return.
          } finally {
            completing.current.delete(key);
          }
        })();
        return;
      }
      const expires = proof.expiresAtMs;
      if (expires !== null && Number.isFinite(expires) && expires > Date.now()) {
        if (proofsRef.current[key] === expires) return;
        proofsRef.current = { ...proofsRef.current, [key]: expires };
      } else {
        if (!(key in proofsRef.current)) return;
        const next = { ...proofsRef.current };
        delete next[key];
        proofsRef.current = next;
      }
      setProofs(proofsRef.current);
    },
    [session.walletId, profileId],
  );
  const refresh = useCallback(
    async (recheckHistory = false) => {
      if (occupied.current) return;
      occupied.current = true;
      const attempt = generation.current;
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      // Unmount journal readers before the same services check historical exits.
      setIntent(null);
      selected.current = null;
      setMessage("");
      try {
        if (profileId !== "ethereum-usdc" && profileId !== "robinhood-usdg")
          throw new Error("Unsupported vault.");
        const positions = (
          await investmentPositions.list({
            walletId: session.walletId ?? "",
            address: session.address,
          })
        )
          .filter(
            (row) =>
              row.profileId === profileId &&
              (!historyOnly ||
                row.activity === "redeemed" ||
                row.activity === "returned" ||
                row.withdrawalAttention !== undefined),
          )
          .sort(
            (a, b) =>
              a.cycleIndex - b.cycleIndex || (a.investmentSlot ?? -1) - (b.investmentSlot ?? -1),
          );
        if (attempt !== generation.current) return;
        rowsRef.current = positions;
        setRows(positions);
        if (historyOnly) {
          // Read every saved portion, including invested rows with an older missing receipt.
          // Receipt verification is not full exit completion and must never populate its cache.
          const verified: Record<string, "accepted"> = {};
          let unresolved: EarnIntent | null = null;
          let failure = "";
          for (const row of positions) {
            if (row.activity === "returned") continue;
            let value: EarnIntent | null = null;
            try {
              if (row.recoveryRequired)
                throw new Error(
                  "Restore and reconcile saved activity before checking this return.",
                );
              value = await selectPosition(row);
              if (attempt !== generation.current || controller.signal.aborted) return;
              let journal = await (
                value.profileId === "robinhood-usdg" ? robinhood : liquidity
              ).list(value);
              if (attempt !== generation.current || controller.signal.aborted) return;
              if (value.profileId === "robinhood-usdg") {
                if (!journal.some((entry) => entry.blocked)) {
                  for (const returned of journal) {
                    if (
                      returned.kind !== "hoodTokenReturn" ||
                      !["returnSubmitted", "awaitingSettlement"].includes(returned.status)
                    )
                      continue;
                    if (attempt !== generation.current || controller.signal.aborted) return;
                    await robinhood.reconcileCredit(value, returned as SponsoredOperation);
                    if (attempt !== generation.current || controller.signal.aborted) return;
                  }
                  journal = await robinhood.list(value);
                }
                if (attempt !== generation.current || controller.signal.aborted) return;
                if (!privateReturnConfirmed(journal as SponsoredOperation[])) {
                  unresolved ??= value;
                  continue;
                }
              } else {
                assertReturnCredits(journal, value);
              }
              verified[positionKey(row)] = "accepted";
            } catch (error) {
              if (!(error instanceof InvestmentExitPendingError))
                failure ||=
                  "Past return status could not be checked. " +
                  (error instanceof Error ? error.message : "Retry the status check.");
              unresolved ??= value;
            }
            if (attempt !== generation.current || controller.signal.aborted) return;
          }
          if (attempt !== generation.current || controller.signal.aborted) return;
          proofsRef.current = verified;
          setProofs(verified);
          selected.current = unresolved ? positionKey(unresolved) : null;
          currentIntent.current = unresolved;
          setIntent(unresolved);
          setMessage(failure);
          return;
        }
        // Accepted exits stay complete during this visit while native activity is
        // still redeemed. New investment, uncertainty or recovery revokes them.
        // A later visit verifies native revisions before accepting recorded history.
        // Unrecorded or explicitly rechecked exits still require fresh public state.
        const checked: Record<string, number | "accepted"> = {};
        for (const row of positions) {
          const proof = proofsRef.current[positionKey(row)];
          if (
            row.activity === "redeemed" &&
            !row.recoveryRequired &&
            (proof === "accepted" || (typeof proof === "number" && proof > Date.now()))
          )
            checked[positionKey(row)] = "accepted";
        }
        proofsRef.current = checked;
        setProofs(checked);
        for (const next of positions) {
          if (next.activity === "returned" || checked[positionKey(next)] === "accepted") continue;
          if (next.recoveryRequired)
            throw new Error("Restore and reconcile saved activity before withdrawing.");
          const value = await selectPosition(next);
          if (attempt !== generation.current || controller.signal.aborted) return;
          if (next.activity === "redeemed") {
            try {
              if (value.profileId === "robinhood-usdg") {
                const completed = await robinhood.list(value);
                if (attempt !== generation.current || controller.signal.aborted) return;
                if (
                  privateReturnConfirmed(completed) &&
                  latestPrivateReturn(completed)?.status === "minimumReceived" &&
                  (await legacyPayoutsFinished(value))
                ) {
                  checked[positionKey(next)] = "accepted";
                  proofsRef.current = { ...checked };
                  setProofs(proofsRef.current);
                  continue;
                }
              }
              if (await earnWithdrawalService.available()) {
                if (recheckHistory) await completedExitsStore.forget(value);
                let journal = await (
                  value.profileId === "robinhood-usdg" ? robinhood : liquidity
                ).list(value);
                if (value.profileId === "robinhood-usdg" && !journal.some((row) => row.blocked)) {
                  for (const returned of journal) {
                    if (
                      returned.kind !== "hoodTokenReturn" ||
                      !["returnSubmitted", "awaitingSettlement"].includes(returned.status)
                    )
                      continue;
                    if (attempt !== generation.current || controller.signal.aborted) return;
                    await robinhood.reconcileCredit(value, returned as SponsoredOperation);
                    if (attempt !== generation.current || controller.signal.aborted) return;
                  }
                  journal = await robinhood.list(value);
                }
                assertReturnCredits(journal, value);
                const savedPayouts = await earnWithdrawalService.list(value);
                const savedRevision = exitHistoryRevision(
                  exitActivityRevision(journal),
                  savedPayouts,
                );
                const recorded =
                  !recheckHistory &&
                  savedRevision &&
                  (await completedExitsStore.has(value, savedRevision));
                if (attempt !== generation.current || controller.signal.aborted) return;
                if (recorded) {
                  checked[positionKey(next)] = "accepted";
                  proofsRef.current = { ...checked };
                  setProofs(proofsRef.current);
                  continue;
                }
                const result = await exitChecker.check(value, controller.signal);
                const payouts = await earnWithdrawalService.list(value);
                if (attempt !== generation.current || controller.signal.aborted) return;
                if (isCompleteInvestmentExit(result, value, payouts)) {
                  const revision = exitHistoryRevision(result.journalRevision, payouts);
                  if (revision) await completedExitsStore.save(value, revision);
                  if (attempt !== generation.current || controller.signal.aborted) return;
                  checked[positionKey(next)] = "accepted";
                  proofsRef.current = { ...checked };
                  setProofs(proofsRef.current);
                  continue;
                }
              }
            } catch (error) {
              // A failed check is uncertainty, not evidence of an unfinished return.
              if (!(error instanceof InvestmentExitPendingError))
                throw new Error(
                  "Previous withdrawal status could not be checked. " +
                    (error instanceof Error ? error.message : "Retry the status check."),
                );
            }
          }
          if (attempt !== generation.current || controller.signal.aborted) return;
          selected.current = positionKey(next);
          currentIntent.current = value;
          setIntent(value);
          return;
        }
        currentIntent.current = null;
      } catch (error) {
        if (attempt === generation.current) {
          setIntent(null);
          selected.current = null;
          setMessage(
            error instanceof Error
              ? error.message
              : "Saved vault withdrawal activity is unavailable.",
          );
        }
      } finally {
        occupied.current = false;
        if (active.current === controller) active.current = null;
        if (attempt === generation.current) setLoading(false);
      }
    },
    [
      investmentPositions,
      selectPosition,
      exitChecker,
      liquidity,
      robinhood,
      session.walletId,
      session.address,
      profileId,
      historyOnly,
    ],
  );
  useEffect(() => {
    const attempt = ++generation.current;
    selected.current = null;
    currentIntent.current = null;
    proofsRef.current = {};
    if (!earnLoading)
      void Promise.resolve().then(() => {
        if (attempt === generation.current) return refresh();
      });
    return () => {
      generation.current = attempt + 1;
      active.current?.abort();
    };
  }, [refresh, earnLoading]);
  const completed = rows.filter(
    (row) => row.activity === "returned" || proofs[positionKey(row)] === "accepted",
  ).length;
  return {
    rows,
    intent,
    completed,
    // Presentation only. Refresh rechecks expiry before accepting this proof.
    readyToContinue: intent !== null && typeof proofs[positionKey(intent)] === "number",
    recordCompletion,
    recheckCompleted: () => {
      if (occupied.current) return;
      proofsRef.current = {};
      return refresh(true);
    },
    loading: loading || earnLoading,
    message,
    refresh,
  };
}

/** Home and the vault entry read the same private-USDC finish decision as the withdrawal screen. */
export function useSharedWithdrawalState() {
  const wallet = useOptionalMainnetWallet();
  const earn = useOptionalEarn();
  const positionsService = earn?.investmentPositions;
  const robinhood = earn?.robinhood;
  const cycles = earn?.cycles;
  const walletId = wallet?.session.walletId ?? "";
  const address = wallet?.session.address ?? "";
  const [positions, setPositions] = useState<EarnInvestmentPosition[]>([]);
  const [journals, setJournals] = useState<Record<string, SponsoredOperation[]>>({});
  const [checked, setChecked] = useState(false);
  const covered = useMemo(() => {
    const next: Record<string, true> = {};
    for (const [key, journal] of Object.entries(journals)) {
      if (privateReturnConfirmed(journal)) next[key] = true;
    }
    return next;
  }, [journals]);
  useFocusEffect(
    useCallback(() => {
      if (!positionsService || !robinhood) return;
      let alive = true;
      void (async () => {
        const owner = { walletId, address };
        for (let attempt = 0; attempt < 6 && alive; attempt++) {
          try {
            const rows = await positionsService.list(owner);
            if (!alive) return;
            const next: Record<string, SponsoredOperation[]> = {};
            let waitingForCycle = false;
            for (const row of rows) {
              if (
                row.profileId !== "robinhood-usdg" ||
                row.recoveryRequired ||
                row.activity === "returned"
              )
                continue;
              const cycle = cycles?.find(
                (item) => item.intentId === row.intentId && item.profileId === row.profileId,
              );
              if (!cycle || cycle.status !== "prepared") {
                waitingForCycle = true;
                continue;
              }
              const intent: EarnIntent =
                row.investmentSlot === undefined
                  ? cycle
                  : { ...cycle, investmentSlot: row.investmentSlot };
              next[investmentPositionKey(row)] = await robinhood.list(intent);
              if (!alive) return;
            }
            if (!alive) return;
            if (waitingForCycle) {
              setChecked(false);
              return;
            }
            const fresh = await positionsService.list(owner);
            if (!alive) return;
            setPositions(fresh);
            setJournals(next);
            setChecked(true);
            return;
          } catch {
            if (!alive) return;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
      })();
      return () => {
        alive = false;
      };
    }, [positionsService, robinhood, cycles, walletId, address]),
  );
  return {
    attention: checked ? openWithdrawalAttention(positions, covered) : null,
    attentionFor: (profileId: EarnProfileId) =>
      checked
        ? openWithdrawalAttention(
            positions.filter((row) => row.profileId === profileId),
            covered,
          )
        : null,
    historyProfile: checked
      ? positions.find(
          (row) => row.withdrawalAttention === "checking" && !covered[investmentPositionKey(row)],
        )?.profileId
      : undefined,
    hasPastReturn: (profileId: EarnProfileId) =>
      checked &&
      positions.some(
        (row) =>
          row.profileId === profileId &&
          row.withdrawalAttention === "checking" &&
          !covered[investmentPositionKey(row)],
      ),
    canWithdraw: (profileId: EarnProfileId) => {
      if (!earn) return true;
      const position = portfolioVaultPosition(wallet?.snapshot, profileId);
      return vaultWithdrawalAvailable({
        amountAtoms: position ? portfolioAssetAmount(position, true) : null,
        positions,
        covered,
        profileId,
        checked,
      });
    },
  };
}
