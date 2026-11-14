import type { ReactNode } from "react";
import { useState } from "react";
import { TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/navigation/types";
import { BackAction } from "@/navigation/BackAction";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { formatUsdc } from "@/domain/wallet/amounts";
import { portfolioVaultPosition, portfolioAssetAmount } from "@/domain/wallet/portfolioValue";
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { PrivateBalanceRefresh } from "@/features/wallet/PrivateBalanceRefresh";
import { useEarn } from "./EarnProvider";
import { WithdrawalLadder } from "./WithdrawalLadder";
import { RobinhoodWithdrawalPanel } from "./RobinhoodWithdrawalPanel";
import { useRequestedWithdrawal } from "./useRequestedWithdrawal";
import colors from "@/theme/colors.json";

export function RequestedVaultWithdrawalScreen({
  navigation,
  renderSavedWithdrawal,
}: NativeStackScreenProps<RootStackParamList, "VaultWithdrawal"> & {
  renderSavedWithdrawal: () => ReactNode;
}) {
  const v = useRequestedWithdrawal(),
    earn = useEarn(),
    portfolio = useMainnetWallet();
  const [childBusy, setChildBusy] = useState(false);
  const position = portfolioVaultPosition(portfolio.snapshot, "robinhood-usdg");
  const invested = position ? portfolioAssetAmount(position, true) : null;
  if (v.legacyRecovery) return renderSavedWithdrawal();
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">Steakhouse USDG</Typography>
      <Surface>
        <View className="gap-3 p-5">
          <Typography variant="heading">Your vault position</Typography>
          <Typography>
            {invested !== null
              ? `Deposited: ${formatUsdc(invested)} USDG`
              : "Checking deposited amount…"}
          </Typography>
          <Typography variant="caption">
            Your remaining shares stay invested. Withdrawal proceeds return to your private USDC
            balance in Account 2 after fees.
          </Typography>
        </View>
      </Surface>
      {v.loading && (
        <Typography accessibilityLiveRegion="polite">
          Checking withdrawal amounts and saved progress…
        </Typography>
      )}
      {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      {!v.loading && v.complete ? (
        <>
          <Typography variant="heading">Requested withdrawal complete.</Typography>
          <WithdrawalLadder withdrawn quoteReady sent received paused={false} />
          <Typography>
            The selected proceeds have returned to private USDC. Your remaining investment stays in
            the vault.
          </Typography>
          <Button label="Done" onPress={() => navigation.goBack()} />
        </>
      ) : !v.intent && !v.selection ? (
        <Surface>
          <View className="gap-3 p-5">
            <Typography variant="heading">How much would you like to withdraw?</Typography>
            <TextInput
              accessibilityLabel="USDG withdrawal amount"
              value={v.amount}
              onChangeText={v.setAmount}
              editable={!v.loading && !earn.busy}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.fg[45]}
              className="min-h-16 rounded-2xl bg-well px-4 py-3 font-sans text-[28px] text-text"
              maxLength={38}
            />
            <Typography>Available: {formatUsdc(v.total)} USDG</Typography>
            <Button
              label="Max"
              variant="quiet"
              disabled={v.loading || earn.busy || v.total === "0"}
              onPress={() => v.setAmount(formatUsdc(v.total))}
            />
            <Typography variant="caption">
              Enter the vault amount before network and private-return fees. The review shows the
              estimated proceeds; the private return quotes its minimum after the vault receipt.
            </Typography>
            <Button
              label="Review withdrawal amount"
              disabled={v.loading || earn.busy || v.total === "0"}
              onPress={() => void v.review()}
            />
          </View>
        </Surface>
      ) : null}
      {v.selection && !v.complete && (
        <Typography>
          Requested: {formatUsdc(v.selection.amountAtoms)} USDG · {v.completed} of{" "}
          {v.selection.portions.length} portions complete
        </Typography>
      )}
      {!v.loading && v.intent && !v.complete && (
        <RobinhoodWithdrawalPanel
          key={`${v.selection?.requestId ?? "recovery"}:${v.intent.intentId}:${v.intent.investmentSlot ?? "legacy"}`}
          intent={v.intent}
          service={earn.robinhood}
          initialPlan={v.reviewedPlan}
          onBusyChange={setChildBusy}
          withdrawalStartsAfter={v.portion?.afterReturnOperationId}
          withdrawalOptions={
            v.selection && v.portion
              ? {
                  withdrawalRequestId: v.selection.requestId,
                  requestedWithdrawalAtoms: v.portion.amountAtoms,
                  ...(v.portion.allShares ? { withdrawAllShares: true as const } : {}),
                }
              : undefined
          }
          onWithdrawalComplete={v.finish}
        />
      )}
      {v.selection && !v.complete && (
        <Button
          label="Choose a different amount"
          variant="quiet"
          disabled={v.loading || earn.busy || childBusy}
          onPress={() => void v.chooseAnother()}
        />
      )}
      <PrivateBalanceRefresh
        showAmount
        onReadComplete={() => {
          if (!childBusy) void v.refresh();
        }}
      />
      <Button
        label="Refresh withdrawal"
        variant="quiet"
        disabled={v.loading || earn.busy || childBusy}
        onPress={() => void v.refresh()}
      />
    </Screen>
  );
}
