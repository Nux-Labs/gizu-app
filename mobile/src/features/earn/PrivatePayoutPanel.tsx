import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { formatUsdc } from "@/domain/wallet/amounts";
import { earnProfiles, type EarnIntent } from "@/domain/earn/types";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { payoutLegs } from "@/domain/earn/distribution";
import { useEarn } from "./EarnProvider";
import { useEarnJournal } from "./useEarnJournal";
export function PrivatePayoutPanel({
  intent,
  funding,
  fundings,
  fundingBlocked = false,
}: {
  intent: EarnIntent;
  funding?: SponsoredOperation;
  fundings?: SponsoredOperation[];
  fundingBlocked?: boolean;
}) {
  const service = useEarn().payout,
    v = useEarnJournal(intent, service),
    sources = fundings ?? (funding ? [funding] : []);
  const disabled =
      fundingBlocked || v.busy || v.loading || !v.available || v.rows.some((r) => r.blocked),
    symbol = earnProfiles[intent.profileId].symbol;
  return (
    <View className="gap-3">
      <Typography variant="row">Independent wallet payouts</Typography>
      {(sources.length ? sources : [undefined]).map((source) => {
        const credit = source?.status === "credited" ? BigInt(source.creditedAtoms ?? "0") : 0n;
        const hold = credit / 10n,
          invest = credit - hold;
        const accountLabel =
          sources.length > 1 ? ` from account ${source?.sourceAccountIndex}` : "";
        return (
          <View key={source?.operationId ?? "saved"} className="gap-2">
            {credit > 0n ? (
              <Typography>
                {intent.distribution
                  ? `Verified private credit is allocated across ${intent.distribution.weightsBps.length} investment wallets using the saved shares. Every wallet invests after its fees and reserve.`
                  : `Confirmed private credit allocation: ${formatUsdc(hold.toString())} USDC for wallet 1 and ${formatUsdc(invest.toString())} USDC for wallet 2. Each route receives its own native quote and authorization.`}
              </Typography>
            ) : (
              <Typography>
                Payouts wait for authenticated credit from this funding operation.
              </Typography>
            )}
            {payoutLegs(intent).map((leg, index) => (
              <Button
                key={leg}
                label={`Review and authorize wallet ${index + 1} payout${accountLabel}`}
                disabled={
                  disabled ||
                  credit < 10n ||
                  v.rows.some(
                    (row) =>
                      row.leg === leg &&
                      (!row.sourceOperationId || row.sourceOperationId === source?.operationId),
                  )
                }
                onPress={() => {
                  if (source) void v.perform(() => service.execute(intent, source, leg), v.update);
                }}
              />
            ))}
          </View>
        );
      })}
      {v.rows.map((row) => (
        <View key={row.operationId} className="gap-2">
          <Typography>
            Wallet{" "}
            {row.leg.startsWith("invest:")
              ? Number(row.leg.split(":")[1]) + 1
              : row.leg === "hold"
                ? 1
                : 2}{" "}
            payout · {row.status}
          </Typography>
          <Typography>
            Allocated input: {formatUsdc(row.amountAtoms)} USDC · minimum destination credit:{" "}
            {formatUsdc(row.minimumDestinationAtoms)} {symbol}
          </Typography>
          {row.status === "paid" && (
            <Typography>
              {intent.distribution
                ? "Investment wallet funding is verified. Review its investment fees."
                : row.leg === "hold"
                  ? "Wallet 1 funds remain separate."
                  : "Wallet 2 funding is verified. Review its investment fees."}{" "}
              Received {formatUsdc(row.receivedAtoms)} {symbol}.
            </Typography>
          )}
          {row.destinationTransactionHash && (
            <Typography selectable variant="caption">
              {row.destinationTransactionHash}
            </Typography>
          )}
          {(row.canResume || row.canRefreshUnsigned) && (
            <Button
              label={
                row.canRefreshUnsigned ? "Refresh unsigned payout review" : "Review saved payout"
              }
              disabled={v.busy || fundingBlocked}
              variant="secondary"
              onPress={() => void v.perform(() => service.resume(intent, row), v.update)}
            />
          )}
          {row.blocked && (
            <Button
              label="Check payout settlement"
              disabled={v.busy}
              variant="secondary"
              onPress={() => void v.perform(() => service.reconcile(intent, row), v.update)}
            />
          )}
          {row.status === "planned" && (
            <Button
              label="Cancel unsigned payout review"
              disabled={v.busy}
              variant="secondary"
              onPress={() => void v.perform(() => service.cancelUnsigned(intent, row), v.update)}
            />
          )}
        </View>
      ))}
      <Typography variant="caption">
        {intent.distribution
          ? "The native dialog checks the saved distribution, wallet slot, destination, qualified fees and deadline."
          : "The native dialog checks the exact 10/90 split, destination, qualified quote fees and deadline. No joint wallet transaction or shared application fee is added."}
      </Typography>
      <Button
        label="Check saved payouts"
        variant="secondary"
        disabled={v.busy || v.loading}
        onPress={() => void v.refresh()}
      />
      {v.message && <Typography accessibilityRole="alert">{v.message}</Typography>}
    </View>
  );
}
