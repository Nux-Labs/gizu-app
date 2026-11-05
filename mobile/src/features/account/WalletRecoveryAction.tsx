import { TextInput, View } from "react-native";
import { recoveryScanBound, type WalletRecoveryService } from "@/domain/wallet/recovery";
import { Surface } from "@/components/molecules/Surface";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { useWalletRecovery } from "./useWalletRecovery";

export function WalletRecoveryAction({
  walletId,
  service,
}: {
  walletId: string;
  service?: WalletRecoveryService;
}) {
  const v = useWalletRecovery(walletId, service),
    row = v.status,
    bound = recoveryScanBound(v.bound),
    disabled = v.running || v.cancelling || !v.capabilities.recovery;
  return (
    <Surface>
      <View className="gap-4 p-5">
        <Typography variant="section" accessibilityRole="header">
          Wallet discovery and recovery
        </Typography>
        <Typography>
          Keep your encrypted backup file and original passkey. Synced recovery metadata helps
          restore wallets created after that file was saved.
        </Typography>
        {v.loading ? (
          <Typography>Checking wallet recovery…</Typography>
        ) : (
          <>
            {!v.capabilities.recovery && (
              <Typography>
                Wallet recovery requires an updated native app with recovery support.
              </Typography>
            )}
            {row?.synced && (
              <Typography>Recovery metadata synced · revision {row.revision}</Typography>
            )}
            {row && !row.synced && <Typography>Recovery metadata needs syncing.</Typography>}
            {row?.recoveryRequired && (
              <Typography>
                Saved activity requires verified reconciliation before spending. Discovery never
                submits a transaction.
              </Typography>
            )}
            {row?.phase === "error" && !v.message && (
              <Typography accessibilityRole="alert">
                Recovery could not finish. Check saved progress and try again.
              </Typography>
            )}
            {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
            <Button
              label="Sync encrypted recovery"
              disabled={disabled}
              onPress={() => void v.sync()}
            />
            <Button
              label="Restore saved wallet catalogue"
              variant="secondary"
              disabled={disabled}
              onPress={() => void v.restore()}
            />
            <Typography variant="row">Read-only wallet discovery</Typography>
            <Typography variant="caption">
              Choose the last deposit cycle to check, including that cycle. Reaching this bound does
              not prove that no later wallets exist. Empty wallets do not prove an unused index.
            </Typography>
            <TextInput
              accessibilityLabel="Last deposit cycle to scan"
              keyboardType="number-pad"
              value={v.bound}
              onChangeText={v.setBound}
              editable={!v.running && !v.cancelling}
              className="min-h-14 rounded-xl bg-well px-4 py-3 text-text"
            />
            {row && row.scanTargetCycle >= 0 && (
              <Typography>
                Scanned through cycle {row.scannedThroughCycle} of {row.scanTargetCycle} ·{" "}
                {row.discoveredWallets} wallets with activity
              </Typography>
            )}
            {!v.capabilities.discovery && v.capabilities.recovery && (
              <Typography>This native build does not support wallet discovery.</Typography>
            )}
            <Button
              label="Scan for wallets"
              disabled={
                disabled ||
                !v.capabilities.discovery ||
                bound === null ||
                (row !== null && bound !== null && bound < row.scannedThroughCycle)
              }
              onPress={() => {
                if (bound !== null) void v.discover(bound);
              }}
            />
            {v.scanRunning && (
              <Button
                label="Pause wallet discovery"
                variant="secondary"
                disabled={v.cancelling}
                onPress={() => void v.cancel()}
              />
            )}
            {v.capabilities.recovery && (
              <Button
                label="Check recovery progress"
                variant="secondary"
                disabled={v.cancelling}
                onPress={() => void v.refresh()}
              />
            )}
          </>
        )}
      </View>
    </Surface>
  );
}
