import { render, screen, userEvent } from "@testing-library/react-native";
import { Fingerprint } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { AccessCard } from "@/components/molecules/AccessCard";
import colors from "@/theme/colors.json";

test.each([
  ["primary", colors.ctaText],
  ["secondary", colors.text],
  ["quiet", colors.fg["70"]],
  ["destructive", colors.danger],
  ["sell", colors.sellText],
] as const)("%s actions retain a readable label and respond to presses", async (variant, color) => {
  const onPress = jest.fn();
  render(<Button label="Continue" variant={variant} onPress={onPress} />);
  expect(screen.getByText("Continue")).toBeVisible();
  expect(screen.getByText("Continue")).toHaveStyle({ color });
  await userEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("loading and disabled actions keep their labels and prevent duplicate submission", async () => {
  const onPress = jest.fn();
  const { rerender } = render(<Button label="Invest" loading onPress={onPress} />);
  expect(screen.getByText("Invest")).toBeVisible();
  expect(screen.getByRole("button", { name: "Invest", busy: true })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Invest" }));
  rerender(<Button label="Invest" disabled onPress={onPress} />);
  expect(screen.getByText("Invest")).toHaveStyle({ color: colors.muted });
  await userEvent.press(screen.getByRole("button", { name: "Invest" }));
  expect(onPress).not.toHaveBeenCalled();
  rerender(<Button label="Invest" onPress={onPress} />);
  await userEvent.press(screen.getByRole("button", { name: "Invest" }));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("passkey access preserves its visible label while waiting for native authorization", async () => {
  const onPress = jest.fn();
  const { rerender } = render(
    <AccessCard label="Continue with passkey" icon={Fingerprint} onPress={onPress} />,
  );
  expect(screen.getByText("Continue with passkey")).toHaveStyle({ color: colors.ctaText });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  rerender(<AccessCard label="Opening access" icon={Fingerprint} loading onPress={onPress} />);
  expect(screen.getByText("Opening access")).toBeVisible();
  expect(screen.getByRole("button", { name: "Opening access" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Opening access" }));
  expect(onPress).toHaveBeenCalledTimes(1);
});
