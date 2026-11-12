import { Image, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Spinner } from "@/components/atoms/Spinner";
import { Surface } from "@/components/molecules/Surface";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { earnProfiles, type EarnProfileId } from "@/domain/earn/types";
import type { DepositPhase } from "@/domain/earn/depositJourney";
import { formatUsdc } from "@/domain/wallet/amounts";
import { protocolLogo } from "@/features/opportunities/protocolLogos";
import { depositPauseCopy, useDepositJourney } from "./useDepositJourney";
import colors from "@/theme/colors.json";
const stages = [
  ["funding", "Convert USDC to private balance"],
  ["credit", "Verify confidential credit"],
  ["payouts", "Hold 10% and route 90%"],
  ["deposit", "Deposit wallet 2 into the vault"],
] as const;
const phaseCopy: Partial<Record<DepositPhase, string>> = {
  preparing: "Preparing deposit review",
  authorizing: "Approve deposit on your device",
  funding: "Converting USDC to private balance",
  settlingCredit: "Verifying confidential credit",
  payouts: "Routing separate wallet payouts",
  depositing: "Depositing into the vault",
  paused: "Deposit paused",
  invested: "Invested",
};
const currentStage: Partial<Record<DepositPhase, (typeof stages)[number][0]>> = {
  funding: "funding",
  settlingCredit: "credit",
  payouts: "payouts",
  depositing: "deposit",
};
function shareAmount(atoms: string, decimals: number) {
  const p = atoms.padStart(decimals + 1, "0");
  if (!decimals) return p;
  const fraction = p.slice(-decimals).replace(/0+$/, "");
  return p.slice(0, -decimals) + (fraction ? "." + fraction : "");
}
export function DepositJourneyScreen({
  profileId,
  savedJourneyId,
}: {
  profileId: EarnProfileId;
  savedJourneyId?: string;
}) {
  const v = useDepositJourney(profileId, savedJourneyId),
    navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const row = v.snapshot,
    review = row?.review,
    profile = earnProfiles[profileId],
    unsigned = v.editable,
    invested = row?.phase === "invested",
    paused = row?.phase === "paused";
  const holdMinimum =
    review?.sources
      .reduce((sum, s) => sum + BigInt(s.hold?.minimumOutputAtoms ?? "0"), 0n)
      .toString() ?? "0";
  const distribution = row?.distribution;
  return (
    <Screen refreshing={v.balanceRefreshing} onRefresh={() => void v.refreshBalance()}>
      <BackAction fallback="Vaults" />
      <View className="flex-row items-center gap-3">
        <Image
          source={protocolLogo("Morpho")}
          accessibilityLabel="Morpho"
          className="h-10 w-10"
          resizeMode="contain"
        />
        <View className="flex-1 gap-1">
          <Typography variant="title">Deposit</Typography>
          <Typography variant="row">
            {profileId === "robinhood-usdg" ? "Steakhouse USDG" : "Pendle USDC"}
          </Typography>
        </View>
      </View>
      {v.loading ? (
        <Typography accessibilityLiveRegion="polite">Checking deposit availability…</Typography>
      ) : !v.available ? (
        <Typography accessibilityRole="alert">{depositPauseCopy.unsupportedCapability}</Typography>
      ) : null}
      {unsigned && (
        <Surface>
          <View className="gap-3 p-5">
            <Typography variant="row">Amount in USDC</Typography>
            <TextInput
              accessibilityLabel="USDC deposit amount"
              value={v.amount}
              onChangeText={v.setAmount}
              editable={unsigned && !distribution}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.fg[45]}
              className="min-h-16 rounded-2xl bg-well px-4 py-3 font-sans text-[28px] text-text"
              maxLength={38}
            />
            <Typography variant="caption">
              {v.balance !== null
                ? `Available: ${v.balance} USDC`
                : "Your balance will be checked when you review this deposit."}
            </Typography>
            {v.balanceBreakdown && (
              <Typography variant="caption">
                Private {v.balanceBreakdown.privateBalance} USDC · Public{" "}
                {v.balanceBreakdown.publicBalance} USDC
              </Typography>
            )}
            <Typography variant="caption">
              {row && !distribution
                ? "Two fresh wallets are created for this investment. The 10/90 split applies to verified private credit after source fees."
                : "Your amount determines a distribution across fresh investment wallets. Every selected wallet invests in this vault after routing fees, gas and its withdrawal reserve."}
            </Typography>
          </View>
        </Surface>
      )}
      {review && (row?.phase === "review" || (paused && v.details)) && (
        <Surface>
          <View className="gap-3 p-5">
            <Typography variant="heading">
              {paused ? "Remaining deposit limits" : "Review deposit"}
            </Typography>
            <Typography>Source budget: {formatUsdc(review.sourceBudgetAtoms)} USDC</Typography>
            {!distribution && <Typography>At least {formatUsdc(holdMinimum)} USDG held</Typography>}
            {distribution && (
              <Typography>Investment wallets: {distribution.weightsBps.length}</Typography>
            )}
            <Typography>
              At least {formatUsdc(review.deposit.minimumAssetsAtoms)} USDG invested
            </Typography>
            <Typography variant="caption">
              Vault gas cap: {formatUsdc(review.deposit.maximumFeeAtoms)} USDG
            </Typography>
            <Typography variant="caption">
              Withdrawal reserve: {formatUsdc(review.deposit.withdrawalReserveAtoms)} USDG
            </Typography>
            <Typography variant="caption">
              {distribution
                ? "Each wallet retains its own withdrawal reserve. It is not an already-paid fee."
                : "The reserve stays liquid in wallet 2. It is not an already-paid fee."}
            </Typography>
            <Typography variant="caption">
              Minimum shares:{" "}
              {shareAmount(review.deposit.minimumSharesAtoms, review.deposit.shareDecimals)}
            </Typography>
            {review.deposits?.map((deposit) => (
              <View key={deposit.slot} className="gap-1 rounded-xl bg-well p-3">
                <Typography variant="row">
                  Wallet {deposit.slot + 1} · {distribution!.weightsBps[deposit.slot]! / 100}%
                </Typography>
                <Typography selectable variant="caption">
                  {deposit.recipient}
                </Typography>
                <Typography>
                  At least {formatUsdc(deposit.minimumAssetsAtoms)} USDG invested
                </Typography>
                <Typography variant="caption">
                  Gas cap: {formatUsdc(deposit.maximumFeeAtoms)} USDG · withdrawal reserve:{" "}
                  {formatUsdc(deposit.withdrawalReserveAtoms)} USDG
                </Typography>
              </View>
            ))}
            <Typography variant="caption">
              {paused
                ? "These are saved approval limits. Native review checks the remaining operations before signing."
                : "Estimates require fresh live terms. One device approval authorizes this deposit within the displayed limits for up to 15 minutes while the app stays open."}
            </Typography>
          </View>
        </Surface>
      )}
      {row?.indicativeReview && !review && (row.phase === "preparing" || paused) && (
        <Surface>
          <View className="gap-3 p-5" accessibilityLiveRegion="polite">
            <Typography variant="heading">Preliminary deposit estimate</Typography>
            {!distribution && (
              <Typography>
                Estimated 10% held: {formatUsdc(row.indicativeReview.holdEstimatedAtoms)} USDG
              </Typography>
            )}
            <Typography>
              {distribution
                ? "Estimated investment before vault fees: "
                : "Estimated 90% before vault fees: "}
              {formatUsdc(row.indicativeReview.investEstimatedAtoms)} USDG
            </Typography>
            <Typography variant="caption">
              {row.phase === "preparing" || v.preparing
                ? "Calculating vault fees and the withdrawal reserve…"
                : "Review again for current vault fees and the withdrawal reserve."}
            </Typography>
            <Typography variant="caption">
              These amounts are indicative. No funds move before the final review and your device
              approval.
            </Typography>
          </View>
        </Surface>
      )}
      {row && !unsigned && (
        <Surface>
          <View className="gap-4 p-5">
            <View className="flex-row flex-wrap items-center gap-2">
              <View className="rounded-full bg-neon-deep px-3 py-1.5">
                <Typography variant="eyebrow" className="text-accent">
                  {invested ? "INVESTED" : paused ? "NEEDS ATTENTION" : "INVESTING"}
                </Typography>
              </View>
              <View className="rounded-full border border-cardEdge bg-well px-3 py-1.5">
                <Typography variant="eyebrow">
                  {distribution
                    ? `USDG · ${distribution.weightsBps.length} investment wallets`
                    : "USDG · 10 / 90"}
                </Typography>
              </View>
            </View>
            <Typography variant="heading" accessibilityLiveRegion="polite">
              {v.authorizing
                ? "Approve deposit on your device"
                : invested
                  ? "Invested"
                  : paused
                    ? "Deposit paused"
                    : "Deposit in progress"}
            </Typography>
            {!paused && !invested && !v.authorizing && (
              <View className="flex-row items-center gap-3" accessibilityLiveRegion="polite">
                <Spinner size="sm" />
                <Typography variant="row" className="flex-1">
                  {phaseCopy[row.phase] ?? "Continuing your deposit"}
                </Typography>
              </View>
            )}
            {row.phase === "settlingCredit" && (
              <Typography variant="caption" accessibilityLiveRegion="polite">
                Waiting for confidential credit. Your deposit continues automatically within your
                approval limits. Keep this page open.
              </Typography>
            )}
            <View className="gap-4 rounded-2xl bg-well p-4">
              {stages.map(([stage, legacyLabel], index) => {
                const label =
                  distribution && stage === "payouts"
                    ? "Route funds to investment wallets"
                    : distribution && stage === "deposit"
                      ? "Deposit every wallet into the vault"
                      : legacyLabel;
                const done = row.completedSteps.includes(stage),
                  active = !v.authorizing && !done && currentStage[row.phase] === stage;
                return (
                  <View
                    key={stage}
                    className="flex-row items-center gap-3"
                    accessible
                    accessibilityLabel={`${label}: ${done ? "Verified" : active ? "In progress" : "Pending"}`}
                  >
                    <View
                      className={`h-7 w-7 items-center justify-center rounded-full border ${done ? "border-neon bg-neon" : active ? "border-neon bg-neon-deep" : "border-cardEdge"}`}
                    >
                      <Typography
                        variant="micro"
                        className={done ? "text-ctaText" : active ? "text-accent" : "text-fg-35"}
                      >
                        {done ? "✓" : index + 1}
                      </Typography>
                    </View>
                    <Typography
                      variant="rowTitle"
                      className={`flex-1 ${active ? "text-accent" : done ? "text-text" : "text-fg-45"}`}
                    >
                      {label}
                    </Typography>
                  </View>
                );
              })}
            </View>
            {row.investments?.map((investment) => (
              <View key={investment.slot} className="gap-1">
                <Typography>
                  Wallet {investment.slot + 1}:{" "}
                  {investment.status === "invested"
                    ? "Invested"
                    : investment.status === "received"
                      ? "Funding verified"
                      : investment.status === "depositing"
                        ? "Depositing"
                        : investment.status === "paused"
                          ? "Needs attention"
                          : "Pending"}
                </Typography>
                {investment.status === "invested" && (
                  <Typography variant="caption">
                    {formatUsdc(investment.depositedAtoms)} USDG invested
                  </Typography>
                )}
                {investment.transactionHash && (
                  <Typography selectable variant="caption">
                    {investment.transactionHash}
                  </Typography>
                )}
              </View>
            ))}
            <View className="gap-3 rounded-2xl bg-well p-4">
              <View className="flex-row items-center justify-between gap-3">
                <Typography variant="rowTitle">Steps verified</Typography>
                <Typography variant="rowValue">{row.completedSteps.length} / 4</Typography>
              </View>
              <View
                className="h-1.5 overflow-hidden rounded-full bg-glassSoft"
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel="Verified deposit steps"
                accessibilityValue={{ min: 0, max: 4, now: row.completedSteps.length }}
              >
                <View
                  className="h-full rounded-full bg-neon"
                  style={{ width: `${row.completedSteps.length * 25}%` }}
                />
              </View>
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <Typography variant="caption">USDC budget</Typography>
                <Typography variant="rowValue">{formatUsdc(row.budgetAtoms)} USDC</Typography>
              </View>
            </View>
            {!paused && !invested && row.phase !== "settlingCredit" && (
              <Typography variant="caption">
                Keep this page open. The remaining steps continue automatically within your approval
                limits.
              </Typography>
            )}
            {invested && (
              <>
                {!distribution && (
                  <Typography>{formatUsdc(row.holdReceivedAtoms)} USDG held</Typography>
                )}
                <Typography>{formatUsdc(row.depositedAtoms)} USDG invested</Typography>
                <Typography variant="caption">
                  Your investment remains in the vault until you choose to withdraw.
                </Typography>
              </>
            )}
          </View>
        </Surface>
      )}
      {v.preparing && (
        <Typography accessibilityLiveRegion="polite">Preparing deposit review</Typography>
      )}
      {paused && !v.preparing && (
        <Typography accessibilityRole="alert">
          {depositPauseCopy[row.pauseReason ?? "recoveryRequired"]}
        </Typography>
      )}
      {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      {v.discoveryFailed && <Button label="Retry saved progress" onPress={v.retryDiscovery} />}
      {v.canChangeAmount && (
        <Button
          label="Change amount"
          variant="secondary"
          disabled={v.busy}
          onPress={() => void v.changeAmount()}
        />
      )}
      {row?.phase === "review" ? (
        <Button
          label="Confirm deposit"
          disabled={!v.canConfirm}
          loading={v.busy}
          onPress={() => void v.confirm()}
        />
      ) : unsigned ? (
        <Button
          label="Review deposit"
          disabled={!v.canReview}
          loading={v.busy}
          onPress={() => void v.review()}
        />
      ) : invested ? (
        <Button
          label="View investment"
          onPress={() => navigation.navigate("VaultPosition", { profileId })}
        />
      ) : paused &&
        !["recoveryRequired", "unsupportedCapability"].includes(row.pauseReason ?? "") ? (
        <Button
          label="Review remaining steps"
          disabled={v.busy}
          loading={v.busy}
          onPress={() => void v.resume()}
        />
      ) : null}
      {row?.phase === "review" && !v.canConfirm && !v.busy && (
        <>
          <Typography accessibilityRole="alert">
            The review expired or the amount changed. Refresh the estimates before confirming.
          </Typography>
          <Button
            label="Refresh deposit review"
            variant="secondary"
            onPress={() => void v.review()}
          />
        </>
      )}
      {row && !unsigned && !invested && (
        <Button
          label="Check progress"
          variant="quiet"
          disabled={v.busy}
          onPress={() => void v.refresh()}
        />
      )}
      {row && !invested && !unsigned && (
        <Button label="Pause deposit" variant="secondary" onPress={v.cancel} />
      )}
      {row && (
        <Button
          label={v.details ? "Hide details" : "Details"}
          variant="quiet"
          onPress={() => v.setDetails(!v.details)}
        />
      )}
      {v.details && row && (
        <Surface>
          <View className="gap-2 p-5">
            {row.destinations.map((destination, slot) => (
              <View key={destination.address} className="gap-1">
                <Typography variant="row">
                  Wallet {slot + 1} · {destination.role}
                </Typography>
                <Typography selectable variant="caption">
                  {destination.address}
                </Typography>
              </View>
            ))}
            <Typography variant="caption">Vault contract</Typography>
            <Typography selectable variant="caption">
              {profile.vault}
            </Typography>
            {review?.sources.map((source) => (
              <View key={source.operationId} className="gap-1">
                {source.kind === "private" ? (
                  <Typography variant="caption">
                    Private USDC source · {formatUsdc(source.budgetAtoms)} USDC
                  </Typography>
                ) : (
                  <>
                    <Typography selectable variant="caption">
                      {source.address}
                    </Typography>
                    <Typography variant="caption">
                      Budget {formatUsdc(source.budgetAtoms)} USDC · gas cap{" "}
                      {formatUsdc(source.maximumFeeAtoms)} USDC · retained{" "}
                      {formatUsdc(source.retainedAtoms)} USDC
                    </Typography>
                  </>
                )}
              </View>
            ))}
            {row.depositTransactionHash && (
              <Typography selectable variant="caption">
                {row.depositTransactionHash}
              </Typography>
            )}
            <Typography variant="caption">
              Public chains and routing providers can observe amounts and timing. Each destination
              uses its own transaction. Withdrawal and return need a separate review.
            </Typography>
          </View>
        </Surface>
      )}
    </Screen>
  );
}
