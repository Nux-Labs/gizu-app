import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { ArrowDown } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { SwapTokenPicker } from "./SwapTokenPicker";
import { SwapSellForm } from "./SwapSellForm";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Surface } from "@/components/molecules/Surface";
import { ActiveSwapCard, LastSwapButton, LastSwapSummary, isFinished } from "./SwapStatusPanel";
import { Screen } from "@/components/templates/Screen";
import { formatSwapAmount } from "@/domain/swap";
import { groupDigits } from "@/domain/wallet/amounts";
import colors from "@/theme/colors.json";
import { useNativeSwap } from "./useNativeSwap";

export function NativeSwapScreen() {
  const swap = useNativeSwap();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [showLast, setShowLast] = useState(false);
  const wallet = useOptionalMainnetWallet();
  const maxAmount =
    wallet?.snapshot && wallet.snapshot.balanceComplete !== false
      ? formatSwapAmount(BigInt(wallet.snapshot.totalAtoms))
      : null;
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
      accessibilityLabel={mode === "buy" ? "Switch to selling" : "Switch to buying"}
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
        <SwapSellForm flip={flip} onSettled={() => void swap.refresh()} />
      )}
      {!active && mode === "buy" && (
        <>
          <Surface>
            <View className="gap-1.5 p-2">
              <View className="gap-3 rounded-[20px] bg-well p-4">
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <Typography variant="label11">You pay</Typography>
                  {wallet && (
                    <Typography variant="micro">
                      {wallet.snapshot && wallet.snapshot.balanceComplete !== false
                        ? `Available${wallet.error || wallet.snapshot.stale ? " (cached)" : ""}: ${groupDigits(formatSwapAmount(BigInt(wallet.snapshot.totalAtoms)))} USDC`
                        : "Checking available USDC…"}
                    </Typography>
                  )}
                </View>
                <View className="flex-row items-center gap-3">
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
                </View>
              </View>
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
            label={swap.busy ? "Working" : "Review swap"}
            onPress={swap.start}
            disabled={!swap.canStart}
          />
          {!swap.busy && !swap.canStart && (
            // Say why review is unavailable instead of leaving a silent grey button.
            <Typography
              variant="micro"
              className="-mt-2 px-1 text-center"
              accessibilityLiveRegion="polite"
            >
              {!swap.target
                ? "Choose a token to receive."
                : Number(swap.amount) > 0
                  ? "Check the amount to pay."
                  : "Enter an amount to pay."}
            </Typography>
          )}
        </>
      )}
      {swap.error ? <Notice message={swap.error} error /> : null}
      {active ? (
        <View className="gap-3">
          <Button
            label={swap.busy ? "Working" : "Resume"}
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
              label={
                swap.busy ? "Working" : `Buy ${selected?.symbol ?? "token"} with private balance`
              }
              onPress={swap.payout}
              disabled={swap.busy}
            />
          ) : null}
          {swap.canSell ? (
            <Button
              label={swap.busy ? "Working" : "Sell back to USDC"}
              onPress={swap.sell}
              disabled={swap.busy}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}
