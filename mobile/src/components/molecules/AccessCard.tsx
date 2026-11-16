import type { LucideIcon } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { Button } from "@/components/atoms/Button";

/**
 * Full-width primary access action (frontend `neon-btn`: 56 pt, button radius, neon
 * fill, dark text) with a leading icon. Shares the native label/background layering
 * with every other primary action.
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
  const foreground = disabled ? colors.fg["35"] : colors.ctaText;
  return (
    <Button
      label={label}
      disabled={disabled}
      loading={loading}
      onPress={onPress}
      icon={<Icon size={20} strokeWidth={2} color={foreground} />}
    />
  );
}
