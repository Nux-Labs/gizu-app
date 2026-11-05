import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { AuroraIntents } from "../../adapters/aurora/aurora-intents.ts";
import type { OneInchFusion } from "../../adapters/oneinch/fusion.ts";
import type { PimlicoMonadFunding } from "../../adapters/pimlico/monad-funding.ts";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/).transform((value) => getAddress(value) as Address);
const hex = z.string().regex(/^0x([a-fA-F0-9]{2})*$/).transform((value) => value as Hex);
const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).transform((value) => value as Hex);
const quantity = z.string().regex(/^0x[a-fA-F0-9]+$/);
const atoms = z.string().regex(/^[1-9]\d{0,38}$/).transform(BigInt);
const preset = z.enum(["fast", "medium", "slow"]);
const auroraRecipient = z.string().min(1).max(128);

const quoteBody = z.object({
  dry: z.literal(false),
  swapType: z.literal("EXACT_INPUT"),
  depositType: z.enum(["ORIGIN_CHAIN", "CONFIDENTIAL_INTENTS"]),
  recipientType: z.enum(["CONFIDENTIAL_INTENTS", "DESTINATION_CHAIN"]),
  recipient: auroraRecipient,
  refundType: z.enum(["ORIGIN_CHAIN", "CONFIDENTIAL_INTENTS"]),
  refundTo: auroraRecipient,
  originAsset: z.string().min(1).max(200),
  destinationAsset: z.string().min(1).max(200),
  amount: z.string().regex(/^[1-9]\d*$/),
  slippageTolerance: z.number().int().min(0).max(10_000),
  confidentiality: z.literal("advanced"),
}).strict();
const signedIntent = z.object({
  standard: z.literal("erc191"),
  payload: z.string().min(2).max(8_000),
  signature: z.string().regex(/^secp256k1:[1-9A-HJ-NP-Za-km-z]{80,100}$/),
}).strict();
const eip7702Auth = z.object({
  address,
  chainId: quantity,
  nonce: quantity,
  r: hash,
  s: hash,
  yParity: quantity,
}).strict();
const rpcUserOperation = z.object({
  sender: address,
  nonce: quantity,
  factory: z.string().regex(/^0x(7702|[a-fA-F0-9]{40})$/).optional(),
  factoryData: hex.optional(),
  callData: hex,
  callGasLimit: quantity,
  verificationGasLimit: quantity,
  preVerificationGas: quantity,
  maxFeePerGas: quantity,
  maxPriorityFeePerGas: quantity,
  paymaster: address,
  paymasterVerificationGasLimit: quantity,
  paymasterPostOpGasLimit: quantity,
  paymasterData: hex,
  signature: hex,
  eip7702Auth: eip7702Auth.optional(),
}).strict();
const limitOrder = z.object({
  salt: z.string().regex(/^\d+$/),
  maker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  receiver: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  makerAsset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  takerAsset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  makingAmount: z.string().regex(/^\d+$/),
  takingAmount: z.string().regex(/^\d+$/),
  makerTraits: z.string().regex(/^\d+$/),
}).strict();

type Gateway = {
  aurora: Pick<AuroraIntents, "tokens" | "quote" | "generateIntent" | "submitIntent" | "status" | "authSalt" | "authenticate" | "balances"> & Partial<Pick<AuroraIntents, "history">>;
  funding: Pick<PimlicoMonadFunding, "prepare" | "submit" | "receipt">;
  fusion: Pick<OneInchFusion, "preview" | "permitContext" | "createOrder" | "submit" | "status">;
};

