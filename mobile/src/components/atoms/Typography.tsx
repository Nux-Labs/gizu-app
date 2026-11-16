import { Text, useWindowDimensions, type TextProps } from "react-native";
const variants = {
  title: "text-4xl leading-[44px] font-medium text-text",
  heading: "text-2xl leading-8 font-medium text-text",
  body: "text-base leading-6 text-muted",
  balance: "text-5xl leading-[56px] font-normal text-text",
  amount: "text-[36px] leading-[44px] font-normal text-text",
  value: "text-xl leading-7 font-semibold text-text",
  row: "text-base leading-6 font-medium text-text",
  negative: "text-sm font-medium text-danger",
  caption: "text-sm leading-5 text-muted",
  label: "text-sm font-semibold text-accent",
  // Frontend scale (additive; existing variants above are unchanged).
  pageTitle: "text-[30px] leading-[38px] font-normal tracking-tight text-text",
  section: "text-[20px] leading-7 font-medium ios:tracking-tight text-text",
  rowTitle: "text-[14px] leading-5 font-medium text-text",
  rowValue: "text-[14px] leading-5 font-normal text-text",
  micro: "text-[11px] leading-4 text-muted",
  eyebrow: "text-[12px] leading-[18px] tracking-[0.2px] text-muted",
  eyebrowSmall: "text-[11px] leading-4 tracking-[0.2px] text-muted",
  cardTitle: "text-[17px] leading-6 font-medium text-text",
  label11: "text-[11px] leading-4 tracking-[0.6px] text-muted",
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
  style,
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
      style={[{ includeFontPadding: false }, style]}
      className={`${mono.has(variant) ? "font-mono" : "font-sans"} ${variants[variant]} ${className}`}
    >
      {content}
    </Text>
  );
}
