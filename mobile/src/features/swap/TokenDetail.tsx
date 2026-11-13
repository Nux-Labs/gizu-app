import { useMemo, useState } from "react";
import { Image, Text, View, useWindowDimensions } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { IconButton } from "@/components/atoms/IconButton";
import { Spinner } from "@/components/atoms/Spinner";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { StatGrid } from "@/components/molecules/StatGrid";
import { Surface } from "@/components/molecules/Surface";
import { LineChart } from "@/components/molecules/chart/LineChart";
import { PeriodPills } from "@/components/molecules/chart/PeriodPills";
import { Screen } from "@/components/templates/Screen";
import { tokenDisplayName } from "@/domain/tokenCatalog";
import {
  detailPeriods,
  periodChange,
  sessionNames,
  type DetailPeriod,
  type TokenDetails,
} from "@/domain/tokenDetails";
import { RobinhoodChainMark } from "./components/RobinhoodChainMark";
import { formatUsd } from "./formatUsd";
import { useTokenDetails } from "./useTokenDetails";

const tabular = { fontVariant: ["tabular-nums" as const] };
const signed = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  signDisplay: "exceptZero",
});
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const hourLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayHourLabel = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric" });
const flat = [0, 0];

function pointLabel(period: DetailPeriod, seconds: number): string {
  const date = new Date(seconds * 1000);
  if (period === "1D") return hourLabel.format(date);
  if (period === "1W") return weekdayHourLabel.format(date);
  return dayLabel.format(date);
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * One swappable Robinhood stock or fund: price on Robinhood Chain, its history, a short
 * description and Robinhood's facts, with an action to choose it as the swap target.
 */
export function TokenDetail({
  address,
  disabled,
  onBack,
  onSelect,
}: {
  address: string;
  disabled: boolean;
  onBack: () => void;
  onSelect: () => void;
}) {
  const [period, setPeriod] = useState<DetailPeriod>("1M");
  const { details, status, retry } = useTokenDetails(address, period);
  return (
    <Screen>
      <View className="flex-row items-center gap-3">
        <IconButton icon={ChevronLeft} label="Back to tokens" onPress={onBack} />
        <Typography variant="heading" accessibilityRole="header" className="flex-1">
          {details?.symbol ?? "Token"}
        </Typography>
      </View>
      {details ? (
        <Loaded
          details={details}
          period={period}
          status={status}
          disabled={disabled}
          onPeriod={setPeriod}
          onRetry={retry}
          onSelect={onSelect}
        />
      ) : status === "failed" ? (
        <View className="gap-3">
          <Notice error message="Token details are unavailable right now." />
          <Button label="Try again" variant="secondary" onPress={retry} />
        </View>
      ) : (
        <View className="items-center py-10" accessibilityLabel="Loading token details">
          <Spinner />
        </View>
      )}
    </Screen>
  );
}

function Loaded({
  details,
  period,
  status,
  disabled,
  onPeriod,
  onRetry,
  onSelect,
}: {
  details: TokenDetails;
  period: DetailPeriod;
  status: "loading" | "ready" | "failed";
  disabled: boolean;
  onPeriod: (period: DetailPeriod) => void;
  onRetry: () => void;
  onSelect: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const name = tokenDisplayName(details.name);
  // The chart belongs to the period it was loaded for; a newer request keeps it until it lands.
  const chart = details.chart;
  const series = useMemo(() => chart?.points.map((point) => point.price) ?? flat, [chart]);
  const labels = useMemo(
    () => chart?.points.map((point) => pointLabel(chart.period, point.time)),
    [chart],
  );
  const change = periodChange(details);
  const up = change === null || change >= 0;
  const sessions = sessionNames(details.sessions);
  const stats = [
    { label: "Type", value: details.kind === "fund" ? "Fund" : "Stock" },
    ...(details.sharesPerToken
      ? [{ label: "Shares per token", value: Number(details.sharesPerToken).toFixed(4) }]
      : []),
  ];
  // Long values get their own full-width row so they are never cut off.
  const facts = [
    ...(details.isin ? [{ label: "ISIN", value: details.isin }] : []),
    { label: "Contract", value: shortAddress(details.address) },
    {
      label: "Trading",
      value: sessions.length > 0 ? sessions.join(" · ") : "Not trading right now",
    },
  ];
  return (
    <>
      <Surface>
        <View className="gap-5 p-5">
          <View className="flex-row items-center gap-3">
            <Image
              source={{ uri: details.logoURI }}
              className="h-12 w-12 rounded-full"
              accessibilityLabel={`${details.symbol} logo`}
              accessibilityIgnoresInvertColors
            />
            <View className="min-w-0 flex-1 gap-1">
              <Typography variant="cardTitle" numberOfLines={2}>
                {name}
              </Typography>
              <View className="flex-row items-center gap-2">
                <Badge label={details.kind === "fund" ? "Fund" : "Stock"} />
                <RobinhoodChainMark />
              </View>
            </View>
          </View>
          <View
            accessible
            accessibilityLabel={
              details.priceUsd === null
                ? "Price unavailable"
                : `Price ${formatUsd(details.priceUsd)}${change === null ? "" : `, ${signed.format(change)} percent over ${period}`}`
            }
            className="gap-1"
          >
            <Typography variant="label11">Price on Robinhood Chain</Typography>
            <Text
              key={fontScale}
              className="font-sans text-[36px] leading-[40px] ios:tracking-tight text-text"
              style={tabular}
            >
              {details.priceUsd === null ? "Unavailable" : formatUsd(details.priceUsd)}
            </Text>
            {change !== null && (
              <Text
                key={`change-${fontScale}`}
                className={`font-sans text-[14px] ${up ? "text-neon" : "text-rose"}`}
                style={tabular}
              >
                {`${signed.format(change)}% · ${chart?.period ?? period}`}
              </Text>
            )}
          </View>
          <View className="gap-3">
            {chart ? (
              <View
                accessible
                accessibilityLabel={`${chart.period} price history, ${chart.points.length} samples`}
              >
                <LineChart
                  series={series}
                  labels={labels}
                  height={180}
                  up={up}
                  revealKey={chart.period}
                  format={formatUsd}
                />
              </View>
            ) : status === "ready" ? (
              <Typography variant="micro">Price history isn’t available for this token.</Typography>
            ) : null}
            <View className="flex-row items-center justify-between gap-3">
              <PeriodPills options={detailPeriods} selected={period} onSelect={onPeriod} />
              {status === "loading" && <Spinner size="sm" />}
            </View>
            {status === "failed" && (
              <View className="gap-2">
                <Notice error message={`${period} price history couldn’t be loaded.`} />
                <Button label="Try again" variant="secondary" onPress={onRetry} />
              </View>
            )}
            <Typography variant="micro">
              Price of the token on Robinhood Chain. It can differ from the exchange price,
              especially outside market hours.
            </Typography>
          </View>
        </View>
      </Surface>
      <View className="gap-2">
        <Typography variant="section">About</Typography>
        <Typography variant="body">{details.description}</Typography>
      </View>
      <View className="gap-4">
        <StatGrid stats={stats} />
        {facts.map((fact) => (
          <View
            key={fact.label}
            className="gap-1"
            accessible
            accessibilityLabel={`${fact.label}: ${fact.value}`}
          >
            <Typography variant="label11">{fact.label}</Typography>
            <Typography variant="rowValue" style={tabular}>
              {fact.value}
            </Typography>
          </View>
        ))}
      </View>
      <Button label={`Select ${details.symbol}`} disabled={disabled} onPress={onSelect} />
    </>
  );
}
