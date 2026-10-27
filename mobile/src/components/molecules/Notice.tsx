import { useState } from "react";
import { Pressable, View } from "react-native";
import { CircleAlert, Info } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import colors from "@/theme/colors.json";

/** Provider and transport failures (stack-ish text) are never shown as the headline. */
const TECHNICAL =
  /fetch failed|exception|network request failed|econn|etimedout|status \d{3}|java\.|typeerror/i;
export const OFFLINE_MESSAGE = "Can’t reach Gizu right now. Check your connection and try again.";

export function friendlyError(message: string) {
  return TECHNICAL.test(message) ? OFFLINE_MESSAGE : message;
}

export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  const [details, setDetails] = useState(false);
  const shown = error ? friendlyError(message) : message;
  const Icon = error ? CircleAlert : Info;
  return (
    <View
      className={`gap-2 rounded-2xl border px-4 py-3 ${error ? "border-danger/25 bg-danger/[0.06]" : "border-glassBorder bg-glass"}`}
    >
      <View className="flex-row items-start gap-3">
        <View className="pt-0.5">
          <Icon size={16} color={error ? colors.danger : colors.accent} />
        </View>
        <Typography
          className="flex-1 text-[14px] leading-5 text-text"
          accessibilityRole={error ? "alert" : "text"}
          accessibilityLiveRegion={error ? "polite" : "none"}
        >
          {shown}
        </Typography>
      </View>
      {shown !== message && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: details }}
          onPress={() => setDetails((value) => !value)}
          className="min-h-9 justify-center pl-7"
        >
          <Typography variant="micro">{details ? message : "Details"}</Typography>
        </Pressable>
      )}
    </View>
  );
}
