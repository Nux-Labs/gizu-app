import { tokenDisplayName } from "@/domain/tokenCatalog";

test("drops the Robinhood Token suffix and keeps every other name as given", () => {
  expect(tokenDisplayName("NVIDIA • Robinhood Token")).toBe("NVIDIA");
  expect(tokenDisplayName("Invesco QQQ • Robinhood Token")).toBe("Invesco QQQ");
  expect(tokenDisplayName("Apple xStock")).toBe("Apple xStock");
  expect(tokenDisplayName("Robinhood Token Index")).toBe("Robinhood Token Index");
  expect(tokenDisplayName(" • Robinhood Token")).toBe(" • Robinhood Token");
});
