import { View } from "react-native";
import { Notice } from "@/components/molecules/Notice";
import { Button } from "@/components/atoms/Button";
import type { EarnInvestmentPosition } from "@/domain/earn/investmentPositions";

const messages = {
  confirming: "Your vault withdrawal is confirming.",
  checking: "A previous return has not been verified. Check its saved status.",
  unfinished: "Your withdrawal is not finished. Open the vault to return the USDG to private USDC.",
  returning: "Your private USDC return is confirming.",
} as const;

/** Historical confirmation is separate from a new withdrawal and its spending controls. */
export function WithdrawalStatusNotice({
  attention,
  onCheckPastReturn,
  canCheckPastReturn = attention === "checking",
}: {
  attention: EarnInvestmentPosition["withdrawalAttention"] | null;
  onCheckPastReturn: () => void;
  canCheckPastReturn?: boolean;
}) {
  if (!attention) return null;
  return (
    <View className="gap-2">
      <Notice message={messages[attention]} />
      {canCheckPastReturn && (
        <Button label="Check past return" variant="quiet" onPress={onCheckPastReturn} />
      )}
    </View>
  );
}
