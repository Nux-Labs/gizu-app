import { ActivityHistory } from "./ActivityHistory";
import type { OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { useCallback, type ReactNode } from "react";
import { View } from "react-native";
import { Bell, TrendingUp, Wallet } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { useFocusEffect } from "@react-navigation/native";
import type {
  NativeStackScreenProps,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { BackAction } from "@/navigation/BackAction";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { IconButton } from "@/components/atoms/IconButton";
import { GizuLogo } from "@/components/atoms/GizuLogo";
import { Button } from "@/components/atoms/Button";
import { Skeleton } from "@/components/atoms/Skeleton";
import { Spinner } from "@/components/atoms/Spinner";
import { Surface } from "@/components/molecules/Surface";
import { RowListSkeleton } from "@/components/molecules/CardSkeleton";
import { MascotHero } from "@/components/organisms/MascotHero";
import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { Notice } from "@/components/molecules/Notice";
import { AccountAddress } from "@/features/account/AccountAddress";
import { PortfolioActions } from "@/features/investments/components/PortfolioActions";
import { VaultPreview } from "@/features/investments/components/VaultPreview";
import { useSwapAssetSweep } from "@/features/swap/useSwapAssetSweep";
import { useStrategySigning } from "@/features/strategies/useStrategySigning";
import { isSwapChain } from "@/domain/tokenCatalog";
import { WithdrawalStatusNotice } from "@/features/earn/WithdrawalStatusNotice";
import { useSharedWithdrawalState } from "@/features/earn/useVaultPosition";
import { useMainnetWallet } from "./MainnetWalletProvider";
import { AddFunds } from "./AddFunds";
import { useSession } from "@/application/SessionProvider";
import { PrivateBalanceRefresh } from "./PrivateBalanceRefresh";
import { BalanceCard } from "./BalanceCard";
import { PortfolioAssetRow, type PortfolioAssetAction } from "./PortfolioAssetRow";
import { usePortfolioTokenNames, type NamedPortfolioAsset } from "./usePortfolioTokenNames";
import { VaultPositionCard } from "./VaultPositionCard";
import { portfolioAssetValue, vaultPositionProfile } from "@/domain/wallet/portfolioValue";
import type { EarnProfileId } from "@/domain/earn/types";

function usePortfolio() {
  const wallet = useMainnetWallet();
  const { refresh } = wallet;
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  return wallet;
}

const visible = (asset: OwnedPortfolioAsset) =>
  !asset.complete || BigInt(asset.balanceAtoms ?? asset.observedAtoms) > 0n;

/** Largest USD value first; assets without a value follow, by symbol. */
function byValue(a: NamedPortfolioAsset, b: NamedPortfolioAsset) {
  const left = portfolioAssetValue(a);
  const right = portfolioAssetValue(b);
  if (left !== null && right !== null && left !== right)
    return BigInt(right) > BigInt(left) ? 1 : -1;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return a.symbol.localeCompare(b.symbol);
}

type AssetNavigation = {
  onSell: (token: string) => void;
  onBuy: () => void;
  onReceive: () => void;
};

/** Only stocks get a row shortcut; Receive, Send and Withdraw already sit above Assets. */
function assetActions(asset: NamedPortfolioAsset, go: AssetNavigation): PortfolioAssetAction[] {
  // Swap sells Robinhood Chain and Base holdings; the sell form picks this token.
  if (asset.fromSwap && isSwapChain(asset.chainId))
    return [
      {
        label: "Sell",
        accessibilityLabel: `Sell ${asset.symbol}`,
        onPress: () => go.onSell(asset.token),
      },
    ];
  return [];
}

/**
 * Assets with nothing held. Without USDC the first step is receiving it; with USDC it is a first
 * stock. Shown only after a complete read, so a slow or failed read never claims "nothing".
 */
function AssetsEmptyState({
  hasUsdc,
  onBuy,
  onReceive,
}: {
  hasUsdc: boolean;
  onBuy: () => void;
  onReceive: () => void;
}) {
  const Icon = hasUsdc ? TrendingUp : Wallet;
  return (
    <Surface>
      <View className="items-center gap-4 px-6 py-7">
        <View className="h-12 w-12 items-center justify-center rounded-full bg-neon/10">
          <Icon size={22} color={colors.accent} />
        </View>
        <View className="items-center gap-1.5">
          <Typography variant="cardTitle" className="text-center">
            {hasUsdc ? "No stocks yet" : "No assets yet"}
          </Typography>
          <Typography variant="caption" className="text-center">
            {hasUsdc
              ? "Your USDC is ready. Buy your first stock in a few taps and it will show up here."
              : "Stocks you buy and tokens you receive will show up here. Add USDC to get started."}
          </Typography>
        </View>
        <View className="w-full gap-2">
          {hasUsdc ? (
            <Button label="Buy a stock" onPress={onBuy} />
          ) : (
            <>
              <Button label="Receive USDC" onPress={onReceive} />
              <Button label="Browse stocks" variant="quiet" onPress={onBuy} />
            </>
          )}
        </View>
      </View>
    </Surface>
  );
}

function OwnedBalances({
  assets,
  onOpenVault,
  onCheckPastReturn,
  onOpenWithdrawal,
  navigation,
}: {
  assets: NamedPortfolioAsset[];
  onOpenVault: (profile: EarnProfileId) => void;
  onCheckPastReturn: (profile: EarnProfileId) => void;
  onOpenWithdrawal: (profile: EarnProfileId) => void;
  navigation: AssetNavigation;
}) {
  const { snapshot, loading, refresh } = useMainnetWallet();
  const withdrawal = useSharedWithdrawalState();
  const positions = snapshot?.positions?.filter(visible) ?? [];
  // Assets always has a section. "Nothing held" needs a complete token read; until then it loads.
  const settled = !!snapshot?.ownedAssets && !loading && snapshot.ownedBalanceComplete !== false;
  return (
    <View className="gap-5">
      <WithdrawalStatusNotice
        attention={withdrawal.attention}
        onOpenWithdrawal={
          withdrawal.activeProfile ? () => onOpenWithdrawal(withdrawal.activeProfile!) : undefined
        }
        canCheckPastReturn={withdrawal.historyProfile !== undefined}
        onCheckPastReturn={() => {
          if (withdrawal.historyProfile) onCheckPastReturn(withdrawal.historyProfile);
        }}
      />
      {positions.length > 0 && (
        <View className="gap-3">
          <Typography variant="section">Your vaults</Typography>
          {positions.map((position) => {
            const profileId = vaultPositionProfile(position);
            return profileId ? (
              <VaultPositionCard
                key={position.assetId}
                position={position}
                profileId={profileId}
                loading={loading}
                onPress={() => onOpenVault(profileId)}
              />
            ) : (
              <Surface key={position.assetId}>
                <View className="px-5">
                  <PortfolioAssetRow asset={position} position loading={loading} />
                </View>
              </Surface>
            );
          })}
        </View>
      )}
      <View className="gap-3">
        <Typography variant="section">Assets</Typography>
        {assets.length > 0 && snapshot ? (
          <Surface>
            <View className="px-5">
              {assets.map((asset) => (
                <PortfolioAssetRow
                  key={asset.assetId}
                  asset={asset}
                  actions={assetActions(asset, navigation)}
                  loading={loading}
                  privateLocked={
                    snapshot.confidentialReadState === "locked" &&
                    asset.token === "confidential:monad-usdc"
                  }
                />
              ))}
            </View>
          </Surface>
        ) : settled ? (
          <AssetsEmptyState
            hasUsdc={snapshot.totalAtoms !== "0"}
            onBuy={navigation.onBuy}
            onReceive={navigation.onReceive}
          />
        ) : loading || !snapshot ? (
          <RowListSkeleton count={2} label="Loading your assets" />
        ) : (
          <Surface>
            <View className="gap-1 p-5">
              <Typography variant="rowTitle">Assets couldn’t be loaded</Typography>
              <Typography variant="caption">
                Your holdings are safe; only this view is out of date.
              </Typography>
              <View className="items-start pt-2">
                <Button label="Try again" variant="quiet" onPress={() => void refresh()} />
              </View>
            </View>
          </Surface>
        )}
      </View>
      <View className="gap-2">
        {snapshot ? <PrivateBalanceRefresh /> : null}
        {/* Without asset rows the Assets card above carries the retry. */}
        {snapshot?.ownedBalanceComplete === false && !loading && assets.length > 0 && (
          <Button
            label="Retry token balances and positions"
            variant="quiet"
            onPress={() => void refresh()}
          />
        )}
      </View>
    </View>
  );
}

/**
 * Stands in for the balance card until a complete balance arrives. While a read runs the chart
 * area shows a loader; when a read fails it offers a quiet refresh instead of an error, and the
 * deposit and withdraw actions stay usable either way.
 */
function BalanceSkeleton({
  actions,
  paused,
  onRefresh,
}: {
  actions: ReactNode;
  paused: boolean;
  onRefresh: () => void;
}) {
  return (
    <Surface>
      <View className="gap-5 p-5">
        <View
          className="gap-2"
          accessible
          accessibilityLabel={paused ? "Balance not updated yet" : "Loading your balance"}
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-2/3" />
        </View>
        {actions}
        <View className="h-[84px] items-center justify-center">
          <Skeleton className="absolute inset-0 rounded-2xl" />
          {paused ? (
            <View className="items-center gap-1">
              <Typography variant="micro">Your balance is taking longer than usual.</Typography>
              <Button label="Refresh balance" variant="quiet" onPress={onRefresh} />
            </View>
          ) : (
            <Spinner size="md" />
          )}
        </View>
      </View>
    </Surface>
  );
}

export function MainnetPortfolioScreen({
  navigation,
}: BottomTabScreenProps<MainTabParamList, "Home">) {
  const wallet = useMainnetWallet();
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  const strategies = useStrategySigning();
  // A restored wallet rediscovers stocks its earlier swaps bought; found tokens join Assets.
  useSwapAssetSweep(!!wallet.snapshot, () => void wallet.refresh());
  const actions = (
    <PortfolioActions
      onDeposit={() => root.navigate("Transaction", { kind: "deposit" })}
      onWithdraw={() => root.navigate("ConfidentialWithdrawal")}
      withdrawLabel="Withdraw"
      onActivity={() => root.navigate("Activity")}
    />
  );
  // Names and market prices swapped stocks once, so the total and the Assets rows agree.
  const owned = usePortfolioTokenNames(
    wallet.snapshot?.ownedAssets ?? [],
    wallet.snapshot?.checkedAt ?? 0,
  );
  const valued = wallet.snapshot?.ownedAssets
    ? { ...wallet.snapshot, ownedAssets: owned }
    : wallet.snapshot;
  const assets = owned.filter(visible).sort(byValue);
  const ready = !!wallet.snapshot && wallet.snapshot.balanceComplete !== false;
  return (
    <Screen refreshing={wallet.loading} onRefresh={() => void wallet.refresh()}>
      <MascotHero
        title="Your portfolio"
        leading={
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <GizuLogo width={21} height={28} />
          </View>
        }
        trailing={
          <IconButton
            icon={Bell}
            label="Notifications"
            onPress={() => root.navigate("Notifications")}
          />
        }
      />
      {valued && ready ? (
        <>
          <BalanceCard snapshot={valued} actions={actions} />
          {!wallet.loading && (wallet.error || valued.stale) && (
            // A failed refresh keeps the last balance; say so quietly instead of raising an error.
            <View className="-mt-2 flex-row items-center justify-between gap-3 px-1">
              <Typography variant="micro" className="flex-1">
                Showing your last known balance.
              </Typography>
              <Button
                label="Refresh balance"
                variant="quiet"
                onPress={() => void wallet.refresh()}
              />
            </View>
          )}
        </>
      ) : (
        <BalanceSkeleton
          actions={actions}
          paused={!wallet.loading && (!!wallet.error || wallet.snapshot?.balanceComplete === false)}
          onRefresh={() => void wallet.refresh()}
        />
      )}
      {/* Home Earn shortcut is temporarily hidden; the Earn flow remains available. */}
      {strategies && (
        <Button
          label="Sell your strategy"
          variant="secondary"
          onPress={() => root.navigate("Strategies")}
        />
      )}
      <OwnedBalances
        assets={assets}
        onOpenVault={(profileId) => root.navigate("VaultPosition", { profileId })}
        onOpenWithdrawal={(profileId) => root.navigate("VaultWithdrawal", { profileId })}
        onCheckPastReturn={(profileId) =>
          root.navigate("VaultWithdrawal", { profileId, historyOnly: true })
        }
        navigation={{
          onSell: (token) =>
            navigation.navigate("Exchange", { mode: "sell", token, request: Date.now() }),
          onBuy: () => navigation.navigate("Exchange", { mode: "buy", request: Date.now() }),
          onReceive: () => root.navigate("Transaction", { kind: "deposit" }),
        }}
      />
      <VaultPreview
        onSeeAll={() => navigation.navigate("Vaults")}
        onOpen={(id) => root.navigate("OpportunityDetail", { id })}
      />
    </Screen>
  );
}

export function MainnetTransaction(
  props: NativeStackScreenProps<RootStackParamList, "Transaction">,
) {
  return props.route.params.kind === "deposit" ? <MainnetAddFunds /> : <MainnetUnavailable />;
}

/** Mainnet has no direct send; a restored or stale route to one explains that and goes back. */
function MainnetUnavailable() {
  return (
    <Screen>
      <BackAction fallback="Home" />
      <Notice message="This action isn’t available. Use Withdraw on Home to move private USDC." />
    </Screen>
  );
}

/** Add funds only shows where to send USDC; it does not read or refresh balances. */
function MainnetAddFunds() {
  const { session } = useSession();
  return (
    <Screen>
      <BackAction fallback="Home" />
      <Typography variant="title" accessibilityRole="header">
        Add funds
      </Typography>
      {session?.kind === "mainnet" ? <AddFunds address={session.address} /> : <AccountAddress />}
    </Screen>
  );
}

export function MainnetActivity() {
  const wallet = usePortfolio();
  return (
    <Screen refreshing={wallet.loading} onRefresh={() => void wallet.refresh()}>
      <BackAction fallback="Home" />
      <Typography variant="heading" accessibilityRole="header">
        Activity
      </Typography>
      <Typography variant="caption">Your swaps, all in one place.</Typography>
      {wallet.loading && !wallet.snapshot ? (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Loading activity…
        </Typography>
      ) : null}
      {wallet.error ? (
        <ErrorNotice
          kind="balance"
          message={
            wallet.snapshot
              ? "Couldn’t refresh activity. Showing saved activity."
              : "Couldn’t load activity."
          }
          actionLabel="Retry activity"
          busy={wallet.loading}
          onAction={() => void wallet.refresh()}
        />
      ) : wallet.snapshot?.stale ? (
        <Typography variant="micro">Showing saved activity.</Typography>
      ) : null}
      {!wallet.error && !wallet.loading && wallet.snapshot?.history.length === 0 ? (
        <View className="items-center gap-2 py-12">
          <Typography variant="rowTitle">No activity yet</Typography>
          <Typography variant="caption">Your finished swaps will appear here.</Typography>
        </View>
      ) : null}
      {!!wallet.snapshot?.history.length && <ActivityHistory entries={wallet.snapshot.history} />}
      <Typography variant="micro">
        Swaps recorded on this device · Deposits aren’t included
      </Typography>
    </Screen>
  );
}
