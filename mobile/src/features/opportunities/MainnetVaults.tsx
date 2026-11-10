import { View } from "react-native";
import { InfiniteListScreen } from "@/components/templates/InfiniteListScreen";
import { Typography } from "@/components/atoms/Typography";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Button } from "@/components/atoms/Button";
import { Choice } from "@/components/molecules/Choice";
import { FadeIn } from "@/components/molecules/FadeIn";
import { sectionDelay } from "@/theme/motion";
import { useInfiniteOpportunities, opportunityIdentity } from "./useInfiniteOpportunities";
import { OpportunityCard } from "./components/OpportunityCard";
export function MainnetVaults({ onOpen }: { onOpen: (id: string) => void }) {
  const { query, queryKey, list, change, partial, protocols } = useInfiniteOpportunities();
  const filtered = query.search !== "" || query.protocol !== undefined;
  // One protocol is not a choice; keep the row while a selection is active so it can be undone.
  const showProtocols = protocols.length > 1 || query.protocol !== undefined;
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
          {showProtocols && (
            <View
              className="flex-row flex-wrap gap-2"
              accessibilityRole="radiogroup"
              accessibilityLabel="Protocol filter"
            >
              {protocols.map((protocol) => (
                <Choice
                  key={protocol.id}
                  label={protocol.name}
                  selected={query.protocol === protocol.id}
                  onPress={() =>
                    change({
                      ...query,
                      protocol: query.protocol === protocol.id ? undefined : protocol.id,
                    })
                  }
                />
              ))}
            </View>
          )}
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
                onPress={() => change({ search: "" })}
              />
            </View>
          )}
        </>
      }
    />
  );
}
