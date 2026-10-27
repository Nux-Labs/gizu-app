import { friendlyError, OFFLINE_MESSAGE } from "@/components/molecules/Notice";

test("raw transport failures become friendly copy; curated messages pass through", () => {
  expect(friendlyError("fetch failed: java.net.ConnectException: Failed to connect")).toBe(
    OFFLINE_MESSAGE,
  );
  expect(friendlyError("Token list unavailable.")).toBe("Token list unavailable.");
  expect(friendlyError("Wallet access timed out. Try again.")).toBe(
    "Wallet access timed out. Try again.",
  );
});
