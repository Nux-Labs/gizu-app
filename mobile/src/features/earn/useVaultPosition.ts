import { useCallback, useEffect, useRef, useState } from "react";
import type { EarnIntent, EarnProfileId } from "@/domain/earn/types";
import type {
  EarnInvestmentPosition,
  EarnInvestmentExitProof,
} from "@/domain/earn/investmentPositions";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { useEarn } from "./EarnProvider";

function positionKey(row: Pick<EarnInvestmentPosition, "intentId" | "investmentSlot">) {
  return `${row.intentId}:${row.investmentSlot ?? "legacy"}`;
}
export function useVaultPosition(profileId: EarnProfileId) {
  const { investmentPositions, selectPosition, loading: earnLoading } = useEarn();
  const { session } = useFundingWallet();
  const [rows, setRows] = useState<EarnInvestmentPosition[]>([]);
  const [intent, setIntent] = useState<EarnIntent | null>(null);
  const [proofs, setProofs] = useState<Record<string, number | "accepted">>({});
  const proofsRef = useRef<Record<string, number | "accepted">>({});
  const currentIntent = useRef<EarnIntent | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const selected = useRef<string | null>(null);
  const occupied = useRef(false);
  const generation = useRef(0);
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
  const refresh = useCallback(async () => {
    if (occupied.current) return;
    occupied.current = true;
    const attempt = generation.current;
    setLoading(true);
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
        .filter((row) => row.profileId === profileId)
        .sort(
          (a, b) =>
            a.cycleIndex - b.cycleIndex || (a.investmentSlot ?? -1) - (b.investmentSlot ?? -1),
        );
      if (attempt !== generation.current) return;
      setRows(positions);
      // A fresh check is consumed only on explicit progress review. Accepted
      // portions stay complete for this screen while their native activity is
      // still redeemed; later investment, uncertainty or recovery revokes them.
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
      const next = positions.find(
        (row) => row.activity !== "returned" && checked[positionKey(row)] !== "accepted",
      );
      if (!next) {
        selected.current = null;
        currentIntent.current = null;
        setIntent(null);
        return;
      }
      if (next.recoveryRequired) {
        setIntent(null);
        selected.current = null;
        throw new Error("Restore and reconcile saved activity before withdrawing.");
      }
      if (selected.current === positionKey(next)) return;
      const value = await selectPosition(next);
      if (attempt === generation.current) {
        selected.current = positionKey(next);
        currentIntent.current = value;
        setIntent(value);
      }
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
      if (attempt === generation.current) setLoading(false);
    }
  }, [investmentPositions, selectPosition, session.walletId, session.address, profileId]);
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
    };
  }, [refresh, earnLoading]);
  const completed = rows.filter(
    (row) =>
      row.activity === "returned" ||
      (row.activity === "redeemed" && proofs[positionKey(row)] === "accepted"),
  ).length;
  return {
    rows,
    intent,
    completed,
    // Presentation only. Refresh rechecks expiry before accepting this proof.
    readyToContinue: intent !== null && typeof proofs[positionKey(intent)] === "number",
    recordCompletion,
    loading: loading || earnLoading,
    message,
    refresh,
  };
}
