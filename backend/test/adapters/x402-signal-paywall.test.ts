import assert from "node:assert/strict";
import { test } from "node:test";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { X402SignalPaywall, dollars } from "../../src/adapters/x402/x402-signal-paywall.ts";
import { SignalPaymentRejected } from "../../src/ports/strategies.port.ts";

const PAY_TO = "0x7a09de3500b242d260c4c621E92Ac1cE81b5535A";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SETTLEMENT_TX = `0x${"ab".repeat(32)}`;
const agent = privateKeyToAccount(`0x${"11".repeat(32)}`);
const request = {
  priceAtoms: "500000",
  resourceUrl: "https://api.example/v1/strategies/3/signal",
  description: 'Current basket of the Gizu strategy "AI chips"',
};

function facilitator(verifyValid = true) {
  const calls = {
    verify: [] as { payload: PaymentPayload; requirements: PaymentRequirements }[],
    settle: [] as { payload: PaymentPayload; requirements: PaymentRequirements }[],
  };
  const client = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" as const }],
      extensions: [],
      signers: {},
    }),
    verify: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      calls.verify.push({ payload, requirements });
      return verifyValid
        ? { isValid: true, payer: agent.address }
        : { isValid: false, invalidReason: "insufficient_funds" };
    },
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      calls.settle.push({ payload, requirements });
      return {
        success: true,
        transaction: SETTLEMENT_TX,
        network: "eip155:84532" as const,
        payer: agent.address,
      };
    },
  };
  return { calls, client };
}

/** What an agent sends: the real x402 client signs an EIP-3009 authorization for the offer. */
async function pay(body: unknown): Promise<string> {
  const client = new x402Client().register("eip155:84532", new ExactEvmScheme(agent));
  const payload = await client.createPaymentPayload(body as Parameters<typeof client.createPaymentPayload>[0]);
  return encodePaymentSignatureHeader(payload);
}

test("the 402 offer asks for the strategy's price in Base Sepolia USDC to the payee", async () => {
  const { client } = facilitator();
  const paywall = new X402SignalPaywall("eip155:84532", PAY_TO, client);
  const required = await paywall.required(request);
  const offer = decodePaymentRequiredHeader(required.header);
  // The header and the JSON body carry the same offer.
  assert.deepEqual(offer, JSON.parse(JSON.stringify(required.body)));
  assert.equal(offer.x402Version, 2);
  assert.equal(offer.resource.url, request.resourceUrl);
  assert.equal(offer.resource.description, request.description);
  assert.equal(offer.accepts.length, 1);
  const [accept] = offer.accepts;
  assert.equal(accept!.scheme, "exact");
  assert.equal(accept!.network, "eip155:84532");
  assert.equal(accept!.amount, "500000");
  assert.equal(accept!.asset.toLowerCase(), BASE_SEPOLIA_USDC.toLowerCase());
  assert.equal(accept!.payTo.toLowerCase(), PAY_TO.toLowerCase());
});

test("a payment signed by the x402 client is verified, then settled", async () => {
  const { client, calls } = facilitator();
  const paywall = new X402SignalPaywall("eip155:84532", PAY_TO, client);
  const required = await paywall.required(request);
  const settled = await paywall.settle({ paymentHeader: await pay(required.body), required });
  assert.equal(settled.transaction, SETTLEMENT_TX);
  assert.equal(settled.payer, agent.address);
  assert.equal(settled.amountAtoms, "500000");
  const receipt = decodePaymentResponseHeader(settled.responseHeader);
  assert.equal(receipt.transaction, SETTLEMENT_TX);
  // The facilitator omitted the amount; the receipt still states what was charged.
  assert.equal(receipt.amount, "500000");
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.settle.length, 1);
  assert.equal(calls.settle[0]!.requirements.amount, "500000");
});

test("invalid, malformed and mismatched payments are rejected before settlement", async () => {
  const invalid = facilitator(false);
  const paywall = new X402SignalPaywall("eip155:84532", PAY_TO, invalid.client);
  const required = await paywall.required(request);
  await assert.rejects(
    paywall.settle({ paymentHeader: await pay(required.body), required }),
    (error) => error instanceof SignalPaymentRejected && error.reason === "insufficient_funds",
  );
  assert.equal(invalid.calls.settle.length, 0);

  await assert.rejects(
    paywall.settle({ paymentHeader: "not base64 json", required }),
    (error) => error instanceof SignalPaymentRejected && error.reason === "malformed_payment",
  );

  // A payment signed for a cheaper offer does not match this strategy's price.
  const valid = facilitator();
  const priced = new X402SignalPaywall("eip155:84532", PAY_TO, valid.client);
  const cheap = await priced.required({ ...request, priceAtoms: "250000" });
  const full = await priced.required(request);
  await assert.rejects(
    priced.settle({ paymentHeader: await pay(cheap.body), required: full }),
    (error) =>
      error instanceof SignalPaymentRejected && error.reason === "payment_does_not_match_requirements",
  );
  assert.equal(valid.calls.verify.length, 0);
});

test("refusals reported as HTTP errors or failed settlements are rejections, not outages", async () => {
  const refusing = facilitator();
  refusing.client.verify = async () => {
    // What HTTPFacilitatorClient throws when the facilitator answers 400 with a verify body.
    throw new VerifyError(400, { isValid: false, invalidReason: "insufficient_funds" });
  };
  const paywall = new X402SignalPaywall("eip155:84532", PAY_TO, refusing.client);
  const required = await paywall.required(request);
  await assert.rejects(
    paywall.settle({ paymentHeader: await pay(required.body), required }),
    (error) => error instanceof SignalPaymentRejected && error.reason === "insufficient_funds",
  );
  assert.equal(refusing.calls.settle.length, 0);

  const failing = facilitator();
  failing.client.settle = async () =>
    ({ success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "", network: "eip155:84532" }) as never;
  const settling = new X402SignalPaywall("eip155:84532", PAY_TO, failing.client);
  const offer = await settling.required(request);
  await assert.rejects(
    settling.settle({ paymentHeader: await pay(offer.body), required: offer }),
    (error) => error instanceof SignalPaymentRejected && error.reason === "invalid_exact_evm_nonce_already_used",
  );
});

test("prices convert exactly from USDC base units", () => {
  assert.equal(dollars("500000"), "$0.5");
  assert.equal(dollars("10000000"), "$10");
  assert.equal(dollars("1"), "$0.000001");
  assert.equal(dollars("123456789"), "$123.456789");
  assert.throws(() => dollars("-1"));
});
