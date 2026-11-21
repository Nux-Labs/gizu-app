import { useState } from "react";
import { Image, Modal, Pressable, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronDown } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { PressableScale } from "@/components/atoms/PressableScale";
import {
  depositNetworks,
  type DepositNetwork,
  type DepositNetworkId,
} from "@/domain/wallet/depositNetworks";
import { haptic } from "@/theme/haptics";
import colors from "@/theme/colors.json";
import monadLogo from "../../../assets/logos/monad-white.png";
import usdcLogo from "../../../assets/logos/tokens/usdc.png";

const logos: Record<DepositNetworkId, ImageSourcePropType> = { monad: monadLogo };

function NetworkLogo({ id }: { id: DepositNetworkId }) {
  return <Image source={logos[id]} className="h-6 w-6" resizeMode="contain" accessible={false} />;
}

/** The selected deposit network; opens a sheet listing every network Gizu accepts USDC on. */
export function NetworkPicker({
  network,
  onChange,
}: {
  network: DepositNetwork;
  onChange: (network: DepositNetwork) => void;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  function choose(next: DepositNetwork) {
    haptic.select();
    onChange(next);
    setOpen(false);
  }

  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Network: ${network.name}. Change network`}
        accessibilityHint={`Accepts ${network.asset} only`}
        onPress={() => setOpen(true)}
        className="w-full flex-row items-center gap-3 rounded-2xl border border-cardEdge bg-well px-4 py-3"
      >
        <NetworkLogo id={network.id} />
        <View className="flex-1">
          <Typography variant="micro">Network</Typography>
          <Typography variant="rowTitle">{network.name}</Typography>
        </View>
        {/* The asset this address accepts, beside the network it accepts it on. */}
        <View className="flex-row items-center gap-1.5 rounded-full border border-cardEdge bg-well py-1 pl-1 pr-2.5">
          <Image source={usdcLogo} className="h-5 w-5" resizeMode="contain" accessible={false} />
          <Typography variant="micro" className="!text-text">
            {network.asset}
          </Typography>
        </View>
        <ChevronDown size={18} color={colors.fg["55"]} />
      </PressableScale>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 justify-end">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close network list"
            onPress={() => setOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <View
            className="gap-4 rounded-t-3xl border border-cardEdge bg-ink px-5 pt-5"
            style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
          >
            <View className="h-1 w-10 self-center rounded-full bg-fg-20" />
            <View className="gap-1">
              <Typography variant="section" accessibilityRole="header">
                Choose network
              </Typography>
              <Typography variant="caption">
                Send USDC only on the network you choose here.
              </Typography>
            </View>
            <View accessibilityRole="radiogroup" className="gap-2">
              {depositNetworks.map((option) => {
                const selected = option.id === network.id;
                return (
                  <PressableScale
                    key={option.id}
                    accessibilityRole="radio"
                    accessibilityLabel={`${option.name}, ${option.asset}`}
                    accessibilityState={{ checked: selected }}
                    onPress={() => choose(option)}
                    className={`flex-row items-center gap-3 rounded-2xl border px-4 py-3.5 ${selected ? "border-neon/30 bg-neon/10" : "border-cardEdge bg-well"}`}
                  >
                    <NetworkLogo id={option.id} />
                    <View className="flex-1">
                      <Typography variant="rowTitle">{option.name}</Typography>
                      <Typography variant="micro">{option.asset}</Typography>
                    </View>
                    {selected ? <Check size={18} color={colors.neon.DEFAULT} /> : null}
                  </PressableScale>
                );
              })}
            </View>
            <Typography variant="micro" className="text-center">
              More networks are coming soon.
            </Typography>
          </View>
        </View>
      </Modal>
    </>
  );
}