// Addresses travel only in POST bodies so request logs never carry wallet links.
export function registerSwapRoutes(app: FastifyInstance, gateway: Gateway) {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route?.startsWith("/v1/swap/")) {
      request.log.info({ event: "swap.gateway", route, status: reply.statusCode, elapsedMs: Math.round(reply.elapsedTime) }, "swap gateway request");
    }
  });
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/v1/swap/aurora/tokens", async () => ({ tokens: await gateway.aurora.tokens() }));
  routes.post("/v1/swap/aurora/quote", { schema: { body: quoteBody } }, async (request) => gateway.aurora.quote(request.body));
  routes.post(
    "/v1/swap/aurora/generate-intent",
    { schema: { body: z.object({ signerId: address, depositAddress: auroraRecipient }).strict() } },
    async (request) => gateway.aurora.generateIntent(request.body.signerId.toLowerCase(), request.body.depositAddress),
  );
  routes.post(
    "/v1/swap/aurora/submit-intent",
    { schema: { body: z.object({ signedData: signedIntent }).strict() } },
    async (request) => gateway.aurora.submitIntent(request.body.signedData),
  );
  routes.post(
    "/v1/swap/aurora/status",
    { schema: { body: z.object({ depositAddress: auroraRecipient, depositMemo: z.string().max(200).optional() }).strict() } },
    async (request) => gateway.aurora.status(request.body.depositAddress, request.body.depositMemo),
  );
  routes.get("/v1/swap/aurora/auth-salt", async () => ({ salt: await gateway.aurora.authSalt() }));
  routes.post(
    "/v1/swap/aurora/authenticate",
    { schema: { body: z.object({ payload: z.string().min(2).max(2_000), signature: signedIntent.shape.signature }).strict() } },
    async (request) => gateway.aurora.authenticate(request.body.payload, request.body.signature),
  );
  routes.post("/v1/swap/aurora/history", {schema: {body: z.object({accessToken: z.string().min(1).max(4000), depositAddress: auroraRecipient}).strict()}}, async (request, reply) => {
    if (!gateway.aurora.history) return reply.code(503).send({code: "AUTHENTICATED_HISTORY_UNAVAILABLE"});
    return gateway.aurora.history(request.body.accessToken, request.body.depositAddress);
  });
  routes.post(
    "/v1/swap/aurora/balances",
    { schema: { body: z.object({ accessToken: z.string().min(1).max(4_000) }).strict() } },
    async (request) => gateway.aurora.balances(request.body.accessToken),
  );

  routes.post(
    "/v1/swap/monad/prepare-funding",
    { schema: { body: z.object({ owner: address, recipient: address, amount: atoms }).strict() } },
    async (request) => gateway.funding.prepare(request.body.owner, request.body.recipient, request.body.amount),
  );
  routes.post(
    "/v1/swap/monad/submit",
    { schema: { body: z.object({ userOperation: rpcUserOperation }).strict() } },
    async (request) => ({ userOperationHash: await gateway.funding.submit(request.body.userOperation) }),
  );
  routes.post(
    "/v1/swap/monad/receipt",
    { schema: { body: z.object({ userOperationHash: hash }).strict() } },
    async (request) => gateway.funding.receipt(request.body.userOperationHash),
  );

  routes.post(
    "/v1/swap/fusion/preview",
    { schema: { body: z.object({ wallet: address, dstToken: address, amount: atoms, preset, srcToken: address.optional() }).strict() } },
    async (request) => gateway.fusion.preview(
      request.body.wallet,
      request.body.dstToken,
      request.body.amount,
      request.body.preset,
      request.body.srcToken,
    ),
  );
  routes.post(
    "/v1/swap/fusion/permit-context",
    { schema: { body: z.object({ owner: address, token: address.optional() }).strict() } },
    async (request) => gateway.fusion.permitContext(request.body.owner, request.body.token),
  );
  routes.post(
    "/v1/swap/fusion/order",
    { schema: { body: z.object({ wallet: address, dstToken: address, amount: atoms, permit: z.string().regex(/^0x[a-fA-F0-9]{448}$/), preset, srcToken: address.optional(), receiver: address.optional() }).strict() } },
    async (request) => gateway.fusion.createOrder(
      request.body.wallet,
      request.body.dstToken,
      request.body.amount,
      request.body.permit as Hex,
      request.body.preset,
      request.body.srcToken,
      request.body.receiver,
    ),
  );
  routes.post(
    "/v1/swap/fusion/submit",
    { schema: { body: z.object({ order: limitOrder, signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/), quoteId: z.string().min(1).max(200), extension: hex }).strict() } },
    async (request, reply) => {
      await gateway.fusion.submit({ ...request.body, signature: request.body.signature as Hex });
      return reply.code(202).send({ accepted: true });
    },
  );
  routes.post(
    "/v1/swap/fusion/status",
    { schema: { body: z.object({ orderHash: hash }).strict() } },
    async (request, reply) => {
      const status = await gateway.fusion.status(request.body.orderHash);
      if (!status) return reply.code(404).send({ code: "FUSION_NOT_FOUND", message: "relayer does not know the order" });
      return status;
    },
  );
}
