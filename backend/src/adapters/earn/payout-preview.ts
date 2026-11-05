import { createHash } from "node:crypto";
import { payoutLegSchema, type PayoutLeg } from "./distribution.ts";
import { auroraApi } from "../aurora/http.ts";
import { monadUsdcAssetId, robinhoodUsdgAssetId } from "../aurora/assets.ts";
import {
  qualifyAuroraFees,
  type AuroraFeeQualification,
} from "./fee-policy.ts";
type Input = {
  profileChainId: 4663;
  confidentialAccount: string;
  recipient: string;
  amountAtoms: string;
  operationId: string;
  revision: number;
  leg: PayoutLeg;
};
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Malformed preview");
  return v as Record<string, unknown>;
}
function atoms(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[1-9][0-9]{0,77}$/.test(v) ||
    BigInt(v) >= 1n << 256n
  )
    throw new Error("Invalid preview amount");
  return v;
}
export class EarnPayoutPreviewGateway {
  constructor(
    private config: {
      auroraApiKey?: string;
      auroraFeeQualification?: AuroraFeeQualification;
    },
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  async preview(input: Input) {
    if (
      input.profileChainId !== 4663 ||
      !this.config.auroraApiKey ||
      !/^[-a-zA-Z0-9_]{1,128}$/.test(input.operationId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !payoutLegSchema.safeParse(input.leg).success
    )
      throw new Error("Invalid payout preview");
    for (const address of [input.recipient, input.confidentialAccount])
      if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address))
        throw new Error("Invalid preview recipient");
    if (
      input.recipient.toLowerCase() === input.confidentialAccount.toLowerCase()
    )
      throw new Error("Self payout forbidden");
    const quotedAtMs = this.now(),
      request = {
        dry: true,
        swapType: "EXACT_INPUT",
        depositType: "CONFIDENTIAL_INTENTS",
        depositMode: "SIMPLE",
        confidentiality: "advanced",
        amount: atoms(input.amountAtoms),
        originAsset: monadUsdcAssetId,
        destinationAsset: robinhoodUsdgAssetId,
        // The approved floor is 7% below the estimate: the signing quote uses 5% (see private-payout),
        // so its guaranteed minimum stays above this floor through ~2% of drift between review and signing.
        slippageTolerance: 700,
        refundTo: input.confidentialAccount.toLowerCase(),
        refundType: "CONFIDENTIAL_INTENTS",
        recipient: input.recipient.toLowerCase(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(quotedAtMs + 600000).toISOString(),
      };
    const body = await auroraApi(
        this.config.auroraApiKey,
        this.fetcher,
        "quote/{key}",
        request,
      ),
      qr = object(body.quoteRequest),
      q = object(body.quote);
    for (const [key, value] of Object.entries(request))
      if (qr[key] !== value) throw new Error("Changed preview route");
    const feePolicy = qualifyAuroraFees(
      this.config.auroraFeeQualification,
      "payoutRobinhood",
      qr,
    );
    for (const row of [qr, q])
      for (const field of [
        "depositMemo",
        "chainDepositAddresses",
        "virtualChainRecipient",
        "virtualChainRefundRecipient",
        "customRecipientMsg",
      ])
        if (row[field] != null) throw new Error("Additional preview effects");
    if (
      qr.connectedWallets != null &&
      (!Array.isArray(qr.connectedWallets) || qr.connectedWallets.length)
    )
      throw new Error("Extra preview wallets");
    const estimatedOutputAtoms = atoms(q.amountOut),
      minimumOutputAtoms = atoms(q.minAmountOut),
      observedAt = Date.parse(String(body.timestamp)),
      // Dry quotes have no executable deadline; this is only a short local preview lifetime.
      deadline = q.deadline == null ? Infinity : Date.parse(String(q.deadline)),
      inactive =
        q.timeWhenInactive == null
          ? Infinity
          : Date.parse(String(q.timeWhenInactive));
    if (
      q.amountIn !== input.amountAtoms ||
      q.minAmountIn !== input.amountAtoms ||
      BigInt(minimumOutputAtoms) > BigInt(estimatedOutputAtoms) ||
      !Number.isFinite(observedAt) ||
      Math.abs(observedAt - quotedAtMs) > 60000 ||
      this.now() - quotedAtMs > 60000
    )
      throw new Error("Unverified preview output");
    const expiresAtMs = Math.min(quotedAtMs + 45000, deadline, inactive);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now() + 15000)
      throw new Error("Expired preview route");
    return {
      kind: "preview" as const,
      readOnly: true as const,
      executionAvailable: false as const,
      assumption: "indicative-unfunded-confidential-route" as const,
      operationId: input.operationId,
      revision: input.revision,
      profileChainId: 4663 as const,
      leg: input.leg,
      recipient: input.recipient,
      amountAtoms: input.amountAtoms,
      estimatedOutputAtoms,
      minimumOutputAtoms,
      feePolicy,
      quotedAtMs,
      expiresAtMs,
      referenceHash:
        "0x" + createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    };
  }
}
