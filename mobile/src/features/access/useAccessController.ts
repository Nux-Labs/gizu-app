import { WalletUnavailableError } from "@/services/wallet/nativeBridge";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/application/SessionProvider";
import { AccessRejectedError, type LocalWalletStatus } from "@/services/access";
type AccessViewModel = {
  pending: boolean;
  error: string | null;
  start: () => Promise<void>;
  restore: () => Promise<void>;
  canRestore: boolean;
  /** Null while unknown or when the access service has no local wallet. */
  localWallet: LocalWalletStatus | null;
  cancel: () => void;
};

export function useAccessController(): AccessViewModel {
  const { accessService, signIn } = useSession();
  const attempt = useRef(0);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localWallet, setLocalWallet] = useState<LocalWalletStatus | null>(null);
  // Bumped after every attempt: a fast failure can batch pending true/false into one render.
  const [attempts, setAttempts] = useState(0);
  // Native restore never replaces a readable wallet, so only offer it when it can proceed.
  const canRestore =
    typeof accessService.restore === "function" &&
    (localWallet === "absent" || localWallet === "unreadable");
  useEffect(() => {
    let current = true;
    if (!pending)
      accessService
        .localWallet?.()
        .then((value) => {
          if (current) setLocalWallet(value);
        })
        .catch(() => {
          if (current) setLocalWallet(null);
        });
    return () => {
      current = false;
    };
  }, [accessService, pending, attempts]);
  useEffect(
    () => () => {
      attempt.current += 1;
      if (inFlight.current) accessService.cancel?.();
      inFlight.current = false;
    },
    [accessService],
  );
  function cancel() {
    accessService.cancel?.();
    attempt.current += 1;
    inFlight.current = false;
    setPending(false);
    setError(null);
    setAttempts((value) => value + 1);
  }
  async function start(restoring = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++attempt.current;
    setPending(true);
    setError(null);
    try {
      const session =
        restoring && accessService.restore
          ? await accessService.restore()
          : await accessService.request(accessService.method ?? "Demo passkey");
      if (id === attempt.current) {
        // Successful navigation unmounts Welcome. Its cleanup must not revoke
        // the native read-only permission granted by this completed login.
        inFlight.current = false;
        signIn(session);
      }
    } catch (cause) {
      if (id === attempt.current)
        setError(
          cause instanceof WalletUnavailableError
            ? cause.message
            : cause instanceof AccessRejectedError
              ? "Access was rejected. You can try again."
              : accessService.method === "Passkey"
                ? passkeyErrorMessage(cause)
                : "Access failed. Please try again.",
        );
    } finally {
      if (id === attempt.current) {
        inFlight.current = false;
        setPending(false);
        setAttempts((value) => value + 1);
      }
    }
  }
  return { pending, error, start, cancel, canRestore, localWallet, restore: () => start(true) };
}

function passkeyErrorMessage(cause: unknown): string {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  switch (code) {
    case "WALLET_CANCELLED":
      return "Wallet access was cancelled. Continue when you are ready to try again.";
    case "WALLET_TIMEOUT":
      return "Wallet access timed out. Keep the app open and try again. Any saved wallet is retained.";
    case "BUSY":
      return "Another wallet operation is still closing or in progress. Wait a moment, then try again.";
    case "PASSKEY_FAILED":
      return "Apple could not complete the passkey request. Try again. If it keeps failing, contact support with your app version and the step where it stopped.";
    case "UNAVAILABLE":
      return "Wallet access is unavailable right now. Bring the app to the foreground and try again.";
    case "WALLET_EXISTS":
      return "This device already has a wallet, so no restore is needed. Unlock it with your passkey.";
    default:
      return "Wallet access or backup was not completed. Continue to retry the same wallet. If local storage cannot be read, restore your backup with the original passkey.";
  }
}
