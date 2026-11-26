import type { AuroraFeeQualification } from "../../adapters/earn/fee-policy.ts";
import type {
  FastifyInstance,
  FastifyError,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { getAddress } from "viem";
import {
  fundingChain,
  type FundingChainId,
} from "../../adapters/pimlico/funding-chains.ts";
import type { FundingPlanner } from "../../adapters/pimlico/source-funding.ts";
import type { PimlicoFunding } from "../../adapters/pimlico/monad-funding.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { rpcUserOperation } from "./swap.routes.ts";

type Gateways = Record<
  FundingChainId,
  {
    planner: Pick<FundingPlanner, "prepare">;
    funding: Pick<PimlicoFunding, "prepare" | "submit" | "receipt">;
  }
>;
const params = z.object({ chainId: z.enum(["143", "8453", "42161"]) }).strict();
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .transform((value) => getAddress(value));
const atoms = z.string().regex(/^[1-9][0-9]{0,38}$/);
const transfer = z
  .object({ owner: address, recipient: address, amount: atoms })
  .strict();
const options = {
  bodyLimit: 65536,
  logLevel: "silent" as const,
  errorHandler(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const known = error instanceof InfrastructureError;
    const status = known
      ? error.statusCode
      : error.validation
        ? 400
        : error.statusCode === 413
          ? 413
          : 502;
    return reply.code(status).send({
      code: known
        ? error.code
        : status === 400 || status === 413
          ? "INVALID_FUNDING_REQUEST"
          : "FUNDING_UNAVAILABLE",
      message: "The funding request could not be verified.",
    });
  },
};

/** Source selection stays independent of the Swap/Earn destination. Legacy Monad routes remain valid. */
export function registerFundingRoutes(
  app: FastifyInstance,
  gateways: Gateways,
  enabledChainIds: readonly FundingChainId[] = [143],
  privateFundingQualification?: AuroraFeeQualification,
) {
  const enabled = new Set(enabledChainIds);
  const requireEnabled = (id: FundingChainId) => {
    if (!enabled.has(id))
      throw new InfrastructureError(
        403,
        "FUNDING_CHAIN_DISABLED",
        "New funding on this network is not enabled.",
      );
  };
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get("/v1/funding/capabilities", async () => ({
    fundingContractVersion: 2,
    fundingChainIds: [...enabled],
    ...(privateFundingQualification &&
    ("protocolFeeBps" in privateFundingQualification ||
      privateFundingQualification.routes.payoutEthereum)
      ? { earnPrivateFundingVersion: 2, earnPrivateFundingProfileChainIds: [1] }
      : {}),
  }));
  routes.post(
    "/v1/funding/:chainId/plan",
    {
      ...options,
      bodyLimit: 2048,
      schema: { params, body: transfer.extend({ budget: atoms }).strict() },
    },
    async (request) => {
      const id = Number(request.params.chainId) as FundingChainId;
      requireEnabled(id);
      const result = await gateways[id].planner.prepare(request.body);
      return { ...result, sourceChainId: id, token: fundingChain(id).token };
    },
  );
  routes.post(
    "/v1/funding/:chainId/prepare",
    { ...options, bodyLimit: 2048, schema: { params, body: transfer } },
    async (request) => {
      const id = Number(request.params.chainId) as FundingChainId;
      requireEnabled(id);
      const result = await gateways[id].funding.prepare(
        request.body.owner,
        request.body.recipient,
        BigInt(request.body.amount),
      );
      return { ...result, sourceChainId: id, token: fundingChain(id).token };
    },
  );
  routes.post(
    "/v1/funding/:chainId/submit",
    {
      ...options,
      schema: {
        params,
        body: z.object({ userOperation: rpcUserOperation }).strict(),
      },
    },
    async (request) => {
      const id = Number(request.params.chainId) as FundingChainId;
      const operation = request.body.userOperation;
      if (
        operation.eip7702Auth &&
        BigInt(operation.eip7702Auth.chainId) !== BigInt(id)
      )
        throw new InfrastructureError(
          400,
          "INVALID_FUNDING_SOURCE",
          "Funding authorization chain changed.",
        );
      return {
        userOperationHash: await gateways[id].funding.submit(operation),
        sourceChainId: id,
      };
    },
  );
  routes.post(
    "/v1/funding/:chainId/receipt",
    {
      ...options,
      bodyLimit: 1024,
      schema: {
        params,
        body: z
          .object({
            userOperationHash: z
              .string()
              .regex(/^0x[0-9a-f]{64}$/i)
              .transform((v) => v as `0x${string}`),
          })
          .strict(),
      },
    },
    async (request) => {
      const id = Number(request.params.chainId) as FundingChainId;
      return {
        ...(await gateways[id].funding.receipt(request.body.userOperationHash)),
        sourceChainId: id,
      };
    },
  );
}
