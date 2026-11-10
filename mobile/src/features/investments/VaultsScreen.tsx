import { MainnetVaults } from "@/features/opportunities/MainnetVaults";
import { useSession } from "@/application/SessionProvider";
import { useState } from "react";
import { View } from "react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Choice } from "@/components/molecules/Choice";
import { FadeIn } from "@/components/molecules/FadeIn";
import { VaultList } from "@/components/organisms/VaultList";
import { filterVaults, type Risk } from "@/domain/investments";
import { sectionDelay } from "@/theme/motion";
import { useInvestments } from "./InvestmentProvider";
import { DataStatus } from "./DataStatus";
export function VaultsScreen(props: BottomTabScreenProps<MainTabParamList, "Vaults">) {
  const { session } = useSession();
  if (session?.kind === "testnet" || session?.kind === "mainnet")
    return (
      <MainnetVaults
        onOpen={(id) =>
          props.navigation
            .getParent<NativeStackNavigationProp<RootStackParamList>>()
            .navigate("OpportunityDetail", { id })
        }
      />
    );
  return <DemoVaults {...props} />;
}
function DemoVaults({ navigation }: BottomTabScreenProps<MainTabParamList, "Vaults">) {
  const { data } = useInvestments();
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<Risk | "All">("All");
  const filtered = filterVaults(data?.vaults ?? [], query, risk);
  return (
    <Screen>
      <FadeIn delay={sectionDelay(0)} className="gap-2 pb-2">
        <Typography variant="pageTitle">Earn</Typography>
        <Typography variant="body">Earn yield on your USDC with selected vaults.</Typography>
      </FadeIn>
      <SearchInput
        label="Search name, ticker, strategy or manager"
        value={query}
        onChangeText={setQuery}
      />
      <View
        className="flex-row flex-wrap gap-2"
        accessibilityRole="radiogroup"
        accessibilityLabel="Risk filter"
      >
        {(["All", "Low", "Medium", "High"] as const).map((value) => (
          <Choice
            key={value}
            label={`${value} risk`}
            selected={risk === value}
            onPress={() => setRisk(value)}
          />
        ))}
      </View>
      {(query !== "" || risk !== "All") && (
        <View className="self-start">
          <Button
            label="Clear filters"
            variant="quiet"
            onPress={() => {
              setQuery("");
              setRisk("All");
            }}
          />
        </View>
      )}
      <DataStatus />
      {data && (
        <>
          <Typography
            variant="micro"
            accessibilityLiveRegion="polite"
          >{`${filtered.length} ${filtered.length === 1 ? "vault" : "vaults"} found`}</Typography>
          {filtered.length === 0 && (
            <Typography variant="caption" className="py-6 text-center">
              {data.vaults.length ? "No vaults match your filters." : "No vaults available."}
            </Typography>
          )}
          <VaultList
            vaults={filtered}
            onOpen={(id) =>
              navigation
                .getParent<NativeStackNavigationProp<RootStackParamList>>()
                .navigate("VaultDetail", { id })
            }
          />
        </>
      )}
    </Screen>
  );
}
