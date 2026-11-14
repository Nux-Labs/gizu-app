import { TextInput, View } from "react-native";
import { recoveryScanBound, type WalletRecoveryService } from "@/domain/wallet/recovery";
import { Surface } from "@/components/molecules/Surface";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { useWalletRecovery } from "./useWalletRecovery";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { ShieldCheck } from "lucide-react-native";
import colors from "@/theme/colors.json";

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
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-2xl bg-neon/10">
            <ShieldCheck size={22} color={colors.accent} />
          </View>
          <View className="flex-1 gap-1">
            <Typography variant="cardTitle" accessibilityRole="header">
              Wallet recovery
            </Typography>
            <Typography variant="micro">
              Keep your encrypted backup file and original passkey.
            </Typography>
          </View>
        </View>
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
              <Typography variant="micro">
                Recovery metadata synced · revision {row.revision}
              </Typography>
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
              label="Restore saved wallet catalogue"
              disabled={disabled}
              onPress={() => void v.restore()}
            />
            <Button
              label="Sync encrypted recovery"
              variant="secondary"
              disabled={disabled}
              onPress={() => void v.sync()}
            />
            <HoldingDetails
              label="Find missing wallets"
              accessibilityLabel="Wallet discovery options"
            >
              <Typography variant="caption">
                Read-only discovery · Last deposit cycle to check
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
              <Typography variant="micro">
                Reaching this bound does not prove that no later wallets exist. Empty wallets do not
                prove an unused index.
              </Typography>
            </HoldingDetails>
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
