import { DepositJourneyScreen } from "./DepositJourneyScreen";
import { LegacyEthereumDepositScreen } from "./LegacyEthereumDepositScreen";
import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { TextInput, View } from "react-native";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Choice } from "@/components/molecules/Choice";
import { Surface } from "@/components/molecules/Surface";
import { BackAction } from "@/navigation/BackAction";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { earnProfiles, type EarnProfileId } from "@/domain/earn/types";
import { useEarn } from "./EarnProvider";
import { PrivateBalancePanel } from "./PrivateBalancePanel";
import { PreflightPanel } from "./PreflightPanel";
import { VaultExecutionPanel } from "./VaultExecutionPanel";
import { RobinhoodExecutionPanel } from "./RobinhoodExecutionPanel";
import { SourceFundingPanel } from "./SourceFundingPanel";
import type { RootStackParamList } from "@/navigation/types";
import { useOpportunityDetail } from "@/features/opportunities/useOpportunityDetail";
import { catalogEarnProfile } from "@/domain/earn/catalog";
import { depositBudgetAtoms } from "./useDepositJourney";

export function EarnScreen({ route }: NativeStackScreenProps<RootStackParamList, "Earn">) {
  return route.params?.opportunityId ? (
    <CatalogEarnEntry opportunityId={route.params.opportunityId} />
  ) : (
    <EarnJourney />
  );
}

function CatalogEarnEntry({ opportunityId }: { opportunityId: string }) {
  const { load, retry } = useOpportunityDetail(opportunityId);
  if (load.kind !== "ready")
    return (
      <Screen>
        <BackAction fallback="Vaults" />
        <Typography variant="title">Deposit</Typography>
        {load.kind === "loading" ? (
          <Typography>Checking vault…</Typography>
        ) : (
          <>
            <Typography accessibilityRole="alert">Vault unavailable. Please retry.</Typography>
            <Button label="Retry vault" onPress={retry} />
          </>
        )}
      </Screen>
    );
  const vault = load.opportunity;
  const profile = catalogEarnProfile(vault);
  if (profile === "robinhood-usdg") return <DepositJourneyScreen profileId={profile} />;
  if (profile) return <CatalogEarnStart profile={profile} />;
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">Deposit</Typography>
      <Typography variant="heading">{vault.name}</Typography>
      <Typography>
        {vault.chain.name} · {vault.tokens[0]?.symbol ?? "Deposit asset unavailable"}
      </Typography>
      <Typography selectable variant="caption">
        {vault.vaultAddress ?? vault.explorerAddress}
      </Typography>
      <Typography accessibilityRole="alert">
        Deposits to this vault are not available in Gizu yet. No funds have moved.
      </Typography>
    </Screen>
  );
}

/** Each new catalog Deposit request starts a fresh cycle; existing investments stay intact. */
function CatalogEarnStart({ profile }: { profile: EarnProfileId }) {
  const earn = useEarn();
  const [amount, setAmount] = useState("");
  const [initialIntentId, setInitialIntentId] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const intent = earn.state && "intentId" in earn.state ? earn.state : null;
  if (requested && intent && intent.intentId !== initialIntentId && intent.profileId === profile)
    return (
      <LegacyEthereumDepositScreen
        key={`${intent.intentId}:${intent.investmentSlot ?? "legacy"}`}
        intent={intent}
      />
    );
  const canStart =
    !!earn.state &&
    !earn.loading &&
    !earn.busy &&
    earn.state.status !== "recoveryRequired" &&
    !!earn.prepareDistribution &&
    !!depositBudgetAtoms(amount);
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">Deposit</Typography>
      <Typography variant="heading">{earnProfiles[profile].name}</Typography>
      <Typography selectable variant="caption">
        {earnProfiles[profile].vault}
      </Typography>
      <Typography>
        Choose an amount to create a saved distribution of fresh investment wallets. Every wallet
        invests in this vault after its fees and withdrawal reserve.
      </Typography>
      <TextInput
        accessibilityLabel="USDC deposit amount"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        placeholder="USDC amount"
        className="min-h-14 rounded-xl bg-well px-4 py-3 text-text"
        editable={!earn.busy && !requested}
      />
      {earn.state?.status === "recoveryRequired" && (
        <Typography accessibilityRole="alert">
          Recover your existing earn activity before starting another deposit.
        </Typography>
      )}
      <Button
        label="Prepare deposit wallets"
        disabled={!canStart}
        loading={earn.busy}
        onPress={() => {
          setInitialIntentId(intent?.intentId ?? null);
          setRequested(true);
          const budget = depositBudgetAtoms(amount);
          if (budget) void earn.prepareDistribution?.(profile, budget);
        }}
      />
      {earn.message !== "" && <Typography accessibilityRole="alert">{earn.message}</Typography>}
      {!earn.state && !earn.loading && (
        <Button
          label="Check saved intent"
          variant="secondary"
          onPress={() => void earn.refresh()}
        />
      )}
    </Screen>
  );
}

