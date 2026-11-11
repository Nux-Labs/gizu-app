import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  canConfirmDeposit,
  type DepositPauseCode,
  type DepositSnapshot,
} from "@/domain/earn/depositJourney";
import type { EarnProfileId } from "@/domain/earn/types";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { useEarn } from "./EarnProvider";
import { formatUsdc } from "@/domain/wallet/amounts";
import { useDepositFundingBalance } from "./useDepositFundingBalance";
export const depositPauseCopy: Record<DepositPauseCode, string> = {
  quoteUnavailable: "The route is unavailable. Review again when the provider recovers.",
  previewUnavailable: "A fresh fee estimate is unavailable. No new spending can be approved.",
  sponsorshipUnavailable:
    "Gas sponsorship is unavailable. Saved transactions remain tracked; review the remaining steps to retry.",
  insufficientFunds: "Your available USDC does not cover this budget and gas.",
  uneconomicAmount: "This amount is too small to cover routing, gas and the withdrawal reserve.",
  termsChanged:
    "The live terms changed. Saved transactions remain tracked; review the remaining limits before continuing.",
  approvalExpired: "Approval ended. Review the remaining steps to continue.",
  settlementPending: "Waiting for verified confidential credit. Funds will not be paid out early.",
  submissionUnknown:
    "A submitted transaction needs verification. Check saved progress before retrying.",
  recoveryRequired: "Saved activity needs recovery before another deposit can be approved.",
  unsupportedCapability: "This build does not support this deposit. Update the native app.",
  cancelled: "Approval stopped. Submitted transactions remain tracked.",
};
export function depositBudgetAtoms(text: string): string | null {
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const atoms = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return atoms > 10000n ? atoms.toString() : null;
}
const running = ["authorizing", "funding", "settlingCredit", "payouts", "depositing"];
export function useDepositJourney(profileId: EarnProfileId, savedJourneyId?: string) {
  const isFocused = useIsFocused();
  const wallet = useFundingWallet(),
    { depositJourney: service } = useEarn();
  const owner = useMemo(
    () => ({ walletId: wallet.session.walletId ?? "", address: wallet.session.address }),
    [wallet.session.walletId, wallet.session.address],
  );
  const funding = useDepositFundingBalance(service, owner, isFocused, wallet);
  const [amount, setAmountText] = useState(""),
    [snapshot, setSnapshot] = useState<DepositSnapshot | null>(null),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [preparingReview, setPreparingReview] = useState(false),
    [message, setMessage] = useState(""),
    [details, setDetails] = useState(false),
    [clock, setClock] = useState(() => Date.now()),
    [authorizing, setAuthorizing] = useState(false);
  const saved = useRef<DepositSnapshot | null>(null),
    request = useRef(0),
    mounted = useRef(false),
    occupied = useRef(false),
    foreground = useRef(true),
    started = useRef(0),
    epoch = useRef(0),
    ceremony = useRef(false);
  const focused = useRef(isFocused);
  const preparingBudgetRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    focused.current = isFocused;
  }, [isFocused]);
  const accept = useCallback(
    (next: DepositSnapshot) => {
      if (next.profileId !== profileId)
        throw new Error("The saved deposit belongs to a different vault.");
      saved.current = next;
      if (next.distribution) setAmountText(formatUsdc(next.budgetAtoms));
      if (next.phase === "review") setClock(Date.now());
      setSnapshot((old) =>
        old && old.journeyId === next.journeyId && old.revision > next.revision ? old : next,
      );
    },
    [profileId],
  );
  const revoke = useCallback(() => {
    const row = saved.current,
      lifecycleEpoch = epoch.current;
    // Failed preparation has no spending authority left to revoke. Cancelling it
    // on blur/unmount would overwrite the useful failure with "cancelled".
    if (
      !occupied.current &&
      row?.phase === "paused" &&
      !row.review &&
      row.completedSteps.length === 0 &&
      row.creditedAtoms === "0"
    )
      return;
    if (row && row.phase !== "invested")
      void service
        .cancel(owner, row.journeyId, row.revision)
        .then((next) => {
          if (mounted.current && epoch.current === lifecycleEpoch) accept(next);
        })
        .catch(() => {
          if (mounted.current)
            setMessage("Approval stopped. Check saved progress before continuing.");
        });
    else if (!row && preparingBudgetRef.current) {
      const budget = preparingBudgetRef.current;
      void service
        .status(owner, "current-deposit")
        .then((next) => {
          if (
            next.phase === "preparing" &&
            next.profileId === profileId &&
            next.budgetAtoms === budget
          )
            return service.cancel(owner, next.journeyId, next.revision);
        })
        .catch(() => undefined);
    }
  }, [service, owner, accept, profileId]);
  useEffect(() => {
    const lifecycleEpoch = ++epoch.current;
    saved.current = null;
    mounted.current = true;
    foreground.current = AppState.currentState !== "background";
    started.current = Date.now();
    const attempt = ++request.current;
    void Promise.resolve()
      .then(() => {
        if (epoch.current !== lifecycleEpoch) return false;
        setSnapshot(null);
        setAmountText("");
        setLoading(true);
        setAuthorizing(false);
        setPreparingReview(false);
        return service.available();
      })
      .then(async (enabled) => {
        if (!mounted.current || attempt !== request.current) return;
        setAvailable(enabled);
        if (enabled && savedJourneyId) {
          const next = await service.status(owner, savedJourneyId);
          if (mounted.current && attempt === request.current) accept(next);
        }
      })
      .catch((error) => {
        if (mounted.current && attempt === request.current)
          setMessage(error instanceof Error ? error.message : "Deposit unavailable.");
      })
      .finally(() => {
        if (mounted.current && attempt === request.current) setLoading(false);
      });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        foreground.current = false;
        if (!ceremony.current) {
          ++request.current;
          revoke();
        }
      } else if (state === "active") {
        foreground.current = true;
        setClock(Date.now());
      }
    });
    return () => {
      mounted.current = false;
      epoch.current = lifecycleEpoch + 1;
      request.current = attempt + 1;
      subscription.remove();
      revoke();
    };
  }, [service, owner, savedJourneyId, accept, revoke]);
  useEffect(() => {
    if (!isFocused) {
      ++request.current;
      revoke();
    }
  }, [isFocused, revoke]);
  const journeyId = snapshot?.journeyId,
    phase = snapshot?.phase,
    pauseReason = snapshot?.pauseReason,
    expiresAtMs = snapshot?.review?.expiresAtMs;
  useEffect(() => {
    if (!isFocused || !journeyId || phase === "invested" || !foreground.current) return;
    if (phase === "review" && (expiresAtMs ?? 0) > Date.now()) {
      const timer = setTimeout(
        () => setClock(Date.now()),
        Math.max(1, (expiresAtMs ?? Date.now()) - Date.now()),
      );
      return () => clearTimeout(timer);
    }
    if (
      !running.includes(phase ?? "") &&
      !(
        phase === "paused" && ["settlementPending", "submissionUnknown"].includes(pauseReason ?? "")
      )
    )
      return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      count = 0;
    async function poll() {
      if (disposed || !foreground.current || Date.now() - started.current >= 900000) return;
      try {
        const next = await service.status(owner, journeyId!);
        if (!disposed && mounted.current) accept(next);
      } catch {
        if (!disposed && mounted.current)
          setMessage("Could not check saved progress. Submitted funds remain tracked.");
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          [2000, 4000, 8000, 16000, 30000][Math.min(count++, 4)]!,
        );
    }
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [journeyId, phase, pauseReason, expiresAtMs, service, owner, accept, clock, isFocused]);
  const perform = async (task: () => Promise<DepositSnapshot>, preparingBudget?: string) => {
    if (occupied.current || !foreground.current || !isFocused) return;
    occupied.current = true;
    setBusy(true);
    setPreparingReview(!!preparingBudget);
    setMessage("");
    const attempt = ++request.current,
      sessionEpoch = epoch.current;
    preparingBudgetRef.current = preparingBudget ?? null;
    let preparing = !!preparingBudget,
      timer: ReturnType<typeof setTimeout> | undefined,
      polls = 0;
    const pollPreparation = async () => {
      if (
        !preparing ||
        !mounted.current ||
        !foreground.current ||
        !focused.current ||
        attempt !== request.current ||
        sessionEpoch !== epoch.current
      )
        return;
      try {
        const next = await service.status(owner, saved.current?.journeyId ?? "current-deposit");
        if (
          preparing &&
          mounted.current &&
          foreground.current &&
          focused.current &&
          attempt === request.current &&
          sessionEpoch === epoch.current &&
          next.budgetAtoms === preparingBudget &&
          ["preparing", "review"].includes(next.phase)
        )
          accept(next);
      } catch {
        // The native draft may not exist yet; preparation owns its eventual result/error.
      }
      if (preparing)
        timer = setTimeout(() => void pollPreparation(), [1000, 2000, 4000][Math.min(polls++, 2)]!);
    };
    if (preparing) timer = setTimeout(() => void pollPreparation(), 1000);
    try {
      const next = await task();
      if (epoch.current !== sessionEpoch) {
        void service.cancel(owner, next.journeyId, next.revision).catch(() => undefined);
        return;
      }
      saved.current = next;
      if (mounted.current && foreground.current && isFocused && attempt === request.current)
        accept(next);
      else if (!mounted.current || !foreground.current || !focused.current)
        void service.cancel(owner, next.journeyId, next.revision).catch(() => undefined);
    } catch (error) {
      if (mounted.current && attempt === request.current) {
        setMessage(
          error instanceof Error ? error.message : "Deposit stopped. Check saved activity.",
        );
        try {
          const next = await service.status(owner, saved.current?.journeyId ?? "current-deposit");
          if (mounted.current && attempt === request.current) accept(next);
        } catch {
          /* no invented rollback */
        }
      }
    } finally {
      preparing = false;
      preparingBudgetRef.current = null;
      if (timer) clearTimeout(timer);
      occupied.current = false;
      if (mounted.current) {
        setPreparingReview(false);
        setBusy(false);
      }
    }
  };
  const atoms = depositBudgetAtoms(amount),
    editable =
      !authorizing &&
      (!snapshot ||
        ["draft", "review", "preparing"].includes(snapshot.phase) ||
        (snapshot.phase === "paused" &&
          !snapshot.completedSteps.length &&
          snapshot.creditedAtoms === "0" &&
          ([
            "previewUnavailable",
            "quoteUnavailable",
            "insufficientFunds",
            "uneconomicAmount",
          ].includes(snapshot.pauseReason ?? "") ||
            (!snapshot.review &&
              ["cancelled", "approvalExpired"].includes(snapshot.pauseReason ?? "")))));
  const canReview =
    available &&
    !loading &&
    !busy &&
    !!atoms &&
    editable &&
    !funding.loading &&
    !funding.error &&
    funding.balance !== null &&
    !!depositBudgetAtoms(funding.balance) &&
    BigInt(atoms ?? "0") <= BigInt(depositBudgetAtoms(funding.balance) ?? "0");
  return {
    amount,
    snapshot,
    available,
    loading,
    busy,
    preparing: preparingReview,
    message,
    details,
    setDetails,
    editable,
    canChangeAmount:
      editable &&
      !!snapshot?.distribution &&
      !!service.discardDraft &&
      snapshot.completedSteps.length === 0 &&
      snapshot.creditedAtoms === "0",
    changeAmount: async () => {
      const row = saved.current;
      if (
        !row?.distribution ||
        !service.discardDraft ||
        occupied.current ||
        !foreground.current ||
        !focused.current
      )
        return;
      occupied.current = true;
      setBusy(true);
      setMessage("");
      const attempt = ++request.current,
        sessionEpoch = epoch.current;
      try {
        await service.discardDraft(owner, row.journeyId);
        if (sessionEpoch === epoch.current && attempt === request.current) {
          saved.current = null;
          setSnapshot(null);
          setDetails(false);
        }
      } catch (error) {
        if (mounted.current && attempt === request.current)
          setMessage(
            error instanceof Error
              ? error.message
              : "Check saved deposit progress before changing the amount.",
          );
      } finally {
        occupied.current = false;
        if (mounted.current && attempt === request.current) setBusy(false);
      }
    },
    authorizing,
    setAmount: (text: string) => {
      if (!editable || saved.current?.distribution) return;
      ++request.current;
      setAmountText(text);
      setSnapshot(null);
      setMessage("");
    },
    canReview,
    canConfirm:
      !busy &&
      !!snapshot &&
      canConfirmDeposit(snapshot, clock) &&
      (savedJourneyId !== undefined || snapshot.budgetAtoms === atoms),
    review: async () => {
      if (!atoms || !canReview) return;
      // Preparation can renew read-only authentication in system credential UI.
      // Native lifecycle guards still cancel real departures and device locks.
      ceremony.current = true;
      try {
        await perform(
          () => service.prepare(owner, profileId, atoms, saved.current?.journeyId),
          atoms,
        );
      } finally {
        ceremony.current = false;
      }
    },
    confirm: async () => {
      if (
        !snapshot ||
        !canConfirmDeposit(snapshot, Date.now()) ||
        (savedJourneyId === undefined && snapshot.budgetAtoms !== atoms) ||
        occupied.current
      )
        return;
      ceremony.current = true;
      setAuthorizing(true);
      try {
        await perform(() => service.confirm(owner, snapshot.journeyId, snapshot.revision));
      } finally {
        ceremony.current = false;
        if (mounted.current) setAuthorizing(false);
      }
    },
    resume: async () => {
      if (!snapshot || occupied.current) return;
      ceremony.current = true;
      setAuthorizing(true);
      try {
        await perform(() => service.resume(owner, snapshot.journeyId, snapshot.revision));
      } finally {
        ceremony.current = false;
        if (mounted.current) setAuthorizing(false);
      }
    },
    cancel: () => {
      ++request.current;
      revoke();
    },
    refresh: () =>
      snapshot ? perform(() => service.status(owner, snapshot.journeyId)) : Promise.resolve(),
    balance: funding.balance,
    balanceLoading: funding.loading,
    balanceUnavailable: funding.error,
    balanceBreakdown: funding.breakdown,
    retryBalance: funding.retry,
  };
}
