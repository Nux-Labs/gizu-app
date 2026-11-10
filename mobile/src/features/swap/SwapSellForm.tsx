import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { Notice } from "@/components/molecules/Notice";
import { Surface } from "@/components/molecules/Surface";
import colors from "@/theme/colors.json";
import { holdingAmount } from "./SwapHoldingsSection";
import { useSwapHoldings } from "./useSwapHoldings";

/** Sells a held token back to Monad USDC, the only destination the sale route supports. */
export function SwapSellForm({ flip, onSettled }: { flip: ReactNode; onSettled: () => void }) {
  const holdings = useSwapHoldings(onSettled);
  const list = holdings.snapshot?.holdings ?? [];
  const [chosen, setChosen] = useState("");
  const holding = list.find((item) => item.token === chosen) ?? list[0];
  const batch = holding?.batches[0];
  return (
    <>
      <Surface>
        <View className="gap-1.5 p-2">
          <View className="gap-3 rounded-[20px] bg-well p-4">
            <Typography variant="label11">You pay</Typography>
            <View className="flex-row items-center justify-between gap-3">
              <Typography
                variant="rowTitle"
                numberOfLines={1}
                adjustsFontSizeToFit
                className={`flex-1 !text-[36px] ${holding ? "" : "!text-fg-20"}`}
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {holding ? holdingAmount(holding.balanceAtoms, holding.decimals) : "0"}
              </Typography>
              <View className="rounded-full bg-neon/15 px-3 py-2">
                <Typography variant="rowTitle" className="!text-neon">
                  {holding?.symbol ?? "—"}
                </Typography>
              </View>
            </View>
            {list.length > 1 ? (
              <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
                {list.map((item) => (
                  <PressableScale
                    key={item.token}
                    accessibilityRole="radio"
                    accessibilityLabel={item.symbol}
                    accessibilityState={{ checked: item.token === holding?.token }}
                    disabled={holdings.busy}
                    onPress={() => setChosen(item.token)}
                    className={`rounded-full px-3 py-1.5 ${item.token === holding?.token ? "bg-neon/15" : "bg-card"}`}
                  >
                    <Typography
                      variant="caption"
                      className={item.token === holding?.token ? "!text-neon" : ""}
                    >
                      {item.symbol}
                    </Typography>
                  </PressableScale>
                ))}
              </View>
            ) : null}
            <Typography variant="micro">
              {holdings.snapshot && !holding
                ? "No sellable tokens found in your swap wallets."
                : holdings.busy && !holding
                  ? "Checking holdings…"
                  : "Sells this token's full balance in your swap wallets."}
            </Typography>
          </View>
          {flip}
          <View className="gap-3 rounded-[20px] bg-well p-4">
            <Typography variant="label11">You receive</Typography>
            <View className="flex-row items-center justify-between gap-3">
              <Typography variant="micro" className="flex-1">
                Kept in your confidential balance
              </Typography>
              <View className="flex-row items-center gap-2 rounded-full bg-neon/15 px-3 py-2">
                <Typography variant="rowTitle" className="!text-neon">
                  USDC
                </Typography>
                <ChevronDown size={14} color={colors.fg["20"]} />
              </View>
            </View>
            <Typography variant="micro">
              Confidential USDC · withdraw from Gizu separately
            </Typography>
          </View>
        </View>
      </Surface>
      {holdings.error ? (
        <ErrorNotice
          kind="holdings"
          message="Couldn’t refresh your holdings."
          stale={!!holdings.snapshot}
          actionLabel="Retry holdings"
          busy={holdings.busy}
          onAction={() => void holdings.retryRead()}
        />
      ) : null}
      {holdings.saleFailed ? (
        <ErrorNotice
          kind="sale"
          message="Couldn’t finish the sale. Check its status in Swap before trying again."
          actionLabel="Check status"
          onAction={onSettled}
          busy={holdings.busy}
        />
      ) : null}
      {holdings.notice ? <Notice message={holdings.notice} /> : null}
      {holding && !batch ? (
        <Typography variant="micro">
          Balance found, but no complete receiving-wallet group is available to sell.
        </Typography>
      ) : null}
      <Button
        label={holdings.busy ? "Working" : `Sell ${holding?.symbol ?? "token"} for USDC`}
        disabled={holdings.busy || !!holdings.error || holdings.saleFailed || !batch}
        onPress={() => {
          if (batch) void holdings.sell(batch.id);
        }}
      />
    </>
  );
}
