import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Skeleton } from "@/components/atoms/Skeleton";
import { Card } from "@/components/molecules/Card";
import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { FadeIn } from "@/components/molecules/FadeIn";
import { StatGrid } from "@/components/molecules/StatGrid";
import { Surface } from "@/components/molecules/Surface";
import { Screen } from "@/components/templates/Screen";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { sectionDelay } from "@/theme/motion";
import { EarningsEstimate } from "./detail/EarningsEstimate";
import { OpportunityHero } from "./detail/OpportunityHero";
import { money, rate } from "./format";
import { useOpportunityDetail } from "./useOpportunityDetail";
import { catalogEarnProfile } from "@/domain/earn/catalog";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { portfolioVaultPosition } from "@/domain/wallet/portfolioValue";

/** Shape-matched placeholder for the summary card while the vault loads. */
function DetailSkeleton() {
  return (
    <View accessible accessibilityLabel="Loading vault…" accessibilityLiveRegion="polite">
      <Surface>
        <View className="gap-5 p-5">
          <View className="flex-row items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-2xl" />
            <View className="flex-1 gap-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </View>
          </View>
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-[190px] w-full rounded-2xl" />
          <View className="flex-row gap-3">
            <Skeleton className="h-14 flex-1 rounded-button" />
            <Skeleton className="h-14 flex-1 rounded-button" />
          </View>
        </View>
      </Surface>
    </View>
  );
}

// Detail order: summary card (rate, chart, actions), key stats, earnings estimate.
export function OpportunityDetailScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "OpportunityDetail">) {
  const { load, history, retry } = useOpportunityDetail(route.params.id);
  const wallet = useOptionalMainnetWallet();
  const profileId = load.kind === "ready" ? catalogEarnProfile(load.opportunity) : null;
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      {load.kind === "loading" && <DetailSkeleton />}
      {load.kind === "failed" && (
        <ErrorNotice
          kind="vault"
          message="Couldn’t load this vault."
          actionLabel="Retry vault"
          onAction={retry}
        />
      )}
      {load.kind === "ready" && (
        <>
          <FadeIn delay={sectionDelay(1)}>
            <OpportunityHero
              opportunity={load.opportunity}
              history={history}
              onDeposit={() => navigation.navigate("Earn", { opportunityId: load.opportunity.id })}
              position={profileId ? portfolioVaultPosition(wallet?.snapshot, profileId) : null}
              onWithdraw={() => {
                if (profileId)
                  navigation.navigate("VaultPosition", {
                    profileId,
                    opportunityId: load.opportunity.id,
                  });
              }}
            />
          </FadeIn>
          <FadeIn delay={sectionDelay(2)}>
            <Card title="Overview">
              <StatGrid
                stats={[
                  { label: "Network", value: load.opportunity.chain.name },
                  { label: "Daily rewards", value: money.format(load.opportunity.dailyRewards) },
                  { label: "Base APR", value: rate(load.opportunity.apr) },
                ]}
              />
            </Card>
          </FadeIn>
          {(!load.opportunity.featured || catalogEarnProfile(load.opportunity) !== null) && (
            <FadeIn delay={sectionDelay(3)}>
              <EarningsEstimate
                ratePercent={load.opportunity.totalApr}
                rateType={load.opportunity.rateType ?? "apr"}
              />
            </FadeIn>
          )}
        </>
      )}
    </Screen>
  );
}
