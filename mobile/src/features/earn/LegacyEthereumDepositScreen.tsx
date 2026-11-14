import { TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import type { EarnIntent } from "@/domain/earn/types";
import { formatMon, formatUsdc } from "@/domain/wallet/amounts";
import { useLegacyEthereumDeposit } from "./useLegacyEthereumDeposit";
import { useEarn } from "./EarnProvider";
export function LegacyEthereumDepositScreen({
  intent,
  onViewInvestment,
}: {
  intent: EarnIntent;
  onViewInvestment?: () => void;
}) {
  const v = useLegacyEthereumDeposit(intent),
    earn = useEarn(),
    navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">Deposit</Typography>
      <Typography variant="heading">Pendle USDC</Typography>
      {intent.distribution && (
        <>
          <Typography>Investment wallets: {intent.distribution.weightsBps.length}</Typography>
          <Typography>
            Wallet {(intent.investmentSlot ?? 0) + 1} ·{" "}
            {intent.distribution.weightsBps[intent.investmentSlot ?? 0]! / 100}% of verified private
            credit
          </Typography>
        </>
      )}
      {v.phase === "invested" ? (
        <>
          <Typography variant="heading">
            {intent.distribution
              ? `Wallet ${(intent.investmentSlot ?? 0) + 1} invested`
              : "Invested"}
          </Typography>
          {intent.distribution &&
            (intent.investmentSlot ?? 0) + 1 < intent.distribution.weightsBps.length && (
              <Button
                label={`Continue with wallet ${(intent.investmentSlot ?? 0) + 2}`}
                disabled={earn.busy}
                onPress={() =>
                  void earn.selectInvestmentSlot?.(
                    intent.intentId,
                    (intent.investmentSlot ?? 0) + 1,
                  )
                }
              />
            )}
          <Button
            label="View investment"
            onPress={
              onViewInvestment ??
              (() => navigation.navigate("EarnInvestment", { intentId: intent.intentId }))
            }
          />
        </>
      ) : (
        <>
          <Surface>
            <View className="gap-3 p-5">
              <Typography variant="row">Step: {v.activeStage}</Typography>
              {v.activeStage === "funding" && !v.review && (
                <TextInput
                  accessibilityLabel="USDC deposit amount"
                  keyboardType="decimal-pad"
                  value={v.amount}
                  onChangeText={v.setAmount}
                  editable={!intent.distributionBudgetAtoms}
                  className="min-h-14 rounded-xl bg-well px-4 py-3 text-text"
                  placeholder="USDC amount"
                />
              )}
              {v.review?.kind === "funding" && (
                <>
                  <Typography>
                    Source budget:{" "}
                    {formatUsdc(
                      v.review.plans.reduce((sum, p) => sum + BigInt(p.budget), 0n).toString(),
                    )}{" "}
                    USDC
                  </Typography>
                  <Typography>
                    Each selected source keeps its own gas and retained margin.
                  </Typography>
                </>
              )}
              {v.review?.kind === "liquidity" && (
                <>
                  <Typography>
                    Swap{" "}
                    {formatUsdc(
                      v.review.plan.proposal.kind === "fusionEthOrder"
                        ? v.review.plan.proposal.inputAtoms
                        : "0",
                    )}{" "}
                    USDC for ETH
                  </Typography>
                  <Typography>
                    Approve the permit and order in the existing native dialogs.
                  </Typography>
                </>
              )}
              {v.review?.kind === "vault" && (
                <>
                  <Typography>Deposit: {formatUsdc(v.review.plan.amountAtoms)} USDC</Typography>
                  <Typography>
                    Maximum gas: {formatMon(v.review.plan.maximumGasCostWei)} ETH
                  </Typography>
                  <Typography>
                    Withdrawal reserve: {formatMon(v.review.plan.withdrawalReserveWei)} ETH
                  </Typography>
                </>
              )}
            </View>
          </Surface>
          <Button
            label={v.label}
            disabled={v.disabled}
            loading={v.busy}
            onPress={() => void v.primaryAction()}
          />
          {!v.available && !v.loading && (
            <Typography accessibilityRole="alert">
              This build does not support native Ethereum deposits.
            </Typography>
          )}
        </>
      )}
      {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      <HoldingDetails label="Deposit details" accessibilityLabel="Ethereum deposit details">
        <Typography variant="caption">
          Ethereum uses separate native approvals for funding, payouts, ETH liquidity and the vault.
          Each step keeps its saved progress.
        </Typography>
        <Typography variant="caption">
          Withdrawal and returns remain separate. Public chains and providers can observe amounts
          and timing.
        </Typography>
      </HoldingDetails>
    </Screen>
  );
}
