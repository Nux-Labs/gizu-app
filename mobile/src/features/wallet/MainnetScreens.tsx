import type { OwnedPortfolioAsset, OwnedPortfolioPosition } from "@/domain/wallet/storedSigner";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { Bell, ChevronDown, ChevronUp } from "lucide-react-native";
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
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { Surface } from "@/components/molecules/Surface";
import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { Notice } from "@/components/molecules/Notice";
import { AccountAddress } from "@/features/account/AccountAddress";
import { clipboardService } from "@/services/clipboard";
import { PortfolioActions } from "@/features/investments/components/PortfolioActions";
import { VaultPreview } from "@/features/investments/components/VaultPreview";
import { SwapHoldingsSection, holdingAmount } from "@/features/swap/SwapHoldingsSection";
import { useMainnetWallet } from "./MainnetWalletProvider";
import { BalanceCard } from "./BalanceCard";
import { VaultPositionCard } from "./VaultPositionCard";
import { vaultPositionProfile } from "@/domain/wallet/portfolioValue";
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
/** Home omits the loading line: pull-to-refresh and the balance skeleton already show progress. */
function BalanceStatus({
  showRefresh = true,
  showLoading = true,
}: {
  showRefresh?: boolean;
  showLoading?: boolean;
}) {
  const wallet = useMainnetWallet();
  return (
    <>
      {showLoading && wallet.loading ? (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Updating your balance…
        </Typography>
      ) : null}
      {wallet.snapshot?.stale && !wallet.error && !wallet.loading && (
        <Typography variant="micro">Showing your last known balance.</Typography>
      )}
      {wallet.error || (!wallet.loading && wallet.snapshot?.balanceComplete === false) ? (
        <ErrorNotice
          kind="balance"
          message="Couldn’t refresh your balance."
          stale={!!wallet.snapshot}
          actionLabel="Retry balance"
          busy={wallet.loading}
          onAction={() => void wallet.refresh()}
        />
      ) : null}
      {showRefresh && !wallet.error && wallet.snapshot?.balanceComplete !== false && (
        <Button
          label="Refresh balance"
          variant="quiet"
          disabled={wallet.loading}
          onPress={() => void wallet.refresh()}
        />
      )}
    </>
  );
}
function WalletDetails() {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Wallet details"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 flex-row items-center justify-between gap-3"
      >
        <Typography variant="caption">Wallet details</Typography>
        {expanded ? (
          <ChevronUp size={18} color={colors.text} />
        ) : (
          <ChevronDown size={18} color={colors.text} />
        )}
      </Pressable>
      {expanded && <ReceivingAccounts />}
    </View>
  );
}

function ReceivingAccounts() {
  const { snapshot, loading } = useMainnetWallet();
  const [message, setMessage] = useState("");
  return (
    <View className="gap-3">
      <Typography variant="section">USDC accounts</Typography>
      <Typography variant="micro">
        All these wallets count toward your USDC balance. Funds stay in their respective wallets.
      </Typography>
      {snapshot?.accounts.map((account) => (
        <Surface key={account.address}>
          <View className="gap-2 p-5">
            <Typography variant="rowTitle">
              {account.role === "funding"
                ? "Swap funding"
                : `Receiving account ${account.accountIndex}`}
            </Typography>
            <Typography>
              {snapshot.balanceComplete === false
                ? loading
                  ? "Checking balance…"
                  : "Balance unavailable. Refresh to retry."
                : `${holdingAmount(account.balanceAtoms, 6)} USDC`}
            </Typography>
            <Typography variant="micro" selectable>
              {account.address}
            </Typography>
            <Button
              variant="quiet"
              label={`Copy ${account.role === "funding" ? "funding" : `receiving ${account.accountIndex}`} address`}
              onPress={() => {
                void clipboardService.copy(account.address).then(
                  () => setMessage("Address copied."),
                  () => setMessage("Could not copy address."),
                );
              }}
            />
          </View>
        </Surface>
      ))}
      {message ? (
        <Typography accessibilityLiveRegion="polite" variant="micro">
          {message}
        </Typography>
      ) : null}
    </View>
  );
}

