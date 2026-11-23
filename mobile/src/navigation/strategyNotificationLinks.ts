import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import { secureFollowStore, type StrategyFollowStore } from "@/services/strategyFollows";
import { strategyForPushRef } from "@/services/strategyPush";

// Updates arriving while Gizu is open still show as a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * The strategy a notification is about, as a deep link. Notifications carry only an opaque
 * reference; this phone maps it to one of the strategies it follows, or ignores it.
 */
export async function strategyLinkFor(
  data: unknown,
  store: StrategyFollowStore = secureFollowStore,
): Promise<string | null> {
  if (!data || typeof data !== "object") return null;
  const { type, ref } = data as Record<string, unknown>;
  if (type !== "strategy-update" || typeof ref !== "string" || !/^[0-9a-f]{32}$/.test(ref))
    return null;
  const [device, follows] = await Promise.all([store.pushDevice(), store.load()]);
  if (!device) return null;
  const id = strategyForPushRef(
    ref,
    device,
    follows.map((follow) => follow.strategyId),
  );
  return id === null ? null : `gizu://strategy/${id}`;
}

const linkFor = (response: Notifications.NotificationResponse | null) =>
  response ? strategyLinkFor(response.notification.request.content.data) : Promise.resolve(null);

/** Opening the app from a link, or from a strategy notification when there is no link. */
export async function initialUrl(): Promise<string | null> {
  const url = await Linking.getInitialURL();
  if (url) return url;
  return linkFor(Notifications.getLastNotificationResponse()).catch(() => null);
}

/** Links and taps on strategy notifications while the app runs. */
export function subscribeToUrls(listener: (url: string) => void): () => void {
  const links = Linking.addEventListener("url", ({ url }) => listener(url));
  const taps = Notifications.addNotificationResponseReceivedListener((response) => {
    void linkFor(response)
      .then((url) => {
        if (url) listener(url);
      })
      .catch(() => undefined);
  });
  return () => {
    links.remove();
    taps.remove();
  };
}
