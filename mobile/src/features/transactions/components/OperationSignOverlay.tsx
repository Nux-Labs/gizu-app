import { Button } from "@/components/atoms/Button";
import { SignStatus, useSignOverlay, type SignState } from "@/components/molecules/SignStatus";
import type { Operation } from "../TransactionProvider";

type Phase = Operation["phase"];

// Pending/unknown are submitted but unsettled: close without a success mark.
function signState(phase: Phase | undefined): SignState | null {
  if (phase === "signing" || phase === "submitting") return "signing";
  if (phase === "confirmed") return "done";
  if (phase === "failed" || phase === "rejected") return "failed";
  return null;
}

const LABELS: Partial<Record<Phase, string>> = {
  signing: "Signing with passkey",
  submitting: "Sending",
  confirmed: "Confirmed",
  failed: "Not completed",
  rejected: "Signature rejected",
};

/** Web SignOverlay over the order screen while the operation is signed and submitted. */
export function OperationSignOverlay({
  phase,
  onCancel,
}: {
  phase: Phase | undefined;
  onCancel: () => void;
}) {
  const state = useSignOverlay(signState(phase));
  if (!state || !phase) return null;
  return (
    <SignStatus
      layout="overlay"
      state={state}
      label={LABELS[phase]}
      tone={state === "failed" ? "negative" : "positive"}
    >
      {phase === "signing" && <Button label="Cancel signing" variant="quiet" onPress={onCancel} />}
    </SignStatus>
  );
}
