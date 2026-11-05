import { investmentDestination } from "@/domain/earn/distribution";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import type { EarnIntent, EarnPreflight } from "@/domain/earn/types";
import { earnProfiles } from "@/domain/earn/types";
import { formatUsdc } from "@/domain/wallet/amounts";
import { useEarn } from "./EarnProvider";
export function PreflightPanel({ intent }: { intent: EarnIntent }) {
  const { preflight } = useEarn();
  const [state, setState] = useState<EarnPreflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  async function check() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    setState(null);
    try {
      const next = await preflight.check(
        intent.profileId,
        investmentDestination(intent).address,
        controller.signal,
      );
      if (!controller.signal.aborted) setState(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Vault readiness unavailable.");
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Surface>
      <View className="gap-3 p-5">
        <Typography variant="row">Vault readiness</Typography>
        <Typography variant="caption">
          Check {intent.distribution ? "the selected investment wallet" : "wallet 2"} and the
          selected vault before planning fees. This check does not authorize an investment.
        </Typography>
        <Button
          label="Check vault readiness"
          variant="secondary"
          loading={busy}
          onPress={() => void check()}
        />
        {state && (
          <>
            <Typography>Vault asset verified · {earnProfiles[intent.profileId].symbol}</Typography>
            <Typography variant="caption">
              {intent.distribution ? "Selected wallet" : "Wallet 2"} balance:{" "}
              {formatUsdc(state.tokenBalance)} {earnProfiles[intent.profileId].symbol}
            </Typography>
            <Typography variant="caption">
              {state.newCycleReady
                ? "No existing shares found in this wallet."
                : "Existing shares or unsupported native ETH require reconciliation before a new cycle."}
            </Typography>
            <Typography variant="caption">
              Total fees require deposit and future withdrawal simulation, live routing quotes and a
              separate approval.
            </Typography>
          </>
        )}
        {message !== "" && <Typography accessibilityRole="alert">{message}</Typography>}
      </View>
    </Surface>
  );
}
