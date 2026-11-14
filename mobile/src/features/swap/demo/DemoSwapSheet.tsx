import { useSyncExternalStore } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CircleCheck } from "lucide-react-native";
import { Button } from "@/components/atoms/Button";
import { Spinner } from "@/components/atoms/Spinner";
import { Typography } from "@/components/atoms/Typography";
import { ActiveSwapCard } from "../SwapStatusPanel";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { Surface } from "@/components/molecules/Surface";
import { formatSwapAmount } from "@/domain/swap";
import type { StoredSwapView } from "@/domain/wallet/storedSigner";
import colors from "@/theme/colors.json";
import { formatTokenAtoms } from "../confidentialSwap";
import { swapDemo, swapDemoEnabled, type DemoReview } from "./swapDemo";

/** What the engine is doing at a step, in the words the native screen uses. */
export function demoStepText(step: string, symbol: string): string {
  const words: Record<string, string> = {
    review: "Waiting for your approval",
    fundingSign: "Signing the transfer",
    fundingSubmit: "Sending the transfer",
    fundingReceipt: "Waiting for the transfer to confirm",
    credit: "Waiting for the private balance to be credited",
    balances: "Checking your private balance",
    payoutQuote: "Getting a payout quote",
    payoutSubmit: "Submitting a payout",
    payoutStatus: "Waiting for the payouts to arrive",
    fusionPreview: `Pricing the ${symbol} order`,
    sellQuote: "Getting the private deposit quote",
    fusionSign: "Signing the order",
    fusionStatus: "Waiting for the order to fill",
    fusionAfter: "Confirming the balances",
    done: "Finished",
  };
  return words[step] ?? step;
}

function stages(view: StoredSwapView) {
  const symbol = view.targetSymbol || "tokens";
  const sell = view.direction === "sell";
  const names = sell
    ? ["Check holdings", `Sell ${symbol}`, "Private credit", "Pay out USDC", "Done"]
    : [
        "Check wallet and quotes",
        "Move USDC to the private balance",
        "Send to your new wallets",
        `Buy ${symbol}`,
        "Done",
      ];
  const order: Record<string, number> = sell
    ? { REVIEW: 0, FUSION: 1, FUNDING: 2, CREDITED: 2, PAYOUTS: 3, COMPLETE: 4 }
    : { REVIEW: 0, FUNDING: 1, CREDITED: 1, PAYOUTS: 2, FUSION: 3, COMPLETE: 4 };
  const current = order[view.phase] ?? 0;
  return names.map((name, i) => ({ name, done: i < current, current: i === current }));
}

function Chip({ label }: { label: string }) {
  return (
    <View className="self-start rounded-full bg-neon/15 px-3 py-1">
      <Typography variant="label11" className="!text-neon">
        {label}
      </Typography>
    </View>
  );
}

function Review({ review }: { review: DemoReview }) {
  return (
    <>
      <ScrollView className="flex-1" contentContainerClassName="gap-3 pb-4">
        <Chip label={review.headline} />
        <Typography variant="cardTitle">{review.flow}</Typography>
        <Surface>
          <View className="gap-3 p-4">
            {review.facts.map((fact) => (
              <View key={fact.label} className="flex-row items-start justify-between gap-4">
                <Typography variant="micro">{fact.label}</Typography>
                <Typography variant="caption" className="flex-1 text-right">
                  {fact.value}
                </Typography>
              </View>
            ))}
          </View>
        </Surface>
        {review.legs.map((leg) => (
          <Surface key={leg.address}>
            <View className="gap-1 p-4">
              <Typography variant="rowTitle">{leg.title}</Typography>
              <Typography variant="micro" selectable>
                {leg.address}
              </Typography>
              <Typography variant="caption">{leg.detail}</Typography>
            </View>
          </Surface>
        ))}
        <View className="gap-1 rounded-2xl border border-borderSoft bg-glassSoft p-4">
          <Typography variant="label11">PRIVACY</Typography>
          <Typography variant="micro">
            Each wallet is fresh and never reused. The private balance in the middle hides which
            deposit paid which wallet.
          </Typography>
        </View>
      </ScrollView>
      <View className="gap-2 pt-2">
        <Button label="Approve for 15 minutes" onPress={() => swapDemo.approve()} />
        <Button label="Cancel" variant="secondary" onPress={() => swapDemo.cancelReview()} />
      </View>
    </>
  );
}

