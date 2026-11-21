import { useState } from "react";
import { Info } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { Modal, View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Typography } from "@/components/atoms/Typography";
import { PressableScale } from "@/components/atoms/PressableScale";
import { InfiniteListScreen } from "@/components/templates/InfiniteListScreen";
import { Badge } from "@/components/atoms/Badge";
import {
  isSwapChain,
  swapChains,
  tokenDisplayName,
  tokenIdentity,
  tokenNetworks,
  type CatalogToken,
} from "@/domain/tokenCatalog";
import { useTokenCatalog } from "./useTokenCatalog";
import type { ListedToken } from "./confidentialSwap";
import { ESTIMATE_INFO, SwapAmountBox } from "./SwapAmountBox";
import { RobinhoodChainMark } from "./components/RobinhoodChainMark";
import { TokenPill } from "./components/TokenPill";
import { TokenDetail } from "./TokenDetail";
import { formatUsd } from "./formatUsd";

/** "1 AAPL = $227.40" for the receive row; nothing when the catalog has no market price. */
function unitPrice(token: ListedToken): string | undefined {
  return typeof token.priceUsd === "number" && Number.isFinite(token.priceUsd) && token.priceUsd > 0
    ? `1 ${token.symbol} = ${formatUsd(token.priceUsd)}`
    : undefined;
}

export function SwapTokenPicker({
  tokens,
  target,
  disabled,
  estimate,
  onSelect,
}: {
  tokens: ListedToken[];
  target: string;
  disabled: boolean;
  estimate?: { text: string; loading: boolean } | null;
  onSelect: (token: CatalogToken) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = tokens.find((token) => token.address === target);
  return (
    <>
      <SwapAmountBox
        label="You receive"
        note={selected ? unitPrice(selected) : undefined}
        info={estimate && !estimate.loading ? ESTIMATE_INFO : undefined}
      >
        <Typography
          variant="amount"
          numberOfLines={1}
          adjustsFontSizeToFit
          className={`min-w-0 flex-1 ${estimate && !estimate.loading ? "" : "!text-fg-20"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {estimate && !estimate.loading ? estimate.text : estimate ? "…" : "0"}
        </Typography>
        <TokenPill
          symbol={selected?.symbol ?? "Choose"}
          logo={selected ? { uri: selected.logoURI } : undefined}
          accessibilityLabel="Choose receive token"
          disabled={disabled}
          expanded={open}
          onPress={() => setOpen(true)}
          className="max-w-[52%]"
        />
      </SwapAmountBox>
      {open && (
        <TokenChoices
          target={target}
          disabled={disabled}
          onClose={() => setOpen(false)}
          onSelect={(token) => {
            onSelect(token);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

export function TokenChoices({
  target,
  disabled,
  onClose,
  onSelect,
}: {
  target: string;
  disabled: boolean;
  onClose: () => void;
  onSelect: (token: CatalogToken) => void;
}) {
  // Swap buys stocks on Robinhood Chain and Base, so the picker lists both chains (Robinhood
  // first) and nothing a buy cannot target. A stock on both chains appears once per chain.
  const { query, queryKey, list, change } = useTokenCatalog({
    category: "rwa",
    chainId: null,
    chainIds: swapChains,
    liquidOnly: true,
  });
  // The list's data and query live here, so returning from a detail page keeps them.
  const [detail, setDetail] = useState<CatalogToken | null>(null);
  const content = detail ? (
    <TokenDetail
      address={detail.address}
      chainId={isSwapChain(detail.chainId) ? detail.chainId : undefined}
      disabled={disabled}
      onBack={() => setDetail(null)}
      onSelect={() => onSelect(detail)}
    />
  ) : (
    <InfiniteListScreen
      list={list}
      queryKey={queryKey}
      getIdentity={tokenIdentity}
      noun="tokens"
      unavailableMessage="Token catalog unavailable. Please retry."
      emptyMessage="No tokens found."
      header={
        <>
          <View className="flex-row items-center justify-between gap-3">
            <Typography variant="heading" accessibilityRole="header" className="flex-1">
              Choose token
            </Typography>
            <Button label="Close" variant="quiet" onPress={onClose} />
          </View>
          <SearchInput
            label="Search tokens"
            value={query.search}
            maxLength={200}
            onChangeText={(search) => change({ search })}
          />
        </>
      }
      renderItem={(item) => {
        const selectable =
          isSwapChain(item.chainId) &&
          item.category === "rwa" &&
          item.swapListed &&
          item.buyable !== false;
        const checked =
          isSwapChain(item.chainId) && item.address.toLowerCase() === target.toLowerCase();
        const price = typeof item.priceUsd === "number" ? formatUsd(item.priceUsd) : null;
        return (
          <View className="mb-2 flex-row items-stretch gap-2">
            <PressableScale
              accessibilityRole="radio"
              accessibilityLabel={`${item.symbol} · ${tokenDisplayName(item.name)}`}
              accessibilityState={{ checked, disabled: disabled || !selectable }}
              accessibilityValue={price ? { text: price } : undefined}
              disabled={disabled || !selectable}
              onPress={() => {
                if (selectable && !disabled) onSelect(item);
              }}
              className={`flex-1 gap-1 rounded-2xl px-4 py-3 ${checked ? "bg-neon/10" : "bg-well"} ${!selectable ? "opacity-60" : ""}`}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Typography variant="rowTitle" className={`flex-1 ${checked ? "!text-neon" : ""}`}>
                  {item.symbol}
                </Typography>
                {price && (
                  <Typography variant="rowValue" style={{ fontVariant: ["tabular-nums"] }}>
                    {price}
                  </Typography>
                )}
                {item.chainId === 4663 ? (
                  <RobinhoodChainMark />
                ) : (
                  <Badge
                    label={
                      tokenNetworks.find((network) => network.chainId === item.chainId)?.name ?? ""
                    }
                  />
                )}
              </View>
              <Typography variant="micro">{tokenDisplayName(item.name)}</Typography>
              {!selectable && <Typography variant="micro">Not available for swaps</Typography>}
            </PressableScale>
            {selectable && (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${item.symbol} details`}
                onPress={() => setDetail(item)}
                hitSlop={4}
                className="w-12 items-center justify-center rounded-2xl bg-well"
              >
                <Info size={18} color={colors.fg["55"]} />
              </PressableScale>
            )}
          </View>
        );
      }}
    />
  );
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (detail) setDetail(null);
        else onClose();
      }}
    >
      {content}
    </Modal>
  );
}
