import { Image, TextInput, View } from "react-native";
import { CircleCheck } from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Spinner } from "@/components/atoms/Spinner";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import { Screen } from "@/components/templates/Screen";
import { formatUsdc } from "@/domain/wallet/amounts";
import { protocolLogo } from "@/features/opportunities/protocolLogos";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import colors from "@/theme/colors.json";
import { useDemoVaultAction } from "./useDemoVaultAction";

/** Simulated deposit: shared demo balances only, with no native signing or submission. */
export function DemoDepositScreen({
  vaultId,
  vaultName,
  protocolName,
}: {
  vaultId: string;
  vaultName: string;
  protocolName: string;
}) {
  const v = useDemoVaultAction(vaultId, "deposit");
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const done = v.phase === "done",
    processing = v.phase === "processing";
  const logo = protocolLogo(protocolName);
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <View className="flex-row items-center gap-3">
        {logo && (
          <Image
            source={logo}
            accessibilityLabel={protocolName}
            className="h-10 w-10"
            resizeMode="contain"
          />
        )}
        <View className="flex-1 gap-1">
          <Typography variant="pageTitle">
            {done
              ? "Deposit complete"
              : processing
                ? "Depositing"
                : v.phase === "review"
                  ? "Review deposit"
                  : "Deposit"}
          </Typography>
          <Typography variant="row">{vaultName}</Typography>
        </View>
      </View>
      {v.phase === "amount" && (
        <Surface>
          <View className="gap-3 p-5">
            <Typography variant="caption">Amount in USDC</Typography>
            <TextInput
              accessibilityLabel="USDC deposit amount"
              value={v.amount}
              onChangeText={v.setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.fg[45]}
              className="min-h-16 rounded-2xl bg-well px-4 py-3 font-sans text-[36px] text-text"
              maxLength={38}
            />
            <Typography variant="caption">
              {v.balanceLoading
                ? "Checking available USDC…"
                : v.balanceUnavailable
                  ? "Available USDC is unavailable. Refresh your wallet before investing."
                  : `Available: ${v.balance} USDC`}
            </Typography>
            <Button
              label="Max"
              variant="quiet"
              disabled={v.balanceLoading || v.balanceUnavailable || v.empty}
              onPress={v.max}
            />
          </View>
        </Surface>
      )}
      {v.quote && v.phase !== "amount" && (
        <Surface>
          <View className="gap-4 p-5">
            {done && <CircleCheck size={48} color={colors.neon.DEFAULT} />}
            {processing && <Spinner size="lg" label="Processing deposit" />}
            <Typography variant="caption">{done ? "Invested" : "You invest"}</Typography>
            <Typography variant="value" className="!text-[28px] text-neon">
              {formatUsdc(v.quote.receiveAtoms)} USDC
            </Typography>
            {v.phase === "review" && (
              <>
                <View className="flex-row flex-wrap justify-between gap-2">
                  <Typography variant="caption">You pay</Typography>
                  <Typography variant="row">{formatUsdc(v.quote.amountAtoms)} USDC</Typography>
                </View>
                <View className="flex-row flex-wrap justify-between gap-2">
                  <Typography variant="caption">Estimated fee</Typography>
                  <Typography variant="row">{formatUsdc(v.quote.feeAtoms)} USDC</Typography>
                </View>
              </>
            )}
            {done && (
              <Typography variant="caption">Your vault position has been updated.</Typography>
            )}
          </View>
        </Surface>
      )}
      {v.message && <Typography accessibilityRole="alert">{v.message}</Typography>}
      <View className="mt-auto gap-3 pt-5">
        {v.phase === "amount" ? (
          <Button label="Review deposit" disabled={!v.canReview} onPress={v.review} />
        ) : v.phase === "review" ? (
          <>
            <Button label="Confirm deposit" onPress={v.confirm} />
            <Button label="Edit amount" variant="quiet" onPress={v.edit} />
          </>
        ) : processing ? (
          <Button label="Processing deposit…" disabled loading onPress={() => undefined} />
        ) : (
          <Button
            label="Done"
            onPress={() => {
              if (navigation.canGoBack()) navigation.goBack();
              else navigation.navigate("Main", { screen: "Home" });
            }}
          />
        )}
      </View>
    </Screen>
  );
}
