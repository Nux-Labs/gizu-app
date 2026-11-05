import { View } from "react-native";
import { Bell, CircleCheck, CircleX } from "lucide-react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { Surface } from "@/components/molecules/Surface";
import { formatSwapAmount } from "@/domain/swap";
import { groupDigits } from "@/domain/wallet/amounts";
import { formatTokenAtoms } from "./confidentialSwap";
import type { StoredSwapView } from "@/domain/wallet/storedSigner";
import colors from "@/theme/colors.json";

/** A swap that has ended: nothing to resume, so it must not compete with the swap form. */
export const isFinished = (status: StoredSwapView | null): status is StoredSwapView =>
  status !== null && (status.phase === "COMPLETE" || status.phase === "CANCELLED");

function Facts({ status, fullRows }: { status: StoredSwapView; fullRows: boolean }) {
  return (
    <>
      {fullRows ? (
        <>
          <Typography variant="micro">{status.phase}</Typography>
          <Typography variant="micro">
            {status.direction === "sell" ? "Sell" : "Buy"} · {status.targetSymbol || "Target"} ·
            step {status.step || "—"}
            {status.pausedCode ? ` · ${status.pausedCode}` : ""}
          </Typography>
        </>
      ) : null}
      <Typography variant="micro">
        Payouts {status.payoutsSubmitted} · orders {status.ordersComplete}
      </Typography>
      {/^[1-9]\d*$/.test(status.creditedAtoms) ? (
        <Typography variant="micro">
          Private balance · {formatSwapAmount(BigInt(status.creditedAtoms))} USDC
        </Typography>
      ) : null}
      {status.returnAddresses.length > 0 ? (
        <Typography variant="micro" selectable>
          Return wallets{"\n"}
          {status.returnAddresses.join("\n")}
        </Typography>
      ) : null}
    </>
  );
}

/** An unfinished swap needs the user's attention, so it keeps the prominent card. */
export function ActiveSwapCard({ status }: { status: StoredSwapView }) {
  return (
    <Surface>
      <View className="gap-2 px-5 py-5">
        <Typography variant="cardTitle">
          {status.phase === "PAUSED" ? "Swap paused" : "Swap in progress"}
        </Typography>
        <Typography variant="caption">
          {status.direction === "sell" ? "Selling" : "Buying"} {status.targetSymbol || "tokens"}
        </Typography>
        <HoldingDetails label="Swap details" accessibilityLabel="Swap details">
          <Facts status={status} fullRows />
        </HoldingDetails>
      </View>
    </Surface>
  );
}

/** Small notification bell beside the page title; a green dot says completed, a muted one cancelled. */
export function LastSwapButton({
  status,
  open,
  onPress,
}: {
  status: StoredSwapView;
  open: boolean;
  onPress: () => void;
}) {
  const done = status.phase === "COMPLETE";
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={done ? "Last swap completed" : "Last swap cancelled"}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      hitSlop={8}
      className="h-10 w-10 items-center justify-center rounded-full border border-borderSoft bg-glassSoft"
    >
      <Bell size={18} color={open ? colors.text : colors.fg["55"]} />
      <View
        className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: done ? colors.neon.DEFAULT : colors.fg["45"] }}
      />
    </PressableScale>
  );
}

const wallets = (count: number) => `${count} wallet${count === 1 ? "" : "s"}`;
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Typography variant="micro">{label}</Typography>
      <Typography variant="caption" className="flex-1 text-right">
        {value}
      </Typography>
    </View>
  );
}

