import type { LucideIcon } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { PressableScale } from "./PressableScale";
import { Spinner } from "./Spinner";
export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  loading = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  // Frontend: `glass-soft h-11 w-11 rounded-2xl text-white/60`.
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      hitSlop={4}
      className={`h-11 w-11 items-center justify-center rounded-xl border border-glassBorder bg-glass ${disabled ? "opacity-50" : ""}`}
    >
      {loading ? <Spinner size="sm" /> : <Icon size={18} color={colors.fg["55"]} />}
    </PressableScale>
  );
}
