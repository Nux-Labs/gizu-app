import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ArrowUpDown, Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { FilterChip } from "@/components/atoms/FilterChip";
import { Typography } from "@/components/atoms/Typography";
import { BottomSheet } from "@/components/molecules/BottomSheet";
import {
  activeFilters,
  discoverSorts,
  filterOptions,
  noFilters,
  type DiscoverFilters,
  type DiscoverSort,
} from "@/domain/strategyDiscovery";
import colors from "@/theme/colors.json";
import { haptic } from "@/theme/haptics";

function BarButton({
  icon: Icon,
  label,
  accessibilityLabel,
  active,
  onPress,
}: {
  icon: typeof ArrowUpDown;
  label: string;
  accessibilityLabel: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={`min-h-9 flex-row items-center gap-1.5 rounded-full border px-3 ${
        active ? "border-accent/50 bg-accent/10" : "border-glassBorder"
      }`}
    >
      <Icon size={14} color={active ? colors.accent : colors.fg["55"]} />
      <Text
        maxFontSizeMultiplier={1.3}
        className={`text-[13px] leading-4 ${active ? "text-accent" : "text-fg-70"}`}
      >
        {label}
      </Text>
      <ChevronDown size={14} color={active ? colors.accent : colors.fg["45"]} />
    </Pressable>
  );
}

/** One single-choice filter group; tapping the chosen chip again clears it. */
function Group<T>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  return (
    <View className="gap-2" accessibilityRole="radiogroup" accessibilityLabel={title}>
      <Typography variant="eyebrow">{title}</Typography>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <FilterChip
            key={String(option.value)}
            label={option.label}
            selected={value === option.value}
            onPress={() => onChange(value === option.value ? null : option.value)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * Discover's controls: a search over names and holdings, one sort button and one filter button
 * that open sheets, and the chosen filters as removable chips.
 */
export function DiscoverControls({
  query,
  onQuery,
  sort,
  onSort,
  filters,
  onFilters,
  countFor,
}: {
  query: string;
  onQuery: (query: string) => void;
  sort: DiscoverSort;
  onSort: (sort: DiscoverSort) => void;
  filters: DiscoverFilters;
  onFilters: (filters: DiscoverFilters) => void;
  /** How many strategies a set of filters would show, for the sheet's button. */
  countFor: (filters: DiscoverFilters) => number;
}) {
  const [sheet, setSheet] = useState<"sort" | "filters" | null>(null);
  const [draft, setDraft] = useState(filters);
  const chips = activeFilters(filters);
  const sortLabel = discoverSorts.find((option) => option.key === sort)!.label;
  const shown = countFor(draft);
  const set = <K extends keyof DiscoverFilters>(key: K, value: DiscoverFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <View className="gap-3">
      <View className="min-h-11 flex-row items-center gap-2 rounded-xl bg-well px-3">
        <Search size={16} color={colors.fg["45"]} />
        <TextInput
          accessibilityLabel="Search strategies or assets"
          placeholder="Search strategies or assets"
          placeholderTextColor={colors.fg["35"]}
          value={query}
          onChangeText={onQuery}
          autoCorrect={false}
          returnKeyType="search"
          className="flex-1 py-2.5 text-[15px] text-text"
        />
        {query.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={8}
            onPress={() => onQuery("")}
          >
            <X size={16} color={colors.fg["45"]} />
          </Pressable>
        )}
      </View>

      <View className="flex-row gap-2">
        <BarButton
          icon={ArrowUpDown}
          label={sortLabel}
          accessibilityLabel={`Sort: ${sortLabel}`}
          active={false}
          onPress={() => setSheet("sort")}
        />
        <BarButton
          icon={SlidersHorizontal}
          label={chips.length > 0 ? `Filters · ${chips.length}` : "Filters"}
          accessibilityLabel={chips.length > 0 ? `Filters, ${chips.length} on` : "Filters"}
          active={chips.length > 0}
          onPress={() => {
            setDraft(filters);
            setSheet("filters");
          }}
        />
      </View>

      {chips.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          {chips.map((chip) => (
            <Pressable
              key={chip.key}
              accessibilityRole="button"
              accessibilityLabel={`Remove filter ${chip.label}`}
              onPress={() => {
                haptic.select();
                onFilters(chip.cleared);
              }}
              className="min-h-7 flex-row items-center gap-1 rounded-full bg-white/[0.07] pl-2.5 pr-2"
            >
              <Text maxFontSizeMultiplier={1.3} className="text-[12px] leading-4 text-fg-85">
                {chip.label}
              </Text>
              <X size={12} color={colors.fg["55"]} />
            </Pressable>
          ))}
        </ScrollView>
      )}

      <BottomSheet
        visible={sheet === "sort"}
        onClose={() => setSheet(null)}
        title="Sort by"
        closeLabel="Close sorting"
      >
        <View accessibilityRole="radiogroup" className="gap-1">
          {discoverSorts.map((option) => {
            const selected = option.key === sort;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityHint={option.hint}
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  haptic.select();
                  onSort(option.key);
                  setSheet(null);
                }}
                className={`min-h-14 flex-row items-center gap-3 rounded-2xl px-3 py-2 ${selected ? "bg-white/[0.06]" : ""}`}
              >
                <View className="flex-1 gap-0.5">
                  <Typography variant="rowTitle">{option.label}</Typography>
                  <Typography variant="micro">{option.hint}</Typography>
                </View>
                {selected && <Check size={18} color={colors.accent} />}
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>

      <BottomSheet
        visible={sheet === "filters"}
        onClose={() => setSheet(null)}
        title="Filters"
        closeLabel="Close filters"
        footer={
          <View className="flex-row items-center gap-3">
            <Button label="Clear all" variant="quiet" onPress={() => setDraft(noFilters)} />
            <View className="flex-1">
              <Button
                label={shown === 1 ? "Show 1 strategy" : `Show ${shown} strategies`}
                onPress={() => {
                  onFilters(draft);
                  setSheet(null);
                }}
              />
            </View>
          </View>
        }
      >
        <Group
          title="What it holds"
          options={filterOptions.content}
          value={draft.content}
          onChange={(value) => set("content", value)}
        />
        <View className="gap-2">
          <Group
            title="Risk"
            options={filterOptions.maxDrawdownBps}
            value={draft.maxDrawdownBps}
            onChange={(value) => set("maxDrawdownBps", value)}
          />
          <View className="flex-row">
            <FilterChip
              role="checkbox"
              label="No late reveals"
              selected={draft.noLateReveal}
              onPress={() => set("noLateReveal", !draft.noLateReveal)}
            />
          </View>
        </View>
        <Group
          title="Track record"
          options={filterOptions.record}
          value={draft.record}
          onChange={(value) => set("record", value)}
        />
        <Group
          title="Weights revealed"
          options={filterOptions.maxEmbargoSeconds}
          value={draft.maxEmbargoSeconds}
          onChange={(value) => set("maxEmbargoSeconds", value)}
        />
        <Group
          title="Monthly price"
          options={filterOptions.price}
          value={draft.price}
          onChange={(value) => set("price", value)}
        />
        <View className="gap-2">
          <Typography variant="eyebrow">Availability</Typography>
          <View className="flex-row">
            <FilterChip
              role="checkbox"
              label="Seats open"
              selected={draft.seatsOpen}
              onPress={() => set("seatsOpen", !draft.seatsOpen)}
            />
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}
