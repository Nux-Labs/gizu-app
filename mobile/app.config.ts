import { existsSync } from "node:fs";
import type { ExpoConfig } from "expo/config";
import { identity, validatePasskeyMode } from "./src/config/passkeys";

import { distributionConfig } from "./src/config/distribution";

validatePasskeyMode(process.env.EXPO_PUBLIC_PASSKEY_MODE);

const { release } = distributionConfig(process.env);

// Firebase client config for strategy notifications; kept out of git. Without it the app builds
// and runs, and strategy notifications are simply unavailable.
const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";

const config: ExpoConfig = {
  name: "Gizu",
  slug: "gizu-mobile",
  owner: "okanaslan",
  extra: {
    eas: { projectId: "6f1c36fc-416b-46ec-a3fd-0d5302cbbdce" },
  },
  version: "1.0.0",
  icon: "./assets/icon.png",
  scheme: "gizu",
  userInterfaceStyle: "dark",
  ios: {
    bundleIdentifier: identity.iosBundleIdentifier,
    appleTeamId: identity.appleTeamId,
    supportsTablet: false,
    buildNumber: "15",
    infoPlist: {
      GizuWalletEnabled: release,
      // Standard cryptography only; France is excluded from distribution (see README).
      ITSAppUsesNonExemptEncryption: false,
    },
    associatedDomains: [`webcredentials:${identity.rpId}`],
  },
  android: {
    package: identity.androidPackage,
    versionCode: 12,
    ...(existsSync(googleServicesFile) ? { googleServicesFile } : {}),
  },
  plugins: [
    [
      "expo-splash-screen",
      {
        backgroundColor: "#050706",
        android: { image: "./assets/splash-logo.png", imageWidth: 80 },
      },
    ],
    [
      // iOS ships Helvetica Neue; Android embeds the owner-licensed frontend files as
      // one weighted family so fontWeight selects the right face.
      "expo-font",
      {
        android: {
          fonts: [
            {
              fontFamily: "HelveticaNeue",
              fontDefinitions: [
                { path: "./assets/fonts/HelveticaNeue-400.ttf", weight: 400 },
                { path: "./assets/fonts/HelveticaNeue-500.ttf", weight: 500 },
                { path: "./assets/fonts/HelveticaNeue-700.ttf", weight: 700 },
                { path: "./assets/fonts/HelveticaNeue-800.ttf", weight: 800 },
              ],
            },
          ],
        },
      },
    ],
    "expo-localization",
    "expo-secure-store",
    "expo-notifications",
    "./plugins/withAndroidDevelopmentSigning.cjs",
    "./plugins/withStoredSignerIos.cjs",
  ],
};
export default config;
