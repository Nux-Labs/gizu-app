import { useState, type PropsWithChildren } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { ScreenFrame, useScreenBottomPadding } from "./ScreenFrame";
import { ScrollLockContext } from "./ScrollLock";
import { ScreenReveal } from "./ScreenReveal";
import colors from "@/theme/colors.json";

export function Screen({
  children,
  scrollable = true,
  refreshing = false,
  onRefresh,
}: PropsWithChildren<{
  scrollable?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}>) {
  const bottomPadding = useScreenBottomPadding();
  const [scrollLocked, setScrollLocked] = useState(false);
  return (
    <ScreenFrame>
      {scrollable ? (
        <ScrollView
          scrollEnabled={!scrollLocked}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                accessibilityLabel="Refresh content"
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.neon.DEFAULT}
                colors={[colors.neon.DEFAULT]}
              />
            ) : undefined
          }
          contentContainerClassName="grow px-5 py-4"
          contentContainerStyle={
            bottomPadding === undefined ? undefined : { paddingBottom: bottomPadding }
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        >
          <ScrollLockContext.Provider value={setScrollLocked}>
            <ScreenReveal className="grow gap-4">{children}</ScreenReveal>
          </ScrollLockContext.Provider>
        </ScrollView>
      ) : (
        <View className="flex-1 px-5 py-4" style={{ paddingBottom: bottomPadding ?? 16 }}>
          <ScreenReveal className="flex-1 gap-4">{children}</ScreenReveal>
        </View>
      )}
    </ScreenFrame>
  );
}
