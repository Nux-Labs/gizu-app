import { Text, View, useWindowDimensions } from "react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { VaultGrid } from "@/components/organisms/VaultList";
import { useOpportunities } from "@/features/opportunities/useOpportunities";
import { CatalogStatus } from "@/features/opportunities/components/CatalogStatus";
import { OpportunityCard } from "@/features/opportunities/components/OpportunityCard";
import { PagerButton } from "@/components/molecules/PagerButton";
import { CardGridSkeleton } from "@/components/molecules/CardSkeleton";

/** Frontend Home previews the first page at `items: 4`. */
const PREVIEW_SIZE = 4;

/** Frontend Home `see all` link in neon/70, sentence case per the native type decision. */
function SeeAll({ onPress }: { onPress: () => void }) {
  const { fontScale } = useWindowDimensions();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="See all vaults"
      onPress={onPress}
      hitSlop={8}
      className="min-h-11 justify-center px-1"
    >
      <Text key={fontScale} className="font-sans text-[13px] text-neon/70">
        See all
      </Text>
    </PressableScale>
  );
}

/** Frontend Home "Earn" section backed by the real mainnet catalog. */
export function VaultPreview({
  onSeeAll,
  onOpen,
}: {
  onSeeAll: () => void;
  onOpen: (id: string) => void;
}) {
  const { load, retry } = useOpportunities();
  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Typography variant="section">Earn</Typography>
        <SeeAll onPress={onSeeAll} />
      </View>
      {load.kind === "loading" && <CardGridSkeleton count={PREVIEW_SIZE} label="Loading vaults…" />}
      {load.kind === "failed" && (
        <View className="items-center">
          <CatalogStatus accessibilityRole="alert">Vault catalog unavailable.</CatalogStatus>
          <PagerButton
            label="Retry"
            accessibilityLabel="Retry vaults"
            disabled={false}
            onPress={retry}
          />
        </View>
      )}
      {load.kind === "ready" && load.data.list.length === 0 && (
        <CatalogStatus>No vaults available right now.</CatalogStatus>
      )}
      {load.kind === "ready" && load.data.list.length > 0 && (
        <VaultGrid>
          {load.data.list.slice(0, PREVIEW_SIZE).map((opportunity, index) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              index={index}
              onOpen={onOpen}
            />
          ))}
        </VaultGrid>
      )}
    </View>
  );
}