/** What the info button opens: a plain-language summary of the swap that just ended. */
export function LastSwapSummary({ status, canSell }: { status: StoredSwapView; canSell: boolean }) {
  const done = status.phase === "COMPLETE";
  const sell = status.direction === "sell";
  const symbol = status.targetSymbol || "tokens";
  const total = status.legs ?? Math.max(status.ordersComplete, status.payoutsSubmitted, 1);
  // A sell sells from its holder wallets and pays out to `legs` fresh ones.
  const sold = status.holders ?? total;
  const spent = /^[1-9]\d*$/.test(status.sourceAtoms)
    ? `${groupDigits(formatSwapAmount(BigInt(status.sourceAtoms)))} USDC`
    : null;
  const received =
    !sell && /^[1-9]\d*$/.test(status.receivedTargetAtoms) && status.targetDecimals > 0
      ? `${formatTokenAtoms(status.receivedTargetAtoms, status.targetDecimals)} ${symbol}`
      : null;
  const untouched = status.ordersComplete === 0 && status.payoutsSubmitted === 0;
  const Icon = done ? CircleCheck : CircleX;
  const title = done
    ? sell
      ? `Sold ${symbol}`
      : received
        ? `Bought ${received}`
        : `Bought ${symbol}`
    : "Swap cancelled";
  const detail = done
    ? "Finished successfully."
    : untouched
      ? `Nothing was ${sell ? "sold" : "bought"} and nothing is pending.`
      : "Stopped partway. Anything already completed stays in your wallets.";
  return (
    <Surface>
      <View className="gap-4 px-4 py-4" accessibilityLiveRegion="polite">
        <View className="flex-row items-center gap-3">
          <Icon size={26} color={done ? colors.neon.DEFAULT : colors.fg["55"]} />
          <View className="flex-1 gap-0.5">
            <Typography variant="rowTitle">{title}</Typography>
            <Typography variant="micro">{detail}</Typography>
          </View>
        </View>
        {done || !untouched ? (
          <View className="gap-3 rounded-2xl bg-well p-3">
            {!sell && spent && done ? <Row label="You paid" value={spent} /> : null}
            {!sell && received && !done ? <Row label="You got" value={received} /> : null}
            {sell ? (
              <Row
                label={done ? "Sold from" : "Sold so far from"}
                value={`${status.ordersComplete} of ${wallets(sold)}`}
              />
            ) : (
              <Row
                label={done ? "Split across" : "Finished"}
                value={
                  done
                    ? wallets(status.payoutsSubmitted || total)
                    : `${status.ordersComplete} of ${wallets(total)}`
                }
              />
            )}
            {sell && done && status.completionTarget !== "confidential" ? (
              <Row label="USDC sent to" value={`${wallets(status.payoutsSubmitted)} on Monad`} />
            ) : null}
            {status.completionTarget === "confidential" && sell && done ? (
              <Row
                label="Verified private USDC credit"
                value={`${formatSwapAmount(BigInt(status.privateCreditedAtoms!))} USDC`}
              />
            ) : null}
            {/^[1-9]\d*$/.test(status.creditedAtoms) &&
            sell &&
            done &&
            status.completionTarget !== "confidential" ? (
              <Row
                label={status.holders !== undefined ? "Paid out" : "Last payout"}
                value={`${formatSwapAmount(BigInt(status.creditedAtoms))} USDC`}
              />
            ) : null}
          </View>
        ) : null}
        {sell && done && status.completionTarget === "confidential" && (
          <Typography variant="caption">
            Proceeds remain confidential until you withdraw from Gizu.
          </Typography>
        )}
        {status.returnAddresses.length > 0 ? (
          <HoldingDetails label="Show wallet addresses" accessibilityLabel="Wallet addresses">
            <Typography variant="micro">Wallets set aside for this payout</Typography>
            {status.returnAddresses.map((address) => (
              <View key={address} className="gap-0.5">
                <Typography variant="caption">{shortAddress(address)}</Typography>
                <Typography variant="micro" selectable>
                  {address}
                </Typography>
              </View>
            ))}
          </HoldingDetails>
        ) : null}
        {done && !sell && canSell ? (
          <Typography variant="micro">
            Your tokens are in Token holdings on Home, and you can sell them from this page.
          </Typography>
        ) : null}
      </View>
    </Surface>
  );
}
