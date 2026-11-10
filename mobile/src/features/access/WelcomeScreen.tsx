import { Pressable, View, type TextStyle } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Fingerprint } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { AccessCard } from "@/components/molecules/AccessCard";
import { Notice } from "@/components/molecules/Notice";
import { SignStatus } from "@/components/molecules/SignStatus";
import { useAccessController } from "./useAccessController";
import { useSession } from "@/application/SessionProvider";
import { GizuLogo } from "@/components/atoms/GizuLogo";
import { Typography } from "@/components/atoms/Typography";
import type { RootStackParamList } from "@/navigation/types";
import colors from "@/theme/colors.json";
import { Reveal } from "./components/Reveal";
import { WelcomeBackdrop } from "./components/WelcomeBackdrop";
import { WelcomeHeading } from "./components/WelcomeHeading";
import { tracking } from "./components/tracking";
import { useWelcomeMotion } from "./useWelcomeMotion";

// Frontend: logo `h-7`, wordmark `text-[16px] font-medium tracking-tight`,
// tagline `text-[15px] leading-relaxed text-white/45`.
const LOGO_HEIGHT = 28;
const wordmark: TextStyle = {
  fontSize: 16,
  lineHeight: 20,
  fontWeight: "500",
  letterSpacing: tracking(-0.16),
};
// Secondary text action: sentence case, normal tracking (owner decision over the
// frontend uppercase mono link).
const link: TextStyle = { fontSize: 13, lineHeight: 18, fontWeight: "500", color: colors.fg["55"] };
const tagline: TextStyle = { fontSize: 15, lineHeight: 24, color: colors.fg["45"] };

/**
 * Frontend Onboarding. Welcome is a fixed, full-bleed screen with no keyboard or tab
 * bar, so it owns its safe-area padding instead of the opaque Screen template.
 */
export function WelcomeScreen({
  navigation,
}: NativeStackScreenProps<RootStackParamList, "Welcome">) {
  const native = useSession().accessService.method === "Passkey";
  const controller = useAccessController();
  // An unreadable local wallet cannot be unlocked; restore is the only way forward.
  const unreadable = controller.localWallet === "unreadable" && controller.canRestore;
  const animate = useWelcomeMotion();
  return (
    <View className="flex-1 bg-ink">
      <WelcomeBackdrop paused={!animate} />
      <View className="flex-1 pb-safe pl-safe pr-safe pt-safe">
        <View className="flex-1 px-6 pb-6 pt-6">
          <Reveal offset={-8} className="flex-row items-center gap-2.5">
            <GizuLogo width={(LOGO_HEIGHT * 638) / 866} height={LOGO_HEIGHT} />
            <Typography variant="row" style={wordmark}>
              Gizu
            </Typography>
          </Reveal>
          <View className="mt-auto">
            <WelcomeHeading animate={animate} />
            <Reveal delay={1500} duration={300} offset={0}>
              <Typography className="mt-6 max-w-[310px]" style={tagline}>
                Explore investments. Protect your privacy. Stay in control.
              </Typography>
            </Reveal>
          </View>
          <View className="mt-10">
            <Reveal delay={1700} offset={20} className="gap-3">
              {controller.error && <Notice error message={controller.error} />}
              {unreadable && (
                <Notice message="The wallet on this device can't be opened. Restore it with your encrypted backup and original passkey." />
              )}
              {!unreadable && (
                <AccessCard
                  icon={Fingerprint}
                  label={
                    controller.pending
                      ? "Opening access"
                      : controller.localWallet === "present"
                        ? "Unlock wallet"
                        : "Continue with passkey"
                  }
                  loading={controller.pending}
                  onPress={() => void controller.start()}
                />
              )}
              {controller.canRestore && (
                <Button
                  label="Restore wallet from backup"
                  variant={unreadable ? "primary" : "secondary"}
                  disabled={controller.pending}
                  onPress={() => void controller.restore()}
                />
              )}
            </Reveal>
            {!native && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Request access"
                onPress={() => navigation.navigate("RequestAccess")}
                className="mt-3 min-h-11 items-center justify-center active:opacity-60"
              >
                <Typography style={link}>Request access</Typography>
              </Pressable>
            )}
          </View>
        </View>
      </View>
      {controller.pending && (
        <SignStatus layout="overlay" orb="access" state="signing" label="Waiting for passkey">
          <Button label="Cancel access" variant="quiet" onPress={controller.cancel} />
        </SignStatus>
      )}
    </View>
  );
}
