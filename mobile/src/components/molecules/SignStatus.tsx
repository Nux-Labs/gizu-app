import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  withDelay,
  withSpring,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";
import { Check, X } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { ScrambleText } from "@/components/atoms/ScrambleText";
import { ParticleOrb, type ParticleOrbProps } from "@/components/molecules/ParticleOrb";
import colors from "@/theme/colors.json";
import { reduceMotion, springs } from "@/theme/motion";
import { haptic } from "@/theme/haptics";

export type SignState = "signing" | "done" | "failed";

const LABEL: Record<SignState, string> = {
  signing: "Signing with passkey",
  done: "Order filled",
  failed: "Signature rejected",
};

/** Web SignOverlay mobile tuning; `access` matches the Auth passkey orb. */
const ORB = {
  sign: { distance: 20, spread: 11, dotScale: 2.4, count: 560 },
  access: { distance: 15, spread: 9, dotScale: 4.2, count: 520 },
  inline: { distance: 4.4, spread: 5, dotScale: 2.4, count: 340 },
} satisfies Record<string, Partial<ParticleOrbProps>>;

type SignStatusProps = {
  state: SignState;
  /** overrides the status text for the current state */
  label?: string;
  doneLabel?: string;
  detail?: string;
  tone?: "positive" | "negative";
  /** `overlay` covers its positioned parent like the web SignOverlay */
  layout?: "inline" | "overlay";
  orb?: "sign" | "access";
  /** actions under the status, e.g. a cancel button while signing */
  children?: ReactNode;
  testID?: string;
};

// Web: scale 0.4 → 1 and fade in after 0.55s on a 220/18 spring.
const MARK_DELAY = 550;
const markEntering: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.4 }] },
    animations: {
      opacity: withDelay(MARK_DELAY, withSpring(1, springs.check), reduceMotion),
      transform: [{ scale: withDelay(MARK_DELAY, withSpring(1, springs.check), reduceMotion) }],
    },
  };
};

function Mark({ state, accent, size }: { state: SignState; accent: string; size: number }) {
  useEffect(() => {
    if (state === "signing") return;
    // Lands with the mark's delayed spring so the tap and the check arrive together.
    const timer = setTimeout(state === "done" ? haptic.success : haptic.error, MARK_DELAY);
    return () => clearTimeout(timer);
  }, [state]);
  if (state === "signing") return null;
  return (
    <Animated.View key={state} entering={markEntering} testID="gizu-sign-mark">
      {state === "done" ? (
        <Check size={size} strokeWidth={2} color={accent} accessible={false} />
      ) : (
        <X size={size} strokeWidth={2} color={colors.rose} accessible={false} />
      )}
    </Animated.View>
  );
}

function Status({ state, text, detail }: { state: SignState; text: string; detail?: string }) {
  return (
    <View className="items-center gap-2 px-8">
      <ScrambleText
        key={`${state}:${text}`}
        text={text}
        variant="label"
        className={`text-center ${state === "failed" ? "!text-rose" : ""}`}
        accessibilityLiveRegion="polite"
      />
      {detail ? <Typography variant="micro">{detail}</Typography> : null}
    </View>
  );
}

/**
 * Web SignOverlay: particle orb that scatters when the signature settles, a check or
 * cross springing in at its centre and scrambled status text.
 */
export function SignStatus({
  state,
  label,
  doneLabel,
  detail,
  tone = "positive",
  layout = "inline",
  orb = "sign",
  children,
  testID = "gizu-sign-status",
}: SignStatusProps) {
  const accent = tone === "negative" ? colors.sell : colors.accent;
  const settled = state !== "signing";
  const text = label ?? (state === "done" && doneLabel ? doneLabel : LABEL[state]);
  const shownDetail = state === "done" ? detail : undefined;

  if (layout === "inline") {
    return (
      <View testID={testID} className="items-center gap-6">
        <View className="items-center justify-center">
          <ParticleOrb burst={settled} color={accent} size={240} {...ORB.inline} speed={1.4} />
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
            <Mark state={state} accent={accent} size={48} />
          </View>
        </View>
        <Status state={state} text={text} detail={shownDetail} />
      </View>
    );
  }

  return (
    <Animated.View
      testID={testID}
      entering={FadeIn.duration(250).reduceMotion(reduceMotion)}
      exiting={FadeOut.duration(250).reduceMotion(reduceMotion)}
      pointerEvents={settled ? "none" : "auto"}
      className="absolute inset-0 z-50 bg-ink/95"
      style={{ elevation: 24 }}
    >
      <ParticleOrb
        burst={settled}
        color={accent}
        {...ORB[orb]}
        speed={1.4}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      />
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        <Mark state={state} accent={accent} size={56} />
      </View>
      <View className="absolute inset-x-0 bottom-0 items-center gap-6 pb-safe">
        <Status state={state} text={text} detail={shownDetail} />
        <View className="mb-8 min-h-11 items-center">{children}</View>
      </View>
    </Animated.View>
  );
}

/**
 * Keeps a settled result on screen briefly after signing, like the web sheet does
 * before it closes. Results only follow an observed `signing` state.
 */
export function useSignOverlay(target: SignState | null, hold = 1600): SignState | null {
  const [shown, setShown] = useState<SignState | null>(target === "signing" ? "signing" : null);
  if (target === "signing" && shown !== "signing") setShown("signing");
  else if (target !== "signing" && shown === "signing") setShown(target);

  useEffect(() => {
    if (shown !== "done" && shown !== "failed") return;
    const timer = setTimeout(() => setShown(null), hold);
    return () => clearTimeout(timer);
  }, [shown, hold]);

  return shown;
}
