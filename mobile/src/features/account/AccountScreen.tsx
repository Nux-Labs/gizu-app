import { View } from "react-native";
import { Fingerprint, ShieldCheck, Bell, FileText, LifeBuoy } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { FadeIn } from "@/components/molecules/FadeIn";
import { Surface } from "@/components/molecules/Surface";
import { GroupedRow } from "@/components/molecules/GroupedRow";
import { useSession } from "@/application/SessionProvider";
import { profileFixture as profile } from "@/services/fixtures/profile";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { sectionDelay } from "@/theme/motion";
import { AccountAddress } from "./AccountAddress";
import { PreferenceFeedback } from "./PreferenceFeedback";
import { useAccount } from "./AccountProvider";
import { WalletBackupAction } from "./WalletBackupAction";
import { WalletRecoveryAction } from "./WalletRecoveryAction";
import { SettingsGroup } from "./components/SettingsGroup";
import { AccountInitials } from "./components/AccountInitials";
import { AmbientMotionRow } from "./components/AmbientMotionRow";
import type { AccountPage } from "./pages";

type Row = { page: AccountPage; label: string; icon: LucideIcon };

const groups: { title: string; rows: Row[] }[] = [
  {
    title: "Security",
    rows: [
      { page: "passkey-wallet", label: "Passkey wallet", icon: Fingerprint },
      { page: "transaction-signing", label: "Transaction signing", icon: ShieldCheck },
      { page: "alerts", label: "Push alerts", icon: Bell },
    ],
  },
  {
    title: "Support",
    rows: [
      { page: "contact-desk", label: "Contact desk", icon: LifeBuoy },
      { page: "terms", label: "Terms and disclosures", icon: FileText },
    ],
  },
];

// Frontend Settings: title, glass identity card, groups staggered 60ms, glass Disconnect.
export function AccountScreen({ navigation }: BottomTabScreenProps<MainTabParamList, "Settings">) {
  const { session } = useSession();
  const native = session?.kind === "testnet" || session?.kind === "mainnet";
  const { preferences, busy, disconnectAccount } = useAccount();
  const root = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
  const method = session?.method === "Demo passkey" ? "Passkey" : session?.method;
  return (
    <Screen>
      <FadeIn delay={sectionDelay(0)} className="pb-1">
        <Typography variant="pageTitle" className="!text-[26px]">
          Account
        </Typography>
      </FadeIn>
      <FadeIn delay={sectionDelay(1)} className="mt-2 gap-4">
        {session?.kind === "mainnet" ? (
          <Surface>
            <View className="pt-5">
              <AccountAddress
                heading={<Typography variant="rowTitle">Account address</Typography>}
              />
            </View>
          </Surface>
        ) : (
          <Surface>
            <View className="pt-5">
              <AccountAddress
                leading={<AccountInitials initials={native ? undefined : profile.initials} />}
                heading={
                  <>
                    <Typography variant="rowTitle" className="!text-[16px]">
                      {native ? "Account 0" : profile.name}
                    </Typography>
                    <Typography variant="micro">Access method: {method}</Typography>
                  </>
                }
              />
            </View>
          </Surface>
        )}
        <PreferenceFeedback />
      </FadeIn>
      {groups.map((group, index) => (
        <SettingsGroup key={group.title} title={group.title} delay={sectionDelay(index + 2)}>
          {group.rows.map((row, rowIndex) => (
            <GroupedRow
              key={row.page}
              last={rowIndex === group.rows.length - 1}
              label={row.label}
              icon={row.icon}
              value={
                row.page === "alerts" && preferences
                  ? preferences.alerts
                    ? "On"
                    : "Off"
                  : undefined
              }
              onPress={() => root.navigate("AccountPage", { page: row.page })}
            />
          ))}
        </SettingsGroup>
      ))}
      <SettingsGroup title="Display" delay={sectionDelay(groups.length + 2)}>
        <AmbientMotionRow />
      </SettingsGroup>
      {native && session.walletId && (
        <FadeIn delay={sectionDelay(groups.length + 2)} className="mt-3">
          <WalletBackupAction />
          <WalletRecoveryAction key={session.walletId} walletId={session.walletId} />
        </FadeIn>
      )}
      <FadeIn delay={sectionDelay(groups.length + 3)} className="mt-3">
        <Button
          variant="destructive"
          label="Disconnect"
          disabled={busy}
          onPress={() => void disconnectAccount()}
        />
      </FadeIn>
    </Screen>
  );
}
