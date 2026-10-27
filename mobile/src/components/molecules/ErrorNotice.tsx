import { useState } from "react";
import { Pressable, View } from "react-native";
import { CircleAlert } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import colors from "@/theme/colors.json";

const diagnosticCodes = {
  balance: "PORTFOLIO_READ_FAILED",
  holdings: "HOLDINGS_READ_FAILED",
  tokenSearch: "TOKEN_SEARCH_FAILED",
  sale: "SALE_STATUS_REQUIRES_REVIEW",
  vault: "VAULT_READ_FAILED",
  initial: "CATALOG_READ_FAILED",
  more: "CATALOG_PAGE_FAILED",
  refresh: "CATALOG_REFRESH_FAILED",
  stalled: "CATALOG_REFRESH_REQUIRED",
} as const;

/** Display curated copy and fixed codes only, never raw provider exceptions. */
export function ErrorNotice({
  message,
  kind,
  stale = false,
  actionLabel = "Try again",
  onAction,
  busy = false,
}: {
  message: string;
  kind: keyof typeof diagnosticCodes;
  stale?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-1 rounded-2xl border border-danger/25 bg-danger/[0.06] px-4 pb-1 pt-3">
      <View className="flex-row items-start gap-3">
        <View className="pt-0.5">
          <CircleAlert size={16} color={colors.danger} />
        </View>
        <Typography
          className="flex-1 text-[14px] leading-5 text-text"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {message}
          {stale ? " Previously loaded balances may be stale." : ""}
        </Typography>
      </View>
      <View className="flex-row items-center justify-between pl-7">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Error details"
          accessibilityState={{ expanded }}
          className="min-h-11 justify-center"
          onPress={() => setExpanded((value) => !value)}
        >
          <Typography variant="micro">
            {expanded ? "Hide error details" : "Error details"}
          </Typography>
        </Pressable>
        {onAction && (
          <Button label={actionLabel} variant="quiet" disabled={busy} onPress={onAction} />
        )}
      </View>
      {expanded && (
        <Typography variant="micro" selectable className="pb-2 pl-7">
          Code: {diagnosticCodes[kind]}
        </Typography>
      )}
    </View>
  );
}
