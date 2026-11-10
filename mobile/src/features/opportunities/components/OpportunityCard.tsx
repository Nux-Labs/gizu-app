import { VaultCard } from "@/components/organisms/VaultList";
import { tvlChange, type Opportunity } from "@/domain/opportunities";
import { useTvlSeries } from "../useTvlSeries";
import { money, percent, rate } from "../format";
import { protocolLogo } from "../protocolLogos";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { portfolioVaultPosition } from "@/domain/wallet/portfolioValue";
import { catalogEarnProfile } from "@/domain/earn/catalog";
import { holdingAmount } from "@/features/swap/SwapHoldingsSection";

/** No history yet: a flat line at zero rather than an empty-state message. */
const flat = [0, 0];

/**
 * Frontend OpportunityCard for a real mainnet catalog row: ticker chip, TVL sparkline,
 * name, TVL and total APR. History loads lazily per card; a failed request just omits
 * the sparkline so the list is never blocked.
 */
export function OpportunityCard({
  opportunity,
  index,
  rateSuffix,
  onOpen,
  virtualized = false,
}: {
  opportunity: Opportunity;
  index: number;
  virtualized?: boolean;
  /** Small suffix after the rate, e.g. ` total APR` on the Earn tab. */
  rateSuffix?: string;
  onOpen: (id: string) => void;
}) {
  const history = useTvlSeries(opportunity.id);
  const wallet = useOptionalMainnetWallet();
  const profileId = catalogEarnProfile(opportunity);
  const position = profileId ? portfolioVaultPosition(wallet?.snapshot, profileId) : null;
  const hasPosition =
    position && (!position.complete || BigInt(position.shareAtoms ?? position.observedAtoms) > 0n);
  const tvl = money.format(opportunity.tvl);
  const apr = rate(opportunity.totalApr);
  const label = opportunity.rateType === "apy" ? "net APY" : "total APR";
  let series: number[] | undefined;
  if (history.kind === "ready")
    series =
      history.series.length >= 2 ? history.series : opportunity.tvl === null ? undefined : flat;
  const change = series ? tvlChange(series) : null;
  const up = change === null || change >= 0;
  return (
    <VaultCard
      index={index}
      virtualized={virtualized}
      ticker={opportunity.asset?.symbol ?? opportunity.protocol.name.slice(0, 4)}
      logo={protocolLogo(opportunity.protocol.name, opportunity.protocol.id)}
      name={opportunity.name}
      tvl={tvl}
      rate={apr}
      rateSuffix={opportunity.rateType === "apy" ? " net APY" : rateSuffix}
      depositedAmount={
        hasPosition
          ? position.underlyingAtoms !== null && position.complete && position.decimals !== null
            ? `${holdingAmount(position.underlyingAtoms, position.decimals)} ${position.symbol} deposited`
            : "Checking position…"
          : undefined
      }
      depositedValue={
        hasPosition && position.valueUsdcAtoms !== null
          ? `≈ ${holdingAmount(position.valueUsdcAtoms, 6)} USDC`
          : undefined
      }
      trailing={
        opportunity.featured
          ? "Featured"
          : change === null
            ? opportunity.status
            : `${up ? "+" : ""}${percent.format(change)}%`
      }
      trailingTone={
        opportunity.featured || change === null ? "muted" : up ? "positive" : "negative"
      }
      series={series}
      negative={!up}
      accessibilityLabel={`View ${opportunity.name}`}
      accessibilityHint={`${opportunity.featured ? "Featured vault. " : ""}${opportunity.asset?.symbol ?? ""} ${opportunity.protocol.name}, ${opportunity.status}, TVL ${tvl}, ${label} ${apr}`}
      onPress={() => onOpen(opportunity.id)}
    />
  );
}
