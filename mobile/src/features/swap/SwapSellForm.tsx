import { useState, type ReactNode } from "react";
import { Modal, TextInput, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { Notice } from "@/components/molecules/Notice";
import { Surface } from "@/components/molecules/Surface";
import { Screen } from "@/components/templates/Screen";
import colors from "@/theme/colors.json";
import { parseTokenAmount } from "@/domain/swap";
import type { CatalogToken } from "@/domain/tokenCatalog";
import { holdingAmount } from "./SwapHoldingsSection";
import { ESTIMATE_INFO, SwapAmountBox } from "./SwapAmountBox";
import { TokenChoices } from "./SwapTokenPicker";
import { useSellEstimate } from "./useSellEstimate";
import { useSwapHoldings } from "./useSwapHoldings";

/**
 * Sells a held token into confidential USDC. Without holdings it becomes a preview: any swap
 * token and amount can be priced, but nothing can be sold until the wallet holds it.
 */
export function SwapSellForm({
  flip,
  fundingAddress,
  onSettled,
}: {
  flip: ReactNode;
  fundingAddress: string;
  onSettled: () => void;
}) {
  const holdings = useSwapHoldings(onSettled);
  const list = holdings.snapshot?.holdings ?? [];
  const [chosen, setChosen] = useState("");
  const holding = list.find((item) => item.token === chosen) ?? list[0];

  const previewing = !!holdings.snapshot && !holding;
  const [previewToken, setPreviewToken] = useState<CatalogToken | null>(null);
  const [previewAmount, setPreviewAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const previewAtoms =
    previewToken && previewToken.decimals > 0
      ? parseTokenAmount(previewAmount, previewToken.decimals)
      : null;
  const estimate = useSellEstimate(
    fundingAddress,
    previewing ? previewToken?.address : holding?.token,
    previewing
      ? previewAtoms !== null
        ? previewAtoms.toString()
        : null
      : (holding?.balanceAtoms ?? null),
  );
  return (
    <>
      <Surface>
        <View className="gap-1.5 p-2">
          <SwapAmountBox
            label="You pay"
            note={
              previewing
                ? previewToken
                  ? `Available: 0 ${previewToken.symbol}`
                  : undefined
                : holding
                  ? `Available: ${holdingAmount(holding.balanceAtoms, holding.decimals)} ${holding.symbol}`
                  : undefined
            }
          >
            {previewing ? (
              <TextInput
                accessibilityLabel="Amount to sell"
                value={previewAmount}
                onChangeText={setPreviewAmount}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.fg["20"]}
                maxLength={40}
                className="font-sans min-h-14 flex-1 text-[36px] text-text"
                style={{ fontVariant: ["tabular-nums"] }}
              />
            ) : (
              <Typography
                variant="rowTitle"
                numberOfLines={1}
                adjustsFontSizeToFit
                className={`flex-1 !text-[36px] ${holding ? "" : "!text-fg-20"}`}
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {holding ? holdingAmount(holding.balanceAtoms, holding.decimals) : "0"}
              </Typography>
            )}
            {previewing || list.length > 1 ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={previewing ? "Choose token to sell" : "Choose held token"}
                accessibilityState={{ expanded: picking, disabled: holdings.busy }}
                disabled={holdings.busy}
                onPress={() => setPicking(true)}
                className="flex-row items-center gap-2 rounded-full bg-neon/15 px-3 py-2"
              >
                <Typography variant="rowTitle" className="!text-neon">
                  {(previewing ? previewToken?.symbol : holding?.symbol) ?? "Choose"}
                </Typography>
                <ChevronDown size={14} color={colors.fg["70"]} />
              </PressableScale>
            ) : (
              <View className="rounded-full bg-neon/15 px-3 py-2">
                <Typography variant="rowTitle" className="!text-neon">
                  {holding?.symbol ?? "—"}
                </Typography>
              </View>
            )}
          </SwapAmountBox>
          {flip}
          <SwapAmountBox
            label="You receive"
            note={estimate?.kind === "unavailable" ? "Estimate unavailable" : undefined}
            info={estimate?.kind === "ready" ? ESTIMATE_INFO : undefined}
          >
            <Typography
              variant="rowTitle"
              numberOfLines={1}
              adjustsFontSizeToFit
              accessibilityLabel={
                estimate?.kind === "ready" ? `Estimated ${estimate.text} USDC` : undefined
              }
              className={`flex-1 !text-[36px] ${estimate?.kind === "ready" ? "" : "!text-fg-20"}`}
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {estimate?.kind === "ready"
                ? estimate.text
                : estimate?.kind === "loading"
                  ? "…"
                  : "0"}
            </Typography>
            <View className="rounded-full bg-neon/15 px-3 py-2">
              <Typography variant="rowTitle" className="!text-neon">
                USDC
              </Typography>
            </View>
          </SwapAmountBox>
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
          message="Couldn’t finish the swap. Check its status in Swap before trying again."
          actionLabel="Check status"
          onAction={onSettled}
          busy={holdings.busy}
        />
      ) : null}
      {holdings.notice ? <Notice message={holdings.notice} /> : null}
      <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)}>
        {picking && previewing && (
          <TokenChoices
            target={previewToken?.address ?? ""}
            disabled={false}
            onClose={() => setPicking(false)}
            onSelect={(token) => {
              setPreviewToken(token);
              setPicking(false);
            }}
          />
        )}
        {picking && !previewing && (
          <Screen>
            <View className="flex-row items-center justify-between gap-3">
              <Typography variant="heading" accessibilityRole="header" className="flex-1">
                Choose token
              </Typography>
              <Button label="Close" variant="quiet" onPress={() => setPicking(false)} />
            </View>
            <View className="gap-2" accessibilityRole="radiogroup">
              {list.map((item) => (
                <PressableScale
                  key={item.token}
                  accessibilityRole="radio"
                  accessibilityLabel={item.symbol}
                  accessibilityState={{ checked: item.token === holding?.token }}
                  onPress={() => {
                    setChosen(item.token);
                    setPicking(false);
                  }}
                  className={`flex-row items-center justify-between gap-3 rounded-2xl px-4 py-3 ${item.token === holding?.token ? "bg-neon/10" : "bg-well"}`}
                >
                  <Typography
                    variant="rowTitle"
                    className={item.token === holding?.token ? "!text-neon" : ""}
                  >
                    {item.symbol}
                  </Typography>
                  <Typography variant="micro">
                    {holdingAmount(item.balanceAtoms, item.decimals)}
                  </Typography>
                </PressableScale>
              ))}
            </View>
          </Screen>
        )}
      </Modal>
      <Button
        label={holdings.busy ? "Preparing…" : "Swap"}
        disabled={
          holdings.busy ||
          !!holdings.error ||
          holdings.saleFailed ||
          !holding ||
          BigInt(holding.balanceAtoms) === 0n
        }
        onPress={() => {
          if (holding) void holdings.sell(`${holding.token}:all`);
        }}
      />
    </>
  );
}
