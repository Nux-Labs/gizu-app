import type { PropsWithChildren, ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Typography } from "@/components/atoms/Typography";

/**
 * A sheet that rises from the bottom over a dimmed screen; tapping outside or Back closes it.
 * Long content scrolls inside the sheet, and `footer` stays pinned under it.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  closeLabel,
  footer,
  children,
}: PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Screen-reader label for the dimmed area that closes the sheet. */
  closeLabel: string;
  footer?: ReactNode;
}>) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
          className="absolute inset-0 bg-black/60"
        />
        <View
          className="max-h-[85%] gap-4 rounded-t-3xl border border-cardEdge bg-ink px-5 pt-5"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <View className="h-1 w-10 self-center rounded-full bg-fg-20" />
          <Typography variant="section" accessibilityRole="header">
            {title}
          </Typography>
          <ScrollView bounces={false} contentContainerClassName="gap-5 pb-2">
            {children}
          </ScrollView>
          {footer}
        </View>
      </View>
    </Modal>
  );
}
