import { useIsFocused } from "@react-navigation/native";
import { ToastHost } from "@/components/organisms/toast/ToastHost";
import { useSession } from "@/application/SessionProvider";
import { NativeTransaction } from "./NativeTransaction";
import { useState } from "react";
import { View } from "react-native";
import { Fingerprint } from "lucide-react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/navigation/types";
import { BackAction } from "@/navigation/BackAction";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Notice } from "@/components/molecules/Notice";
import { decimal, operationLabels } from "@/domain/transactions";
import { unresolved, useTransactions } from "./TransactionProvider";
import { useOrderController } from "./useOrderController";
import { OperationFeedback } from "./OperationFeedback";
import { OperationSignOverlay } from "./components/OperationSignOverlay";
import { AmountField, PercentChips, ReviewRows, Sheet, SheetRow } from "./components/TransferSheet";
import colors from "@/theme/colors.json";

export function TransactionScreen(
  props: NativeStackScreenProps<RootStackParamList, "Transaction">,
) {
  const { session } = useSession();
  const focused = useIsFocused();
  return (
    <View className="flex-1">
      {session?.kind === "testnet" || session?.kind === "mainnet" ? (
        <NativeTransaction {...props} />
      ) : (
        <DemoTransaction {...props} />
      )}
      {focused ? <ToastHost /> : null}
    </View>
  );
}
function DemoTransaction({ route }: NativeStackScreenProps<RootStackParamList, "Transaction">) {
  const { kind = "buy", vaultId, resume = false } = route.params;
  const context = useTransactions();
  const c = useOrderController(kind, vaultId);
  const [observing, setObserving] = useState(resume);
  const vault = context.account?.vaults.find((v) => v.id === vaultId);
  const title =
    kind === "deposit" ? "Add funds" : kind === "withdraw" ? "Send" : operationLabels[kind];
  const unit = kind === "sell" ? (vault?.ticker ?? "units") : "USDC";
  const balance =
    context.account &&
    (kind === "sell"
      ? vault?.redeemable
      : kind === "deposit"
        ? context.account.wallet
        : context.account.cash);
  const showOperation = observing || unresolved(context.operation);
  const verb = kind === "withdraw" ? "withdrawal" : kind;
  return (
    <View className="flex-1 bg-ink">
      <Screen>
        <BackAction fallback="Home" />
        <Typography variant="title">
          {showOperation ? "Operation status" : `${title}${vault ? ` ${vault.ticker}` : ""}`}
        </Typography>
        {showOperation ? (
          <OperationFeedback
            onReview={() => {
              setObserving(false);
              c.edit();
            }}
          />
        ) : (
          <>
            {context.loading && <Typography>Loading available balances…</Typography>}
            {context.error && (
              <>
                <Notice error message={context.error} />
                <Button label="Reload balances" onPress={() => void context.refresh()} />
              </>
            )}
            {vault && (
              <Typography variant="micro">
                {vault.name} · 1 {vault.ticker} = {decimal(vault.price)} USDC
              </Typography>
            )}
            <Sheet>
              {c.quote ? (
                <>
                  <Typography variant="section">Review {verb}</Typography>
                  <ReviewRows
                    rows={[
                      ["From", c.quote.from],
                      ["To", c.quote.to],
                      ["Total debit", `${decimal(c.quote.debit)} ${unit}`],
                      ["You receive", `${decimal(c.quote.credit)} ${c.quote.to}`],
                      ["Fees included", `${decimal(c.quote.fee)} USDC`],
                      ["Network", "Monad"],
                      ...(vault ? [["Lockup", vault.lockup] as const] : []),
                    ]}
                  />
                  <Typography variant="micro">
                    Quote valid for 60 seconds. It is checked again before submission. Confirmation
                    determines the final status.
                  </Typography>
                  <Button
                    label={`Confirm ${verb}`}
                    variant={kind === "sell" ? "destructive" : "primary"}
                    disabled={c.blocked}
                    onPress={() => {
                      setObserving(true);
                      void context.execute(c.quote!);
                    }}
                  />
                  <Button label="Edit amount" variant="secondary" onPress={() => c.edit()} />
                </>
              ) : (
                <>
                  <AmountField
                    unit={unit}
                    label={`Amount · ${unit}`}
                    available={`${kind === "sell" ? "Unlocked" : "Available"}: ${balance ? decimal(balance) : "—"} ${unit}`}
                    value={c.amount}
                    onChange={c.edit}
                    editable={!c.quoting && !c.blocked}
                  />
                  <PercentChips disabled={c.quoting || c.blocked} onSelect={c.percentage} />
                  <SheetRow
                    icon={<Fingerprint size={18} color={colors.accent} accessible={false} />}
                  >
                    <Typography variant="rowTitle">
                      {kind === "deposit"
                        ? "Passkey wallet → Account"
                        : kind === "withdraw"
                          ? "Account → Passkey wallet"
                          : kind === "buy"
                            ? `Account USDC → ${unit === "USDC" ? (vault?.ticker ?? "vault") : unit}`
                            : `${unit} → Account USDC`}{" "}
                      · Monad
                    </Typography>
                  </SheetRow>
                  <View className="gap-1.5 px-1">
                    {vault && (
                      <Typography variant="micro">
                        Minimum buy: {decimal(vault.minimum)} USDC · Lockup: {vault.lockup}
                        {kind === "sell"
                          ? `. Total held: ${decimal(vault.units)} ${vault.ticker}; only unlocked units can be sold.`
                          : ""}
                      </Typography>
                    )}
                    <Typography variant="micro">
                      Network fee: 0.42 USDC
                      {kind === "buy" || kind === "sell" ? " · Trading fee: 0.05%" : ""}. Max
                      reserves applicable fees.
                    </Typography>
                  </View>
                  {c.error && <Notice error message={c.error} />}
                  <Button
                    label={c.quoting ? "Getting quote" : `Review ${verb}`}
                    loading={c.quoting}
                    disabled={c.blocked}
                    variant={kind === "sell" ? "destructive" : "primary"}
                    onPress={() => void c.review()}
                  />
                </>
              )}
            </Sheet>
          </>
        )}
      </Screen>
      {showOperation && (
        <OperationSignOverlay phase={context.operation?.phase} onCancel={context.cancelSigning} />
      )}
    </View>
  );
}
