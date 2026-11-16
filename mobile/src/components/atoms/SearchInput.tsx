import { TextInput } from "react-native";
import colors from "@/theme/colors.json";
export function SearchInput({
  value,
  onChangeText,
  label,
  maxLength,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  maxLength?: number;
}) {
  return (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      value={value}
      maxLength={maxLength}
      onChangeText={onChangeText}
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      className="font-sans min-h-12 rounded-2xl border border-cardEdge bg-glassSoft px-4 py-3 text-[16px] leading-6 text-text focus:border-neon/60"
      style={{ includeFontPadding: false }}
    />
  );
}
