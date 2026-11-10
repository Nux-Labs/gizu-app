import { MainnetPortfolioScreen } from "@/features/wallet/MainnetScreens";
import { SwapHoldingsSection } from "@/features/swap/SwapHoldingsSection";
import type { ReactNode } from "react";
import { useSession } from "@/application/SessionProvider";
import { useWallet } from "@/features/wallet/WalletProvider";
import { useNotifications } from "@/features/notifications/NotificationProvider";
import { useTransactions } from "@/features/transactions/TransactionProvider";
import { OperationLink } from "@/features/transactions/OperationLink";
import { decimal } from "@/domain/transactions";
import { Image, View } from "react-native";
import monadMark from "../../../assets/logos/monad-white.png";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Badge } from "@/components/atoms/Badge";
import { Balance } from "@/components/molecules/Balance";
import { FadeIn } from "@/components/molecules/FadeIn";
import { Surface } from "@/components/molecules/Surface";
import { HistoryChart } from "@/components/organisms/HistoryChart";
import { VaultList } from "@/components/organisms/VaultList";
import { dollars, portfolioTotal } from "@/domain/investments";
import { profileFixture as profile } from "@/services/fixtures/profile";
import { sectionDelay } from "@/theme/motion";
import { useInvestments } from "./InvestmentProvider";
import { DataStatus } from "./DataStatus";
import { HoldingRow } from "./components/HoldingRow";
import { PortfolioActions } from "./components/PortfolioActions";
import { PortfolioHeader } from "./components/PortfolioHeader";
import { PerformanceUnavailable } from "./components/PerformanceUnavailable";
import { VaultPreview } from "./components/VaultPreview";

type Props = BottomTabScreenProps<MainTabParamList, "Home">;

// Frontend Home section stagger: header 0, balance 1, chart 2, actions 3, lists 4.
// Screen already applies a 16px gap, so `mt-*` below tops up to the frontend rhythm.

export function PortfolioScreen(props: Props) {
  const { session } = useSession();
  return session?.kind === "mainnet" ? (
    <MainnetPortfolioScreen {...props} />
  ) : session?.kind === "testnet" ? (
    <NativePortfolio {...props} />
  ) : (
    <DemoPortfolio {...props} />
  );
}

function PortfolioTitle({ detail }: { detail?: string }) {
  return (
    <View className="gap-1">
      <Typography variant="eyebrow" accessibilityRole="header">
        Your portfolio
      </Typography>
      {detail !== undefined && <Typography variant="micro">{detail}</Typography>}
    </View>
  );
}

function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View className="mb-1 flex-row flex-wrap items-center justify-between gap-3">
      <Typography variant="section">{title}</Typography>
      {action}
    </View>
  );
}

function DemoPortfolio({ navigation }: Props) {
  const { unread } = useNotifications();
  const { data } = useInvestments();
  const { account, error: balanceError } = useTransactions();
  const holdings = account && account.revision > 0 ? account.holdings : (data?.holdings ?? []);
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  const openVault = (id: string) => root.navigate("VaultDetail", { id });
  return (
    <Screen>
      <FadeIn delay={sectionDelay(0)}>
        <PortfolioHeader
          initials={profile.initials}
          eyebrow={profile.member}
          greeting={profile.greeting}
          notificationsLabel={`Notifications, ${unread} unread`}
          unread={unread}
          onNotifications={() => root.navigate("Notifications")}
        />
      </FadeIn>
      <FadeIn delay={sectionDelay(1)} className="mt-5 gap-3">
        <PortfolioTitle detail="Vault holdings · USD" />
        {data && <Balance value={portfolioTotal(holdings)} />}
        {data && holdings.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge
              label={`${data.dailyChange.percent}%`}
              negative={Number(data.dailyChange.percent) < 0}
            />
            <Typography variant="micro" className="!text-fg-35">
              {`${BigInt(data.dailyChange.valueCents) >= 0n ? "+" : ""}${dollars(data.dailyChange.valueCents)} today`}
            </Typography>
          </View>
        )}
        <DataStatus />
        {account && (
          <Typography variant="rowTitle">
            {balanceError
              ? "Available USDC: refresh required"
              : `Available USDC: ${decimal(account.cash)}`}
          </Typography>
        )}
        <OperationLink />
      </FadeIn>
      {data && (
        <>
          <FadeIn delay={sectionDelay(2)} className="mt-1">
            <HistoryChart series={data.portfolioSeries} height={140} />
          </FadeIn>
          <FadeIn delay={sectionDelay(3)} className="mt-2">
            <PortfolioActions
              onDeposit={() => root.navigate("Transaction", { kind: "deposit" })}
              onWithdraw={() => root.navigate("Transaction", { kind: "withdraw" })}
              onActivity={() => root.navigate("Activity")}
            />
          </FadeIn>
          <FadeIn delay={sectionDelay(4)} className="mt-5 gap-3">
            {holdings.length === 0 ? (
              <>
                <Typography variant="body">No holdings yet.</Typography>
                <SectionHeading
                  title="Earn"
                  action={
                    <Button
                      label="See all vaults"
                      variant="quiet"
                      onPress={() => navigation.navigate("Vaults")}
                    />
                  }
                />
                <VaultList vaults={data.vaults} onOpen={openVault} />
              </>
            ) : (
              <>
                <SectionHeading title="Holdings" />
                <Surface>
                  {holdings.map((holding, index) => (
                    <HoldingRow
                      key={holding.id}
                      holding={holding}
                      last={index === holdings.length - 1}
                      onOpen={openVault}
                    />
                  ))}
                </Surface>
              </>
            )}
          </FadeIn>
        </>
      )}
    </Screen>
  );
}

