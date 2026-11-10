import { View } from "react-native";
import { InfiniteListScreen } from "@/components/templates/InfiniteListScreen";
import { Typography } from "@/components/atoms/Typography";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Button } from "@/components/atoms/Button";
import { Choice } from "@/components/molecules/Choice";
import { FadeIn } from "@/components/molecules/FadeIn";
import { opportunityProtocols } from "@/domain/opportunities";
import { sectionDelay } from "@/theme/motion";
import { useInfiniteOpportunities, opportunityIdentity } from "./useInfiniteOpportunities";
import { OpportunityCard } from "./components/OpportunityCard";
const labels = { all: "All protocols", aave: "Aave", morpho: "Morpho", curvance: "Curvance" };
export function MainnetVaults({ onOpen }: { onOpen: (id: string) => void }) {
  const { query, queryKey, list, change, partial } = useInfiniteOpportunities();
  const filtered = query.search !== "" || query.protocol !== "all";
  return (
    <InfiniteListScreen
      list={list}
      queryKey={queryKey}
      getIdentity={opportunityIdentity}
      renderItem={(opportunity, index) => (
        <OpportunityCard
          opportunity={opportunity}
          index={index}
          virtualized
          rateSuffix=" total APR"
          onOpen={onOpen}
        />
      )}
      layout="responsive-grid"
      noun="vaults"
      unavailableMessage="Vault catalog unavailable. Please retry."
      emptyMessage="No vaults match your filters."
      header={
        <>
          <FadeIn delay={sectionDelay(0)} className="gap-2 pb-2">
            <Typography variant="pageTitle">Earn</Typography>
            <Typography variant="body">Earn yield on your USDC with selected vaults.</Typography>
          </FadeIn>
          <View
            className="flex-row flex-wrap gap-2"
            accessibilityRole="radiogroup"
            accessibilityLabel="Protocol filter"
          >
            {opportunityProtocols.map((protocol) => (
              <Choice
                key={protocol}
                label={labels[protocol]}
                selected={query.protocol === protocol}
                onPress={() => change({ ...query, protocol })}
              />
            ))}
          </View>
          <SearchInput
            label="Search opportunities"
            value={query.search}
            onChangeText={(search) => change({ ...query, search })}
          />
          {partial && (
            <Typography accessibilityRole="alert">
              Some vaults are unavailable. Showing the available catalog.
            </Typography>
          )}
          {filtered && (
            <View className="self-start">
              <Button
                label="Clear filters"
                variant="quiet"
                onPress={() => change({ ...query, search: "", protocol: "all" })}
              />
            </View>
          )}
        </>
      }
    />
  );
}
