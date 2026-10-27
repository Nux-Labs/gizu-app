import { Switch, View } from "react-native";
import { Sparkles } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { setAmbientMotion, useAmbientMotion } from "@/storage/ambientMotion";
import colors from "@/theme/colors.json";

export function AmbientMotionRow() {
  const enabled = useAmbientMotion();
  return (
    <View className="min-h-14 flex-row items-center gap-3 px-5 py-4">
      <View className="h-9 w-9 items-center justify-center rounded-full bg-well">
        <Sparkles size={17} color={colors.fg["70"]} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Typography variant="rowTitle">Mascot animation</Typography>
        <Typography variant="micro">Pause the chameleon to save battery.</Typography>
      </View>
      <Switch
        style={{ alignSelf: "center" }}
        accessible
        accessibilityRole="switch"
        accessibilityLabel="Animate the chameleon mascot"
        accessibilityState={{ checked: enabled }}
        value={enabled}
        trackColor={{ false: colors.fg["20"], true: colors.neon.DEFAULT }}
        thumbColor={enabled ? colors.ink : colors.fg["85"]}
        ios_backgroundColor={colors.fg["20"]}
        onValueChange={setAmbientMotion}
      />
    </View>
  );
}
