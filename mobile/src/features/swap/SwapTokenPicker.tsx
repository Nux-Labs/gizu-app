import { useState } from "react";
import { ChevronDown } from "lucide-react-native";
import colors from "@/theme/colors.json";
import { Modal, View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Typography } from "@/components/atoms/Typography";
import { PressableScale } from "@/components/atoms/PressableScale";
import { InfiniteListScreen } from "@/components/templates/InfiniteListScreen";
import { Badge } from "@/components/atoms/Badge";
import { tokenIdentity, tokenNetworks, type CatalogToken } from "@/domain/tokenCatalog";
import { useTokenCatalog } from "./useTokenCatalog";
import type { ListedToken } from "./confidentialSwap";
import { ESTIMATE_INFO, SwapAmountBox } from "./SwapAmountBox";

const tokenKinds = [
  { category: "rwa", label: "Stocks" },
  { category: "other", label: "DeFi" },
] as const;

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
        note={selected?.name}
        info={estimate && !estimate.loading ? ESTIMATE_INFO : undefined}
      >
        <Typography
          variant="rowTitle"
          numberOfLines={1}
          adjustsFontSizeToFit
          className={`flex-1 !text-[36px] ${estimate && !estimate.loading ? "" : "!text-fg-20"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {estimate && !estimate.loading ? estimate.text : estimate ? "…" : "0"}
        </Typography>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Choose receive token"
          accessibilityState={{ disabled, expanded: open }}
          disabled={disabled}
          onPress={() => setOpen(true)}
          className="flex-row items-center gap-2 rounded-full bg-neon/15 px-3 py-2"
        >
          <Typography variant="rowTitle" className="!text-neon">
            {selected?.symbol ?? "Choose"}
          </Typography>
          <ChevronDown size={14} color={colors.fg["70"]} />
        </PressableScale>
      </SwapAmountBox>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
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
      </Modal>
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
  const { query, queryKey, list, change } = useTokenCatalog({ category: "rwa", chainId: null });
  return (
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
          <View
            className="flex-row gap-1 rounded-full bg-well p-1"
            accessibilityRole="radiogroup"
            accessibilityLabel="Token type"
          >
            {tokenKinds.map(({ category, label }) => {
              const selected = query.category === category;
              return (
                <PressableScale
                  key={category}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected }}
                  onPress={() => change({ category })}
                  className={`min-h-11 flex-1 items-center justify-center rounded-full ${selected ? "bg-neon/10" : ""}`}
                >
                  <Typography variant="caption" className={selected ? "!text-neon" : ""}>
                    {label}
                  </Typography>
                </PressableScale>
              );
            })}
          </View>
          <SearchInput
            label="Search tokens"
            value={query.search}
            maxLength={200}
            onChangeText={(search) => change({ search })}
          />
          <Typography variant="micro">
            Swaps currently support Robinhood stocks only; availability is checked during review.
          </Typography>
        </>
      }
      renderItem={(item) => {
        const selectable = item.chainId === 4663 && item.category === "rwa" && item.swapListed;
        const checked =
          item.chainId === 4663 && item.address.toLowerCase() === target.toLowerCase();
        return (
          <PressableScale
            accessibilityRole="radio"
            accessibilityLabel={`${item.symbol} · ${item.name}`}
            accessibilityState={{ checked, disabled: disabled || !selectable }}
            disabled={disabled || !selectable}
            onPress={() => {
              if (selectable && !disabled) onSelect(item);
            }}
            className={`mb-2 gap-1 rounded-2xl px-4 py-3 ${checked ? "bg-neon/10" : "bg-well"} ${!selectable ? "opacity-60" : ""}`}
          >
            <View className="flex-row items-center justify-between gap-3">
              <Typography variant="rowTitle" className={`flex-1 ${checked ? "!text-neon" : ""}`}>
                {item.symbol}
              </Typography>
              <Badge
                label={
                  tokenNetworks.find((network) => network.chainId === item.chainId)?.name ?? ""
                }
              />
            </View>
            <Typography variant="micro">{item.name}</Typography>
            {!selectable && <Typography variant="micro">Not available for swaps</Typography>}
          </PressableScale>
        );
      }}
    />
  );
}
