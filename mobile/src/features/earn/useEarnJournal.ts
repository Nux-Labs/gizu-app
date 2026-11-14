import { useCallback, useEffect, useRef, useState } from "react";
import type { EarnIntent } from "@/domain/earn/types";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
type JournalService<Row> = {
  available(): Promise<boolean>;
  list(intent: EarnIntent): Promise<Row[]>;
  cancel(): void;
};
/** Ignore late results while retaining native authority for explicit reconciliation. */
export function useEarnJournal<Row extends { operationId: string }>(
  intent: EarnIntent,
  service: JournalService<Row>,
) {
  const portfolio = useOptionalMainnetWallet();
  const [rows, setRows] = useState<Row[]>([]),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    occupied = useRef(false),
    controller = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const attempt = generation.current;
    try {
      const enabled = await service.available();
      if (attempt !== generation.current) return;
      setAvailable(enabled);
      if (enabled) {
        const next = await service.list(intent);
        if (attempt === generation.current) setRows(next);
      }
    } catch (error) {
      if (attempt === generation.current)
        setMessage(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Saved Earn progress is unavailable. Please try again.",
        );
    } finally {
      if (attempt === generation.current) setLoading(false);
    }
  }, [intent, service]);
  useEffect(() => {
    const attempt = ++generation.current;
    void Promise.resolve().then(() => {
      if (generation.current === attempt) return reload();
    });
    return () => {
      generation.current = attempt + 1;
      controller.current?.abort();
      service.cancel();
    };
  }, [reload, service]);
  async function perform<T>(
    task: (signal: AbortSignal) => Promise<T>,
    accept: (result: T) => void,
    refreshPortfolio = true,
  ) {
    if (occupied.current) return;
    occupied.current = true;
    const attempt = generation.current,
      abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMessage("");
    try {
      const result = await task(abort.signal);
      if (attempt === generation.current) accept(result);
    } catch (error) {
      if (attempt === generation.current) {
        await reload();
        if (attempt === generation.current)
          setMessage(
            error instanceof Error && error.message.trim()
              ? error.message
              : "We could not complete this step. Check your connection and try again. Your saved progress will be checked before continuing.",
          );
      }
    } finally {
      occupied.current = false;
      if (attempt === generation.current) {
        setBusy(false);
      }
      if (refreshPortfolio) void portfolio?.refreshAfterAction();
    }
  }
  const update = (row: Row) =>
    setRows((old) => [...old.filter((r) => r.operationId !== row.operationId), row]);
  return {
    rows,
    available,
    loading,
    busy,
    message,
    perform,
    update,
    refresh: () => perform(() => service.list(intent), setRows),
  };
}
