import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  SettleError,
  VerifyError,
  type PaymentPayload,
  type PaymentRequirements,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Address } from "viem";
import {
  SignalPaymentRejected,
  type SignalPaymentRequired,
  type SignalPaymentSettled,
  type SignalPaywall,
} from "../../ports/strategies.port.ts";

/** CAIP-2 network of the strategy registry; payments settle in that network's USDC. */
export type SignalPaymentNetwork = "eip155:8453" | "eip155:84532";

/** How long a signed payment authorization may wait before settlement. */
const MAX_TIMEOUT_SECONDS = 120;

type Facilitator = ConstructorParameters<typeof x402ResourceServer>[0];

/**
 * x402 v2 paywall for strategy signals. The "exact" EVM scheme resolves the network's USDC and
 * its EIP-712 domain; the facilitator verifies the payment authorization and settles it on chain.
 */
export class X402SignalPaywall implements SignalPaywall {
  private readonly server: x402ResourceServer;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly network: SignalPaymentNetwork,
    private readonly payTo: Address,
    facilitator: Facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }),
  ) {
    this.server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  }

  async required(input: {
    priceAtoms: string;
    resourceUrl: string;
    description: string;
    error?: string;
  }): Promise<SignalPaymentRequired> {
    await this.initialize();
    const requirements = await this.server.buildPaymentRequirements({
      scheme: "exact",
      network: this.network,
      payTo: this.payTo,
      price: dollars(input.priceAtoms),
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });
    const body = await this.server.createPaymentRequiredResponse(
      requirements,
      { url: input.resourceUrl, description: input.description, mimeType: "application/json" },
      input.error,
    );
    return { header: encodePaymentRequiredHeader(body), body, requirements };
  }

  async settle(input: {
    paymentHeader: string;
    required: SignalPaymentRequired;
  }): Promise<SignalPaymentSettled> {
    await this.initialize();
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(input.paymentHeader);
    } catch {
      throw new SignalPaymentRejected("malformed_payment");
    }
    const requirements = input.required.requirements as PaymentRequirements[];
    const matched = this.server.findMatchingRequirements(requirements, payload);
    if (!matched) throw new SignalPaymentRejected("payment_does_not_match_requirements");
    // Facilitators report a refused payment either in a 200 body or as a non-2xx status, which
    // the x402 client raises as VerifyError/SettleError; both are the payer's problem, not an outage.
    const verified = await this.server.verifyPayment(payload, matched).catch((error: unknown) => {
      if (error instanceof VerifyError)
        throw new SignalPaymentRejected(error.invalidReason ?? "invalid_payment");
      throw error;
    });
    if (!verified.isValid) throw new SignalPaymentRejected(verified.invalidReason ?? "invalid_payment");
    const settled = await this.server.settlePayment(payload, matched).catch((error: unknown) => {
      if (error instanceof SettleError)
        throw new SignalPaymentRejected(error.errorReason ?? "settlement_failed");
      throw error;
    });
    if (!settled.success) throw new SignalPaymentRejected(settled.errorReason ?? "settlement_failed");
    // Facilitators may omit the amount; the receipt states what was charged either way.
    const amountAtoms = settled.amount ?? matched.amount;
    return {
      payer: settled.payer ?? verified.payer ?? "",
      transaction: settled.transaction,
      amountAtoms,
      responseHeader: encodePaymentResponseHeader({ ...settled, amount: amountAtoms }),
    };
  }

  /** Learns the facilitator's supported kinds once; a failure is retried on the next request. */
  private initialize(): Promise<void> {
    if (!this.ready)
      this.ready = this.server.initialize().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
}

/** USDC base units as an exact dollar string, for example "500000" -> "$0.5". */
export function dollars(atoms: string): string {
  if (!/^(0|[1-9]\d*)$/.test(atoms)) throw new Error("Invalid USDC amount.");
  const padded = atoms.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}
