import { View } from "react-native";
import { useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { useEarn } from "./EarnProvider";
import { SourceFundingPanel } from "./SourceFundingPanel";
import { RobinhoodExecutionPanel } from "./RobinhoodExecutionPanel";
import { VaultExecutionPanel } from "./VaultExecutionPanel";
import { DepositJourneyScreen } from "./DepositJourneyScreen";
import { LegacyEthereumDepositScreen } from "./LegacyEthereumDepositScreen";
export function EarnInvestmentScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, "EarnInvestment">) {
  const earn = useEarn(),
    wallet = useFundingWallet(),
    id = route.params.intentId,
    requested = useRef(false),
    refreshed = useRef(false),
    [guided, setGuided] = useState(false);
  useEffect(() => {
    if (!refreshed.current) {
      refreshed.current = true;
      void earn.refresh();
    }
  }, [earn]);
  const cycle = earn.cycles.find(
      (c) => c.intentId === id && c.walletId === wallet.session.walletId,
    ),
    selected = earn.state && "intentId" in earn.state ? earn.state : null;
  useEffect(() => {
    if (cycle && selected?.intentId !== id && !requested.current && !earn.busy) {
      requested.current = true;
      void earn.selectCycle?.(id);
    }
  }, [cycle, selected?.intentId, id, earn]);
  if (guided && cycle && selected?.intentId === id) {
    if (cycle.profileId === "robinhood-usdg")
      return <DepositJourneyScreen profileId="robinhood-usdg" savedJourneyId={"intent:" + id} />;
    if (cycle.status === "prepared")
      return (
        <LegacyEthereumDepositScreen
          key={`${cycle.intentId}:${cycle.investmentSlot ?? "legacy"}`}
          intent={cycle}
          onViewInvestment={() => setGuided(false)}
        />
      );
  }
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">Saved investment</Typography>
      {earn.loading || earn.busy ? (
        <Typography>Checking saved activity…</Typography>
      ) : !cycle || selected?.intentId !== id ? (
        <>
          <Typography accessibilityRole="alert">
            This investment is unavailable for the current wallet. Check saved activity.
          </Typography>
          <Button label="Check saved activity" onPress={() => void earn.refresh()} />
        </>
      ) : (
        <>
          <Typography variant="heading">
            {cycle.profileId === "robinhood-usdg" ? "Steakhouse USDG" : "Pendle USDC"}
          </Typography>
          {cycle.destinations.map((d, slot) => (
            <View key={d.address} className="gap-1">
              <Typography selectable variant="caption">
                {cycle.distribution
                  ? `Investment wallet ${slot + 1} · ${cycle.distribution.weightsBps[slot]! / 100}%`
                  : d.role}
                : {d.address}
              </Typography>
              {cycle.distribution && (
                <Button
                  label={`Select wallet ${slot + 1}`}
                  variant="secondary"
                  disabled={earn.busy || cycle.investmentSlot === slot}
                  onPress={() => void earn.selectInvestmentSlot?.(id, slot)}
                />
              )}
            </View>
          ))}
          {(cycle.profileId === "robinhood-usdg" || cycle.status === "prepared") && (
            <Button
              label="Open saved deposit progress"
              variant="secondary"
              onPress={() => setGuided(true)}
            />
          )}
          <Typography>
            Withdrawal and return require a separate native review. They use fresh receiving
            addresses.
          </Typography>
          {cycle.status === "recoveryRequired" ? (
            <Typography accessibilityRole="alert">
              Restored accounts require activity reconciliation before spending.
            </Typography>
          ) : cycle.profileId === "robinhood-usdg" ? (
            <RobinhoodExecutionPanel
              key={`${cycle.intentId}:${cycle.investmentSlot ?? "legacy"}`}
              intent={cycle}
              service={earn.robinhood}
              presentation="investment"
            />
          ) : (
            <VaultExecutionPanel
              key={`${cycle.intentId}:${cycle.investmentSlot ?? "legacy"}`}
              intent={cycle}
              presentation="investment"
            />
          )}
          <Typography variant="heading">Funding recovery</Typography>
          <SourceFundingPanel intent={cycle} presentation="recovery" />
        </>
      )}
      {earn.message !== "" && <Typography accessibilityRole="alert">{earn.message}</Typography>}
    </Screen>
  );
}
