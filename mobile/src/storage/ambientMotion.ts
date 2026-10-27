import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Device-level choice to pause decorative motion (the ASCII mascot). Not account data.
const KEY = "gizu:ambient-motion:v1";
let enabled = true;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

void AsyncStorage.getItem(KEY)
  .then((value) => {
    if (value === "off") {
      enabled = false;
      emit();
    }
  })
  .catch(() => undefined);

export function setAmbientMotion(next: boolean) {
  enabled = next;
  emit();
  void AsyncStorage.setItem(KEY, next ? "on" : "off").catch(() => undefined);
}

export function useAmbientMotion() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => enabled,
  );
}
