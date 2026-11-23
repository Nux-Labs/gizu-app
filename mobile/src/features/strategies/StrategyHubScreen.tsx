import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { UserRound } from "lucide-react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { IconButton } from "@/components/atoms/IconButton";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { SegmentedControl } from "@/components/molecules/SegmentedControl";
import { UnderlineTabs } from "@/components/molecules/UnderlineTabs";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import type { StrategyCard } from "@/domain/strategies";
import {
  matchesFilters,
  matchesQuery,
  noFilters,
  sortStrategies,
  type DiscoverFilters,
  type DiscoverSort,
} from "@/domain/strategyDiscovery";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { DiscoverControls } from "./components/DiscoverControls";
import { FeedEventCard } from "./components/FeedEventCard";
import { StrategyCardRow } from "./components/StrategyCardRow";
import { useStrategyList } from "./useStrategyFollower";
import { useOwnStrategySigners } from "./useStrategyOwner";
import { useFeed, useStrategySocialDeps } from "./useStrategySocial";

type Props = BottomTabScreenProps<MainTabParamList, "StrategyHub">;
type Section = "feed" | "discover" | "following";

const sections = [
  { key: "feed", label: "Feed" },
  { key: "discover", label: "Discover" },
  { key: "following", label: "Following" },
] as const satisfies readonly { key: Section; label: string }[];
const scopes = [
  { key: "following", label: "Following" },
  { key: "everyone", label: "Everyone" },
] as const;

/** Strategies as a social space: a feed of updates, discovery and the strategies you follow. */
export function StrategyHubScreen({ navigation }: Props) {
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  const { now } = useStrategySocialDeps();
  const list = useStrategyList();
  const own = useOwnStrategySigners();
  const [section, setSection] = useState<Section>("feed");
  const [sort, setSort] = useState<DiscoverSort>("return");
  const [filters, setFilters] = useState<DiscoverFilters>(noFilters);
  const [query, setQuery] = useState("");
  const [everyone, setEveryone] = useState(false);
  const followedIds = useMemo(() => [...list.followed], [list.followed]);
  // Following nobody yet shows everyone's updates rather than an empty feed.
  const feedScope = everyone || followedIds.length === 0 ? null : followedIds;
  const feed = useFeed(feedScope);
  const { reload } = list;
  const reloadFeed = feed.reload;

  // Coming back from a strategy shows new follows, likes and comments.
  const seen = useRef(false);
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (seen.current) {
          reload();
          reloadFeed();
        }
        seen.current = true;
      }),
    [navigation, reload, reloadFeed],
  );

  const nowMs = now();
  const openStrategy = (id: number) => root?.navigate("StrategyDetail", { id });
  const openUpdate = (id: number, seq: number) => root?.navigate("StrategyUpdate", { id, seq });
  const mine = (card: StrategyCard) => own.has(card.signer.toLowerCase());

  // Strategies without a sealed basket have nothing to judge yet; your own always shows.
  const listed = list.cards.filter((card) => card.commits > 0 || mine(card));
  const matching = (chosen: DiscoverFilters) =>
    listed.filter((card) => matchesQuery(card, query) && matchesFilters(card, chosen, nowMs));
  const { ranked, unranked } = sortStrategies(matching(filters), sort, nowMs);
  const following = sortStrategies(
    list.cards.filter((card) => list.followed.has(card.id)),
    "newest",
    nowMs,
  ).ranked;
  const refreshing = list.loading || (section === "feed" && feed.loading);

  const row = (card: StrategyCard) => (
    <StrategyCardRow
      key={card.id}
      card={card}
      mine={mine(card)}
      following={list.followed.has(card.id)}
      nowMs={nowMs}
      onPress={() => openStrategy(card.id)}
    />
  );

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        reload();
        reloadFeed();
      }}
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Typography variant="pageTitle">Strategies</Typography>
          <Typography variant="body">
            Real portfolios, sealed on Base before anyone sees them.
          </Typography>
        </View>
        <IconButton
          icon={UserRound}
          label="Your strategy"
          onPress={() => root?.navigate("Strategies")}
        />
      </View>

      <UnderlineTabs tabs={sections} selected={section} onSelect={setSection} />

      {list.error && <Notice error message={list.error} />}

      {section === "feed" && (
        <View className="gap-3">
          {followedIds.length > 0 && (
            <SegmentedControl
              options={scopes}
              selected={everyone ? "everyone" : "following"}
              onSelect={(key) => setEveryone(key === "everyone")}
            />
          )}
          {feed.error && <Notice error message={feed.error} />}
          {feed.loading && feed.list.length === 0 && (
            <Typography variant="micro" accessibilityLiveRegion="polite">
              Loading the feed…
            </Typography>
          )}
          {!feed.loading && !feed.error && feed.list.length === 0 && (
            <Typography variant="rowValue" className="!text-fg-45">
              Nothing here yet. Updates appear as strategies seal and reveal them.
            </Typography>
          )}
          {feed.list.map((event) => (
            <FeedEventCard
              key={`${event.kind}:${event.strategyId}:${event.kind === "price" ? event.version : event.seq}`}
              event={event}
              nowMs={nowMs}
              onOpenStrategy={openStrategy}
              onOpenUpdate={openUpdate}
            />
          ))}
          {feed.next && (
            <Button
              label="Show more"
              variant="quiet"
              disabled={feed.loading}
              onPress={() => void feed.loadMore()}
            />
          )}
        </View>
      )}

      {section === "discover" && (
        <View className="gap-3">
          <DiscoverControls
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            filters={filters}
            onFilters={setFilters}
            countFor={(chosen) => matching(chosen).length}
          />
          {list.loading && list.cards.length === 0 && (
            <Typography variant="micro" accessibilityLiveRegion="polite">
              Loading strategies…
            </Typography>
          )}
          {!list.loading && !list.error && ranked.length + unranked.length === 0 && (
            <View className="items-start gap-2 py-4">
              <Typography variant="rowValue" className="!text-fg-45">
                No strategy matches these filters.
              </Typography>
              {(query.length > 0 || filters !== noFilters) && (
                <Button
                  label="Clear search and filters"
                  variant="quiet"
                  onPress={() => {
                    setQuery("");
                    setFilters(noFilters);
                  }}
                />
              )}
            </View>
          )}
          {ranked.map(row)}
          {unranked.length > 0 && (
            <View className="gap-3 pt-2">
              <View className="gap-0.5">
                <Typography variant="rowTitle">Not ranked yet</Typography>
                <Typography variant="micro">
                  Ranking starts after 3 reveals and 14 days. Newest first.
                </Typography>
              </View>
              {unranked.map(row)}
            </View>
          )}
        </View>
      )}

      {section === "following" && (
        <View className="gap-3">
          {!list.loading && following.length === 0 && (
            <Typography variant="rowValue" className="!text-fg-45">
              You don&apos;t follow a strategy yet. Find one in Discover.
            </Typography>
          )}
          {following.map(row)}
        </View>
      )}
    </Screen>
  );
}
