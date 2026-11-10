import { ErrorNotice } from "@/components/molecules/ErrorNotice";
import { Spinner } from "@/components/atoms/Spinner";
import { CardGridSkeleton, RowListSkeleton } from "@/components/molecules/CardSkeleton";
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { FlatList, View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import type { InfiniteListState } from "@/hooks/useInfiniteList";
import { ScreenFrame, useScreenBottomPadding } from "./ScreenFrame";

/** Virtualize rows, allowing grid cells to use NativeWind responsive widths. */
export function InfiniteListScreen<T>({
  list,
  queryKey,
  header,
  renderItem,
  getIdentity,
  layout = "list",
  noun,
  unavailableMessage,
  emptyMessage,
}: {
  list: InfiniteListState<T>;
  queryKey: string;
  header: ReactElement;
  renderItem: (item: T, index: number) => ReactElement;
  getIdentity: (item: T) => string;
  layout?: "list" | "grid" | "responsive-grid";
  noun: string;
  unavailableMessage: string;
  emptyMessage: string;
}) {
  const ref = useRef<FlatList<T[]>>(null);
  const bottomPadding = useScreenBottomPadding();
  const columns = layout === "list" ? 1 : 2;
  const rows = useMemo(() => {
    const result: T[][] = [];
    for (let i = 0; i < list.items.length; i += columns)
      result.push(list.items.slice(i, i + columns));
    return result;
  }, [list.items, columns]);
  useEffect(() => {
    ref.current?.scrollToOffset({ offset: 0, animated: false });
  }, [queryKey]);
  const cellClass = layout === "list" ? "w-full" : layout === "grid" ? "w-1/2" : "w-full xs:w-1/2";
  return (
    <ScreenFrame>
      <FlatList
        className="flex-1"
        ref={ref}
        accessibilityLabel={`${noun} list`}
        data={rows}
        keyExtractor={(row) => getIdentity(row[0]!)}
        renderItem={({ item: row, index }) => (
          <View className="-mx-1.5 flex-row flex-wrap">
            {row.map((item, cell) => (
              <View key={getIdentity(item)} className={`${cellClass} px-1.5 pb-3`}>
                {renderItem(item, index * columns + cell)}
              </View>
            ))}
          </View>
        )}
        contentContainerClassName="grow px-5 py-4"
        contentContainerStyle={
          bottomPadding === undefined ? undefined : { paddingBottom: bottomPadding }
        }
        ListHeaderComponent={<View className="gap-4 pb-4">{header}</View>}
        ListEmptyComponent={
          list.loading ? (
            layout === "list" ? (
              <RowListSkeleton label={`Loading ${noun}…`} />
            ) : (
              <CardGridSkeleton label={`Loading ${noun}…`} />
            )
          ) : !list.error && !list.refreshing ? (
            <Typography>{emptyMessage}</Typography>
          ) : null
        }
        ListFooterComponent={
          <View className="gap-3 py-3">
            {list.error && (
              <ErrorNotice
                kind={list.error}
                message={
                  list.error === "initial"
                    ? unavailableMessage
                    : list.error === "stalled"
                      ? "The catalog changed. Refresh to continue."
                      : list.error === "refresh"
                        ? "Could not refresh. Your previous results are still shown."
                        : "Could not load more. Your previous results are still shown."
                }
                actionLabel={
                  list.error === "initial"
                    ? `Retry ${noun}`
                    : list.error === "more"
                      ? "Retry loading more"
                      : "Retry refresh"
                }
                onAction={list.retry}
                busy={list.loading || list.loadingMore || list.refreshing}
              />
            )}
            {list.loadingMore && (
              <View className="flex-row items-center justify-center gap-3 py-2">
                <Spinner size="sm" />
                <Typography variant="micro" accessibilityLiveRegion="polite">
                  Loading more…
                </Typography>
              </View>
            )}
            {!list.loading &&
              !list.loadingMore &&
              !list.refreshing &&
              !list.error &&
              list.hasMore && (
                <Button label="Load more" variant="secondary" onPress={list.loadMore} />
              )}
          </View>
        }
        onEndReached={list.loadMore}
        onEndReachedThreshold={0.5}
        onRefresh={list.refresh}
        refreshing={list.refreshing}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
      />
    </ScreenFrame>
  );
}