function Progress({ view }: { view: StoredSwapView }) {
  return (
    <>
      <ScrollView className="flex-1" contentContainerClassName="gap-4 pb-4">
        <ActiveSwapCard status={view} background />
        <HoldingDetails label="Progress details" accessibilityLabel="Demo swap progress details">
          <Typography variant="caption">
            {demoStepText(view.step, view.targetSymbol || "tokens")}
          </Typography>
          {stages(view).map((stage) => (
            <View key={stage.name} className="flex-row items-center gap-3 py-2">
              <View
                className={`h-2 w-2 rounded-full ${stage.done || stage.current ? "bg-neon" : "bg-glassSoft"}`}
              />
              <Typography variant="rowTitle" className={stage.current ? "!text-neon" : ""}>
                {stage.name}
              </Typography>
            </View>
          ))}
        </HoldingDetails>
      </ScrollView>
      <Button
        label="Continue in background"
        variant="secondary"
        onPress={() => swapDemo.continueInBackground()}
      />
    </>
  );
}

function Done({ view }: { view: StoredSwapView }) {
  const sell = view.direction === "sell";
  const symbol = view.targetSymbol || "tokens";
  const received = BigInt(view.receivedTargetAtoms || "0");
  return (
    <>
      <View className="flex-1 items-center justify-center gap-4">
        <CircleCheck size={56} color={colors.neon.DEFAULT} />
        <Typography variant="pageTitle" className="text-center !text-[26px]">
          {sell
            ? `Sold ${symbol}`
            : `Bought ${formatTokenAtoms(received.toString(), 18)} ${symbol}`}
        </Typography>
        <Typography variant="caption" className="text-center">
          {sell
            ? `${formatSwapAmount(BigInt(view.creditedAtoms || "0"))} USDC paid out to ${view.payoutsSubmitted} new wallet${view.payoutsSubmitted === 1 ? "" : "s"}.`
            : `Spread across ${view.legs ?? 1} fresh wallet${(view.legs ?? 1) === 1 ? "" : "s"}.`}
        </Typography>
      </View>
      <Button label="Done" onPress={() => swapDemo.dismiss()} />
    </>
  );
}

/** Demo mode's stand-in for the native review and progress screens. */
export function DemoSwapSheet() {
  const insets = useSafeAreaInsets();
  useSyncExternalStore(swapDemo.subscribe, swapDemo.version);
  const sheet = swapDemo.sheet();
  const status = swapDemo.status();
  if (!swapDemoEnabled()) return null;
  return (
    <Modal
      visible={sheet !== null}
      animationType="slide"
      onRequestClose={() => {
        if (sheet?.mode === "review") swapDemo.cancelReview();
        else if (sheet?.mode === "progress") swapDemo.continueInBackground();
        else if (sheet?.mode === "done") swapDemo.dismiss();
      }}
    >
      <View
        className="flex-1 gap-3 bg-ink px-5"
        style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }}
        accessibilityLabel="Swap review and progress"
      >
        {sheet?.mode === "review" ? <Review review={sheet.review} /> : null}
        {sheet?.mode === "authorizing" ? (
          <View className="flex-1 items-center justify-center gap-4">
            <Spinner size="lg" />
            <Typography variant="cardTitle">Confirm with your passkey</Typography>
          </View>
        ) : null}
        {sheet?.mode === "progress" && status ? <Progress view={status} /> : null}
        {sheet?.mode === "done" && status ? <Done view={status} /> : null}
      </View>
    </Modal>
  );
}
