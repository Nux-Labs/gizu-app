import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Info } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import colors from "@/theme/colors.json";

const box = "gap-3 rounded-[20px] bg-well p-4";

/** Shared explanation for gross market estimates on the receive side. */
export const ESTIMATE_INFO = {
  label: "About this estimate",
  text: "Market estimate before fees. Gas, bridge fees and price movement are not included.",
};

/**
 * One pay/receive box. Every box has the same two rows (label + note, then a 56px amount row),
 * so the buy and sell forms keep one height and switching between them does not resize.
 */
export function SwapAmountBox({
  label,
  note,
  children,
  info,
}: {
  label: string;
  /** Short status on the label row; never a separate line, so the box height stays fixed. */
  note?: string;
  /** Explanation behind an (i) button; it opens over the box so the height stays fixed. */
  info?: { label: string; text: string };
  children: ReactNode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const content = (
    <>
      <View className="min-h-5 flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-1.5">
          <Typography variant="label11">{label}</Typography>
          {info ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={info.label}
              accessibilityState={{ expanded: infoOpen }}
              hitSlop={12}
              onPress={() => setInfoOpen((open) => !open)}
            >
              <Info size={13} color={colors.fg["55"]} />
            </Pressable>
          ) : null}
        </View>
        {note ? (
          <Typography variant="micro" numberOfLines={1} className="shrink text-right">
            {note}
          </Typography>
        ) : null}
      </View>
      <View className="min-h-14 flex-row items-center gap-3">{children}</View>
      {info && infoOpen ? (
        <Pressable
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
          onPress={() => setInfoOpen(false)}
          className="absolute left-3 right-3 top-10 z-20 rounded-xl border border-cardEdge bg-card px-3 py-2"
        >
          <Typography variant="micro">{info.text}</Typography>
        </Pressable>
      ) : null}
    </>
  );
  return <View className={box}>{content}</View>;
}
