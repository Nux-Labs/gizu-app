import { useSession } from "@/application/SessionProvider";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { IconButton } from "@/components/atoms/IconButton";
import { profileFixture } from "@/services/fixtures/profile";
import { showToast } from "@/services/toast";
import { useAccount } from "./AccountProvider";

type Props = {
  /** Optional identity tile rendered before the address column (Account card). */
  leading?: ReactNode;
  /** Optional lines rendered above the address inside the address column. */
  heading?: ReactNode;
  /** Truncate the address to one line (middle ellipsis); copy still copies it in full. */
  compact?: boolean;
};

// Frontend Account card: address in faint mono under the name, glass-soft copy button.
export function AccountAddress({ leading, heading, compact = false }: Props) {
  const { clipboard } = useAccount();
  const { session } = useSession();
  const native = session?.kind === "testnet" || session?.kind === "mainnet";
  const address = native ? session.address : profileFixture.address;
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function copy() {
    if (busy.current) return;
    busy.current = true;
    setStatus("copying");
    try {
      await clipboard.copy(address);
      if (mounted.current) {
        setStatus("copied");
        showToast({ variant: "success", title: "Address copied." });
      }
    } catch {
      if (mounted.current) setStatus("failed");
    } finally {
      busy.current = false;
    }
  }
  return (
    <View className="gap-3 px-5 pb-5">
      <View className="flex-row items-center gap-4">
        {leading}
        <View className="min-w-0 flex-1 gap-1">
          {heading}
          <Typography
            variant="micro"
            className="!text-fg-55"
            selectable
            numberOfLines={compact ? 1 : undefined}
            ellipsizeMode="middle"
            accessibilityLabel={`Account address: ${address}`}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {address}
          </Typography>
        </View>
        <IconButton
          icon={status === "copied" ? Check : Copy}
          label="Copy account address"
          loading={status === "copying"}
          onPress={() => void copy()}
        />
      </View>
      {/* Functional safety note: which asset the address may receive. */}
      <Typography variant="micro" className="!text-fg-35">
        {session?.kind === "mainnet"
          ? "Funding address · Receive USDC on Monad mainnet only."
          : native
            ? "Receive Monad testnet MON only."
            : "This address cannot receive funds."}
      </Typography>
      {status === "failed" && (
        <Typography variant="micro" className="!text-danger" accessibilityRole="alert">
          Could not copy address. Try again.
        </Typography>
      )}
    </View>
  );
}
