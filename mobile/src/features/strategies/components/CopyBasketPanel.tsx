import { useState } from "react";
import { TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { formatPrice, usdcAtoms, type StrategySignal } from "@/domain/strategies";
import { copyPlan, type CopyLeg } from "@/domain/strategyCopy";
import { formatUsdc } from "@/domain/wallet/amounts";
import { portfolioPublicUsdcAtoms } from "@/domain/wallet/portfolioValue";
import { usePricedPortfolio } from "@/features/wallet/usePricedPortfolio";
import type { RootStackParamList } from "@/navigation/types";
import colors from "@/theme/colors.json";
import { useCopyBasket, type StockLeg } from "../useCopyBasket";

const inputClass = "min-h-12 rounded-xl bg-well px-4 py-3 text-text";
const usd = (atoms: bigint) => formatPrice(atoms.toString());

function legText(leg: CopyLeg): string {
  if (leg.kind === "stock") return `Buy ${usd(leg.atoms)} of ${leg.label}`;
  if (leg.kind === "vault") return `Deposit ${usd(leg.atoms)} in the ${leg.label}`;
  return `Keep ${usd(leg.atoms)} as USDC`;
}

/**
 * Copies a basket with a USDC budget: stocks are bought one confidential swap at a time, vault
 * shares go through Earn with the amount filled in, and positions already above their weight are
 * pointed out rather than sold. Holdings of the basket's assets count, so an update buys only the
 * difference.
 */
export function CopyBasketPanel({
  signal,
  copiedSeq,
  onCopied,
}: {
  signal: StrategySignal;
  copiedSeq: number | null;
  onCopied: (seq: number) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Stocks already held count toward the basket, so their market values must be in first.
  const { snapshot, pricing } = usePricedPortfolio();
  const [budget, setBudget] = useState("");
  // The plan is fixed when copying starts: buys change the holdings it was computed from.
  const [deposits, setDeposits] = useState<Extract<CopyLeg, { kind: "vault" }>[]>([]);
  const copy = useCopyBasket(() => onCopied(signal.seq));
  const { progress } = copy;
  const running = progress.current !== null;

  const budgetAtoms = usdcAtoms(budget);
  const available = snapshot ? portfolioPublicUsdcAtoms(snapshot) : null;
  const plan =
    budgetAtoms && budgetAtoms !== "0"
      ? copyPlan(signal.assets, BigInt(budgetAtoms), snapshot)
      : null;
  const stocks = (plan?.legs.filter((leg) => leg.kind === "stock") ?? []) as StockLeg[];
  const vaults = (plan?.legs.filter((leg) => leg.kind === "vault") ?? []) as Extract<
    CopyLeg,
    { kind: "vault" }
  >[];
  const tooMuch =
    available !== null && budgetAtoms !== null && BigInt(budgetAtoms) > BigInt(available);
  // Once a copy started, its plan stays fixed until it finishes or is reset.
  const started = progress.legs.length > 0 || progress.finished;

  return (
    <View className="gap-3">
      <Typography variant="section">
        {copiedSeq === null ? "Copy this basket" : "Bring your copy up to date"}
      </Typography>
      {!started && (
        <View className="gap-1">
          <Typography variant="micro">
            Amount to invest (USDC)
            {available !== null ? ` · ${formatPrice(available)} available` : ""}
          </Typography>
          <TextInput
            accessibilityLabel="Amount to invest in USDC"
            keyboardType="decimal-pad"
            value={budget}
            onChangeText={setBudget}
            className={inputClass}
            placeholderTextColor={colors.fg["35"]}
            placeholder="100"
          />
          {tooMuch && <Notice error message="That's more USDC than this wallet holds." />}
        </View>
      )}
      {plan && !started && (
        <View className="gap-2" accessibilityLabel="Copy plan">
          {plan.legs.map((leg) => (
            <View key={`${leg.kind}:${leg.label}`} className="gap-1">
              <Typography variant="rowValue">{legText(leg)}</Typography>
              {leg.kind === "vault" && leg.small && (
                <Typography variant="micro">
                  Small vault deposits lose much of their value to fees. Consider keeping this share
                  in USDC.
                </Typography>
              )}
            </View>
          ))}
          {plan.unsupported.length > 0 && (
            <Typography variant="micro">
              Kept in USDC because this app can&apos;t buy them: {plan.unsupported.join(", ")}.
            </Typography>
          )}
          {plan.overweight.map((item) => (
            <View key={item.address} className="gap-1">
              <Typography variant="micro">
                You hold {usd(item.excessAtoms)} more {item.label} than the basket asks for.
              </Typography>
              {item.symbol && (
                <Button
                  label={`Sell ${item.symbol}`}
                  variant="secondary"
                  onPress={() =>
                    navigation.navigate("Main", {
                      screen: "Exchange",
                      params: { mode: "sell", token: item.address, request: Date.now() },
                    })
                  }
                />
              )}
            </View>
          ))}
          {stocks.length > 1 && (
            <Typography variant="micro">
              Each buy is its own confidential swap with its own approval, one after another.
            </Typography>
          )}
          {pricing !== "ready" && (
            <Typography variant="micro" accessibilityLiveRegion="polite">
              {pricing === "failed"
                ? "Market prices for the stocks you hold couldn't be loaded yet. Copying waits for them, so nothing you hold is bought again."
                : "Getting market prices for the stocks you hold…"}
            </Typography>
          )}
          <Button
            label={stocks.length > 0 ? "Copy basket" : "Continue to deposits"}
            disabled={tooMuch || running || pricing !== "ready"}
            onPress={() => {
              setDeposits(vaults);
              void copy.start(stocks);
            }}
          />
        </View>
      )}
      {running && (
        <Typography accessibilityLiveRegion="polite" variant="rowValue">
          Buying {progress.current! + 1} of {progress.legs.length}:{" "}
          {progress.legs[progress.current!]!.symbol}
        </Typography>
      )}
      {progress.message && (
        <>
          <Notice error message={progress.message} />
          <Button label="Continue copying" variant="secondary" onPress={() => void copy.resume()} />
        </>
      )}
      {progress.finished && (
        <View className="gap-2">
          <Notice
            message={
              progress.legs.length > 0
                ? `Bought ${progress.legs.map((leg) => leg.symbol).join(", ")}. Your copy matches update ${signal.seq}.`
                : `Your copy matches update ${signal.seq}.`
            }
          />
          {deposits.map((leg) => (
            <Button
              key={leg.profileId}
              label={`Deposit ${usd(leg.atoms)} in the ${leg.label}`}
              variant="secondary"
              onPress={() =>
                navigation.navigate("Earn", {
                  profileId: leg.profileId,
                  amount: formatUsdc(leg.atoms.toString()),
                })
              }
            />
          ))}
          <Button
            label="Done"
            variant="secondary"
            onPress={() => {
              setDeposits([]);
              setBudget("");
              copy.reset();
            }}
          />
        </View>
      )}
    </View>
  );
}
