import { useSession } from "@/application/SessionProvider";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/navigation/types";
import type { StatementFrequency } from "@/domain/preferences";
import { Screen } from "@/components/templates/Screen";
import { Button } from "@/components/atoms/Button";
import { FadeIn } from "@/components/molecules/FadeIn";
import { GroupedRow } from "@/components/molecules/GroupedRow";
import { PreferenceOption } from "@/components/molecules/PreferenceOption";
import { BackAction } from "@/navigation/BackAction";
import { sectionDelay } from "@/theme/motion";
import { PushAlertsRow } from "./components/PushAlertsRow";
import { useAccount } from "./AccountProvider";
import { PreferenceFeedback } from "./PreferenceFeedback";
import { SettingsGroup } from "./components/SettingsGroup";
import { PageIntro } from "./components/PageIntro";
import { SigningOverview } from "./components/SigningOverview";
import {
  informationPages,
  nativeInformationPages,
  mainnetInformationPages,
  testnetInformationPages,
  type AccountPage,
} from "./pages";

const frequencies: StatementFrequency[] = ["Monthly", "Quarterly", "On request"];

function PageActions({ labels, delay }: { labels: string[]; delay: number }) {
  return (
    <FadeIn delay={delay} className="mt-5 gap-3">
      {labels.map((label) => (
        <Button key={label} label={label} disabled onPress={() => {}} />
      ))}
    </FadeIn>
  );
}

function InformationPage({ page, native }: { page: AccountPage; native: boolean }) {
  const { session } = useSession();
  const walletPages =
    session?.kind === "testnet" ? testnetInformationPages : mainnetInformationPages;
  const info = (native ? walletPages[page] : undefined) ?? informationPages[page];
  if (!info) return null;
  return (
    <>
      <PageIntro
        title={info.title}
        body={page === "transaction-signing" || page === "contact-desk" ? undefined : info.body}
      />
      {page === "transaction-signing" ? (
        <SigningOverview native={native} rows={info.rows} explanation={info.body} />
      ) : (
        info.rows.length > 0 && (
          <SettingsGroup delay={sectionDelay(1)}>
            {info.rows.map((row, index) => (
              <GroupedRow key={row.label} {...row} last={index === info.rows.length - 1} />
            ))}
          </SettingsGroup>
        )
      )}
      {info.actions && <PageActions labels={info.actions} delay={sectionDelay(3)} />}
    </>
  );
}

function AlertsPage() {
  return (
    <>
      <PageIntro title="Push alerts" />
      <PreferenceFeedback />
      <SettingsGroup delay={sectionDelay(1)}>
        <PushAlertsRow />
      </SettingsGroup>
    </>
  );
}

function CurrencyPage({ native }: { native: boolean }) {
  const { session } = useSession();
  const asset = session?.kind === "mainnet" ? "USDC" : "MON";
  const currencies = native ? [asset] : ["USD", "EUR", "GBP", "TRY"];
  const selected = native ? asset : "USD";
  return (
    <>
      <PageIntro title="Currency" />
      <PreferenceFeedback />
      <SettingsGroup delay={sectionDelay(1)}>
        {currencies.map((currency) => (
          <PreferenceOption
            key={currency}
            label={currency}
            selected={currency === selected}
            disabled
            onSelect={() => {}}
          />
        ))}
      </SettingsGroup>
    </>
  );
}

function StatementsPage() {
  const { preferences, loading, busy, save } = useAccount();
  const unavailable = loading || busy || !preferences;
  return (
    <>
      <PageIntro title="Statements" />
      <PreferenceFeedback />
      <SettingsGroup title="Frequency" delay={sectionDelay(1)}>
        {frequencies.map((frequency) => (
          <PreferenceOption
            key={frequency}
            label={frequency}
            selected={preferences?.statements === frequency}
            disabled={unavailable}
            onSelect={() => void save({ statements: frequency })}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Archive" delay={sectionDelay(2)}>
        <GroupedRow label="No statements available." last />
      </SettingsGroup>
      <PageActions labels={["Request statement"]} delay={sectionDelay(3)} />
    </>
  );
}

// Frontend SubPage: glass back button, 30px title, sections staggered below.
export function AccountPageScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, "AccountPage">) {
  const page = route.params.page;
  const { session } = useSession();
  const native = session?.kind === "testnet" || session?.kind === "mainnet";
  const hasInfo = Boolean(
    (native ? nativeInformationPages[page] : undefined) ?? informationPages[page],
  );
  return (
    <Screen>
      <BackAction fallback="Settings" />
      {hasInfo ? (
        <InformationPage page={page} native={native} />
      ) : page === "alerts" ? (
        <AlertsPage />
      ) : page === "currency" ? (
        <CurrencyPage native={native} />
      ) : page === "statements" ? (
        <StatementsPage />
      ) : (
        <PageIntro title="Page unavailable" body="This account page is not supported." />
      )}
    </Screen>
  );
}
