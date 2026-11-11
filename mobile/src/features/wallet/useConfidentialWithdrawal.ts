import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfidentialWithdrawal,
  ConfidentialWithdrawalService,
} from "@/domain/wallet/confidentialWithdrawal";

export function useConfidentialWithdrawal(
  service: ConfidentialWithdrawalService,
  refreshPortfolio: () => Promise<void>,
) {
  const [operation, setOperation] = useState<ConfidentialWithdrawal | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const occupied = useRef(false);
  const load = useCallback(async () => {
    const attempt = generation.current;
    setLoading(true);
    setMessage("");
    try {
      const supported = await service.available();
      if (attempt !== generation.current) return;
      setAvailable(supported);
      if (supported) {
        const result = await service.read();
        if (attempt === generation.current) setOperation(result);
      }
    } catch (error) {
      if (attempt === generation.current)
        setMessage(error instanceof Error ? error.message : "Saved withdrawal is unavailable.");
    } finally {
      if (attempt === generation.current) setLoading(false);
    }
  }, [service]);
  useEffect(() => {
    const attempt = ++generation.current;
    occupied.current = false;
    void Promise.resolve().then(() => {
      if (attempt === generation.current) {
        setOperation(null);
        setBusy(false);
        setAvailable(false);
        return load();
      }
    });
    return () => {
      generation.current = attempt + 1;
    };
  }, [load]);
  const perform = async (action: () => Promise<ConfidentialWithdrawal>) => {
    if (occupied.current) return;
    occupied.current = true;
    const attempt = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const result = await action();
      if (attempt === generation.current) {
        setOperation(result);
      }
    } catch (error) {
      if (attempt === generation.current) {
        // A plan/signature may have been saved before the native reply failed.
        // Read that operation rather than allocating replacement recipients.
        try {
          const saved = await service.read();
          if (attempt === generation.current) setOperation(saved);
        } catch {
          /* Keep the prior saved view and show the original action failure. */
        }
        if (attempt === generation.current)
          setMessage(
            error instanceof Error
              ? error.message
              : "Check saved withdrawal progress before retrying.",
          );
      }
    } finally {
      if (attempt === generation.current) {
        occupied.current = false;
        setBusy(false);
      }
      void refreshPortfolio();
    }
  };
  return { operation, available, loading, busy, message, load, perform };
}
