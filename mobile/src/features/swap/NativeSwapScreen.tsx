import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useState } from "react";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { MainTabParamList } from "@/navigation/types";
import { TextInput, View } from "react-native";
import { ArrowDown, Lock } from "lucide-react-native";
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
import {
  portfolioPrivateUsdcAtoms,
  portfolioPublicUsdcAtoms,
} from "@/domain/wallet/portfolioValue";
import colors from "@/theme/colors.json";
import { useNativeSwap } from "./useNativeSwap";

const PRIVATE_PAY_INFO = {
  label: "About paying privately",
  text: "Uses your whole private USDC balance, including sale proceeds and Earn returns, in one buy. Nothing is taken from your wallet USDC.",
};

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
  // Sale proceeds and Earn returns stay private. A buy can spend them directly; the engine's
  // private-balance buy takes no amount, so it always uses the whole private balance.
  const privateAtoms = portfolioPrivateUsdcAtoms(wallet?.snapshot);
  const privateAmount =
    privateAtoms !== null && BigInt(privateAtoms) > 0n
      ? formatSwapAmount(BigInt(privateAtoms))
      : null;
  const [payFrom, setPayFrom] = useState<"wallet" | "private">("wallet");
  const fromPrivate = payFrom === "private" && privateAmount !== null;
  const choosePayFrom = (next: "wallet" | "private") => {
    if (swap.busy || next === payFrom) return;
    setPayFrom(next);
    swap.setAmount(next === "private" && privateAmount !== null ? privateAmount : "");
  };
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
                    : fromPrivate
                      ? `Private: ${groupDigits(privateAmount)} USDC`
                      : publicAtoms !== null
                        ? `Available: ${groupDigits(formatSwapAmount(BigInt(publicAtoms)))} USDC`
                        : "Checking available USDC…"
                }
                info={fromPrivate ? PRIVATE_PAY_INFO : undefined}
              >
                <TextInput
                  accessibilityLabel="Amount in USDC"
                  value={fromPrivate ? privateAmount : swap.amount}
                  onChangeText={swap.setAmount}
                  editable={!swap.busy && !fromPrivate}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={colors.fg["20"]}
                  maxLength={21}
                  className="font-sans min-h-14 min-w-0 flex-1 text-[36px] text-text"
                  selectionColor={colors.accent}
                  cursorColor={colors.accent}
                  style={{ fontVariant: ["tabular-nums"], includeFontPadding: false }}
                />
                {privateAmount !== null ? (
                  <PressableScale
                    accessibilityRole="switch"
                    accessibilityLabel="Pay with private USDC"
                    accessibilityState={{ checked: fromPrivate, disabled: swap.busy }}
                    disabled={swap.busy}
                    hitSlop={8}
                    onPress={() => choosePayFrom(fromPrivate ? "wallet" : "private")}
                    className={`flex-row items-center gap-1.5 rounded-full px-3 py-1.5 ${fromPrivate ? "bg-neon/10" : "bg-card"}`}
                  >
                    {fromPrivate ? <Lock size={13} color={colors.accent} /> : null}
                    <Typography
                      variant="rowTitle"
                      className={fromPrivate ? "!text-neon" : "!text-fg-55"}
                    >
                      {fromPrivate ? "Private" : "USDC"}
                    </Typography>
                  </PressableScale>
                ) : (
                  <Typography variant="rowTitle" className="!text-fg-55">
                    USDC
                  </Typography>
                )}
                {fromPrivate ? null : (
                  <Button
                    label="Max"
                    accessibilityLabel="Use maximum USDC amount"
                    variant="quiet"
                    disabled={swap.busy || maxAmount === null}
                    onPress={() => {
                      if (maxAmount !== null) swap.setAmount(maxAmount);
                    }}
                  />
                )}
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
            onPress={fromPrivate ? swap.payout : swap.start}
            disabled={fromPrivate ? !swap.canPayPrivate : !swap.canStart}
          />
          {!swap.busy &&
            !(fromPrivate ? swap.canPayPrivate : swap.canStart) &&
            (!swap.target || Number(swap.amount) > 0) && (
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
