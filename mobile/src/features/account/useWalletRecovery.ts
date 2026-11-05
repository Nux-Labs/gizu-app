import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  WalletRecoveryService,
  WalletRecoveryStatus,
  WalletRecoveryCapabilities,
} from "@/domain/wallet/recovery";
import { createWalletRecoveryService } from "@/services/wallet/recovery";

const unavailable = "Wallet recovery is unavailable. Check your connection and try again.";
const recoveryCopy: Record<string, string> = {
  conflict: "Recovery metadata changed. Restore the saved wallet catalogue before syncing again.",
  rollback:
    "An older recovery revision was returned. Recovery is paused; keep your verified backup.",
  tampered:
    "Recovery data could not be authenticated. Use your verified backup before approving new funding.",
  reconciliationRequired: "Saved activity requires verified reconciliation before spending.",
  storageUnavailable:
    "Recovery data could not be saved. New funding stays paused until storage is available.",
};
type Action = "sync" | "restore" | "discover" | null;
export function useWalletRecovery(walletId: string, injected?: WalletRecoveryService) {
  const service = useMemo(() => injected ?? createWalletRecoveryService(), [injected]);
  const [status, setStatus] = useState<WalletRecoveryStatus | null>(null);
  const [capabilities, setCapabilities] = useState<WalletRecoveryCapabilities>({
    recovery: false,
    discovery: false,
  });
  const [loading, setLoading] = useState(true),
    [action, setAction] = useState<Action>(null),
    [cancelling, setCancelling] = useState(false),
    [message, setMessage] = useState("");
  const [bound, setBound] = useState("256");
  const generation = useRef(0),
    occupied = useRef(false),
    discovering = useRef(false),
    read = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
    read.current++;
  }, []);
  const accept = useCallback((next: WalletRecoveryStatus) => {
    setStatus((old) =>
      old &&
      (old.revision > next.revision ||
        (old.revision === next.revision &&
          old.scanTargetCycle === next.scanTargetCycle &&
          old.scannedThroughCycle > next.scannedThroughCycle))
        ? old
        : next,
    );
  }, []);
  const failed = useCallback(
    async (attempt: number) => {
      if (attempt !== generation.current) return;
      let text = unavailable;
      try {
        const next = await service.status(walletId);
        if (attempt !== generation.current) return;
        accept(next);
        text = recoveryCopy[next.messageCode ?? ""] ?? unavailable;
      } catch {
        /* Provider payloads are never shown or logged. */
      }
      if (attempt === generation.current) setMessage(text);
    },
    [service, walletId, accept],
  );
  useEffect(() => {
    const attempt = ++generation.current;
    occupied.current = false;
    discovering.current = false;
    void Promise.resolve()
      .then(() => {
        if (attempt !== generation.current) return null;
        setLoading(true);
        setStatus(null);
        setAction(null);
        setCancelling(false);
        setMessage("");
        setBound("256");
        return service.available();
      })
      .then(async (caps) => {
        if (!caps) return;
        if (attempt !== generation.current) return;
        setCapabilities(caps);
        if (caps.recovery) {
          const next = await service.status(walletId);
          if (attempt !== generation.current) return;
          accept(next);
          if (next.scanTargetCycle >= 0) setBound(String(next.scanTargetCycle));
        }
      })
      .catch(() => {
        if (attempt === generation.current) setMessage(unavailable);
      })
      .finally(() => {
        if (attempt === generation.current) setLoading(false);
      });
    return () => {
      invalidate();
      if (discovering.current) void service.cancel(walletId).catch(() => undefined);
    };
  }, [walletId, service, accept, invalidate]);
  const refresh = useCallback(async () => {
    const attempt = generation.current,
      sequence = ++read.current;
    try {
      const next = await service.status(walletId);
      if (attempt === generation.current && sequence === read.current) accept(next);
    } catch {
      if (attempt === generation.current && sequence === read.current) setMessage(unavailable);
    }
  }, [service, walletId, accept]);
  const running =
    action !== null || ["syncing", "restoring", "discovering"].includes(status?.phase ?? "");
  const scanRunning = action === "discover" || status?.phase === "discovering";
  useEffect(() => {
    discovering.current = scanRunning;
    if (!running || !capabilities.recovery) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [running, scanRunning, capabilities.recovery, refresh]);
  async function run(kind: Exclude<Action, null>, throughCycle?: number) {
    if (
      occupied.current ||
      running ||
      loading ||
      !capabilities.recovery ||
      (kind === "discover" && !capabilities.discovery)
    )
      return;
    occupied.current = true;
    const attempt = ++generation.current;
    read.current++;
    setMessage("");
    setAction(kind);
    discovering.current = kind === "discover";
    try {
      if (kind === "discover") {
        let previous = -2;
        while (attempt === generation.current) {
          const next = await service.discover(walletId, throughCycle!);
          if (attempt !== generation.current) break;
          accept(next);
          if (
            next.phase !== "paused" ||
            next.messageCode !== "scanIncomplete" ||
            next.scannedThroughCycle >= throughCycle!
          )
            break;
          if (next.scannedThroughCycle <= previous) throw new Error("Discovery did not advance.");
          previous = next.scannedThroughCycle;
        }
      } else {
        const next =
          kind === "sync" ? await service.sync(walletId) : await service.restore(walletId);
        if (attempt === generation.current) accept(next);
      }
    } catch {
      await failed(attempt);
    } finally {
      if (attempt === generation.current) {
        occupied.current = false;
        setAction(null);
      }
    }
  }
  const cancel = useCallback(async () => {
    if (cancelling || !capabilities.discovery) return;
    const attempt = ++generation.current;
    read.current++;
    setCancelling(true);
    setMessage("");
    try {
      const next = await service.cancel(walletId);
      if (attempt === generation.current) {
        accept(next);
        discovering.current = false;
      }
    } catch {
      await failed(attempt);
    } finally {
      if (attempt === generation.current) {
        occupied.current = false;
        setAction(null);
        setCancelling(false);
      }
    }
  }, [cancelling, capabilities.discovery, service, walletId, accept, failed]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && discovering.current) void cancel();
    });
    return () => subscription.remove();
  }, [cancel]);
  return {
    status,
    capabilities,
    loading,
    running,
    scanRunning,
    cancelling,
    message,
    bound,
    setBound,
    sync: () => run("sync"),
    restore: () => run("restore"),
    discover: (throughCycle: number) => run("discover", throughCycle),
    cancel,
    refresh,
  };
}
