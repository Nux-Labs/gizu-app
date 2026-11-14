import { ProgressLadder, type LadderStep } from "@/components/molecules/ProgressLadder";

const labels = [
  "Withdraw funds from vault",
  "Quote ready for confidential transaction",
  "Funds sent to confidential wallet",
  "Funds received",
];

export function WithdrawalLadder({
  withdrawn,
  quoteReady,
  sent,
  received,
  paused,
  started = true,
}: {
  withdrawn: boolean;
  quoteReady: boolean;
  sent: boolean;
  received: boolean;
  paused: boolean;
  started?: boolean;
}) {
  const complete = [withdrawn, quoteReady, sent, received];
  const active = complete.findIndex((done) => !done);
  const steps: LadderStep[] = labels.map((label, index) => ({
    id: String(index),
    label,
    state: complete[index]
      ? "complete"
      : index === active
        ? paused
          ? "paused"
          : started
            ? "active"
            : "pending"
        : "pending",
  }));
  return <ProgressLadder steps={steps} />;
}
