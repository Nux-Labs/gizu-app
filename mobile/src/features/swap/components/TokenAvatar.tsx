import { useState } from "react";
import { Image, View, type ImageSourcePropType } from "react-native";
import { GlassFill } from "@/components/atoms/GlassFill";
import { Typography } from "@/components/atoms/Typography";

export type TokenLogo = { uri?: string | null; source?: ImageSourcePropType };

/**
 * 24px token logo for swap chips: a bundled image, else the catalog's remote logo, else a glass
 * monogram so every chip keeps the same shape. Decorative; the chip's label names the token.
 */
export function TokenAvatar({ symbol, logo }: { symbol: string; logo: TokenLogo }) {
  const remote = logo.uri && /^https?:\/\//i.test(logo.uri) ? logo.uri : null;
  // Keyed by the source so a failed logo does not hide the next token's logo.
  return <Avatar key={remote ?? "local"} symbol={symbol} logo={logo} remote={remote} />;
}

function Avatar({
  symbol,
  logo,
  remote,
}: {
  symbol: string;
  logo: TokenLogo;
  remote: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const source = logo.source ?? (remote ? { uri: remote } : null);
  if (source && !failed) {
    return (
      <Image
        source={source}
        accessibilityElementsHidden
        importantForAccessibility="no"
        onError={() => setFailed(true)}
        className="h-6 w-6 rounded-full bg-well"
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-6 w-6 items-center justify-center rounded-full"
    >
      <GlassFill />
      <Typography variant="micro" className="relative z-10 !text-[11px] !text-text">
        {symbol.slice(0, 1).toUpperCase() || "?"}
      </Typography>
    </View>
  );
}
