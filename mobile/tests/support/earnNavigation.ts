import { act, screen } from "@testing-library/react-native";
import { Linking } from "react-native";

/** Exercise the retained Earn route while its Home shortcut is hidden. */
export async function openEarnLink() {
  expect(screen.queryByRole("button", { name: "Earn" })).toBeNull();
  const listener = jest
    .mocked(Linking.addEventListener)
    .mock.calls.filter(([type]) => type === "url")
    .at(-1)?.[1];
  if (!listener) throw new Error("URL subscription missing");
  await act(async () => listener({ url: "gizu://earn" }));
}
