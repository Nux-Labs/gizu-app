import { Image, TextInput, View } from "react-native";
import { ArrowDownLeft, CircleCheck } from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Spinner } from "@/components/atoms/Spinner";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import { Screen } from "@/components/templates/Screen";
import type { OpportunityDetail } from "@/domain/opportunities";
import { formatUsdc } from "@/domain/wallet/amounts";
import { protocolLogo } from "@/features/opportunities/protocolLogos";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import colors from "@/theme/colors.json";
import { useDemoVaultAction } from "./useDemoVaultAction";

export function DemoVaultWithdrawScreen({ vault }: { vault: OpportunityDetail }) {
  const v = useDemoVaultAction(vault.id, "withdrawal");
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const logo = protocolLogo(vault.protocol.name, vault.protocol.id);
  const done = v.phase === "done",
    processing = v.phase === "processing";
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <View className="gap-1">
        <Typography variant="pageTitle">
          {done ? "Withdrawal complete" : processing ? "Withdrawing" : "Withdraw"}
        </Typography>
      </View>
      <Surface>
        <View className="flex-row items-center gap-3 p-5">
          {logo && (
            <View className="h-12 w-12 items-center justify-center rounded-2xl bg-neon/10">
              <Image
                source={logo}
                className="h-8 w-8"
                resizeMode="contain"
                accessibilityLabel={vault.protocol.name}
              />
            </View>
          )}
          <View className="min-w-0 flex-1 gap-1">
            <Typography variant="cardTitle">{vault.name}</Typography>
            <Typography variant="micro">
              {vault.protocol.name} · {vault.chain.name}
            </Typography>
          </View>
        </View>
      </Surface>
      {v.phase === "amount" ? (
        <>
          <Surface>
            <View className="gap-5 p-5">
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <Typography variant="label11">You withdraw</Typography>
                <Typography variant="caption">Available: {v.balance} USDC</Typography>
              </View>
              <View className="flex-row items-center gap-2">
                <TextInput
                  accessibilityLabel="USDC withdrawal amount"
                  value={v.amount}
                  onChangeText={v.setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.fg[35]}
                  className="min-h-16 min-w-0 flex-1 font-sans text-[28px] text-text"
                  maxLength={38}
                  editable={!v.empty}
                />
                <Typography variant="row" className="text-fg-55">
                  USDC
                </Typography>
                <Button label="Max" variant="quiet" disabled={v.empty} onPress={v.max} />
              </View>
            </View>
          </Surface>
          {v.empty && <Typography>No balance left to withdraw from this vault.</Typography>}
        </>
      ) : (
        v.quote && (
          <Surface>
            <View className="gap-6 p-5">
              <View className="items-center gap-3 py-3" accessibilityLiveRegion="polite">
                {done ? (
                  <CircleCheck size={48} color={colors.neon.DEFAULT} />
                ) : processing ? (
                  <Spinner size="lg" label="Processing withdrawal" />
                ) : (
                  <ArrowDownLeft size={32} color={colors.neon.DEFAULT} />
                )}
                <Typography variant="label11">
                  {done ? "Added to your wallet" : "You receive"}
                </Typography>
                <Typography variant="value" className="!text-[28px] text-neon">
                  {formatUsdc(v.quote.receiveAtoms)}
                </Typography>
                <Typography variant="row">USDC on Monad</Typography>
              </View>
              {!done && !processing && (
                <View className="gap-3 border-t border-divider pt-4">
                  <View className="flex-row flex-wrap justify-between gap-2">
                    <Typography variant="caption">Withdrawal amount</Typography>
                    <Typography variant="row">{formatUsdc(v.quote.amountAtoms)} USDC</Typography>
                  </View>
                  <View className="flex-row flex-wrap justify-between gap-2">
                    <Typography variant="caption">Estimated fee</Typography>
                    <Typography variant="row">{formatUsdc(v.quote.feeAtoms)} USDC</Typography>
                  </View>
                  <View className="flex-row flex-wrap justify-between gap-2">
                    <Typography variant="caption">To your Gizu wallet</Typography>
                    <Typography variant="row">
                      {v.address.slice(0, 6)}…{v.address.slice(-4)}
                    </Typography>
                  </View>
                </View>
              )}
            </View>
          </Surface>
        )
      )}
      {v.message && <Typography accessibilityRole="alert">{v.message}</Typography>}
      <View className="mt-auto gap-3 pt-5">
        {v.phase === "amount" ? (
          <Button label="Review withdrawal" disabled={!v.canReview} onPress={v.review} />
        ) : v.phase === "review" ? (
          <>
            <Button label="Confirm withdrawal" onPress={v.confirm} />
            <Button label="Edit amount" variant="quiet" onPress={v.edit} />
          </>
        ) : processing ? (
          <Button label="Processing withdrawal…" disabled loading onPress={() => undefined} />
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
