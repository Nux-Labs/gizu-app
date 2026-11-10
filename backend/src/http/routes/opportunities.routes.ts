import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { supportedProtocolIds } from "../../domain/protocol.ts";
import { defaultCatalogChains, type CatalogChain } from "../../domain/catalog.ts";
import type { OpportunitiesController } from "../controllers/opportunities.controller.ts";

export const ListOpportunitiesQuerySchema = z.object({
  search: z.string(),
  page: z.coerce.number().int().nonnegative(),
  items: z.coerce.number().int().min(1).max(100),
  chainId: z.coerce.number().int().positive(),
  /** Catalog protocol id from `facets.protocols`; omitted means every protocol. */
  protocol: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
});

export type ListOpportunitiesQuery = z.infer<typeof ListOpportunitiesQuerySchema>;

export const ProtocolParamsSchema = z.object({
  protocolId: z.enum(supportedProtocolIds),
});

export type ProtocolParams = z.infer<typeof ProtocolParamsSchema>;

export const OpportunityParamsSchema = z.object({
  id: z.string().min(1),
});

export type OpportunityParams = z.infer<typeof OpportunityParamsSchema>;

export const TvlRecordsParamsSchema = OpportunityParamsSchema;

export const TvlRecordsQuerySchema = z.object({
  items: z.coerce.number().int().min(1).max(200),
});

export type TvlRecordsParams = z.infer<typeof TvlRecordsParamsSchema>;
export type TvlRecordsQuery = z.infer<typeof TvlRecordsQuerySchema>;

export function registerOpportunityRoutes(
  app: FastifyInstance,
  controller: OpportunitiesController,
  chains: CatalogChain[] = defaultCatalogChains,
) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  server.get("/v1/chains", async () => ({ list: chains }));
  server.get("/v1/protocols", controller.protocols);
  server.get(
    "/v1/opportunities",
    { schema: { querystring: ListOpportunitiesQuerySchema } },
    controller.list,
  );
  server.get(
    "/v1/protocols/:protocolId/opportunities",
    {
      schema: {
        params: ProtocolParamsSchema,
        querystring: ListOpportunitiesQuerySchema,
      },
    },
    controller.listByProtocol,
  );
  server.get(
    "/v1/opportunities/:id/tvl-records",
    {
      schema: {
        params: TvlRecordsParamsSchema,
        querystring: TvlRecordsQuerySchema,
      },
    },
    controller.tvlRecords,
  );
  server.get(
    "/v1/opportunities/:id",
    { schema: { params: OpportunityParamsSchema } },
    controller.getById,
  );
}
