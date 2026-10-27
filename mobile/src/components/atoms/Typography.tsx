import { Text, useWindowDimensions, type TextProps } from "react-native";
const variants = {
  title: "text-4xl font-medium text-text",
  heading: "text-2xl font-medium text-text",
  body: "text-base leading-6 text-muted",
  balance: "text-5xl font-normal text-text",
  value: "text-xl font-semibold text-text",
  row: "text-base font-medium text-text",
  negative: "text-sm font-medium text-danger",
  caption: "text-sm leading-5 text-muted",
  label: "text-sm font-semibold text-accent",
  // Frontend scale (additive; existing variants above are unchanged).
  pageTitle: "text-[30px] font-normal tracking-tight text-text",
  section: "text-[20px] font-medium ios:tracking-tight text-text",
  rowTitle: "text-[14px] font-medium text-text",
  rowValue: "text-[14px] font-normal text-text",
  micro: "text-[11px] text-fg-45",
  eyebrow: "text-[12px] tracking-[0.2px] text-muted",
  eyebrowSmall: "text-[11px] tracking-[0.2px] text-muted",
  cardTitle: "text-[17px] font-medium text-text",
  label11: "text-[11px] tracking-[0.6px] text-fg-45",
};
// Kurage pairs a sans body with monospace eyebrows and labels.
const mono = new Set<TypographyVariant>(["eyebrow", "eyebrowSmall", "label11"]);
export type TypographyVariant = keyof typeof variants;
const headers = new Set<TypographyVariant>([
  "title",
  "heading",
  "pageTitle",
  "section",
  "cardTitle",
]);
export function Typography({
  variant = "body",
  className = "",
  children,
  ...props
}: TextProps & { variant?: keyof typeof variants }) {
  // Remeasure native text after Dynamic Type changes, including on inactive screens.
  // Remount only the text node so feature and navigation state are retained.
  const { fontScale } = useWindowDimensions();
  // Locale-independent caps: CSS `uppercase` follows the device locale (Turkish "İ").
  const content =
    variant === "label11" && typeof children === "string" ? children.toUpperCase() : children;
  return (
    <Text
      key={fontScale}
      accessibilityRole={headers.has(variant) ? "header" : undefined}
      {...props}
      className={`${mono.has(variant) ? "font-mono" : "font-sans"} ${variants[variant]} ${className}`}
    >
      {content}
    </Text>
  );
}