function OwnedBalanceRow({
  asset,
  position = false,
  loading,
  privateLocked = false,
}: {
  loading: boolean;
  asset: OwnedPortfolioAsset | OwnedPortfolioPosition;
  position?: boolean;
  privateLocked?: boolean;
}) {
  const estimated = position && "conversionEstimated" in asset && asset.conversionEstimated;
  const amount =
    position && "underlyingAtoms" in asset ? asset.underlyingAtoms : asset.balanceAtoms;
  const observedAmount = position
    ? "observedUnderlyingAtoms" in asset
      ? asset.observedUnderlyingAtoms
      : null
    : asset.observedAtoms;
  return (
    <View className="gap-2 border-b border-cardEdge py-3 last:border-b-0">
      <Typography variant="rowTitle">{asset.symbol}</Typography>
      {position && <Typography variant="micro">Vault position</Typography>}
      <Typography>
        {asset.complete && amount !== null && asset.decimals !== null
          ? `${estimated ? "Estimated underlying: " : ""}${holdingAmount(amount, asset.decimals)} ${asset.symbol}`
          : privateLocked
            ? "Unlock to check your private USDC."
            : loading
              ? `Checking ${asset.symbol} balance…`
              : `${asset.symbol} balance unavailable. Refresh to retry.`}
      </Typography>
      {!asset.complete &&
        asset.checkedAt > 0 &&
        observedAmount != null &&
        asset.decimals !== null && (
          <Typography variant="micro">
            Previously checked: {holdingAmount(observedAmount, asset.decimals)} {asset.symbol}
          </Typography>
        )}
      {asset.valueUsdcAtoms !== null && (
        <Typography>Value: {holdingAmount(asset.valueUsdcAtoms, 6)} USDC</Typography>
      )}
      {asset.stale && (
        <Typography variant="micro">
          {loading ? "Cached amount awaiting refresh." : "Showing a cached observation."}
        </Typography>
      )}
      <HoldingDetails
        accessibilityLabel={`${asset.symbol} ${position ? "position" : "holding"} details`}
      >
        <Typography variant="micro">Chain {asset.chainId}</Typography>
        <Typography variant="micro" selectable>
          {asset.token}
        </Typography>
        {!asset.complete &&
          typeof observedAmount === "string" &&
          observedAmount !== "0" &&
          asset.decimals !== null && (
            <Typography variant="micro">
              Previously observed: {holdingAmount(observedAmount, asset.decimals)} {asset.symbol}
            </Typography>
          )}
        {asset.valueUsdcAtoms === null && (
          <Typography variant="micro">
            {asset.valuationUnavailable || !loading
              ? "USDC value unavailable."
              : "Checking USDC value…"}
          </Typography>
        )}
      </HoldingDetails>
    </View>
  );
}
function OwnedBalances({ onOpenVault }: { onOpenVault: (profile: EarnProfileId) => void }) {
  const {
    snapshot,
    loading,
    refresh,
    unlockingPrivateBalance,
    privateBalanceError,
    unlockPrivateBalance,
  } = useMainnetWallet();
  if (!snapshot?.ownedAssets && !snapshot?.positions) return null;
  const visible = (asset: OwnedPortfolioAsset) =>
    !asset.complete || BigInt(asset.balanceAtoms ?? asset.observedAtoms) > 0n;
  const assets = snapshot.ownedAssets?.filter(visible) ?? [];
  const positions = snapshot.positions?.filter(visible) ?? [];
  return (
    <View className="gap-5">
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
                  <OwnedBalanceRow asset={position} position loading={loading} />
                </View>
              </Surface>
            );
          })}
        </View>
      )}
      {assets.length > 0 && (
        <View className="gap-3">
          <Typography variant="section">Assets</Typography>
          <Surface>
            <View className="px-5">
              {assets.map((asset) => (
                <OwnedBalanceRow
                  key={asset.assetId}
                  asset={asset}
                  loading={loading}
                  privateLocked={
                    snapshot.confidentialReadState === "locked" &&
                    asset.token === "confidential:monad-usdc"
                  }
                />
              ))}
            </View>
          </Surface>
        </View>
      )}
      <View className="gap-2">
        {snapshot.confidentialReadState === "locked" && (
          <>
            <Typography variant="micro">
              Unlock to refresh your private USDC. This does not move funds.
            </Typography>
            <Button
              label="Unlock private balance"
              variant="quiet"
              disabled={loading || unlockingPrivateBalance}
              loading={unlockingPrivateBalance}
              onPress={() => void unlockPrivateBalance()}
            />
          </>
        )}
        {privateBalanceError !== "" && (
          <Typography accessibilityRole="alert" variant="negative">
            {privateBalanceError}
          </Typography>
        )}
        {snapshot.ownedBalanceComplete === false && (
          <Typography variant="micro">
            {loading
              ? "Checking owned token balances and positions…"
              : "Some token balances or positions are unavailable. Refresh to retry."}
          </Typography>
        )}
        {snapshot.ownedBalanceComplete === false && !loading && (
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

function BalanceSkeleton() {
  return (
    <Surface>
      <View className="gap-4 p-5" accessible accessibilityLabel="Loading your balance">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-2/3" />
        <View className="flex-row gap-3">
          <Skeleton className="h-14 flex-1 rounded-2xl" />
          <Skeleton className="h-14 flex-1 rounded-2xl" />
          <Skeleton className="h-14 w-14 rounded-2xl" />
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
  const actions = (
    <PortfolioActions
      onDeposit={() => root.navigate("Transaction", { kind: "deposit" })}
      onWithdraw={() => root.navigate("Transaction", { kind: "withdraw" })}
      onActivity={() => root.navigate("Activity")}
    />
  );
  const ready = !!wallet.snapshot && wallet.snapshot.balanceComplete !== false;
  return (
    <Screen refreshing={wallet.loading} onRefresh={() => void wallet.refresh()}>
      <View className="flex-row items-center gap-3 pb-1">
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <GizuLogo width={24} height={32} />
        </View>
        <Typography variant="pageTitle" accessibilityRole="header" className="flex-1 !text-[26px]">
          Your portfolio
        </Typography>
        <IconButton
          icon={Bell}
          label="Notifications"
          onPress={() => root.navigate("Notifications")}
        />
      </View>
      <BalanceStatus showRefresh={false} showLoading={false} />
      {wallet.snapshot && ready ? (
        <BalanceCard snapshot={wallet.snapshot} actions={actions} />
      ) : wallet.loading ? (
        <BalanceSkeleton />
      ) : (
        actions
      )}
      {/* Home Earn shortcut is temporarily hidden; the Earn flow remains available. */}
      <Button
        label="Withdraw from Gizu"
        variant="secondary"
        onPress={() => root.navigate("ConfidentialWithdrawal")}
      />
      <OwnedBalances onOpenVault={(profileId) => root.navigate("VaultPosition", { profileId })} />
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

export function MainnetTransaction({
  route,
}: NativeStackScreenProps<RootStackParamList, "Transaction">) {
  const wallet = usePortfolio();
  const deposit = route.params.kind === "deposit";
  return (
    <Screen>
      <BackAction fallback="Home" />
      <Typography variant="title">{deposit ? "Receive" : "Send"}</Typography>
      {deposit ? (
        <>
          <AccountAddress />
          <Typography variant="micro">Refresh your balance after funds arrive.</Typography>
        </>
      ) : (
        <Notice message="Sending USDC directly is not available yet. Your funds remain in your wallets." />
      )}
      <BalanceStatus />
      {wallet.snapshot && wallet.snapshot.balanceComplete !== false ? (
        <Typography>Total: {holdingAmount(wallet.snapshot.totalAtoms, 6)} USDC</Typography>
      ) : null}
      <WalletDetails />
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
      <Typography variant="micro">
        Completed and cancelled swaps on this device. Deposits aren’t included.
      </Typography>
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
      {wallet.snapshot?.history.map((item) => (
        <Surface key={item.operationId}>
          <View className="gap-2 p-5">
            <Typography variant="rowTitle">
              {item.direction === "sell" ? "Sell" : "Buy"} {item.symbol}
            </Typography>
            <Typography>{item.phase === "COMPLETE" ? "Completed" : "Cancelled"}</Typography>
            {item.direction === "sell" && item.phase === "COMPLETE" ? (
              <Typography>
                {item.completionTarget === "confidential"
                  ? `Credited ${holdingAmount(item.privateCreditedAtoms ?? item.receivedAtoms, 6)} USDC to confidential cash`
                  : `Returned ${holdingAmount(item.receivedAtoms, 6)} USDC on Monad`}
              </Typography>
            ) : null}
            <Typography variant="micro">{new Date(item.recordedAt).toLocaleString()}</Typography>
          </View>
        </Surface>
      ))}
    </Screen>
  );
}
