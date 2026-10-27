/* eslint-disable @typescript-eslint/no-require-imports -- loaded lazily so builds without the native module keep working. */
type HapticsModule = typeof import("expo-haptics");

let module: HapticsModule | null | undefined;

/** expo-haptics, or null when the installed binary predates it (feedback is optional). */
function haptics(): HapticsModule | null {
  if (module === undefined) {
    try {
      module = require("expo-haptics") as HapticsModule;
    } catch {
      module = null;
    }
  }
  return module;
}

function fire(run: (h: HapticsModule) => Promise<void>) {
  const h = haptics();
  if (h) void run(h).catch(() => undefined);
}

/** Tactile feedback; every call is fire-and-forget and safe without native support. */
export const haptic = {
  /** Picking from a set: tabs, periods, chart scrub steps. */
  select: () => fire((h) => h.selectionAsync()),
  /** A committed press on a primary action. */
  tap: () => fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  success: () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  error: () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};
