import { useState, type ReactNode } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import { LineChart } from "@/components/molecules/chart/LineChart";
import { PeriodPills } from "@/components/molecules/chart/PeriodPills";
import {
  balanceChange,
  balancePeriods,
  balanceSeries,
  type BalancePeriod,
} from "@/domain/wallet/balanceHistory";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { holdingAmount } from "@/features/swap/SwapHoldingsSection";
import colors from "@/theme/colors.json";
import { useBalanceHistory } from "./useBalanceHistory";
import { portfolioValue } from "@/domain/wallet/portfolioValue";

const tabular = { fontVariant: ["tabular-nums" as const] };
const periods = Object.keys(balancePeriods) as BalancePeriod[];
const periodNames: Record<BalancePeriod, string> = {
  "1W": "past week",
  "1M": "past month",
  "1Y": "past year",
  All: "all time",
};
const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** Flat line while there are fewer than two observations; nothing is invented. */
const flat = [0, 0];

function changeText(change: NonNullable<ReturnType<typeof balanceChange>>) {
  const sign = change.delta >= 0 ? "+" : "-";
  const percent =
    change.percent === null ? "" : ` (${sign}${pct.format(Math.abs(change.percent))}%)`;
  return `${sign}$${usd.format(Math.abs(change.delta))}${percent}`;
}

/** Portfolio value in USD; expands to a chart and the balance breakdown. */
export function BalanceCard({
  snapshot,
  actions,
}: {
  snapshot: MainnetPortfolioSnapshot;
  actions: ReactNode;
}) {
  const { fontScale } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [period, setPeriod] = useState<BalancePeriod>("1M");
  const value = portfolioValue(snapshot);
  const history = useBalanceHistory(snapshot, value);
  const series = balanceSeries(history, period, value.checkedAt);
  // Same window as balanceSeries, so labels line up with plotted samples.
  const since = value.checkedAt - balancePeriods[period] * 86_400_000;
  const dates = history
    .filter((point) => point.at >= since)
    .map((point) => dateLabel.format(new Date(point.at)));
  const change = balanceChange(series);
  const up = !change || change.delta >= 0;
  const total = holdingAmount(value.totalAtoms, 6);
  return (
    <Surface>
      <View className="gap-5 p-5">
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Typography variant="label11">Total balance</Typography>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Balance details"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
              hitSlop={8}
              className="h-8 flex-row items-center gap-1 rounded-full bg-well px-3"
            >
              <Text key={fontScale} className="font-sans text-[12px] text-fg-70">
                {expanded ? "Less" : "Performance"}
              </Text>
              {expanded ? (
                <ChevronUp size={14} color={colors.fg["70"]} />
              ) : (
                <ChevronDown size={14} color={colors.fg["70"]} />
              )}
            </Pressable>
          </View>
          <Text
            key={`total-${fontScale}`}
            accessibilityLabel={`${total} USD`}
            numberOfLines={1}
            adjustsFontSizeToFit
            className="font-sans text-[34px] leading-[40px] ios:tracking-tight text-text"
            style={tabular}
          >
            {total}
            <Text className="font-sans text-[18px] text-fg-45"> USD</Text>
          </Text>
          {change && (
            <Text
              key={`change-${fontScale}`}
              className={`font-sans text-[13px] ${up ? "text-neon" : "text-rose"}`}
              style={tabular}
            >
              {changeText(change)}
              <Text className="text-fg-45">{` · ${periodNames[period]}`}</Text>
            </Text>
          )}
        </View>
        {actions}
        {!expanded && (
          // Always-on glance; the full chart, periods and breakdown live behind Performance.
          <LineChart
            series={series.length >= 2 ? series : flat}
            height={84}
            up={up}
            revealKey="compact"
            format={(value) => `$${usd.format(value)}`}
          />
        )}
        {expanded && (
          <View className="gap-4">
            <PeriodPills
              options={periods}
              selected={period}
              onSelect={setPeriod}
              label="Performance period"
            />
            <View
              accessible
              accessibilityLabel={
                change
                  ? `Balance ${periodNames[period]}: ${changeText(change)}`
                  : "Balance history is not available yet"
              }
            >
              <LineChart
                series={series.length >= 2 ? series : flat}
                height={150}
                up={up}
                revealKey={period}
                format={(value) => `$${usd.format(value)}`}
                labels={series.length >= 2 ? dates : undefined}
              />
            </View>
            <Typography variant="micro">
              {series.length >= 2
                ? "Recorded on this device each time your balance is checked. Deposits and withdrawals are included."
                : "Your chart builds as Gizu checks your balance over time."}
            </Typography>
            <View className="gap-3 rounded-2xl bg-well p-4">
              <Typography>Funding: {holdingAmount(snapshot.fundingAtoms, 6)} USDC</Typography>
              <Typography>
                Receiving wallets: {holdingAmount(snapshot.returnAtoms, 6)} USDC
              </Typography>
              <Typography>Other assets: {holdingAmount(value.assetsAtoms, 6)} USD</Typography>
              <Typography>Vault positions: {holdingAmount(value.vaultAtoms, 6)} USD</Typography>
              <Typography variant="micro">
                Last checked {new Date(snapshot.checkedAt).toLocaleTimeString()}
              </Typography>
            </View>
          </View>
        )}
      </View>
    </Surface>
  );
}