function NativeHeader({ onNotifications }: { onNotifications: () => void }) {
  const { unread } = useNotifications();
  return (
    <PortfolioHeader
      greeting="Gizu"
      notificationsLabel={`Notifications, ${unread} unread`}
      unread={unread}
      onNotifications={onNotifications}
    />
  );
}

function NativePortfolio({ navigation }: Props) {
  const wallet = useWallet();
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <Screen>
      <FadeIn delay={sectionDelay(0)}>
        <NativeHeader onNotifications={() => root.navigate("Notifications")} />
      </FadeIn>
      <FadeIn delay={sectionDelay(1)} className="mt-5 gap-2">
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <PortfolioTitle />
          </View>
          {!wallet.error && (
            <Button
              label="Refresh balance"
              variant="quiet"
              disabled={wallet.loading}
              onPress={() => void wallet.refresh()}
            />
          )}
        </View>
        {/* Reserve the 46px balance line so loading/error states do not shift the page. */}
        <View className="min-h-[52px] justify-end">
          {wallet.loading ? (
            <Typography variant="micro" accessibilityLiveRegion="polite">
              Loading balance…
            </Typography>
          ) : wallet.error ? (
            <Typography variant="rowTitle" accessibilityRole="alert" className="!text-danger">
              Balance unavailable. Please retry.
            </Typography>
          ) : wallet.balance !== null ? (
            <Balance
              value={wallet.balance + " " + wallet.asset.symbol}
              icon={
                wallet.asset.symbol === "MON" ? (
                  <Image
                    source={monadMark}
                    className="h-7 w-7"
                    accessibilityIgnoresInvertColors
                    accessible={false}
                  />
                ) : undefined
              }
            />
          ) : null}
        </View>
        {wallet.error && (
          <View className="self-start">
            <Button
              label="Retry balance"
              variant="secondary"
              disabled={wallet.loading}
              onPress={() => void wallet.refresh()}
            />
          </View>
        )}
      </FadeIn>
      <FadeIn delay={sectionDelay(2)} className="mt-1">
        <PerformanceUnavailable />
      </FadeIn>
      <FadeIn delay={sectionDelay(3)} className="mt-2">
        <PortfolioActions
          onDeposit={() => root.navigate("Transaction", { kind: "deposit" })}
          onWithdraw={() => root.navigate("Transaction", { kind: "withdraw" })}
          onActivity={() => root.navigate("Activity")}
        />
      </FadeIn>
      <SwapHoldingsSection
        onReviewSale={() => navigation.navigate("Exchange")}
        emptyContent={
          <VaultPreview
            onSeeAll={() => navigation.navigate("Vaults")}
            onOpen={(id) => root.navigate("OpportunityDetail", { id })}
          />
        }
      />
    </Screen>
  );
}
