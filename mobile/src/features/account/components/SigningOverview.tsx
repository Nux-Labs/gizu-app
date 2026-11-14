import { View } from "react-native";
import {
  ArrowUpRight,
  FileCheck2,
  Fingerprint,
  Globe2,
  Layers3,
  LockKeyhole,
  PenLine,
  ShieldCheck,
} from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import colors from "@/theme/colors.json";
const approvalSteps = [
  { Icon: FileCheck2, label: "Review" },
  { Icon: Fingerprint, label: "Passkey" },
  { Icon: PenLine, label: "Sign" },
];

/** Describes the approval model; it does not claim that a device/provider is available. */
export function SigningOverview({
  native,
  rows,
  explanation,
}: {
  native: boolean;
  rows: { label: string; value: string }[];
  explanation: string;
}) {
  return (
    <View className="gap-4">
      <Surface>
        <View className="gap-5 p-5">
          <View className="flex-row items-center justify-between">
            <Typography variant="label11">Approval flow</Typography>
            <LockKeyhole size={15} color={colors.fg["55"]} />
          </View>
          <View className="flex-row items-center gap-4">
            <View className="h-20 w-20 items-center justify-center rounded-full border border-neon/20 bg-neon/5">
              <View className="h-14 w-14 items-center justify-center rounded-2xl border border-neon/20 bg-neon/10">
                <ShieldCheck size={30} color={colors.accent} />
              </View>
            </View>
            <View className="min-w-0 flex-1 gap-2">
              <Typography variant="section">
                {native ? "Device approval" : "Preview only"}
              </Typography>
              <Typography variant="caption">
                {native
                  ? "Wallet access never authorizes spending."
                  : "Cryptographic signing is not connected."}
              </Typography>
            </View>
          </View>
          {native && (
            <View className="flex-row gap-2">
              {approvalSteps.map(({ Icon, label }) => (
                <View
                  key={label}
                  className="flex-1 items-center gap-2 rounded-2xl border border-cardEdge bg-well px-2 py-3"
                >
                  <Icon size={20} color={colors.accent} />
                  <Typography variant="rowValue">{label}</Typography>
                </View>
              ))}
            </View>
          )}
        </View>
      </Surface>
      <Surface>
        <View className="px-4">
          {rows.map((row, index) => {
            const Icon = /network/i.test(row.label)
              ? Globe2
              : /withdrawal/i.test(row.label)
                ? ArrowUpRight
                : /earn|investment/i.test(row.label)
                  ? Layers3
                  : ShieldCheck;
            return (
              <View
                key={row.label}
                className={`flex-row items-center gap-3 py-4 ${index ? "border-t border-cardEdge" : ""}`}
              >
                <View className="h-9 w-9 items-center justify-center rounded-xl bg-well">
                  <Icon size={18} color={colors.violet.soft} />
                </View>
                <View className="min-w-0 flex-1 gap-1">
                  <Typography variant="caption">{row.label}</Typography>
                  <Typography variant="rowTitle">{row.value}</Typography>
                </View>
              </View>
            );
          })}
        </View>
      </Surface>
      <View className="px-1">
        <HoldingDetails label="How approval works" accessibilityLabel="Signing approval details">
          <Typography variant="caption">{explanation}</Typography>
        </HoldingDetails>
      </View>
    </View>
  );
}
