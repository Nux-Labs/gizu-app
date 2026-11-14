import type { PropsWithChildren, ReactNode } from "react";
import {
  Image,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type TextProps,
} from "react-native";
import { Lock } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { PressableScale } from "@/components/atoms/PressableScale";
import { FadeIn } from "@/components/molecules/FadeIn";
import { Sparkline } from "@/components/molecules/Sparkline";
import type { Vault } from "@/domain/investments";
import { cardDelay } from "@/theme/motion";

const tabular = { fontVariant: ["tabular-nums" as const] };
const trailingTones = {
  positive: "text-neon/70",
  negative: "text-rose/80",
  muted: "text-fg-45",
} as const;

export type VaultCardProps = {
  /** Position in the grid; drives the staggered entrance (frontend 300 + 50·i ms). */
  index: number;
  /** Parent list supplies cell sizing and skips remount animations. */
  virtualized?: boolean;
  /** Ticker chip text (frontend: ticker or first four protocol letters). */
  ticker: string;
  /** Protocol logo shown in the chip instead of the ticker text. */
  logo?: ImageSourcePropType;
  name: string;
  /** Formatted TVL, rendered as the uppercase `… tvl` caption. */
  tvl: string;
  /** Formatted rate, rendered in neon, e.g. `6.1%`. */
  rate: string;
  /** Optional small suffix after the rate, e.g. ` total APR`. */
  rateSuffix?: string;
  /** Top-right text: 24h change or catalog status. */
  trailing?: string;
  trailingTone?: keyof typeof trailingTones;
  series?: number[];
  negative?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Omit for browse-only cards; the card is then a grouped, non-interactive summary. */
  onPress?: () => void;
};

// Remeasure native text after Dynamic Type changes without remounting the card.
function CardText(props: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <Text key={fontScale} {...props} />;
}

function TickerChip({ ticker, logo }: { ticker: string; logo?: ImageSourcePropType }) {
  // Frontend: `h-10 w-10 rounded-xl bg-neon/10 font-mono text-[11px] font-bold text-neon`.
  return (
    <View className="relative min-h-10 min-w-10 max-w-[72px] items-center justify-center rounded-xl bg-neon/10 px-1.5">
      {logo ? (
        <Image
          source={logo}
          className="h-7 w-7 rounded-lg"
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <CardText numberOfLines={1} className="font-sans text-[11px] font-bold text-neon">
          {ticker}
        </CardText>
      )}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="absolute -right-0.5 -top-0.5 rounded-full bg-ink p-px"
      >
        <Lock size={8} color={colors.neon.DEFAULT} opacity={0.7} />
      </View>
    </View>
  );
}

function CardBody({
  ticker,
  logo,
  name,
  tvl,
  rate,
  rateSuffix,
  trailing,
  trailingTone = "positive",
  series,
  negative = false,
}: Omit<
  VaultCardProps,
  "index" | "virtualized" | "accessibilityLabel" | "accessibilityHint" | "onPress"
>) {
  return (
    <>
      <View className="flex-row items-start justify-between gap-2">
        <TickerChip ticker={ticker} logo={logo} />
        {trailing !== undefined && (
          <CardText
            className={`font-sans shrink text-right text-[10px] ${trailingTones[trailingTone]}`}
            style={tabular}
          >
            {trailing}
          </CardText>
        )}
      </View>
      <View className="-mx-1 my-4 h-12 justify-center">
        {series && series.length >= 2 && (
          <Sparkline series={series} negative={negative} height={40} />
        )}
      </View>
      <View className="gap-3">
        <CardText
          numberOfLines={2}
          className="min-h-10 font-sans text-[14px] font-medium leading-5 text-text"
        >
          {name}
        </CardText>
        <View className="gap-2 border-t border-cardEdge pt-3">
          <CardText className="font-sans text-[11px] text-fg-55" style={tabular}>
            {tvl} TVL
          </CardText>
          <CardText className="font-sans text-[22px] font-medium text-neon" style={tabular}>
            {rate}
          </CardText>
          <CardText className="font-mono text-[10px] uppercase text-fg-45">
            {rateSuffix?.trim() || "APY"}
          </CardText>
        </View>
      </View>
    </>
  );
}

// Frontend `.glass` card: 24 px radius, p-4, content spread top to bottom.
const cardClass = "flex-1 overflow-hidden rounded-card border border-cardEdge bg-card p-4";

/** Frontend OpportunityCard/VaultCard: glass tile with ticker chip, sparkline, name, TVL and rate. */
export function VaultCard({
  index,
  virtualized = false,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  ...body
}: VaultCardProps) {
  let card: ReactNode;
  if (onPress) {
    card = (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        className={cardClass}
      >
        <CardBody {...body} />
      </PressableScale>
    );
  } else {
    card = (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        className={cardClass}
      >
        <CardBody {...body} />
      </View>
    );
  }
  if (virtualized) return card;
  // One column on narrow screens; two from the `xs` breakpoint (frontend grid-cols-2).
  return (
    <FadeIn delay={cardDelay(index)} className="w-full xs:w-[48%]">
      {card}
    </FadeIn>
  );
}

/** Two-column wrapping grid used by vault discovery lists. */
export function VaultGrid({ children }: PropsWithChildren) {
  return <View className="flex-row flex-wrap justify-between gap-y-3">{children}</View>;
}

function changeLabel(change: string) {
  const sign = Number(change) >= 0 && !change.startsWith("+") ? "+" : "";
  return `${sign}${change}%`;
}

export function VaultList({ vaults, onOpen }: { vaults: Vault[]; onOpen: (id: string) => void }) {
  return (
    <VaultGrid>
      {vaults.map((vault, index) => {
        const negative = Number(vault.change24h) < 0;
        return (
          <VaultCard
            key={vault.id}
            index={index}
            ticker={vault.ticker}
            name={vault.name}
            tvl={vault.tvl}
            rate={`${vault.apy}%`}
            trailing={changeLabel(vault.change24h)}
            trailingTone={negative ? "negative" : "positive"}
            series={vault.series}
            negative={negative}
            accessibilityLabel={`View ${vault.name}`}
            accessibilityHint={`${vault.risk} risk, APY ${vault.apy} percent, TVL ${vault.tvl}`}
            onPress={() => onOpen(vault.id)}
          />
        );
      })}
    </VaultGrid>
  );
}