function EarnJourney({ profile }: { profile?: EarnProfileId }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const wallet = useFundingWallet();
  const earn = useEarn();
  const [selected, setSelected] = useState<EarnProfileId>(profile ?? "ethereum-usdc");
  const [newDeposit, setNewDeposit] = useState<EarnProfileId | null>(null);
  const profiles = profile ? [profile] : (Object.keys(earnProfiles) as EarnProfileId[]);
  const intent = earn.state && "intentId" in earn.state ? earn.state : null;
  const recovery = earn.state?.status === "recoveryRequired";
  if (newDeposit)
    return newDeposit === "robinhood-usdg" ? (
      <DepositJourneyScreen profileId={newDeposit} />
    ) : (
      <CatalogEarnStart profile={newDeposit} />
    );
  return (
    <Screen>
      <BackAction fallback="Home" />
      <Typography variant="title">Deposit</Typography>
      <Typography>Use USDC from your wallet.</Typography>
      {earn.cycles.length > 1 &&
        earn.cycles
          .filter((cycle) => !profile || cycle.profileId === profile)
          .map((cycle) => (
            <Button
              key={cycle.intentId}
              variant="secondary"
              label={`Open ${earnProfiles[cycle.profileId].name} cycle ${cycle.cycleIndex ?? 0}`}
              disabled={earn.busy || cycle.intentId === intent?.intentId}
              onPress={() => void earn.selectCycle?.(cycle.intentId)}
            />
          ))}
      <Surface>
        <View className="gap-2 p-5">
          <Typography variant="row">Source · USDC</Typography>
          <Typography selectable variant="caption">
            {wallet.session.address}
          </Typography>
          <Typography>
            {wallet.loading
              ? "Checking source balance…"
              : wallet.balance === null
                ? "Your balance will be checked during deposit review."
                : `Source balance: ${wallet.balance} USDC`}
          </Typography>
        </View>
      </Surface>
      {earn.loading ? (
        <Typography accessibilityLiveRegion="polite">Checking saved earn intent…</Typography>
      ) : intent ? (
        <>
          <Typography variant="heading">{earnProfiles[intent.profileId].name}</Typography>
          <Button
            label="View saved investment"
            variant="secondary"
            onPress={() => navigation.navigate("EarnInvestment", { intentId: intent.intentId })}
          />
          {earn.prepareNew && (
            <View className="gap-2">
              {profiles.map((profile) => (
                <Button
                  key={profile}
                  variant="secondary"
                  label={`Start new ${earnProfiles[profile].name} cycle`}
                  disabled={earn.busy}
                  onPress={() =>
                    earn.prepareDistribution
                      ? setNewDeposit(profile)
                      : void earn.prepareNew?.(profile)
                  }
                />
              ))}
            </View>
          )}
          {intent.destinations.map((destination, i) => (
            <Surface key={destination.address}>
              <View className="gap-2 p-5">
                <Typography variant="row">
                  {intent.distribution
                    ? `Investment wallet ${i + 1} · ${intent.distribution.weightsBps[i]! / 100}%`
                    : i === 0
                      ? "Wallet 1 · Hold 10%"
                      : "Wallet 2 · Invest 90%"}
                </Typography>
                <Typography selectable variant="caption">
                  {destination.address}
                </Typography>
                <Typography variant="caption">
                  {earnProfiles[intent.profileId].symbol} · Chain {destination.chainId}
                </Typography>
              </View>
            </Surface>
          ))}
          <Typography>
            {intent.distribution
              ? "The selected investment wallets are covered by your verified backup. Reopening keeps the same wallets and allocation."
              : "Both wallets are covered by your verified source wallet backup and the same passkey. Reopening this intent keeps the same pair."}
          </Typography>
          <Typography>
            {intent.distribution
              ? "Every selected wallet invests its allocated confirmed credit after its payout fees, gas and withdrawal reserve."
              : "The split uses confirmed confidential credit after source fees. Each payout has separate fees; only wallet 2 invests."}
          </Typography>
          {recovery && (
            <Typography accessibilityRole="alert">
              Recovered wallets require activity reconciliation before funding. A restored backup
              does not prove that a previous transfer or investment is absent.
            </Typography>
          )}
          {recovery && (
            <View className="gap-2">
              {profiles.map((profile) => (
                <Button
                  key={profile}
                  label={`Recover ${earnProfiles[profile].name} wallets`}
                  variant="secondary"
                  loading={earn.busy}
                  onPress={() => void earn.prepare(profile)}
                />
              ))}
            </View>
          )}
          <Typography>
            Review current fees before funding, then approve each operation with your passkey. Earn
            stops invested; withdrawal and return need a separate user request.
          </Typography>
          <PrivateBalancePanel key={`private:${intent.intentId}`} intent={intent} />
          <SourceFundingPanel key={`source:${intent.intentId}`} intent={intent} />
          <PreflightPanel key={intent.intentId} intent={intent} />
          {intent.profileId === "ethereum-usdc" ? (
            <VaultExecutionPanel key={`vault:${intent.intentId}`} intent={intent} />
          ) : (
            <RobinhoodExecutionPanel
              key={`hood:${intent.intentId}`}
              intent={intent}
              service={earn.robinhood}
            />
          )}
        </>
      ) : (
        <>
          {recovery && (
            <Typography>
              Choose the original destination profile to recover its wallet pair. Activity
              reconciliation is required before funding.
            </Typography>
          )}
          <Typography variant="heading">Choose destination</Typography>
          <View className="gap-2">
            {profiles.map((profile) => (
              <Choice
                key={profile}
                label={earnProfiles[profile].name}
                selected={selected === profile}
                onPress={() => {
                  if (!earn.busy) setSelected(profile);
                }}
              />
            ))}
          </View>
          <Typography>
            {earn.prepareDistribution && !recovery
              ? "Choose a deposit amount next. The algorithm selects fresh investment wallets and saves their shares before you approve any funding."
              : "Prepare two wallets when you decide to invest. Wallet 1 holds 10%; wallet 2 invests 90% after fees. This does not transfer any funds."}
          </Typography>
          <Typography variant="caption">
            Each earn cycle keeps its own destinations and saved operations.
          </Typography>
          <Button
            label={
              earn.busy
                ? "Preparing wallets…"
                : recovery
                  ? "Recover earn wallets"
                  : "Prepare earn wallets"
            }
            loading={earn.busy}
            disabled={earn.loading || !earn.state}
            onPress={() =>
              !recovery && earn.prepareDistribution
                ? setNewDeposit(selected)
                : void earn.prepare(selected)
            }
          />
        </>
      )}
      {earn.message !== "" && <Typography accessibilityRole="alert">{earn.message}</Typography>}
      {!earn.state && !earn.loading && (
        <Button
          label="Check saved intent"
          variant="secondary"
          onPress={() => void earn.refresh()}
        />
      )}
      <Typography variant="caption">
        Public chains and providers can observe amounts and timing. Privacy is limited. Return
        quotes and resolver fills are not guaranteed. Future withdrawal needs a fresh review and
        enough gas; WETH cannot pay Ethereum gas.
      </Typography>
    </Screen>
  );
}
