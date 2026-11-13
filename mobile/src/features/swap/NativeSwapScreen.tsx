import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useState } from "react";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { MainTabParamList } from "@/navigation/types";
import { TextInput, View } from "react-native";
import { ArrowDown } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { SwapTokenPicker } from "./SwapTokenPicker";
import { SwapSellForm } from "./SwapSellForm";
import { SwapAmountBox } from "./SwapAmountBox";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Surface } from "@/components/molecules/Surface";
import { ActiveSwapCard, LastSwapButton, LastSwapSummary, isFinished } from "./SwapStatusPanel";
import { Screen } from "@/components/templates/Screen";
import { formatSwapAmount } from "@/domain/swap";
import { groupDigits } from "@/domain/wallet/amounts";
import { portfolioPublicUsdcAtoms } from "@/domain/wallet/portfolioValue";
import colors from "@/theme/colors.json";
import { useNativeSwap } from "./useNativeSwap";

export function NativeSwapScreen({
  route,
}: Partial<BottomTabScreenProps<MainTabParamList, "Exchange">> = {}) {
  const swap = useNativeSwap();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const request = route?.params;
  const [sellToken, setSellToken] = useState<string | undefined>();
  // Home asset shortcuts open a direction (and the held token to sell) on each tap.
  const [handled, setHandled] = useState<number | undefined>();
  if (request && request.request !== handled) {
    setHandled(request.request);
    setMode(request.mode);
    setSellToken(request.mode === "sell" ? request.token?.toLowerCase() : undefined);
  }
  const [showLast, setShowLast] = useState(false);
  const wallet = useOptionalMainnetWallet();
  const publicAtoms = wallet?.snapshot ? portfolioPublicUsdcAtoms(wallet.snapshot) : null;
  const maxAmount = publicAtoms !== null ? formatSwapAmount(BigInt(publicAtoms)) : null;
  const selected = swap.tokens.find((token) => token.address === swap.target);
  const active =
    swap.status !== null && swap.status.phase !== "COMPLETE" && swap.status.phase !== "CANCELLED";
  const refunded = swap.status?.phase === "PAUSED" && swap.status.pausedCode === "FUNDING_REFUNDED";
  // A sale that stopped before any order was signed has moved nothing, so leaving it is safe even
  // though it was approved; without this, a rejected quote would trap the screen on Resume.
  const nothingMoved =
    swap.status?.phase === "PAUSED" &&
    swap.status.direction === "sell" &&
    swap.status.ordersComplete === 0 &&
    swap.status.payoutsSubmitted === 0 &&
    /^(QUOTE_REJECTED|FUSION_UNAVAILABLE|PLANNING_UNAVAILABLE|TARGET_ILLIQUID|NO_HOLDINGS|NOTHING_SELLABLE|HOLDER_\d+_HOLDS_ETH)$/.test(
      swap.status.pausedCode ?? "",
    );
  const flip = (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Reverse direction"
      disabled={swap.busy}
      onPress={() => setMode(mode === "buy" ? "sell" : "buy")}
      className="z-10 -my-4 h-9 w-9 items-center justify-center self-center rounded-full border border-cardEdge bg-card"
    >
      <ArrowDown size={16} color={colors.fg["70"]} />
    </PressableScale>
  );
  return (
    <Screen
      refreshing={swap.busy}
      onRefresh={() => {
        if (!swap.busy) void swap.refresh();
      }}
    >
      <View className="flex-row items-start justify-between gap-3 pb-1">
        <Typography variant="pageTitle" className="flex-1 !text-[26px]">
          Swap
        </Typography>
        {isFinished(swap.status) ? (
          <LastSwapButton
            status={swap.status}
            open={showLast}
            onPress={() => setShowLast((value) => !value)}
          />
        ) : null}
      </View>
      {isFinished(swap.status) && showLast ? (
        <LastSwapSummary status={swap.status} canSell={swap.canSell} />
      ) : null}
      {active && swap.status ? <ActiveSwapCard status={swap.status} /> : null}
      {!active && mode === "sell" && (
        <SwapSellForm
          key={sellToken ?? "default"}
          initialToken={sellToken}
          flip={flip}
          fundingAddress={swap.fundingAddress}
          onSettled={() => void swap.refresh()}
        />
      )}
      {!active && mode === "buy" && (
        <>
          <Surface>
            <View className="gap-1.5 p-2">
              <SwapAmountBox
                label="You pay"
                note={
                  !wallet
                    ? undefined
                    : publicAtoms !== null
                      ? `Available: ${groupDigits(formatSwapAmount(BigInt(publicAtoms)))} USDC`
                      : "Checking available USDC…"
                }
              >
                <TextInput
                  accessibilityLabel="Amount in USDC"
                  value={swap.amount}
                  onChangeText={swap.setAmount}
                  editable={!swap.busy}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.fg["20"]}
                  maxLength={21}
                  className="font-sans min-h-14 flex-1 text-[36px] text-text"
                  style={{ fontVariant: ["tabular-nums"] }}
                />
                <Typography variant="rowTitle" className="!text-fg-55">
                  USDC
                </Typography>
                <Button
                  label="Max"
                  accessibilityLabel="Use maximum USDC amount"
                  variant="quiet"
                  disabled={swap.busy || maxAmount === null}
                  onPress={() => {
                    if (maxAmount !== null) swap.setAmount(maxAmount);
                  }}
                />
              </SwapAmountBox>
              {flip}
              <SwapTokenPicker
                tokens={swap.tokens}
                target={swap.target}
                disabled={swap.busy}
                estimate={swap.estimate}
                onSelect={swap.selectToken}
              />
            </View>
          </Surface>
          <Button
            label={swap.busy ? "Preparing…" : "Swap"}
            onPress={swap.start}
            disabled={!swap.canStart}
          />
          {!swap.busy && !swap.canStart && (!swap.target || Number(swap.amount) > 0) && (
            // Say why review is unavailable; an empty amount field needs no prompt.
            <Typography
              variant="micro"
              className="-mt-2 px-1 text-center"
              accessibilityLiveRegion="polite"
            >
              {!swap.target ? "Choose a token to receive." : "Check the amount to pay."}
            </Typography>
          )}
        </>
      )}
      {swap.error ? <Notice message={swap.error} error /> : null}
      {active ? (
        <View className="gap-3">
          <Button
            label={swap.busy ? "Preparing…" : "Resume"}
            onPress={swap.resume}
            disabled={swap.busy}
          />
          {swap.status?.approved && !refunded && !nothingMoved ? (
            <Typography variant="micro" className="px-1 text-center">
              Approved steps may already have moved funds, so this swap can only be resumed.
            </Typography>
          ) : (
            <Button
              label="Cancel swap"
              variant="secondary"
              onPress={swap.cancel}
              disabled={swap.busy}
            />
          )}
        </View>
      ) : (
        <View className="gap-3">
          {swap.canPayout ? (
            <Button
              label={swap.busy ? "Preparing…" : `Swap to ${selected?.symbol ?? "token"}`}
              onPress={swap.payout}
              disabled={swap.busy}
            />
          ) : null}
          {mode === "buy" && swap.canSell ? (
            <Button
              label={swap.busy ? "Preparing…" : "Swap to USDC"}
              onPress={swap.sell}
              disabled={swap.busy}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}
