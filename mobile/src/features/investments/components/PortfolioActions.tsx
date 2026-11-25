import { Text, View, useWindowDimensions } from "react-native";
import { ArrowUpRight, MoreHorizontal, Plus, type LucideIcon } from "lucide-react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
import colors from "@/theme/colors.json";

function TransferButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  // Frontend Home.tsx: `glass flex flex-1 items-center justify-center gap-2 rounded-2xl py-4
  // text-[14px] font-medium`, 17px neon icon before the label. Web line-height 1.5 = 21px.
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-well py-4"
    >
      <Icon size={17} color={colors.neon.DEFAULT} />
      <Text
        key={fontScale}
        className="font-sans shrink text-[14px] font-medium leading-[21px] text-text"
      >
        {label}
      </Text>
    </PressableScale>
  );
}

/**
 * Frontend Home quick actions: glass Add funds / outgoing action and a glass-soft activity tile.
 * Testnet and demo send directly ("Send"); mainnet withdraws private USDC ("Withdraw").
 */
export function PortfolioActions({
  onDeposit,
  onWithdraw,
  withdrawLabel = "Send",
  onActivity,
}: {
  onDeposit: () => void;
  onWithdraw: () => void;
  withdrawLabel?: "Send" | "Withdraw";
  onActivity: () => void;
}) {
  return (
    <View className="flex-row gap-3">
      <TransferButton icon={Plus} label="Add funds" onPress={onDeposit} />
      <TransferButton icon={ArrowUpRight} label={withdrawLabel} onPress={onWithdraw} />
      {/* Frontend: `glass-soft flex w-14 items-center justify-center rounded-2xl text-white/50`. */}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="View activity"
        onPress={onActivity}
        className="w-14 items-center justify-center rounded-2xl bg-well"
      >
        <MoreHorizontal size={18} color={colors.fg["45"]} />
      </PressableScale>
    </View>
  );
}
