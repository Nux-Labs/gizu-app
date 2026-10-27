import { Pressable, Text, useWindowDimensions } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { Spinner } from "@/components/atoms/Spinner";
import { PrimaryFill } from "@/components/atoms/PrimaryFill";

/**
 * Full-width primary access action (frontend `neon-btn`: 56 pt, button radius, neon
 * fill, dark text) with a leading icon. Built on a plain Pressable so NativeWind
 * styles apply directly on every platform.
 */
export function AccessCard({
  label,
  icon: Icon,
  onPress,
  disabled = false,
  loading = false,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  // Remeasure native text after Dynamic Type changes.
  const { fontScale } = useWindowDimensions();
  const unavailable = disabled || loading;
  const foreground = disabled ? colors.fg["35"] : colors.ctaText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: unavailable, busy: loading }}
      disabled={unavailable}
      onPress={onPress}
      className={`min-h-14 w-full flex-row items-center justify-center gap-3 rounded-button px-5 py-4 active:opacity-85 ${disabled ? "border border-borderSoft bg-glassSoft" : "overflow-hidden bg-neon"}`}
    >
      {!disabled && <PrimaryFill />}
      {loading ? (
        <Spinner size="sm" color={foreground} />
      ) : (
        <Icon size={20} strokeWidth={2} color={foreground} />
      )}
      <Text
        key={fontScale}
        className="font-sans shrink text-center text-[15px] font-semibold"
        style={{ color: foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
