import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { UserRound } from "lucide-react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { IconButton } from "@/components/atoms/IconButton";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { FilterChip } from "@/components/atoms/FilterChip";
import { SegmentedControl } from "@/components/molecules/SegmentedControl";
import { UnderlineTabs } from "@/components/molecules/UnderlineTabs";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import type { StrategyCard } from "@/domain/strategies";
import { signalAssetInfo } from "@/domain/strategyCopy";
import { isRanked } from "@/domain/strategyProfile";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import colors from "@/theme/colors.json";
import { FeedEventCard } from "./components/FeedEventCard";
import { StrategyCardRow } from "./components/StrategyCardRow";
import { useStrategyList } from "./useStrategyFollower";
import { useOwnStrategySigners } from "./useStrategyOwner";
import { useFeed, useStrategySocialDeps } from "./useStrategySocial";

type Props = BottomTabScreenProps<MainTabParamList, "StrategyHub">;
type Section = "feed" | "discover" | "following";
type Sort = "return" | "liked" | "active" | "newest";
type Filter = "cheap" | "short" | "record";

const sections = [
  { key: "feed", label: "Feed" },
  { key: "discover", label: "Discover" },
  { key: "following", label: "Following" },
] as const satisfies readonly { key: Section; label: string }[];
const scopes = [
  { key: "following", label: "Following" },
  { key: "everyone", label: "Everyone" },
] as const;

const sorts: { key: Sort; label: string }[] = [
  { key: "return", label: "Top return" },
  { key: "liked", label: "Most liked" },
  { key: "active", label: "Most active" },
  { key: "newest", label: "Newest" },
];
const filters: { key: Filter; label: string; test: (card: StrategyCard) => boolean }[] = [
  {
    key: "cheap",
    label: "Under $10/mo",
    test: (card) => BigInt(card.monthlyPriceAtoms) < 10_000_000n,
  },
  { key: "short", label: "Reveal ≤ 7 days", test: (card) => card.embargoSeconds <= 7 * 86_400 },
  { key: "record", label: "3+ reveals", test: (card) => card.revealed >= 3 },
];

/** Late reveals sink to the bottom of every ordering. */
function sortCards(cards: StrategyCard[], sort: Sort): StrategyCard[] {
  const by: Record<Sort, (a: StrategyCard, b: StrategyCard) => number> = {
    return: (a, b) =>
      (b.performance.cumulativeReturnBps ?? 0) - (a.performance.cumulativeReturnBps ?? 0),
    liked: (a, b) => b.social.likes - a.social.likes || b.social.comments - a.social.comments,
    active: (a, b) => b.commits - a.commits,
    newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  };
  return [...cards].sort((a, b) =>
    a.broken !== b.broken ? (a.broken ? 1 : -1) : by[sort](a, b) || a.id - b.id,
  );
}

/** Strategies as a social space: a feed of updates, discovery and the strategies you follow. */
export function StrategyHubScreen({ navigation }: Props) {
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  const { now } = useStrategySocialDeps();
  const list = useStrategyList();
  const own = useOwnStrategySigners();
  const [section, setSection] = useState<Section>("feed");
  const [sort, setSort] = useState<Sort>("return");
  const [active, setActive] = useState<Set<Filter>>(new Set());
  const [asset, setAsset] = useState("");
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

  const listed = list.cards.filter((card) => card.commits > 0 || mine(card));
  const query = asset.trim().toLowerCase();
  const discovered = sortCards(
    listed.filter(
      (card) =>
        [...active].every((key) => filters.find((f) => f.key === key)!.test(card)) &&
        (!query ||
          card.latestAssets.some((a) => signalAssetInfo(a).label.toLowerCase().includes(query))) &&
        // A ranking by return only compares strategies with enough record.
        (sort !== "return" || isRanked(card, nowMs) || mine(card)),
    ),
    sort,
  );
  const following = sortCards(
    list.cards.filter((card) => list.followed.has(card.id)),
    "active",
  );
  const refreshing = list.loading || (section === "feed" && feed.loading);

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
          {/* Sorts, a divider, then filters: one quiet row that scrolls when it runs out of room. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="items-center gap-2"
          >
            {sorts.map((option) => (
              <FilterChip
                key={option.key}
                label={option.label}
                selected={sort === option.key}
                onPress={() => setSort(option.key)}
              />
            ))}
            <View className="mx-1 h-5 w-px bg-glassBorder" />
            {filters.map((option) => (
              <FilterChip
                key={option.key}
                role="checkbox"
                label={option.label}
                selected={active.has(option.key)}
                onPress={() =>
                  setActive((current) => {
                    const next = new Set(current);
                    if (next.has(option.key)) next.delete(option.key);
                    else next.add(option.key);
                    return next;
                  })
                }
              />
            ))}
          </ScrollView>
          <TextInput
            accessibilityLabel="Holds an asset"
            placeholder="Holds an asset, e.g. NVDA"
            placeholderTextColor={colors.fg["35"]}
            value={asset}
            onChangeText={setAsset}
            autoCapitalize="characters"
            className="min-h-12 rounded-xl bg-well px-4 py-3 text-text"
          />
          {sort === "return" && (
            <Typography variant="micro">
              Ranked by verified return. A strategy joins after 3 reveals and 14 days.
            </Typography>
          )}
          {list.loading && list.cards.length === 0 && (
            <Typography variant="micro" accessibilityLiveRegion="polite">
              Loading strategies…
            </Typography>
          )}
          {!list.loading && !list.error && discovered.length === 0 && (
            <Typography variant="rowValue" className="!text-fg-45">
              No strategy matches yet.
            </Typography>
          )}
          {discovered.map((card) => (
            <StrategyCardRow
              key={card.id}
              card={card}
              mine={mine(card)}
              following={list.followed.has(card.id)}
              nowMs={nowMs}
              onPress={() => openStrategy(card.id)}
            />
          ))}
        </View>
      )}

      {section === "following" && (
        <View className="gap-3">
          {!list.loading && following.length === 0 && (
            <Typography variant="rowValue" className="!text-fg-45">
              You don&apos;t follow a strategy yet. Find one in Discover.
            </Typography>
          )}
          {following.map((card) => (
            <StrategyCardRow
              key={card.id}
              card={card}
              mine={mine(card)}
              following
              nowMs={nowMs}
              onPress={() => openStrategy(card.id)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}
