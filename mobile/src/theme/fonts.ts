import { Platform } from "react-native";

/** System monospace face for ASCII art and Kurage-style labels. */
export const monoFamily = Platform.select({ ios: "Menlo", default: "monospace" });
