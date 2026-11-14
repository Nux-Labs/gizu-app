import { useCallback, useEffect, useRef, useState } from "react";
import { useEarn } from "./EarnProvider";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import type { RobinhoodPlan } from "@/domain/earn/robinhoodExecution";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnInvestmentPosition } from "@/domain/earn/investmentPositions";
import { investmentDestination } from "@/domain/earn/distribution";
import {
  allocateWithdrawal,
  withdrawalPortionKey,
  type WithdrawalCapacity,
  type WithdrawalSelection,
  type WithdrawalPortion,
} from "@/domain/earn/withdrawalSelection";
import { withdrawalSelectionStore } from "@/storage/withdrawalSelection";

type Capacity = WithdrawalCapacity & { afterReturnOperationId?: string };
const pendingWithdrawal = (row: EarnInvestmentPosition) =>
  !row.withdrawalComplete &&
  (row.activity === "pending" ||
    row.activity === "redeemed" ||
    Boolean(row.lastWithdrawalRequestId && row.withdrawalAttention) ||
    ["unfinished", "confirming", "returning"].includes(row.withdrawalAttention ?? ""));
export function useRequestedWithdrawal() {
  const { investmentPositions, selectPosition, robinhood, loading: earnLoading } = useEarn();
  const { session } = useFundingWallet();
  const walletId = session.walletId ?? "";
  const [amount, setAmount] = useState("");
  const [capacities, setCapacities] = useState<Capacity[]>([]);
  const [selection, setSelection] = useState<WithdrawalSelection | null>(null);
  const [portion, setPortion] = useState<WithdrawalPortion | null>(null);
  const [intent, setIntent] = useState<EarnIntent | null>(null);
  const [reviewedPlan, setReviewedPlan] = useState<RobinhoodPlan | undefined>();
  const [legacyRecovery, setLegacyRecovery] = useState(false);
  const [complete, setComplete] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const occupied = useRef(false),
    generation = useRef(0),
    active = useRef<AbortController | null>(null);
  const activeRequest = useRef<string | null>(null);
  const queuedLoad = useRef<(() => Promise<void>) | null>(null);
  const release = useCallback(() => {
    occupied.current = false;
    const next = queuedLoad.current;
    queuedLoad.current = null;
    if (next) void next();
  }, []);
  const owner = { walletId, address: session.address };
  const load = useCallback(
    async function loadWithdrawal(initialPlan?: RobinhoodPlan) {
      if (occupied.current) {
        queuedLoad.current = () => loadWithdrawal(initialPlan);
        return;
      }
      occupied.current = true;
      const attempt = ++generation.current,
        controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setMessage("");
      setIntent(null);
      setPortion(null);
      setComplete(false);
      setLegacyRecovery(false);
      setReviewedPlan(initialPlan);
      const alive = () => attempt === generation.current && !controller.signal.aborted;
      try {
        const rows = (await investmentPositions.list({ walletId, address: session.address }))
          .filter((row) => row.profileId === "robinhood-usdg")
          .sort(
            (a, b) =>
              a.cycleIndex - b.cycleIndex || (a.investmentSlot ?? -1) - (b.investmentSlot ?? -1),
          );
        const saved = await withdrawalSelectionStore.load(walletId);
        if (!alive()) return;
        const nativePending = rows.find(pendingWithdrawal);
        if (nativePending) {
          const selected = await selectPosition(nativePending),
            journal = await robinhood.list(selected);
          if (!alive()) return;
          const spending =
            journal.find(
              (op) => op.blocked && (op.kind === "hoodRedeemAll" || op.kind === "hoodTokenReturn"),
            ) ??
            [...journal]
              .reverse()
              .find(
                (op) =>
                  (op.status === "expired" &&
                    (op.withdrawalRequestId || op.withdrawalOperationId)) ||
                  (op.status === "withdrawn" &&
                    op.withdrawalRequestId === nativePending.lastWithdrawalRequestId),
              );
          const group =
            spending?.withdrawalRequestId ??
            journal.find((op) => op.operationId === spending?.withdrawalOperationId)
              ?.withdrawalRequestId;
          if (!group) {
            setLegacyRecovery(true);
            return;
          }
          if (saved && group !== saved.requestId) {
            setSelection(null);
            setReviewedPlan(undefined);
            setIntent(selected);
            return;
          }
        }
        if (saved) {
          const finished = (part: WithdrawalPortion) =>
            rows.some(
              (row) =>
                withdrawalPortionKey(row) === withdrawalPortionKey(part) &&
                row.cycleIndex === part.cycleIndex &&
                (row.completedWithdrawalRequestIds?.includes(saved.requestId) ||
                  (row.lastWithdrawalRequestId === saved.requestId &&
                    row.withdrawalComplete === true)),
            );
          const done = saved.portions.filter(finished).length;
          setCompleted(done);
          if (done === saved.portions.length) {
            if (activeRequest.current === saved.requestId) {
              setSelection(saved);
              setComplete(true);
              return;
            }
            await withdrawalSelectionStore.clear(walletId);
          } else {
            activeRequest.current = saved.requestId;
            setSelection(saved);
            const pending = rows.find(pendingWithdrawal);
            const next =
              saved.portions.find(
                (part) =>
                  pending &&
                  withdrawalPortionKey(part) === withdrawalPortionKey(pending) &&
                  !finished(part),
              ) ?? saved.portions.find((part) => !finished(part))!;
            const row = rows.find(
              (row) =>
                withdrawalPortionKey(row) === withdrawalPortionKey(next) &&
                row.cycleIndex === next.cycleIndex,
            );
            if (!row || row.recoveryRequired)
              throw new Error(
                "The saved withdrawal portion needs native recovery before continuing.",
              );
            const selected = await selectPosition(row);
            if (alive()) {
              setPortion(next);
              setIntent(selected);
            }
            return;
          }
        }
        setSelection(null);
        setCompleted(0);
        // Native pending work wins over a new amount, including recovery without UI storage.
        const pending = rows.find(pendingWithdrawal);
        if (pending) {
          const selected = await selectPosition(pending);
          const journal = await robinhood.list(selected);
          if (!alive()) return;
          if (journal.some((op) => op.withdrawalRequestId || op.withdrawalOperationId))
            setIntent(selected);
          else setLegacyRecovery(true);
          return;
        }
        const invested = rows.filter((row) => row.activity === "invested" && !row.recoveryRequired);
        if (!invested.length) {
          setCapacities([]);
          return;
        }
        const intents: EarnIntent[] = [];
        for (const row of invested) {
          intents.push(await selectPosition(row));
          if (!alive()) return;
        }
        if (!robinhood.withdrawalBalances)
          throw new Error("Update Gizu to choose a withdrawal amount.");
        const balances = await robinhood.withdrawalBalances(intents, controller.signal);
        if (!alive()) return;
        setCapacities(
          invested.map((row, index) => {
            const owner = investmentDestination(intents[index]!).address;
            const balance = balances.find(
              (balance) => balance.owner.toLowerCase() === owner.toLowerCase(),
            );
            if (!balance)
              throw new Error("A withdrawal balance is unavailable. Refresh the vault.");
            return {
              intentId: row.intentId,
              cycleIndex: row.cycleIndex,
              investmentSlot: row.investmentSlot,
              assetsAtoms: balance.assetsAtoms,
              afterReturnOperationId: row.lastReturnOperationId,
            };
          }),
        );
      } catch (error) {
        if (alive())
          setMessage(
            error instanceof Error ? error.message : "Withdrawal amounts could not be checked.",
          );
      } finally {
        if (alive()) setLoading(false);
        release();
      }
    },
    [investmentPositions, selectPosition, robinhood, walletId, session.address, release],
  );
  const invalidateLoad = useCallback(() => {
    generation.current++;
    queuedLoad.current = null;
    active.current?.abort();
  }, []);
  useEffect(() => {
    if (!earnLoading) void load();
    return invalidateLoad;
  }, [load, earnLoading, invalidateLoad]);
  const total = capacities.reduce((sum, row) => sum + BigInt(row.assetsAtoms), 0n).toString();
  const review = async () => {
    if (occupied.current) return;
    occupied.current = true;
    setLoading(true);
    setMessage("");
    const attempt = ++generation.current,
      controller = new AbortController();
    active.current = controller;
    let saved = false;
    let firstPlan: RobinhoodPlan | undefined;
    try {
      const match = amount
        .trim()
        .replace(",", ".")
        .match(/^(0|[1-9][0-9]{0,31})(?:\.([0-9]{1,6}))?$/);
      if (!match) throw new Error("Enter a USDG amount with up to 6 decimal places.");
      const atoms = (
        BigInt(match[1]!) * 1000000n +
        BigInt((match[2] ?? "").padEnd(6, "0"))
      ).toString();
      const portions = allocateWithdrawal(atoms, capacities);
      const requestId = `withdraw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const request: WithdrawalSelection = {
        version: 1,
        walletId,
        profileId: "robinhood-usdg",
        requestId,
        amountAtoms: atoms,
        portions,
      };
      const rows = await investmentPositions.list(owner);
      if (rows.some((row) => row.profileId === "robinhood-usdg" && pendingWithdrawal(row)))
        throw new Error(
          "A saved withdrawal is already in progress. Refresh to continue it before choosing another amount.",
        );
      // Check every portion and private routing feasibility before the first spending approval.
      for (const part of portions) {
        if (controller.signal.aborted) throw new Error("Withdrawal review stopped.");
        const row = rows.find(
          (row) =>
            withdrawalPortionKey(row) === withdrawalPortionKey(part) &&
            row.cycleIndex === part.cycleIndex,
        );
        if (!row || row.recoveryRequired)
          throw new Error("Investment selection changed. Refresh before withdrawing.");
        const selected = await selectPosition(row);
        const plan = await robinhood.plan(selected, "hoodRedeemAll", controller.signal, {
          withdrawalRequestId: requestId,
          requestedWithdrawalAtoms: part.amountAtoms,
          ...(part.allShares ? { withdrawAllShares: true as const } : {}),
        });
        firstPlan ??= plan;
      }
      if (attempt !== generation.current || controller.signal.aborted) return;
      const latest = await investmentPositions.list(owner);
      if (latest.some((row) => row.profileId === "robinhood-usdg" && pendingWithdrawal(row)))
        throw new Error("Saved withdrawal activity changed. Refresh before approving.");
      await withdrawalSelectionStore.save(request);
      if (attempt !== generation.current || controller.signal.aborted) return;
      activeRequest.current = requestId;
      saved = true;
    } catch (error) {
      if (attempt === generation.current)
        setMessage(
          error instanceof Error ? error.message : "The requested amount could not be reviewed.",
        );
    } finally {
      if (attempt === generation.current) {
        setLoading(false);
        if (saved) queuedLoad.current = () => load(firstPlan);
      }
      release();
    }
  };
  const chooseAnother = async () => {
    if (occupied.current) return;
    occupied.current = true;
    setLoading(true);
    setMessage("");
    const attempt = ++generation.current,
      controller = new AbortController();
    active.current = controller;
    const alive = () => attempt === generation.current && !controller.signal.aborted;
    let cleared = false;
    try {
      const rows = await investmentPositions.list(owner);
      for (const part of selection?.portions ?? []) {
        const row = rows.find((row) => withdrawalPortionKey(row) === withdrawalPortionKey(part));
        if (!row) throw new Error("Saved investment is unavailable.");
        if (
          row.completedWithdrawalRequestIds?.includes(selection!.requestId) ||
          (row.lastWithdrawalRequestId === selection!.requestId && row.withdrawalComplete)
        )
          continue;
        const selected = await selectPosition(row),
          journal = await robinhood.list(selected);
        if (!alive()) return;
        for (const op of journal.filter(
          (op) =>
            op.withdrawalRequestId === selection?.requestId &&
            !["cancelled", "reverted", "expired", "nonceCancelled"].includes(op.status),
        )) {
          if (op.userOperationHash || !(op.canCancelPreparation ?? op.status === "planned"))
            throw new Error("Finish the saved withdrawal before choosing another amount.");
          const canceled = await robinhood.cancelUnsigned(selected, op);
          if (!alive()) return;
          if (canceled.status !== "cancelled" || canceled.blocked)
            throw new Error("The existing review could not be canceled safely.");
        }
      }
      if (!alive()) return;
      await withdrawalSelectionStore.clear(walletId);
      if (!alive()) return;
      activeRequest.current = null;
      setSelection(null);
      cleared = true;
    } catch (error) {
      if (alive())
        setMessage(
          error instanceof Error ? error.message : "Saved withdrawal could not be checked.",
        );
    } finally {
      if (alive()) {
        setLoading(false);
        if (cleared) queuedLoad.current = () => load();
      }
      release();
    }
  };
  const finish = () => {
    if (selection) void load();
    else {
      setIntent(null);
      setComplete(true);
    }
  };
  return {
    amount,
    setAmount,
    total,
    selection,
    portion,
    intent,
    reviewedPlan,
    legacyRecovery,
    finish,
    complete,
    completed,
    loading: loading || earnLoading,
    message,
    review,
    refresh: load,
    chooseAnother,
  };
}
