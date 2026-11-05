import assert from "node:assert/strict";
import test from "node:test";
import { EarnPayoutPreviewGateway } from "../../../src/adapters/earn/payout-preview.ts";
const now = 1800000000000;
const input = {
  profileChainId: 4663 as const,
  confidentialAccount: "0x" + "1".repeat(40),
  recipient: "0x" + "2".repeat(40),
  amountAtoms: "1000000",
  operationId: "preview",
  revision: 1,
  leg: "hold" as const,
};
const qualification = {
  protocolFeeBps: 2 as const,
  appFees: [{ recipient: "provider", fee: 2 as const }],
  referral: null,
};
test("payout previews accept all distribution investment slot identities", async () => {
  const gateway = new EarnPayoutPreviewGateway(
    { auroraApiKey: "test", auroraFeeQualification: qualification },
    fetcher(),
    () => now,
  );
  for (const leg of [
    "invest:0",
    "invest:1",
    "invest:2",
    "invest:3",
    "invest:4",
  ] as const)
    assert.equal((await gateway.preview({ ...input, leg })).leg, leg);
  await assert.rejects(gateway.preview({ ...input, leg: "invest:5" } as never));
});
function fetcher(change: Record<string, unknown> = {}): typeof fetch {
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.dry, true);
    assert.equal(request.depositType, "CONFIDENTIAL_INTENTS");
    return Response.json({
      quoteRequest: {
        ...request,
        appFees: qualification.appFees,
        referral: null,
      },
      quote: {
        amountIn: request.amount,
        minAmountIn: request.amount,
        amountOut: "990000",
        minAmountOut: "980000",
        deadline: request.deadline,
        ...change,
      },
      timestamp: new Date(now).toISOString(),
    });
  }) as typeof fetch;
}
test("payout preview checks the route's qualified fees and exposes only indicative public amounts", async () => {
  const gateway = new EarnPayoutPreviewGateway(
    { auroraApiKey: "test", auroraFeeQualification: qualification },
    fetcher(),
    () => now,
  );
  const result = await gateway.preview(input);
  assert.equal(result.minimumOutputAtoms, "980000");
  assert.equal(result.estimatedOutputAtoms, "990000");
  assert.equal(result.feePolicy.totalBps, 2);
  assert.equal(result.executionAvailable, false);
  assert.equal("signedData" in result, false);
  assert.equal("quote" in result, false);
});
test("documented dry quotes without executable deadlines retain only a short indicative preview expiry", async () => {
  const gateway = new EarnPayoutPreviewGateway(
    { auroraApiKey: "test", auroraFeeQualification: qualification },
    fetcher({ deadline: undefined, timeWhenInactive: undefined }),
    () => now,
  );
  const result = await gateway.preview(input);
  assert.equal(result.expiresAtMs, now + 45000);
  assert.equal(result.executionAvailable, false);
  assert.equal(result.minimumOutputAtoms, "980000");
  assert.equal("deadline" in result, false);
  assert.equal("depositAddress" in result, false);
});
test("unqualified fees, zero outputs and changed input cannot become a payout preview", async () => {
  await assert.rejects(
    new EarnPayoutPreviewGateway(
      { auroraApiKey: "test" },
      fetcher(),
      () => now,
    ).preview(input),
  );
  for (const change of [
    { minAmountOut: "0" },
    { amountIn: "2" },
    { minAmountOut: "999999" },
    { deadline: new Date(now - 1).toISOString() },
    { deadline: "malformed" },
    { timeWhenInactive: "malformed" },
  ])
    await assert.rejects(
      new EarnPayoutPreviewGateway(
        { auroraApiKey: "test", auroraFeeQualification: qualification },
        fetcher(change),
        () => now,
      ).preview(input),
    );
});
test("the approval floor preview allows 7%, leaving headroom for the 5% signing quote", async () => {
  let slippage: unknown;
  const base = fetcher();
  const gateway = new EarnPayoutPreviewGateway(
    { auroraApiKey: "test", auroraFeeQualification: qualification },
    (async (url, init) => {
      slippage = JSON.parse(String(init?.body)).slippageTolerance;
      return base(url, init);
    }) as typeof fetch,
    () => now,
  );
  await gateway.preview(input);
  assert.equal(slippage, 700);
});
