import { useEffect, useState } from "react";
import { Share, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Check, Copy, CreditCard, Share2 } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { showToast } from "@/services/toast";
import { defaultDepositNetwork, type DepositNetwork } from "@/domain/wallet/depositNetworks";
import { fundingCapabilityService } from "@/services/wallet/fundingCapabilities";
import colors from "@/theme/colors.json";
import { useAccount } from "@/features/account/AccountProvider";
import usdcLogo from "../../../assets/logos/tokens/usdc.png";
import { NetworkPicker } from "./NetworkPicker";

/** `0x` and ten groups of four, so the first and last group are easy to compare by eye. */
function addressGroups(address: string) {
  return address.slice(2).match(/.{1,4}/g) ?? [];
}

/** Two even lines of five groups; the first and last group are bright for a quick check. */
function GroupedAddress({ address }: { address: string }) {
  const groups = addressGroups(address);
  const half = Math.ceil(groups.length / 2);
  const line = (part: string[], offset: number) =>
    part.map((group, index) => {
      const position = offset + index;
      const edge = position === 0 || position === groups.length - 1;
      return (
        <Typography
          key={position}
          variant="rowTitle"
          className={`font-mono ${edge ? "!text-text" : "!text-fg-45"}`}
        >
          {index > 0 ? " " : ""}
          {group}
        </Typography>
      );
    });
  return (
    <View
      accessible
      accessibilityLabel={`Wallet address: ${address}`}
      className="items-center gap-1"
    >
      <Typography variant="rowTitle" selectable className="font-mono !text-fg-45">
        0x {line(groups.slice(0, half), 0)}
      </Typography>
      <Typography variant="rowTitle" selectable className="font-mono !text-fg-45">
        {line(groups.slice(half), half)}
      </Typography>
    </View>
  );
}

/** Where to send USDC: network, QR and address. It reads no balances. */
export function AddFunds({ address }: { address: string }) {
  const { clipboard } = useAccount();
  const [copied, setCopied] = useState(false);
  const [network, setNetwork] = useState(defaultDepositNetwork);
  const [networks, setNetworks] = useState<readonly DepositNetwork[] | null>(null);
  useEffect(() => {
    let active = true;
    void fundingCapabilityService
      .networks()
      .then((options) => {
        if (!active) return;
        setNetworks(options);
        setNetwork(
          (current) => options.find((option) => option.id === current.id) ?? options[0] ?? current,
        );
      })
      .catch(() => {
        if (active) setNetworks([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function copy() {
    try {
      await clipboard.copy(address);
      setCopied(true);
      showToast({ variant: "success", title: "Address copied." });
    } catch {
      showToast({ variant: "error", title: "Could not copy address. Try again." });
    }
  }

  if (networks === null)
    return (
      <Surface>
        <Typography variant="caption">Checking funding networks…</Typography>
      </Surface>
    );
  if (networks.length === 0)
    return (
      <Surface>
        <Typography variant="caption">
          Funding is temporarily unavailable. Try again later.
        </Typography>
      </Surface>
    );
  return (
    <View className="gap-5">
      <Surface>
        <View className="items-center gap-5 p-6">
          <NetworkPicker
            network={network}
            onChange={(next) => {
              setNetwork(next);
              setCopied(false);
            }}
            options={networks}
          />
          <View className="w-full gap-1">
            <Typography variant="caption">Send native USDC on {network.name} only.</Typography>
            <Typography
              variant="micro"
              selectable
              accessibilityLabel={`USDC token contract: ${network.token}`}
            >
              {network.token}
            </Typography>
          </View>
          {/* A white quiet zone keeps the code scannable by exchange and desktop cameras. */}
          <View
            className="rounded-2xl bg-white p-3"
            accessible
            accessibilityRole="image"
            accessibilityLabel="QR code of your wallet address"
          >
            {/* High error correction keeps the code readable under the USDC mark. */}
            <QRCode
              value={address}
              size={184}
              color={colors.ink}
              backgroundColor="#ffffff"
              ecl="H"
              logo={usdcLogo}
              logoSize={40}
              logoMargin={4}
              logoBorderRadius={20}
              logoBackgroundColor="#ffffff"
            />
          </View>
          <GroupedAddress address={address} />
          <View className="w-full flex-row gap-3">
            <View className="flex-1">
              <Button
                label={copied ? "Copied" : "Copy"}
                accessibilityLabel="Copy address"
                icon={
                  copied ? (
                    <Check size={16} color={colors.ctaText} />
                  ) : (
                    <Copy size={16} color={colors.ctaText} />
                  )
                }
                onPress={() => void copy()}
              />
            </View>
            <View className="flex-1">
              <Button
                label="Share"
                variant="secondary"
                icon={<Share2 size={16} color={colors.text} />}
                onPress={() => void Share.share({ message: address }).catch(() => {})}
              />
            </View>
          </View>
        </View>
      </Surface>

      <Surface>
        <View className="flex-row items-center gap-4 p-5 opacity-60">
          <CreditCard size={20} color={colors.fg["70"]} />
          <View className="flex-1 gap-0.5">
            <Typography variant="rowTitle">Buy with card or bank</Typography>
            <Typography variant="micro">Pay with your card or a bank transfer.</Typography>
          </View>
          <Typography variant="micro" className="!text-fg-55">
            Coming soon
          </Typography>
        </View>
      </Surface>
    </View>
  );
}
