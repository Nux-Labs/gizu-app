import Toast from "react-native-toast-message";
import { haptic } from "@/theme/haptics";

export type ToastVariant = "success" | "error" | "info" | "warning";
export type ToastAction = { label: string; onPress: () => void };
export type ToastMessage = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds. Zero keeps the message visible until dismissed. */
  duration?: number;
  /** Action messages stay visible until acted on, dismissed, or replaced. */
  action?: ToastAction;
};

export const toastDefaults = {
  duration: 5000,
  errorDuration: 8000,
  edgeSpacing: 12,
} as const;

/** Transient UI feedback only. Never pass raw errors, secrets or transaction payloads. */
export function showToast({
  title,
  description,
  variant = "info",
  duration = variant === "error" ? toastDefaults.errorDuration : toastDefaults.duration,
  action,
}: ToastMessage) {
  if (!title.trim()) return;
  if (variant === "success") haptic.success();
  if (variant === "error") haptic.error();
  Toast.show({
    type: variant,
    text1: title,
    text2: description,
    visibilityTime: duration,
    // Undefined inherits the host's screen-reader-aware default.
    autoHide: duration === 0 || action ? false : undefined,
    props: { action },
  });
}

export function dismissToast() {
  Toast.hide();
}
