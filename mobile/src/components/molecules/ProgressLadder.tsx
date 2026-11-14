import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";

export type LadderStep = {
  id: string;
  label: string;
  state: "pending" | "active" | "complete" | "paused";
};

/** The deposit ladder, shared unchanged with other guided money journeys. */
export function ProgressLadder({ steps }: { steps: readonly LadderStep[] }) {
  return (
    <View className="gap-4 rounded-2xl bg-well p-4">
      {steps.map(({ id, label, state }, index) => {
        const done = state === "complete",
          active = state === "active";
        const status = done
          ? "Verified"
          : active
            ? "In progress"
            : state === "paused"
              ? "Needs attention"
              : "Pending";
        return (
          <View
            key={id}
            className="flex-row items-center gap-3"
            accessible
            accessibilityLabel={`${label}: ${status}`}
          >
            <View
              className={`h-7 w-7 items-center justify-center rounded-full border ${done ? "border-neon bg-neon" : active ? "border-neon bg-neon-deep" : "border-cardEdge"}`}
            >
              <Typography
                variant="micro"
                className={done ? "text-ctaText" : active ? "text-accent" : "text-fg-35"}
              >
                {done ? "✓" : state === "paused" ? "!" : index + 1}
              </Typography>
            </View>
            <Typography
              variant="rowTitle"
              className={`flex-1 ${active ? "text-accent" : done ? "text-text" : "text-fg-45"}`}
            >
              {label}
            </Typography>
          </View>
        );
      })}
    </View>
  );
}
