import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { BackupResult, BackupSteps } from "@/components/molecules/BackupSteps";
import { Surface } from "@/components/molecules/Surface";
import { getStoredSigner } from "@/services/wallet/nativeBridge";

type Outcome = "idle" | "verified" | "incomplete";

const steps = ["Save file", "Reopen & confirm passkey", "Done"] as const;
const messages: Record<Exclude<Outcome, "idle">, string> = {
  verified: "Backup saved and verified. Recovery requires this file and your original passkey.",
  incomplete:
    "Backup was not completed. Your existing wallet remains available. Try again when ready.",
};

/** Presentation for the native backup ceremony; native code owns files and passkey checks. */
export function WalletBackupAction() {
  const attempt = useRef(0);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  useEffect(
    () => () => {
      attempt.current++;
      if (running.current) {
        const signer = getStoredSigner();
        if (signer?.cancelWalletOperation) signer.cancelWalletOperation();
        else signer?.lock();
      }
    },
    [],
  );
  async function backup() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setOutcome("idle");
    const id = ++attempt.current;
    try {
      const state = await getStoredSigner()?.backupWallet();
      if (state?.status !== "ready") throw new Error("Backup incomplete");
      if (attempt.current === id) setOutcome("verified");
    } catch {
      if (attempt.current === id) setOutcome("incomplete");
    } finally {
      if (attempt.current === id) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Surface>
      <View className="gap-5 p-5">
        <Typography variant="section" accessibilityRole="header">
          Wallet backup
        </Typography>
        <View className="gap-5">
          <Typography variant="caption">
            Recovery needs both the encrypted file and your original passkey.
          </Typography>
          <BackupSteps steps={steps} completed={outcome === "verified"} />
          {outcome !== "idle" && (
            <BackupResult message={messages[outcome]} failed={outcome === "incomplete"} />
          )}
          <Button
            label="Save and verify wallet backup"
            disabled={busy}
            loading={busy}
            onPress={() => void backup()}
          />
        </View>
      </View>
    </Surface>
  );
}
